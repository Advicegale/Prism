import {StrictMode,useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ArrowRight,Check,CheckCircle2,ChevronDown,ChevronRight,Clock3,Copy,Download,EyeOff,ExternalLink,FileCode2,GitBranch,GitPullRequest,Layers3,LoaderCircle,Menu,Network,Play,Plus,RefreshCcw,Settings2,ShieldCheck,Sparkles,Terminal,X,AlertCircle} from 'lucide-react'
import {ArchitectureMap} from './components/ArchitectureMap'
import {TopicReview} from './components/TopicReview'
import {ReviewQuestionPanel} from './components/ReviewQuestionPanel'
import {MarkdownContent} from './components/MarkdownContent'
import type { Harnesses,Job,Report,ReviewAssistantSettings,ViewedFiles } from './types'
import './styles.css'

const API='/api'
async function call<T>(path:string,options?:RequestInit):Promise<T>{
 const res=await fetch(API+path,{...options,headers:{'Content-Type':'application/json',...options?.headers}})
 if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(typeof data.detail==='string'?data.detail:`Request failed (${res.status})`)}
 return res.json() as Promise<T>
}
const pick=(key:string,def:string)=>localStorage.getItem('prism:'+key)||def
const display=(val:string)=>val==='claude'?'Claude Code':val==='codex'?'Codex':'Graph only'
const APP_PORT=window.location.port||'4780'
function prettyDate(date:string){try{return new Date(date).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch{return date}}
function reportPathFor(report:Report|null|undefined,path:string){
 const file=report?.files.find(item=>item.path===path||item.old_path===path)
 return file?.path||file?.old_path||path
}

function App(){
 const [report,setReport]=useState<Report|null>(null)
 const [mapView,setMapView]=useState<'architecture'|'topics'>('architecture')
 const [reviewFocus,setReviewFocus]=useState<{path:string;request:number}|null>(null)
 const [viewedFiles,setViewedFiles]=useState<ViewedFiles|null>(null)
 const [viewedFilesLoading,setViewedFilesLoading]=useState(false)
 const [viewedFileBusy,setViewedFileBusy]=useState<Set<string>>(()=>new Set())
 const [viewedFilesError,setViewedFilesError]=useState('')
 const [hideViewedFiles,setHideViewedFiles]=useState(()=>localStorage.getItem('prism:hide-viewed')==='true')
 const [prUrl,setPrUrl]=useState('')
 const [harness,setHarness]=useState(pick('harness','none'))
 const [model,setModel]=useState(pick('model','default'))
 const [effort,setEffort]=useState(pick('effort','default'))
 const [models,setModels]=useState<Harnesses|null>(null)
 const [reviewAssistant,setReviewAssistant]=useState<ReviewAssistantSettings>(()=>{
  const saved=localStorage.getItem('prism:question-harness')||localStorage.getItem('prism:harness')
  return {harness:saved==='claude'?'claude':'codex',model:localStorage.getItem('prism:question-model')||localStorage.getItem('prism:model')||'default',effort:localStorage.getItem('prism:question-effort')||localStorage.getItem('prism:effort')||'default'}
 })
 const [job,setJob]=useState<Job|null>(null)
 const [error,setError]=useState('')
 const [sidebar,setSidebar]=useState(()=>window.innerWidth>900)
 const [showSettings,setShowSettings]=useState(false)
 const [recent,setRecent]=useState<{id:string;meta:Report['meta'];stats:Report['stats'];created_at:string;has_ai:boolean}[]>([])
 const [loading,setLoading]=useState(false)
 const [showHistory,setShowHistory]=useState(false)
 const [showAnalyzeForm,setShowAnalyzeForm]=useState(false)
 const [copied,setCopied]=useState(false)
 const poll=useRef<ReturnType<typeof setInterval>|null>(null)
 const reportIdRef=useRef<string|null>(null)
 reportIdRef.current=report?.id||null
 useEffect(()=>{
  call<Harnesses>('/harnesses').then(setModels).catch(()=>{})
  refreshHistory()
  return()=>{if(poll.current)clearInterval(poll.current)}
 },[])
 useEffect(()=>{const syncSidebar=()=>setSidebar(window.innerWidth>900);window.addEventListener('resize',syncSidebar);return()=>window.removeEventListener('resize',syncSidebar)},[])
 useEffect(()=>{localStorage.setItem('prism:harness',harness);localStorage.setItem('prism:model',model);localStorage.setItem('prism:effort',effort)},[harness,model,effort])
 useEffect(()=>{localStorage.setItem('prism:hide-viewed',String(hideViewedFiles))},[hideViewedFiles])
 useEffect(()=>{
  if(!report||report.demo){setViewedFiles(null);setViewedFilesLoading(false);setViewedFilesError('');return}
  let active=true
  setViewedFiles(null);setViewedFilesLoading(true);setViewedFilesError('')
  call<ViewedFiles>(`/reports/${report.id}/viewed-files`).then(result=>{if(active)setViewedFiles(result)}).catch(cause=>{
   if(active){const message=cause instanceof Error?cause.message:String(cause);setViewedFiles({available:false,states:{},reason:message})}
  }).finally(()=>{if(active)setViewedFilesLoading(false)})
  return()=>{active=false}
 },[report?.id,report?.demo])
 async function refreshHistory(){try{setRecent(await call('/reports'))}catch{/* backend not started */}}
 async function loadReport(id:string){setLoading(true);setError('');try{setReport(await call<Report>('/reports/'+id));setMapView('architecture');setReviewFocus(null);setShowHistory(false);setShowAnalyzeForm(false)}catch(e){setError(String(e))}finally{setLoading(false)}}
 async function watchJob(id:string){
  if(poll.current)clearInterval(poll.current)
  const update=async()=>{
   try{const current=await call<Job>('/jobs/'+id);setJob(current)
     if(current.state==='completed'||current.state==='failed'){
      if(poll.current)clearInterval(poll.current);poll.current=null
      if(current.state==='completed'&&current.report_id){await loadReport(current.report_id);await refreshHistory()}
      else if(current.state==='failed')setError(current.error||'Analysis failed')
     }
   }catch(e){if(poll.current)clearInterval(poll.current);poll.current=null;setError(String(e))}
  }
  poll.current=setInterval(update,1400)
  await update()
 }
 async function begin(){
  setError('');setJob(null)
  try{const result=await call<{job_id:string}>('/analyze',{method:'POST',body:JSON.stringify({url:prUrl,harness,model,effort})});await watchJob(result.job_id)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }
 async function explain(){
  if(!report||report.demo||harness==='none')return
  setError('');setJob(null)
  try{const result=await call<{job_id:string}>(`/reports/${report.id}/explain`,{method:'POST',body:JSON.stringify({harness,model,effort})});await watchJob(result.job_id)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }
 async function discoverArchitecture(){
  if(!report||report.demo)return
  setError('');setJob(null)
  try{const result=await call<{job_id:string}>(`/reports/${report.id}/architecture`,{method:'POST',body:JSON.stringify(reviewAssistant)});await watchJob(result.job_id)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }
 async function toggleViewedFile(path:string,viewed:boolean){
  if(!report||report.demo)return
  setViewedFilesError('')
  setViewedFileBusy(current=>new Set(current).add(path))
  try{
   const result=await call<{available:boolean;path:string;state:'VIEWED'|'UNVIEWED'}>(`/reports/${report.id}/viewed-files`,{method:'POST',body:JSON.stringify({path,viewed})})
   if(reportIdRef.current===report.id)setViewedFiles(current=>current?{...current,available:true,states:{...current.states,[result.path]:result.state}}:{available:true,states:{[result.path]:result.state}})
  }catch(cause){if(reportIdRef.current===report.id)setViewedFilesError(cause instanceof Error?cause.message:String(cause))}
  finally{setViewedFileBusy(current=>{const next=new Set(current);next.delete(path);return next})}
 }
 async function refreshViewedStatus(){
  if(!report||report.demo)return
  const id=report.id
  setViewedFilesLoading(true);setViewedFilesError('')
  try{const result=await call<ViewedFiles>(`/reports/${id}/viewed-files`);if(reportIdRef.current===id)setViewedFiles(result)}
  catch(cause){if(reportIdRef.current===id)setViewedFilesError(cause instanceof Error?cause.message:String(cause))}
  finally{if(reportIdRef.current===id)setViewedFilesLoading(false)}
 }
 function download(){if(!report)return;const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download=`prism-pr-${report.demo?'demo':report.meta.number}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
 function copyLink(){if(!report)return;navigator.clipboard?.writeText(report.meta.url||window.location.href).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1800)}).catch(()=>{})}
 function openAnalyzer(){setShowHistory(false);setShowSettings(false);setShowAnalyzeForm(true);window.setTimeout(()=>document.getElementById('pr-url')?.focus(),0)}
 const topics=report?.ai?.topics?.length?report.ai.topics:report?.topics||[]
 const reportPaths=Array.from(new Set((report?.files||[]).map(file=>file.path||file.old_path).filter((path):path is string=>!!path)))
 const viewedCount=reportPaths.filter(path=>viewedFiles?.states[path]==='VIEWED').length
 const architectureHiddenPaths=useMemo(()=>new Set(hideViewedFiles?reportPaths.filter(path=>viewedFiles?.states[path]==='VIEWED'):[]),[report,hideViewedFiles,viewedFiles])
 function inspectArchitectureFile(path:string){setHideViewedFiles(false);setReviewFocus(current=>({path:reportPathFor(report,path),request:(current?.request||0)+1}));setMapView('topics');window.setTimeout(()=>document.querySelector('.topic-review')?.scrollIntoView({behavior:'smooth',block:'start'}),0)}
 function navigateToCitation(symbolId:string){const node=report?.overview.nodes.find(n=>n.id===symbolId)||report?.groups.flatMap(g=>g.graph.nodes).find(n=>n.id===symbolId);if(node)inspectArchitectureFile(node.path)}
 const available=models?.[harness as keyof Harnesses]
 const modelOptions=available?.models?.length?available.models.map(m=>({id:m.id,label:m.label})):harness==='claude'?(available?.aliases||['default','sonnet','opus','haiku']).map(id=>({id,label:id})):[]
 const selectedModel=available?.models.find(m=>m.id===model)
 const effortOptions=selectedModel?.efforts?.length?selectedModel.efforts:(available?.efforts||['low','medium','high'])
 const busy=job?.state==='running'||job?.state==='queued'
 return <div className="app">
  <aside className={'sidebar '+(!sidebar?'sidebar-hidden':'')}>
   <div className="brand"><div className="brand-icon"><Network size={22}/></div><div><strong>prism<span className="brand-period">.</span></strong><small>Structural PR review</small></div></div>
   <div className="sidebar-main">
    <div className="side-label">Workspace</div>
    <button className={!showHistory?'side-link active':'side-link'} onClick={()=>{setShowHistory(false);setShowSettings(false)}}><Layers3 size={18}/> Explorer</button>
    <button className={showHistory?'side-link active':'side-link'} onClick={()=>{setShowHistory(true);setShowSettings(false);refreshHistory()}}><Clock3 size={18}/> Recent reports <span className="side-count">{recent.length}</span></button>
    <div className="side-label side-label-section">Quick access</div>
    <button className="side-link" onClick={openAnalyzer}><Plus size={18}/> New analysis</button>
   </div>
   <div className="sidebar-footer">
    <div className="local-status"><span className="status-pulse"/><div><strong>Running locally</strong><small>127.0.0.1:{APP_PORT}</small></div><ShieldCheck size={18}/></div>
    <button className="side-link" onClick={()=>setShowSettings(v=>!v)}><Settings2 size={18}/> Configuration</button>
    <div className="version">PRISM / v0.2.0</div>
   </div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div className="topbar-left"><button className="icon-btn" onClick={()=>setSidebar(v=>!v)} aria-label="Toggle sidebar"><Menu size={19}/></button><span className="crumb">Workspace</span><ChevronRight size={14} className="muted"/><span className="crumb-current">{showSettings?'Configuration':showHistory?'Reports':report?.demo?'Example report':report?`PR #${report.meta.number}`:'Explorer'}</span></div><div className="topbar-right">{loading&&<LoaderCircle size={16} className="spinning"/>}{report&&!showSettings&&!showHistory&&<button className="topbar-action" onClick={()=>showAnalyzeForm?setShowAnalyzeForm(false):openAnalyzer()}>{showAnalyzeForm?<X size={14}/>:<Plus size={14}/>}<span>{showAnalyzeForm?'Close':'New analysis'}</span></button>}<span className="host-pill"><span className="status-pulse"/> Local instance</span><span className="avatar">PR</span></div></header>
   <main>
    {showSettings?<div className="settings-view"><div className="page-eyebrow"><Settings2 size={15}/> Configuration</div><h1>Configuration</h1><p>Harnesses run locally using your existing CLI login and credentials. Graphify and Tree-sitter are installed by the setup script.</p><div className="settings-card"><h3>AI harnesses</h3>{(['codex','claude'] as const).map(key=><div className="setting-row" key={key}><div className="setting-title"><Terminal size={18}/><div><strong>{display(key)}</strong><small>{models?.[key]?.discovery||'Checking...'}</small></div></div><span className={'status-tag '+(models?.[key]?.installed?'ok':'')}>{models?.[key]?.installed?'Detected':'Not detected'}</span></div>)}<button className="secondary-btn" onClick={()=>call<Harnesses>('/harnesses').then(setModels).catch(e=>setError(String(e)))}><RefreshCcw size={14}/> Re-detect CLIs</button></div><div className="settings-card"><h3>Runtime</h3><p>Bind address: <code>127.0.0.1</code> · Port: <code>{APP_PORT}</code></p><p>For another port, edit <code>PORT</code> in <code>.env</code> and restart the app.</p><p>AI prompts are sent to your selected CLI provider. Graphify structural indexing is local.</p></div></div>:
    showHistory?<div className="history-view"><div className="page-eyebrow"><Clock3 size={15}/> Recent reports</div><div className="history-head"><div><h1>Saved reports</h1><p>Reports are cached locally and ready to reopen.</p></div><button className="secondary-btn" onClick={refreshHistory}><RefreshCcw size={15}/> Refresh</button></div>{recent.length?recent.map(item=><button className="history-item" key={item.id} onClick={()=>loadReport(item.id)}><div className="history-icon"><GitPullRequest size={20}/></div><div className="history-meta"><strong>{item.meta.title}</strong><small>{item.meta.owner}/{item.meta.repo} · #{item.meta.number} · {prettyDate(item.created_at)}</small></div><span className="history-stats">{item.stats.changed_files} changed files</span><ChevronRight size={18}/></button>):<div className="empty-panel">No saved reports yet. Analyze a pull request to keep its review here.</div>}</div>:
    <>
     {!report&&<section className="hero-top"><div><div className="page-eyebrow"><GitBranch size={14}/> Local code review</div><h1>Understand the pull request.</h1><p>Follow how changes move through the code, then review the exact diff.</p></div></section>}
     {(!report||showAnalyzeForm)&&<section className={'analyze-box'+(report?' analyze-box-compact':'')}><div className="section-top"><div className="section-title"><GitPullRequest size={17}/><strong>Analyze a pull request</strong></div></div>
       <form onSubmit={e=>{e.preventDefault();begin()}} className="analyze-form"><div className="url-row"><div className="url-input-wrap"><GitPullRequest size={19}/><input id="pr-url" type="url" value={prUrl} onChange={e=>setPrUrl(e.target.value)} placeholder="https://github.com/owner/repository/pull/123" required/></div><button className="primary-btn" disabled={busy} type="submit">{busy?<LoaderCircle className="spinning" size={17}/>:<Play size={16} fill="currentColor"/>}<span>{busy?'Analyzing':'Analyze PR'}</span><ArrowRight size={16}/></button></div>
        <div className="analyze-options"><div className="form-field"><label>AI harness</label><div className="select-wrap"><select value={harness} onChange={e=>{setHarness(e.target.value);setModel('default');setEffort('default')}}><option value="none">Graph only (no AI)</option><option value="codex">Codex {models&&!models.codex.installed?'(not installed)':''}</option><option value="claude">Claude Code {models&&!models.claude.installed?'(not installed)':''}</option></select><ChevronDown size={15}/></div></div>
        {harness!=='none'&&<><div className="form-field"><label>Model</label><div className="select-wrap"><select value={modelOptions.some(m=>m.id===model)?model:'custom'} onChange={e=>setModel(e.target.value==='custom'?'':e.target.value)}><option value="default">CLI default</option>{modelOptions.filter(m=>m.id!=='default').map(m=><option key={m.id} value={m.id}>{m.label}</option>)}<option value="custom">Custom model ID…</option></select><ChevronDown size={15}/></div>{(!modelOptions.some(m=>m.id===model)&&model!== 'default')&&<input className="custom-model" placeholder="Enter CLI model ID" value={model} onChange={e=>setModel(e.target.value)}/>}</div><div className="form-field"><label>Reasoning effort</label><div className="select-wrap"><select value={effort} onChange={e=>setEffort(e.target.value)}><option value="default">CLI default</option>{effortOptions.map(e=><option key={e} value={e}>{e.charAt(0).toUpperCase()+e.slice(1)}</option>)}</select><ChevronDown size={15}/></div></div></>}
        <span className="analysis-caption"><ShieldCheck size={14}/> {harness==='none'?'Source extraction runs locally':'AI reads relevant source through the selected CLI'}</span></div>
       </form>
       {busy&&<div className="job-progress"><LoaderCircle className="spinning" size={16}/><span>{job?.message||'Preparing analysis...'}</span></div>}
       {error&&<div className="error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
     </section>}
     {!report&&recent.length>0&&<section className="home-recent" aria-label="Recent reports"><div className="home-recent-heading"><h2>Recent reports</h2><button onClick={()=>{setShowHistory(true);refreshHistory()}}>View all <ArrowRight size={13}/></button></div><div className="home-recent-list">{recent.slice(0,3).map(item=><button className="home-report" key={item.id} onClick={()=>loadReport(item.id)}><GitPullRequest size={16}/><span className="home-report-copy"><strong>{item.meta.title}</strong><small>{item.meta.owner}/{item.meta.repo} · #{item.meta.number}</small></span><span className="home-report-count">{item.stats.changed_files} changed files</span><ChevronRight size={15}/></button>)}</div></section>}
     {report&&<section className="report-section">
      <div className="report-header"><div><div className="section-topline"><span className="eyebrow">{report.demo?'Example report':`${report.meta.owner}/${report.meta.repo} · PR #${report.meta.number}`}</span>{report.demo?<span className="demo-tag">Sample data</span>:<span className="real-tag"><CheckCircle2 size={12}/> Ready to review</span>}</div><h2>{report.meta.title}</h2><div className="report-meta"><span><Clock3 size={14}/> Analyzed {prettyDate(report.created_at)}</span></div></div><div className="report-buttons">{!report.demo&&<button className="small-btn" onClick={copyLink}>{copied?<Check size={15}/>:<Copy size={15}/>}<span>{copied?'Copied':'Copy link'}</span></button>}<button className="small-btn" onClick={download}><Download size={15}/> Export JSON</button>{!report.demo&&<a className="small-btn" href={report.meta.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/> GitHub</a>}</div></div>
      <div className="report-facts" aria-label="Pull request change totals"><span><strong>{report.stats.changed_files}</strong> changed files</span><span><strong>{topics.length}</strong> review {topics.length===1?'topic':'topics'}</span>{!report.demo&&<div className="report-review-controls"><span className={'github-viewed-summary'+(viewedFiles?.available?'':' unavailable')} title={viewedFiles?.reason||''}>{viewedFilesLoading?'Checking GitHub…':viewedFiles?.available?`${viewedCount} of ${reportPaths.length} viewed in GitHub`:'GitHub viewed status unavailable'}</span><button className="github-viewed-refresh" type="button" aria-label="Refresh viewed file status from GitHub" title="Refresh status from GitHub" disabled={viewedFilesLoading} onClick={refreshViewedStatus}><RefreshCcw size={13}/></button><label className={'review-viewed-toggle'+(hideViewedFiles?' active':'')} title={viewedFiles?.available?'Hide files already marked viewed in GitHub':viewedFiles?.reason||'Install GitHub CLI and sign in with gh auth login'}><input type="checkbox" aria-label="Hide files viewed in GitHub" checked={hideViewedFiles} onChange={event=>setHideViewedFiles(event.target.checked)} disabled={!viewedFiles?.available}/><EyeOff size={14}/><span>Hide viewed</span><b>{viewedCount}</b></label></div>}</div>
      {!report.demo&&<ReviewQuestionPanel report={report} harnesses={models} assistant={reviewAssistant} onAssistantChange={setReviewAssistant} onCitationClick={navigateToCitation}/>}
      <div className="section-heading"><div><h3>Review workspace</h3><p>Orient in the architecture. Review changes by topic.</p></div><div className="graph-meta"><span className="status-pulse"/> Source-backed relationships</div></div>
      {report.architecture&&<div className="architecture-view-switch" aria-label="Change map view"><button className={mapView==='architecture'?'active':''} onClick={()=>setMapView('architecture')}><Layers3 size={15}/> Architecture</button><button className={mapView==='topics'?'active':''} onClick={()=>setMapView('topics')}><FileCode2 size={15}/> Topics</button><span>Understand the connections, then review the files</span></div>}
      {report.architecture&&<div className="architecture-view-panel" hidden={mapView!=='architecture'}><ArchitectureMap data={report.architecture} hiddenPaths={architectureHiddenPaths} onOpenFile={inspectArchitectureFile} assistant={reviewAssistant} harnesses={models} onAssistantChange={setReviewAssistant} onDiscover={discoverArchitecture} busy={!!busy} progress={job?.message||''} error={error}/></div>}
      <div className="topics-view-panel" hidden={!!report.architecture&&mapView!=='topics'}><TopicReview report={report} assistant={reviewAssistant} harnesses={models} onAssistantChange={setReviewAssistant} viewedAvailable={!!viewedFiles?.available} viewedStates={viewedFiles?.states||{}} viewedBusy={viewedFileBusy} viewedError={viewedFilesError} onToggleViewed={toggleViewedFile} hideViewed={hideViewedFiles} onShowViewed={()=>setHideViewedFiles(false)} focusPath={reviewFocus?.path||null} focusRequest={reviewFocus?.request||0}/></div>
      {report.ai&&<details className="pr-review-brief"><summary>Pull request brief <ChevronDown size={14}/></summary>{report.ai.overview&&<MarkdownContent text={report.ai.overview}/>} {!!report.ai.key_changes?.length&&<ul>{report.ai.key_changes.map((change,i)=><li key={i}><MarkdownContent text={change}/></li>)}</ul>}</details>}
      {!report.ai&&!report.demo&&<div className="review-summary-empty"><p>File diffs are ready. Generate review notes to add change summaries and a suggested reading order.</p><button type="button" className="secondary-btn" disabled={busy||harness==='none'} onClick={explain}><Sparkles size={14}/> Generate review notes</button></div>}

     </section>}
    </>}
   </main>
   <footer className="footer"><span><span className="footer-dot"/> Local-first code intelligence</span><span>Prism v0.2.0 · Built for Linux & macOS</span></footer>
  </div>
 </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>)
