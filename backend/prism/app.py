"""Local-only FastAPI application; frontend and API share port 4780 in production."""
from __future__ import annotations
from .sourcefiles import git_lines
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import os
import re
import threading
import time
import subprocess
import uuid
from typing import Literal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from . import settings
from .gitops import (RepoError, parse_pr_url, pr_metadata, prepare_worktrees, diff_files,
                     github_viewed_file_states, set_github_file_viewed)
from .graph import identify_changes, segment
from .harness import available_harnesses, explain_progressively as explain, answer_question, bind_cancel, bind_run_options, JobCancelled
from .evidence import collect_evidence
from .topics import build_topics
from .repository_tools import head_worktree, RepositoryToolError
from .architecture_review import discover_architecture
from .architecture import VERSION as ARCHITECTURE_VERSION, build_architecture
from .exploration import service as exploration

app = FastAPI(title="Prism PR Review", version="0.2.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="prism-job")
question_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="prism-question")
lock = threading.Lock()
report_lock = threading.RLock()
jobs: dict[str,dict] = {}
cancel_events: dict[str,threading.Event] = {}

class AnalyzeRequest(BaseModel):
    url: str = Field(min_length=25, max_length=400)
    harness: Literal["none","claude","codex"] = "none"
    model: str = Field(default="default", max_length=120)
    effort: str = Field(default="default", max_length=32)
    scope: Literal["full","outline"] = "full"
    style: Literal["review","describe"] = "review"
    timeout_seconds: int | None = Field(default=None, ge=0, le=86400)  # None: server default; 0: no limit

class ExplainRequest(BaseModel):
    harness: Literal["claude","codex"]
    model: str = Field(default="default", max_length=120)
    effort: str = Field(default="default", max_length=32)
    scope: Literal["full","outline"] = "full"
    style: Literal["review","describe"] = "review"
    timeout_seconds: int | None = Field(default=None, ge=0, le=86400)  # None: server default; 0: no limit

class ViewedFileRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    viewed: bool

class ExplorationResolveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    side: Literal['old','new']
    line: int = Field(ge=1)
    column: int = Field(ge=0)

class ExplorationExpandRequest(BaseModel):
    side: Literal['old','new']
    root_id: str = Field(min_length=1,max_length=64)
    direction: Literal['consumers','origins'] = 'consumers'
    changed_only: bool = True
    query_id: str | None = Field(default=None,max_length=64)
    context_query_id: str | None = Field(default=None,max_length=64)

class QuestionTurn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(min_length=1, max_length=6000)

class DiffLineAnchor(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    old_lines: list[int] = Field(default_factory=list, max_length=30)
    new_lines: list[int] = Field(default_factory=list, max_length=30)

class QuestionRequest(BaseModel):
    harness: Literal["claude","codex"]
    model: str = Field(default="default", max_length=120)
    effort: str = Field(default="default", max_length=32)
    question: str = Field(min_length=1, max_length=2000)
    timeout_seconds: int | None = Field(default=None, ge=0, le=86400)  # None: server default; 0: no limit
    history: list[QuestionTurn] = Field(default_factory=list, max_length=6)
    anchor: DiffLineAnchor | None = None


_QUESTION_HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _verified_diff_anchor(report: dict, anchor: DiffLineAnchor) -> dict:
    """Rebuild a reviewer-selected diff excerpt from the cached PR patch."""
    old_lines, new_lines = set(anchor.old_lines), set(anchor.new_lines)
    if not old_lines and not new_lines:
        raise HTTPException(422, "Select at least one changed-file diff line.")
    if any(line < 1 for line in old_lines | new_lines):
        raise HTTPException(422, "Diff line numbers must be positive.")
    if len(old_lines) != len(anchor.old_lines) or len(new_lines) != len(anchor.new_lines):
        raise HTTPException(422, "A diff line can only be selected once.")
    if len(old_lines | new_lines) > 30:
        raise HTTPException(422, "Select no more than 30 diff lines at a time.")

    file = next((item for item in report.get("files", [])
                 if anchor.path in {item.get("path"), item.get("old_path")}), None)
    if not file:
        raise HTTPException(400, "Choose lines from a file changed by this pull request.")

    rows: list[dict] = []
    old_line = new_line = None
    for raw in git_lines(file.get("patch") or ""):
        header = _QUESTION_HUNK_HEADER.match(raw)
        if header:
            old_line = int(header.group(1))
            new_line = int(header.group(3))
            continue
        if old_line is None or new_line is None or raw.startswith("\\"):
            continue
        prefix = raw[:1]
        if prefix == "+":
            rows.append({"old": None, "new": new_line, "prefix": "+", "code": raw[1:]})
            new_line += 1
        elif prefix == "-":
            rows.append({"old": old_line, "new": None, "prefix": "-", "code": raw[1:]})
            old_line += 1
        elif prefix == " ":
            rows.append({"old": old_line, "new": new_line, "prefix": " ", "code": raw[1:]})
            old_line += 1
            new_line += 1

    available_old = {row["old"] for row in rows if row["old"] is not None}
    available_new = {row["new"] for row in rows if row["new"] is not None}
    if not old_lines.issubset(available_old) or not new_lines.issubset(available_new):
        raise HTTPException(422, "Those lines are not present in the stored PR diff. Select visible diff lines.")

    selected = [row for row in rows if row["old"] in old_lines or row["new"] in new_lines]
    if not selected:
        raise HTTPException(422, "No PR diff lines matched that selection.")
    excerpt = []
    for row in selected:
        if row["prefix"] == "+":
            location = f"new line {row['new']}"
        elif row["prefix"] == "-":
            location = f"old line {row['old']}"
        else:
            location = f"old line {row['old']}, new line {row['new']}"
        excerpt.append(f"{row['prefix']} [{location}] {row['code']}")

    path = file.get("path") or file.get("old_path") or anchor.path
    lines = sorted(new_lines or old_lines)
    return {
        "path": path,
        "old_lines": sorted(old_lines),
        "new_lines": sorted(new_lines),
        "line": lines[0],
        "end_line": lines[-1],
        "label": "Selected diff lines",
        "diff": "\n".join(excerpt)[:9000],
    }


def _reports_dir() -> Path:
    path=settings.DATA_DIR / "reports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def report_path(report_id: str) -> Path:
    if not (len(report_id)==24 and all(c in "0123456789abcdef" for c in report_id)):
        raise HTTPException(404,"Unknown report")
    return _reports_dir() / f"{report_id}.json"


def read_report(report_id: str) -> dict:
    path=report_path(report_id)
    if not path.exists():raise HTTPException(404,"Report not found")
    return json.loads(path.read_text())


def ensure_evidence(report: dict) -> dict:
    """Upgrade cached pre-v0.2 reports without reindexing the entire repo."""
    if 'evidence' in report:
        return report
    meta = report.get('meta', {})
    owner, repo = meta.get('owner',''), meta.get('repo','')
    base, head = meta.get('merge_base',''), meta.get('head','')
    if owner and repo and base and head:
        root = settings.DATA_DIR / 'repos' / hashlib.sha256(f'{owner}/{repo}'.encode()).hexdigest()[:20] / 'worktrees'
        before, after = root / base, root / head
        if before.is_dir() and after.is_dir():
            report['evidence'] = collect_evidence(report.get('groups', []), report.get('files', []), before, after)
        else:
            report['evidence'] = {}
    else:
        report['evidence'] = {}
    save_report(report)
    return report


def ensure_complete_diff(report: dict, root: Path | None = None) -> dict:
    """Recover old capped patches from retained Git objects without an AI run."""
    if report.get('demo') or report.get('diff_version') == 1: return report
    meta = report.get('meta') or {}
    if not meta.get('head') or not meta.get('merge_base'): return report
    root = root or head_worktree(report)
    files = diff_files(root, meta['merge_base'], meta['head'])
    with report_lock:
        # An old-report GET must not overwrite a guide completed during Git IO.
        latest = read_report(report['id']) if report.get('id') and report_path(report['id']).exists() else report
        latest['files'] = files
        latest['diff_version'] = 1
        save_report(latest)
        report.update(latest)
    return report


def _store_ai(report: dict, ai: dict) -> None:
    """Store an AI result; a non-empty AI topic plan also becomes the top-level topics."""
    report["ai"] = ai
    if isinstance(ai.get("topics"), list) and ai["topics"]:
        report["topics"] = ai["topics"]
        report["topics_version"] = 5


def ensure_topics(report: dict) -> dict:
    """Build or refresh reviewer topics when their graph-selection rules change."""
    # Only pre-v5 reports are rebuilt; a stored AI topic plan at v5 is never overwritten here.
    if report.get("topics_version", 0) < 5:
        ai = report.get("ai") or {}
        saved_topics = ai.get("topics") or report.get("topics") or []
        suggestions = [
            {"title": topic.get("title"), "focus": topic.get("focus", ""), "group_ids": topic.get("group_ids")}
            for topic in saved_topics
            if isinstance(topic, dict) and topic.get("source") == "ai"
        ]
        topics = build_topics(report.get("groups", []), report.get("overview", {}), suggestions or None,
                              ai.get("review_order"))
        report["topics"] = topics
        if report.get("ai"):
            report["ai"]["topics"] = topics
        report["topics_version"] = 5
        if not report.get("demo"):
            save_report(report)
    return report


def ensure_architecture(report: dict, root: Path | None = None) -> dict:
    """Opening a report never triggers whole-repository source discovery."""
    architecture = report.get('architecture') or {}
    if architecture.get('version') == ARCHITECTURE_VERSION or architecture.get('method') == 'semantic':
        for edge in architecture.get('edges', []):
            if edge.get('confidence') != 'LLM_INFERRED': edge.pop('label', None)
        return report
    report['architecture'] = build_architecture(report.get('files', []), {})
    for layer in report['architecture'].get('layers', []): layer['title'] = 'Changed files'
    report['architecture'].update(method='manifest', notes=[
        'Changed-file map only. Relationships have not been analyzed. Discover architecture or explore a symbol for surrounding source context.'
    ])
    save_report(report)
    return report


def _changed_structure(files, before, after, progress):
    """Only diff paths enter declaration parsing; source access stays unrestricted."""
    progress(f"Mapping declarations in {len(files)} changed {'file' if len(files) == 1 else 'files'}")
    empty = {'nodes': [], 'edges': []}
    nodes, edges, changed = identify_changes(files, before, after, empty, empty)
    groups, overview = segment(nodes, edges, changed, files)
    return nodes, edges, changed, groups, overview


def save_report(report: dict):
    with report_lock:
        path=report_path(report["id"])
        tmp=path.with_suffix(".tmp")
        report["revision"] = uuid.uuid4().hex
        tmp.write_text(json.dumps(report,ensure_ascii=True))
        tmp.replace(path)



def _job(kind: str, callback, *, review_requested: bool = True, outline: bool = False, timeout: int | None = None):
    job_id=uuid.uuid4().hex
    started = None
    started_at = None
    cancel = threading.Event()
    with lock:
        jobs[job_id]={"id":job_id,"kind":kind,"state":"queued","message":"Queued","report_id":None,"result":None,"error":None,"activity":[]}
        cancel_events[job_id]=cancel
    def update(message):
        # Progress reports double as cancellation checkpoints between non-CLI steps.
        if cancel.is_set(): raise JobCancelled("Stopped by user")
        with lock:
            jobs[job_id]["state"]="running"
            jobs[job_id]["message"]=message
    def report_ready(report_id):
        with report_lock:
            current = read_report(report_id)
            current['analysis'] = {'state': 'running', 'job_id': job_id}
            elapsed = round(time.monotonic() - started, 3)
            if kind == 'analysis':
                current['analysis_timings'] = {'graph_seconds': elapsed, 'started_at': started_at,
                    'review_status': 'running' if review_requested else 'not_requested',
                    'review_kind': 'outline' if outline else 'analysis'}
            elif kind == 'explanation':
                previous = current.get('analysis_timings') or {}
                current['analysis_timings'] = {'graph_seconds': previous.get('graph_seconds'),
                    'started_at': started_at, 'review_status': 'running',
                    'review_kind': 'outline' if outline else 'regenerated'}
            save_report(current)
        with lock: jobs[job_id]['report_id'] = report_id
    update.report_ready = report_ready
    def activity(text):
        # Keep the most recent CLI output lines for the UI's live agent-output panel.
        with lock:
            lines = jobs[job_id]["activity"]
            lines.append(text)
            del lines[:-200]
    def finish_report(state, error=None):
        with lock: report_id = jobs[job_id]['report_id']
        if report_id:
            with report_lock:
                current = read_report(report_id)
                current['analysis'] = {'state': state, 'job_id': job_id, 'error': error}
                timing = current.get('analysis_timings')
                if timing and kind in {'analysis', 'explanation'}:
                    elapsed = max(0, time.monotonic() - started)
                    if kind == 'analysis':
                        review_seconds = max(0, elapsed - timing['graph_seconds'])
                    else:
                        review_seconds = elapsed
                    if kind == 'explanation' or review_requested:
                        timing.update(review_seconds=round(review_seconds, 3),
                                      review_status={'completed': 'completed', 'cancelled': 'cancelled'}.get(state, 'failed'))
                    if state == 'completed':
                        timing['completed_at'] = datetime.now(timezone.utc).isoformat()
                        if kind == 'analysis': timing['total_seconds'] = round(elapsed, 3)
                save_report(current)
    def work():
        nonlocal started, started_at
        started = time.monotonic()
        started_at = datetime.now(timezone.utc).isoformat()
        bind_cancel(cancel)
        bind_run_options(activity, timeout)
        try:
            if cancel.is_set(): raise JobCancelled("Stopped by user")
            update("Starting")
            result=callback(update)
            finish_report("completed")
            with lock:
                jobs[job_id].update(state="completed",message="Ready",
                                    report_id=result if isinstance(result,str) else None,
                                    result=None if isinstance(result,str) else result)
        except Exception as e:
            cancelled = isinstance(e, JobCancelled) or cancel.is_set()
            try: finish_report("cancelled" if cancelled else "failed", None if cancelled else str(e)[:1100])
            finally:
                with lock:
                    if cancelled: jobs[job_id].update(state="cancelled",message="Stopped",error=None)
                    else: jobs[job_id].update(state="failed",message="Analysis failed",error=str(e)[:1100])
        finally:
            bind_cancel(None)
    (question_executor if kind == "question" else executor).submit(work)
    return {"job_id":job_id}


def _publish_ready(report_id, progress):
    ready = getattr(progress, 'report_ready', None)
    if ready: ready(report_id)


def _generate_guide(report, request, progress, root):
    first_publication = True
    def publish(ai):
        nonlocal first_publication
        with report_lock:
            current = read_report(report['id'])
            if first_publication and current.get('ai'):
                current.setdefault('previous_ai', []).append({'reason': 'Progressive guide regeneration',
                                                              'ai': current['ai'], 'topics': current.get('topics')})
            first_publication = False
            _store_ai(current, ai)
            save_report(current)
    ai = explain(report, request.harness, request.model, request.effort, progress, root, publish=publish,
                 outline_only=request.scope == 'outline', describe_only=request.style == 'describe')
    publish(ai)


def _discover_and_store(report_id, root, req, progress):
    current = read_report(report_id)
    architecture = discover_architecture(current,root,req.harness,req.model,req.effort,progress)
    with report_lock:
        current = read_report(report_id)
        current['architecture'] = architecture
        save_report(current)


def run_analysis(req: AnalyzeRequest, progress) -> str:
    owner,repo,number=parse_pr_url(req.url)
    progress("Fetching GitHub pull request metadata")
    meta=pr_metadata(owner,repo,number)
    progress("Fetching Git history and creating isolated checkouts")
    git_repo,before,after,merge_base=prepare_worktrees(meta)
    meta["merge_base"]=merge_base
    report_id=hashlib.sha256(f"{owner}/{repo}/{number}/{merge_base}/{meta['head']}".encode()).hexdigest()[:24]
    path=report_path(report_id)
    if path.exists():
        result=ensure_complete_diff(read_report(report_id), after)
        result["meta"] = meta
        if result.get("symbol_mapping_version") != 2:
            nodes,edges,changed,groups,overview=_changed_structure(result['files'],before,after,progress)
            result['structure'] = {'scope': 'changed_files', 'relationships_complete': False, 'exploration': 'on_demand'}
            if result.get('ai'):
                result.setdefault('previous_ai', []).append({'reason': 'Changed declaration mapping upgraded',
                    'ai': result['ai'], 'topics': result.get('topics'), 'symbol_mapping_version': result.get('symbol_mapping_version', 1)})
            result.update(groups=groups,overview=overview,evidence=collect_evidence(groups,result["files"],before,after),
                          ai=None,topics=build_topics(groups,overview),topics_version=5,symbol_mapping_version=2)
            result["stats"].update(changed_symbols=len(changed),groups=len(groups),
                                   total_graph_nodes=len(nodes),total_graph_edges=len(edges))
        result=ensure_architecture(ensure_topics(ensure_evidence(result)), after)
        save_report(result)
        _publish_ready(report_id, progress)
        if req.harness != "none":
            _generate_guide(result, req, progress, after)
            if req.scope != "outline" and req.style != "describe": _discover_and_store(report_id, after, req, progress)
        return report_id
    progress("Calculating PR diff")
    files=diff_files(git_repo,merge_base,meta["head"])
    if not files: raise RepoError("This PR has no diff against its merge-base.")
    nodes,edges,changed,groups,overview=_changed_structure(files,before,after,progress)
    report={"id":report_id,"meta":meta,"created_at":datetime.now(timezone.utc).isoformat(),
            "stats":{"changed_files":len(files),"changed_symbols":len(changed),
                     "groups":len(groups),"indexed_files":len({n["path"] for n in nodes if n["kind"] != "file"}),
                     "total_graph_nodes":len(nodes),"total_graph_edges":len(edges)},
            "files":files,"groups":groups,"overview":overview,
            "evidence":collect_evidence(groups,files,before,after),"ai":None,
            "topics":build_topics(groups,overview),"topics_version":5,"demo":False,"diff_version":1,"symbol_mapping_version":2,
            "structure":{"scope":"changed_files","relationships_complete":False,"exploration":"on_demand"}}
    ensure_architecture(report, after)
    save_report(report)
    _publish_ready(report_id, progress)
    if req.harness != "none":
        _generate_guide(report, req, progress, after)
        if req.scope != "outline" and req.style != "describe": _discover_and_store(report_id, after, req, progress)
    return report_id


@app.middleware("http")
async def check_origin(request: Request, call_next):
    if request.method not in ("GET","HEAD","OPTIONS"):
        origin=request.headers.get("origin", "")
        port=os.getenv("PORT","4780")
        if origin and origin not in {f"http://localhost:{port}",f"http://127.0.0.1:{port}","http://localhost:5173","http://127.0.0.1:5173"}:
            return JSONResponse({"detail":"Origin not allowed"},status_code=403)
    return await call_next(request)


@app.get("/api/health")
def health():return {"ok":True,"app":"Prism","port":int(os.getenv("PORT","4780"))}

@app.get("/api/harnesses")
def harnesses():return available_harnesses()

@app.post("/api/analyze",status_code=202)
def analyze(request: AnalyzeRequest):
    try:
        parse_pr_url(request.url)
    except RepoError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _job("analysis",lambda progress:run_analysis(request,progress), review_requested=request.harness != "none", outline=request.scope == "outline", timeout=request.timeout_seconds)

@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    with lock:
        job=jobs.get(job_id)
        if not job:raise HTTPException(404,"Unknown job")
        if job["state"] in ("queued","running"):
            # Running CLI calls are killed by the worker within a fraction of a second.
            queued = job["state"]=="queued"
            job["state"]="cancelled" if queued else "cancelling"; job["message"]="Stopped" if queued else "Stopping"
            cancel_events[job_id].set()
        return {**job,"activity":list(job["activity"])}

@app.get("/api/jobs/{job_id}")
def job_info(job_id: str):
    with lock:
        job=jobs.get(job_id)
        if not job:raise HTTPException(404,"Unknown job")
        return {**job,"activity":list(job["activity"])}

@app.get("/api/reports")
def reports():
    results=[]
    for path in sorted(_reports_dir().glob("*.json"),key=lambda p:p.stat().st_mtime,reverse=True)[:40]:
        try:
            data=json.loads(path.read_text())
            results.append({"id":data["id"],"meta":data["meta"],"stats":data["stats"],
                            "created_at":data["created_at"],"has_ai":bool(data.get("ai"))})
        except (ValueError,KeyError):pass
    return results

@app.get("/api/reports/{report_id}")
def report(report_id:str):
    data=ensure_architecture(ensure_topics(ensure_evidence(read_report(report_id))))
    try: data=ensure_complete_diff(data)
    except (RepositoryToolError, RepoError) as exc:
        # Saved reports remain readable offline, with an explicit access gap.
        data['workspace_warning'] = str(exc)
    if data.get('analysis', {}).get('state') == 'running':
        with lock: active = data['analysis'].get('job_id') in jobs
        if not active:
            with report_lock:
                # Merge with the latest report if a replacement job began during GET.
                current = read_report(report_id)
                if current.get('analysis') == data['analysis']:
                    message = 'Analysis interrupted when Prism stopped. Saved guide and feedback are available; regenerate to continue.'
                    current['analysis'] = dict(current['analysis'], state='failed', error=message)
                    timing = current.get('analysis_timings') or {}
                    if timing.get('review_status') == 'running': timing['review_status'] = 'failed'
                    state = (current.get('ai') or {}).get('review_state') or {}
                    if state.get('feedback_status') == 'running':
                        state.update(feedback_status='failed', error=message)
                        for feedback in state.get('topic_feedback', []):
                            if feedback['status'] == 'running': feedback['status'] = 'failed'
                    save_report(current)
                data = current
    return data


def _exploration_call(callback):
    try: return callback()
    except RepositoryToolError as exc: raise HTTPException(409,str(exc)) from exc
    except ValueError as exc: raise HTTPException(422,str(exc)) from exc


@app.post('/api/reports/{report_id}/exploration/resolve')
def resolve_exploration(report_id: str, request: ExplorationResolveRequest):
    data=read_report(report_id)
    return _exploration_call(lambda: exploration.resolve_symbol(data,request.path,request.side,request.line,request.column))


@app.post('/api/reports/{report_id}/exploration/expand')
def expand_exploration(report_id: str, request: ExplorationExpandRequest):
    data=read_report(report_id)
    return _exploration_call(lambda: exploration.expand(data,request.side,request.root_id,request.direction,request.changed_only,request.query_id,request.context_query_id))


@app.get('/api/reports/{report_id}/exploration/source')
def exploration_source(report_id: str, path: str, side: Literal['old','new'], line: int, end_line: int | None = None):
    data=read_report(report_id)
    return _exploration_call(lambda: exploration.source(data,path,side,line,end_line))

@app.get("/api/reports/{report_id}/viewed-files")
def viewed_files(report_id:str):
    data=read_report(report_id)
    meta=data.get("meta", {})
    try:
        states=github_viewed_file_states(meta["owner"],meta["repo"],int(meta["number"]))
        changed_paths={file.get("path") or file.get("old_path", "") for file in data.get("files", [])}
        return {"available":True,"states":{path:state for path,state in states.items() if path in changed_paths}}
    except (KeyError,TypeError,ValueError,RepoError) as exc:
        return {"available":False,"states":{},"reason":str(exc)[:500]}

@app.post("/api/reports/{report_id}/viewed-files")
def update_viewed_file(report_id:str, request:ViewedFileRequest):
    data=read_report(report_id)
    meta=data.get("meta", {})
    valid_paths={path for file in data.get("files", [])
                 for path in (file.get("path"),file.get("old_path")) if path}
    if request.path not in valid_paths:
        raise HTTPException(400,"Choose a file changed by this pull request.")
    try:
        set_github_file_viewed(meta["owner"],meta["repo"],int(meta["number"]),request.path,request.viewed)
    except (KeyError,TypeError,ValueError,RepoError) as exc:
        raise HTTPException(400,str(exc)) from exc
    return {"available":True,"path":request.path,"state":"VIEWED" if request.viewed else "UNVIEWED"}

@app.post("/api/reports/{report_id}/questions",status_code=202)
def ask_question(report_id:str, request:QuestionRequest):
    question=request.question.strip()
    if not question:
        raise HTTPException(422,"Enter a question about this pull request.")
    history=[turn.model_dump() for turn in request.history]
    try:
        anchor = _verified_diff_anchor(ensure_complete_diff(read_report(report_id)), request.anchor) if request.anchor else None
    except (RepositoryToolError, RepoError) as exc:
        raise HTTPException(409, str(exc)) from exc
    def work(progress):
        data=ensure_topics(ensure_evidence(read_report(report_id)))
        repository_root = head_worktree(data)
        data=ensure_complete_diff(data, repository_root)
        return answer_question(data,request.harness,request.model,request.effort,question,history,progress,anchor,repository_root)
    return _job("question",work,timeout=request.timeout_seconds)

@app.post("/api/reports/{report_id}/architecture",status_code=202)
def organize_architecture(report_id: str, request: ExplainRequest):
    report = ensure_architecture(ensure_topics(ensure_evidence(read_report(report_id))))
    root = head_worktree(report)
    def work(progress):
        _publish_ready(report_id, progress)
        architecture = discover_architecture(report, root, request.harness, request.model, request.effort, progress)
        # Preserve other report updates that may have happened while the model ran.
        current = read_report(report_id)
        current["architecture"] = architecture
        save_report(current)
        return report_id
    return _job("architecture", work, timeout=request.timeout_seconds)


@app.post("/api/reports/{report_id}/explain",status_code=202)
def explain_report(report_id:str, request:ExplainRequest):
    read_report(report_id)
    def work(progress):
        data=ensure_topics(ensure_evidence(read_report(report_id)))
        root=head_worktree(data)
        data=ensure_complete_diff(data, root)
        _publish_ready(report_id, progress)
        _generate_guide(data, request, progress, root)
        return report_id
    return _job("explanation",work,outline=request.scope == "outline",timeout=request.timeout_seconds)

@app.get("/api/demo")
def demo():
    return ensure_topics(json.loads((Path(__file__).parent / "demo.json").read_text()))

# Serve frontend build when available. During development, Vite proxies /api to FastAPI.
FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "dist"
@app.get("/{path:path}",include_in_schema=False)
def frontend(path:str):
    if path.startswith("api/"):raise HTTPException(404,"API route not found")
    target=(FRONTEND / path).resolve()
    if FRONTEND.resolve() in target.parents and target.is_file():return FileResponse(target)
    if (FRONTEND / "index.html").exists():return FileResponse(FRONTEND / "index.html")
    return {"message":"Frontend not built yet. Run ./start.sh after ./setup.sh, or run npm run dev in frontend/."}
