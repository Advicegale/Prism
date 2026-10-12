"""Local-only FastAPI application; frontend and API share port 4780 in production."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import os
import threading
import uuid
from typing import Literal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from . import settings
from .gitops import RepoError, parse_pr_url, pr_metadata, prepare_worktrees, diff_files
from .graph import snapshot, identify_changes, segment
from .harness import available_harnesses, explain
from .evidence import collect_evidence
from .topics import build_topics

app = FastAPI(title="Prism PR Review", version="0.2.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="prism-job")
lock = threading.Lock()
jobs: dict[str,dict] = {}

class AnalyzeRequest(BaseModel):
    url: str = Field(min_length=25, max_length=400)
    harness: Literal["none","claude","codex"] = "none"
    model: str = Field(default="default", max_length=120)
    effort: str = Field(default="default", max_length=32)

class ExplainRequest(BaseModel):
    harness: Literal["claude","codex"]
    model: str = Field(default="default", max_length=120)
    effort: str = Field(default="default", max_length=32)


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


def ensure_topics(report: dict) -> dict:
    """Build or refresh reviewer topics when their graph-selection rules change."""
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


def save_report(report: dict):
    path=report_path(report["id"])
    tmp=path.with_suffix(".tmp")
    tmp.write_text(json.dumps(report,ensure_ascii=False))
    tmp.replace(path)


def _job(kind: str, callback):
    job_id=uuid.uuid4().hex
    with lock: jobs[job_id]={"id":job_id,"kind":kind,"state":"queued","message":"Queued","report_id":None,"error":None}
    def update(message):
        with lock:
            jobs[job_id]["state"]="running"
            jobs[job_id]["message"]=message
    def work():
        try:
            update("Starting")
            rid=callback(update)
            with lock:jobs[job_id].update(state="completed",message="Ready",report_id=rid)
        except Exception as e:
            with lock:jobs[job_id].update(state="failed",message="Analysis failed",error=str(e)[:1100])
    executor.submit(work)
    return {"job_id":job_id}


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
        result=ensure_topics(ensure_evidence(read_report(report_id)))
        if req.harness != "none":
            progress("Updating AI explanation")
            result["ai"]=explain(result,req.harness,req.model,req.effort,progress)
            save_report(result)
        return report_id
    progress("Calculating PR diff")
    files=diff_files(git_repo,merge_base,meta["head"])
    if not files: raise RepoError("This PR has no diff against its merge-base.")
    graph_cache=git_repo.parent / "graphs"
    old=snapshot(before,graph_cache,merge_base,progress)
    new=snapshot(after,graph_cache,meta["head"],progress)
    progress("Mapping changed line ranges to classes and methods")
    nodes,edges,changed=identify_changes(files,before,after,old,new)
    progress("Finding structural change groups")
    groups,overview=segment(nodes,edges,changed,files)
    report={"id":report_id,"meta":meta,"created_at":datetime.now(timezone.utc).isoformat(),
            "stats":{"changed_files":len(files),"changed_symbols":len(changed),
                     "groups":len(groups),"indexed_files":new["files_indexed"],
                     "total_graph_nodes":len(nodes),"total_graph_edges":len(edges)},
            "files":files,"groups":groups,"overview":overview,
            "evidence":collect_evidence(groups,files,before,after),"ai":None,
            "topics":build_topics(groups,overview),"topics_version":5,"demo":False}
    save_report(report)
    if req.harness != "none":
        report["ai"]=explain(report,req.harness,req.model,req.effort,progress)
        save_report(report)
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
    return _job("analysis",lambda progress:run_analysis(request,progress))

@app.get("/api/jobs/{job_id}")
def job_info(job_id: str):
    with lock: job=jobs.get(job_id)
    if not job:raise HTTPException(404,"Unknown job")
    return dict(job)

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
def report(report_id:str):return ensure_topics(ensure_evidence(read_report(report_id)))

@app.post("/api/reports/{report_id}/explain",status_code=202)
def explain_report(report_id:str, request:ExplainRequest):
    read_report(report_id)
    def work(progress):
        data=ensure_topics(ensure_evidence(read_report(report_id)))
        data["ai"]=explain(data,request.harness,request.model,request.effort,progress)
        data["topics"]=data["ai"]["topics"]
        data["topics_version"]=5
        save_report(data)
        return report_id
    return _job("explanation",work)

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
