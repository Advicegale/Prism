import {StrictMode,useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ArrowRight,Check,CheckCircle2,ChevronRight,Clock3,Copy,Download,EyeOff,ExternalLink,FileCode2,GitBranch,GitPullRequest,Layers3,LoaderCircle,Menu,Network,Play,Plus,RefreshCcw,Settings2,ShieldCheck,Sparkles,Square,Terminal,X,AlertCircle} from 'lucide-react'
import {ArchitectureMap} from './components/ArchitectureMap'
import {TopicReview} from './components/TopicReview'
import {ReviewQuestionPanel} from './components/ReviewQuestionPanel'
import {ReportBrief} from './components/ReportBrief'
import {AskShell} from './components/AskShell'
import {AssistantMenu} from './components/AssistantMenu'
import type { Harnesses,Job,Report,ViewedFiles } from './types'
import {documentTitle,formatRoute,parseRoute} from './routes'
import type {Route} from './routes'
import {DEFAULT_ASSISTANT,assistantSummary,installedFallback,loadAssistantState,saveAssistantState,type AssistantSetting,type AssistantState} from './assistantSettings'
import {analysisDurationTooltip} from './analysisTiming'
import './styles.css'

const API='/api'
async function call<T>(path:string,options?:RequestInit):Promise<T>{
 const res=await fetch(API+path,{...options,headers:{'Content-Type':'application/json',...options?.headers}})
 if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(typeof data.detail==='string'?data.detail:`Request failed (${res.status})`)}
 return res.json() as Promise<T>
}
const display=(val:string)=>val==='claude'?'Claude Code':val==='codex'?'Codex':'Graph only'
const APP_PORT=window.location.port||'4780'
function prettyDate(date:string){try{return new Date(date).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch{return date}}
function AiStatus({hasAi}:{hasAi:boolean}){return <span className={'ai-status '+(hasAi?'has-ai':'graph-only')} title={hasAi?'Saved with AI change notes and reading order':'Structure and diffs only; generate review notes inside the report'}>{hasAi?'AI notes':'Graph only'}</span>}
function reportPathFor(report:Report|null|undefined,path:string){
 const file=report?.files.find(item=>item.path===path||item.old_path===path)
 return file?.path||file?.old_path||path
}

function App(){
 const [htmlExportBusy,setHtmlExportBusy]=useState(false)
 const [htmlExportError,setHtmlExportError]=useState('')
 const [report,setReport]=useState<Report|null>(null)
 const [route,setRoute]=useState<Route>(()=>parseRoute(window.location.hash))
 const [settledRoute,setSettledRoute]=useState<Route>({name:'home'})
 const routeRef=useRef<Route>(route)
 const mainRouteRef=useRef<Route>(route.name==='settings'?{name:'home'}:route)
 const loadToken=useRef(0)
 const loadingIdRef=useRef<string|null>(null)
 const [reviewFocus,setReviewFocus]=useState<{path:string;request:number}|null>(null)
 const [viewedFiles,setViewedFiles]=useState<ViewedFiles|null>(null)
 const [viewedFilesLoading,setViewedFilesLoading]=useState(false)
 const [viewedFileBusy,setViewedFileBusy]=useState<Set<string>>(()=>new Set())
 const [viewedFilesError,setViewedFilesError]=useState('')
 const [hideViewedFiles,setHideViewedFiles]=useState(()=>localStorage.getItem('prism:hide-viewed')==='true')
 const [prUrl,setPrUrl]=useState('')
 const [models,setModels]=useState<Harnesses|null>(null)
 const [assistantState,setAssistantState]=useState<AssistantState>(()=>{try{return loadAssistantState(localStorage)}catch{return {assistant:{...DEFAULT_ASSISTANT},analyzeWithAi:false}}})
 const {assistant,analyzeWithAi}=assistantState
 const setAssistant=(next:AssistantSetting)=>setAssistantState(current=>({...current,assistant:next}))
 const [outlineOnly,setOutlineOnlyState]=useState(()=>{try{return localStorage.getItem('prism:outline-only')==='true'}catch{return false}})
 const setOutlineOnly=(value:boolean)=>{setOutlineOnlyState(value);try{localStorage.setItem('prism:outline-only',String(value))}catch{}}
 const setAnalyzeWithAi=(value:boolean)=>setAssistantState(current=>({...current,analyzeWithAi:value}))
 const [assistantOpen,setAssistantOpen]=useState(false)
 const assistantReady=!!models?.[assistant.harness]?.installed
 const [job,setJob]=useState<Job|null>(null)
 const [error,setError]=useState('')
 const [sidebar,setSidebar]=useState(()=>window.innerWidth>900)
 const [recent,setRecent]=useState<{id:string;meta:Report['meta'];stats:Report['stats'];created_at:string;has_ai:boolean}[]>([])
 const [loading,setLoading]=useState(false)
 const [showAnalyzeForm,setShowAnalyzeForm]=useState(false)
 const [copied,setCopied]=useState(false)
 const [focusMode,setFocusMode]=useState(false)
 const poll=useRef<ReturnType<typeof setInterval>|null>(null)
 const watchedJob=useRef<string|null>(null)
 const reportIdRef=useRef<string|null>(null)
 reportIdRef.current=report?.id||null
 const routeReportId=route.name==='report'?route.id:null
 const reportReady=route.name!=='report'||report?.id===route.id
 const shown:Route=reportReady?route:settledRoute
 const showHistory=shown.name==='history',showSettings=shown.name==='settings'
 const mapView:'architecture'|'topics'=shown.name==='report'?shown.view:'architecture'
 const explorerRoute:Route=report&&!report.demo?{name:'report',id:report.id,view:mapView}:{name:'home'}
 useEffect(()=>{if(reportReady)setSettledRoute(route)},[reportReady,route])
 useEffect(()=>{
  const onHash=()=>{
   const next=parseRoute(window.location.hash),previous=routeRef.current
   const file=next.name==='report'?next.file:undefined
   if(file&&(previous.name!=='report'||previous.file!==file))setReviewFocus(current=>({path:file,request:(current?.request||0)+1}))
   applyRoute(next)
  }
  window.addEventListener('hashchange',onHash);window.addEventListener('popstate',onHash)
  return()=>{window.removeEventListener('hashchange',onHash);window.removeEventListener('popstate',onHash)}
 },[])
 useEffect(()=>{
  if(routeReportId&&loadingIdRef.current===routeReportId)return
  if(loadingIdRef.current){loadToken.current++;loadingIdRef.current=null;setLoading(false)}
  if(routeReportId&&reportIdRef.current!==routeReportId)loadReport(routeReportId)
 },[routeReportId])
 useEffect(()=>{if(shown.name==='history')refreshHistory()},[shown.name])
 useEffect(()=>{document.title=documentTitle(shown,report&&shown.name==='report'&&report.id===shown.id?{repo:report.meta.repo,number:report.meta.number}:null)},[shown,report])
 useEffect(()=>{
  call<Harnesses>('/harnesses').then(setModels).catch(()=>{})
  refreshHistory()
  return()=>{if(poll.current)clearInterval(poll.current)}
 },[])
 useEffect(()=>{const syncSidebar=()=>setSidebar(window.innerWidth>900);window.addEventListener('resize',syncSidebar);return()=>window.removeEventListener('resize',syncSidebar)},[])
 useEffect(()=>setFocusMode(false),[report?.id,mapView,shown.name])
 useEffect(()=>{
  if(!focusMode)return
  const onKey=(event:KeyboardEvent)=>{
   if(event.key!=='Escape'||event.defaultPrevented)return
   const active=document.activeElement
   if(active instanceof HTMLElement&&(active.matches('input,textarea,select')||active.isContentEditable))return
   if(document.querySelector('.symbol-exploration,.reading-help'))return
   setFocusMode(false)
  }
  document.addEventListener('keydown',onKey)
  return()=>document.removeEventListener('keydown',onKey)
 },[focusMode])
 useEffect(()=>{try{saveAssistantState(localStorage,assistantState)}catch{/* Storage can be unavailable; the choice still applies for this session. */}},[assistantState])
 useEffect(()=>{if(!models)return;const next=installedFallback(assistant,models);if(next)setAssistant(next)},[models,assistant])
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
 function applyRoute(next:Route){routeRef.current=next;if(next.name!=='settings')mainRouteRef.current=next;setRoute(current=>formatRoute(current)===formatRoute(next)?current:next)}
 function navigate(next:Route){const hash=formatRoute(next);if(window.location.hash!==hash)window.location.hash=hash;applyRoute(next)}
 function replaceRoute(next:Route){window.history.replaceState(null,'',formatRoute(next));applyRoute(next)}
 function changeFile(path:string){const current=routeRef.current;if(current.name==='report')replaceRoute({name:'report',id:current.id,view:'topics',file:path})}
 async function loadReport(id:string){
  const token=++loadToken.current;loadingIdRef.current=id;setLoading(true);setError('')
  try{
   const next=await call<Report>('/reports/'+id)
   if(token!==loadToken.current)return
   setReport(next);setShowAnalyzeForm(false)
   if(next.analysis?.state==='running'&&watchedJob.current!==next.analysis.job_id)void watchJob(next.analysis.job_id)
   const current=parseRoute(window.location.hash),file=current.name==='report'&&current.id===id?current.file:undefined
   setReviewFocus(focus=>file?{path:file,request:(focus?.request||0)+1}:null)
   if(file&&current.name==='report'&&current.view==='architecture')replaceRoute({...current,view:'topics'})
  }catch(cause){
   if(token!==loadToken.current)return
   setReport(null);setError(cause instanceof Error?cause.message:String(cause))
   const current=parseRoute(window.location.hash)
   if(current.name==='report'&&current.id===id)replaceRoute({name:'home'})
  }finally{if(token===loadToken.current){loadingIdRef.current=null;setLoading(false)}}
 }
 async function watchJob(id:string,openWhenReady=false){
  if(poll.current)clearInterval(poll.current)
  watchedJob.current=id
  let inFlight=false,opened=false
  const update=async()=>{
   if(inFlight||watchedJob.current!==id)return
   inFlight=true
   try{
    const current=await call<Job>('/jobs/'+id)
    if(watchedJob.current!==id)return
    setJob(current)
    if(current.report_id){
     if(openWhenReady&&!opened){
      opened=true;setShowAnalyzeForm(false)
      navigate({name:'report',id:current.report_id,view:'topics'})
     }
     const route=routeRef.current
     if(route.name==='report'&&route.id===current.report_id){
      const next=await call<Report>('/reports/'+current.report_id)
      if(watchedJob.current!==id)return
      const latest=routeRef.current
      if(latest.name==='report'&&latest.id===next.id)setReport(previous=>previous?.id===next.id&&previous.revision&&previous.revision===next.revision?previous:next)
     }
    }
    if(current.state==='completed'||current.state==='failed'||current.state==='cancelled'){
     if(poll.current)clearInterval(poll.current);poll.current=null;watchedJob.current=null
     if(current.state==='failed')setError(current.error||'Analysis failed')
     await refreshHistory()
    }
   }catch(e){if(watchedJob.current===id){if(poll.current)clearInterval(poll.current);poll.current=null;watchedJob.current=null;setError(String(e))}}
   finally{inFlight=false}
  }
  poll.current=setInterval(update,1400)
  await update()
 }

 async function begin(){
  setError('');setJob(null)
  try{const result=await call<{job_id:string}>('/analyze',{method:'POST',body:JSON.stringify({url:prUrl,harness:analyzeWithAi?assistant.harness:'none',model:assistant.model,effort:assistant.effort,scope:analyzeWithAi&&outlineOnly?'outline':'full'})});await watchJob(result.job_id,true)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }
 async function explain(scope:'full'|'outline'='full'){
  if(!report||report.demo||!assistantReady)return
  setError('');setJob(null)
  try{const result=await call<{job_id:string}>(`/reports/${report.id}/explain`,{method:'POST',body:JSON.stringify({...assistant,scope})});await watchJob(result.job_id)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }
 async function stopJob(){
  const id=job?.id||watchedJob.current
  if(!id)return
  try{setJob(await call<Job>(`/jobs/${id}/cancel`,{method:'POST'}))}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }
 async function redetectHarnesses(){try{setModels(await call<Harnesses>('/harnesses'));return true}catch{return false}}
 async function discoverArchitecture(){
  if(!report||report.demo)return
  setError('');setJob(null)
  try{const result=await call<{job_id:string}>(`/reports/${report.id}/architecture`,{method:'POST',body:JSON.stringify(assistant)});await watchJob(result.job_id)}
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
 async function downloadHtml(){if(!report||htmlExportBusy)return;setHtmlExportBusy(true);setHtmlExportError('');try{const {createHtmlReport,htmlReportFilename}=await import('./htmlExport');const html=await createHtmlReport(report);const href=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=href;a.download=htmlReportFilename(report);a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}catch(cause){setHtmlExportError('Could not export HTML. '+String(cause))}finally{setHtmlExportBusy(false)}}
 function copyLink(){if(!report)return;navigator.clipboard?.writeText(window.location.origin+window.location.pathname+window.location.hash).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1800)}).catch(()=>{})}
 function openAnalyzer(){if(showHistory||showSettings)navigate({name:'home'});setShowAnalyzeForm(true);window.setTimeout(()=>document.getElementById('pr-url')?.focus(),0)}
 const topics=report?.ai?.topics?.length?report.ai.topics:report?.topics||[]
 const reportPaths=Array.from(new Set((report?.files||[]).map(file=>file.path||file.old_path).filter((path):path is string=>!!path)))
 const viewedCount=reportPaths.filter(path=>viewedFiles?.states[path]==='VIEWED').length
 const architectureHiddenPaths=useMemo(()=>new Set(hideViewedFiles?reportPaths.filter(path=>viewedFiles?.states[path]==='VIEWED'):[]),[report,hideViewedFiles,viewedFiles])
 function inspectArchitectureFile(path:string){const file=reportPathFor(report,path);setHideViewedFiles(false);setReviewFocus(current=>({path:file,request:(current?.request||0)+1}));if(report&&!report.demo)navigate({name:'report',id:report.id,view:'topics',file});window.setTimeout(()=>document.querySelector('.topic-review')?.scrollIntoView({behavior:'smooth',block:'start'}),0)}
 function navigateToCitation(symbolId:string){const node=report?.overview.nodes.find(n=>n.id===symbolId)||report?.groups.flatMap(g=>g.graph.nodes).find(n=>n.id===symbolId);if(node)inspectArchitectureFile(node.path)}
 const busy=job?.state==='running'||job?.state==='queued'||job?.state==='cancelling'
 const stopping=job?.state==='cancelling'
 const stopButton=<button type="button" className="small-btn stop-btn" disabled={stopping} onClick={stopJob}><Square size={13}/> {stopping?'Stopping…':'Stop'}</button>
 return <div className={'app'+(focusMode?' focus-mode':'')}>
  <aside className={'sidebar '+(!sidebar||focusMode?'sidebar-hidden':'')}>
   <div className="brand"><div className="brand-icon"><Network size={22}/></div><div><strong>prism<span className="brand-period">.</span></strong><small>Structural PR review</small></div></div>
   <div className="sidebar-main">
    <div className="side-label">Workspace</div>
    <button className={!showHistory&&!showSettings?'side-link active':'side-link'} onClick={()=>navigate(explorerRoute)}><Layers3 size={18}/> Explorer</button>
    <button className={showHistory?'side-link active':'side-link'} onClick={()=>navigate({name:'history'})}><Clock3 size={18}/> Recent reports <span className="side-count">{recent.length}</span></button>
    <div className="side-label side-label-section">Quick access</div>
    <button className="side-link" onClick={openAnalyzer}><Plus size={18}/> New analysis</button>
   </div>
   <div className="sidebar-footer">
    <div className="local-status"><span className="status-pulse"/><div><strong>Running locally</strong><small>127.0.0.1:{APP_PORT}</small></div><ShieldCheck size={18}/></div>
    <button className={showSettings?'side-link active':'side-link'} onClick={()=>showSettings?navigate(mainRouteRef.current):navigate({name:'settings'})}><Settings2 size={18}/> Configuration</button>
    <div className="version">PRISM / v0.2.0</div>
   </div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div className="topbar-left"><button className="icon-btn" onClick={()=>setSidebar(v=>!v)} aria-label="Toggle sidebar"><Menu size={19}/></button><span className="crumb">Workspace</span><ChevronRight size={14} className="muted"/><span className="crumb-current">{focusMode&&report&&!showSettings&&!showHistory?`Focus mode · ${report.demo?'Example report':`PR #${report.meta.number}`}`:showSettings?'Configuration':showHistory?'Reports':report?.demo?'Example report':report?`PR #${report.meta.number}`:'Explorer'}</span></div><div className="topbar-right">{loading&&<LoaderCircle size={16} className="spinning"/>}{report&&!showSettings&&!showHistory&&<button className="topbar-action" onClick={()=>showAnalyzeForm?setShowAnalyzeForm(false):openAnalyzer()}>{showAnalyzeForm?<X size={14}/>:<Plus size={14}/>}<span>{showAnalyzeForm?'Close':'New analysis'}</span></button>}<AssistantMenu assistant={assistant} harnesses={models} open={assistantOpen} onOpenChange={setAssistantOpen} onChange={setAssistant} onRedetect={redetectHarnesses}/><span className="host-pill"><span className="status-pulse"/> Local instance</span><span className="avatar">PR</span></div></header>
   <main>
    {showSettings?<div className="settings-view"><div className="page-eyebrow"><Settings2 size={15}/> Configuration</div><h1>Configuration</h1><p>Harnesses run locally using your existing CLI login and credentials. Graphify and Tree-sitter are installed by the setup script.</p><div className="settings-card"><h3>AI harnesses</h3>{(['codex','claude'] as const).map(key=><div className="setting-row" key={key}><div className="setting-title"><Terminal size={18}/><div><strong>{display(key)}</strong><small>{models?.[key]?.discovery||'Checking...'}</small></div></div><span className={'status-tag '+(models?.[key]?.installed?'ok':'')}>{models?.[key]?.installed?'Detected':'Not detected'}</span></div>)}<button className="secondary-btn" onClick={()=>call<Harnesses>('/harnesses').then(setModels).catch(e=>setError(String(e)))}><RefreshCcw size={14}/> Re-detect CLIs</button></div><div className="settings-card"><h3>Runtime</h3><p>Bind address: <code>127.0.0.1</code> · Port: <code>{APP_PORT}</code></p><p>For another port, edit <code>PORT</code> in <code>.env</code> and restart the app.</p><p>AI prompts are sent to your selected CLI provider. Graphify structural indexing is local.</p></div></div>:
    showHistory?<div className="history-view"><div className="page-eyebrow"><Clock3 size={15}/> Recent reports</div><div className="history-head"><div><h1>Saved reports</h1><p>Reports are cached locally and ready to reopen.</p></div><button className="secondary-btn" onClick={refreshHistory}><RefreshCcw size={15}/> Refresh</button></div>{recent.length?recent.map(item=><button className="history-item" key={item.id} onClick={()=>navigate({name:'report',id:item.id,view:'architecture'})}><div className="history-icon"><GitPullRequest size={20}/></div><div className="history-meta"><strong>{item.meta.title}</strong><small>{item.meta.owner}/{item.meta.repo} · #{item.meta.number} · {prettyDate(item.created_at)}</small></div><span className="history-stats">{item.stats.changed_files} changed files</span><AiStatus hasAi={item.has_ai}/><ChevronRight size={18}/></button>):<div className="empty-panel">No saved reports yet. Analyze a pull request to keep its review here.</div>}</div>:
    <>
     {!report&&<section className="hero-top"><div><div className="page-eyebrow"><GitBranch size={14}/> Local code review</div><h1>Understand the pull request.</h1><p>Follow how changes move through the code, then review the exact diff.</p></div></section>}
     {(!report||showAnalyzeForm)&&<section className={'analyze-box'+(report?' analyze-box-compact':'')}><div className="section-top"><div className="section-title"><GitPullRequest size={17}/><strong>Analyze a pull request</strong></div></div>
       <form onSubmit={e=>{e.preventDefault();begin()}} className="analyze-form"><div className="url-row"><div className="url-input-wrap"><GitPullRequest size={19}/><input id="pr-url" type="url" aria-label="Pull request URL" value={prUrl} onChange={e=>setPrUrl(e.target.value)} placeholder="https://github.com/owner/repository/pull/123" required/></div><button className="primary-btn" disabled={busy} type="submit">{busy?<LoaderCircle className="spinning" size={17}/>:<Play size={16} fill="currentColor"/>}<span>{busy?'Analyzing':'Analyze PR'}</span><ArrowRight size={16}/></button></div>
        <div className="analyze-options"><div className="analyze-ai-row"><label className="analyze-ai-toggle"><input type="checkbox" checked={analyzeWithAi} onChange={e=>setAnalyzeWithAi(e.target.checked)}/><span>Generate AI review notes</span></label><button type="button" className="assistant-summary" onClick={()=>setAssistantOpen(true)} aria-haspopup="dialog" aria-expanded={assistantOpen} title="Change the assistant"><Sparkles size={13}/><span>Using {assistantSummary(assistant)}</span></button></div>
        <label className={'analyze-ai-toggle'+(analyzeWithAi?'':' disabled')} title="Skip detailed per-topic and per-file notes and the architecture pass"><input type="checkbox" checked={outlineOnly} disabled={!analyzeWithAi} onChange={e=>setOutlineOnly(e.target.checked)}/><span>Topics and reading order only</span></label>
        <span className="analysis-caption"><ShieldCheck size={14}/> {analyzeWithAi?'AI reads relevant source through the selected CLI':'Source extraction runs locally'}</span></div>
       </form>
       {busy&&<div className="job-progress"><LoaderCircle className="spinning" size={16}/><span>{job?.message||'Preparing analysis...'}</span>{stopButton}</div>}
       {error&&<div className="error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
     </section>}
     {!report&&recent.length>0&&<section className="home-recent" aria-label="Recent reports"><div className="home-recent-heading"><h2>Recent reports</h2><button onClick={()=>navigate({name:'history'})}>View all <ArrowRight size={13}/></button></div><div className="home-recent-list">{recent.slice(0,3).map(item=><button className="home-report" key={item.id} onClick={()=>navigate({name:'report',id:item.id,view:'architecture'})}><GitPullRequest size={16}/><span className="home-report-copy"><strong>{item.meta.title}</strong><small>{item.meta.owner}/{item.meta.repo} · #{item.meta.number} · {prettyDate(item.created_at)}</small></span><span className="home-report-count">{item.stats.changed_files} changed files</span><AiStatus hasAi={item.has_ai}/><ChevronRight size={15}/></button>)}</div></section>}
     {report&&<section className="report-section">
      <div className="report-header"><div><div className="section-topline"><span className="eyebrow">{report.demo?'Example report':`${report.meta.owner}/${report.meta.repo} · PR #${report.meta.number}`}</span>{report.demo?<span className="demo-tag">Sample data</span>:<span className="real-tag"><CheckCircle2 size={12}/> Ready to review</span>}</div><h2>{report.meta.title}</h2><div className="report-meta"><span title={analysisDurationTooltip(report)} tabIndex={0} aria-label={`Analyzed ${prettyDate(report.analysis_timings?.started_at||report.created_at)}. ${analysisDurationTooltip(report).replace(/\n/g, '. ')}`} style={{cursor:'help'}}><Clock3 size={14}/> Analyzed {prettyDate(report.analysis_timings?.started_at||report.created_at)}</span></div></div><div className="report-buttons">{!report.demo&&<button className="small-btn" onClick={copyLink} title="Copy a link to this view">{copied?<Check size={15}/>:<Copy size={15}/>}<span>{copied?'Copied':'Copy link'}</span></button>}<button className="small-btn" onClick={downloadHtml} disabled={htmlExportBusy}>{htmlExportBusy?<LoaderCircle className="spinning" size={15}/>:<Download size={15}/>} {htmlExportBusy?'Exporting…':'Export HTML'}</button><button className="small-btn" onClick={download}><Download size={15}/> Export JSON</button>{!report.demo&&<a className="small-btn" href={report.meta.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/> GitHub</a>}</div></div>
      {htmlExportError&&<p className="error-banner" role="alert">{htmlExportError}</p>}
      <div className="report-facts" aria-label="Pull request change totals"><span><strong>{report.stats.changed_files}</strong> changed files</span><span><strong>{topics.length}</strong> review {topics.length===1?'topic':'topics'}</span>{!report.demo&&<div className="report-review-controls"><span className={'github-viewed-summary'+(viewedFiles?.available?'':' unavailable')} title={viewedFiles?.reason||''}>{viewedFilesLoading?'Checking GitHub…':viewedFiles?.available?`${viewedCount} of ${reportPaths.length} viewed in GitHub`:'GitHub viewed status unavailable'}</span><button className="github-viewed-refresh" type="button" aria-label="Refresh viewed file status from GitHub" title="Refresh status from GitHub" disabled={viewedFilesLoading} onClick={refreshViewedStatus}><RefreshCcw size={13}/></button><label className={'review-viewed-toggle'+(hideViewedFiles?' active':'')} title={viewedFiles?.available?'Hide files already marked viewed in GitHub':viewedFiles?.reason||'Install GitHub CLI and sign in with gh auth login'}><input type="checkbox" aria-label="Hide files viewed in GitHub" checked={hideViewedFiles} onChange={event=>setHideViewedFiles(event.target.checked)} disabled={!viewedFiles?.available}/><EyeOff size={14}/><span>Hide viewed</span><b>{viewedCount}</b></label></div>}</div>
      {report.analysis?.state==='running'&&<div className="job-progress" role="status"><LoaderCircle className="spinning" size={16}/><span>{job?.message||'Analysis continues in the background'}. You can review now; feedback follows the suggested topic order.</span>{stopButton}</div>}
      {report.analysis?.state==='cancelled'&&<p className="error-banner" role="status">Analysis stopped. Anything already generated is saved. <button type="button" className="small-btn" disabled={!!busy||!assistantReady} onClick={()=>explain()}>Generate full notes</button></p>}
      {report.analysis?.state==='failed'&&<p className="error-banner" role="alert">{report.analysis.error||'Analysis stopped.'} Saved feedback is available. <button type="button" className="small-btn" disabled={!!busy||!assistantReady} onClick={()=>explain()}>Regenerate review notes</button></p>}
      <ReportBrief key={'brief-'+report.id} report={report} busy={!!busy} canGenerate={assistantReady} onGenerate={()=>explain()} onGenerateOutline={()=>explain('outline')}/>
      {!report.demo&&<AskShell key={'ask-'+report.id}><ReviewQuestionPanel report={report} harnesses={models} assistant={assistant} onOpenAssistant={()=>setAssistantOpen(true)} onCitationClick={navigateToCitation}/></AskShell>}
      <div className="section-heading"><div><h3>Review workspace</h3><p>Orient in the architecture. Review changes by topic.</p></div><div className="graph-meta"><span className="status-pulse"/> {report.architecture?.method==='manifest'?'Changed files · explore for relationships':'Source-backed relationships'}</div></div>
      {report.architecture&&<div className="architecture-view-switch" aria-label="Change map view"><button className={mapView==='architecture'?'active':''} onClick={()=>navigate({name:'report',id:report.id,view:'architecture'})}><Layers3 size={15}/> Architecture</button><button className={mapView==='topics'?'active':''} onClick={()=>navigate({name:'report',id:report.id,view:'topics'})}><FileCode2 size={15}/> Topics</button><span>Understand the connections, then review the files</span></div>}
      {report.architecture&&<div className="architecture-view-panel" hidden={mapView!=='architecture'}><ArchitectureMap data={report.architecture} hiddenPaths={architectureHiddenPaths} onOpenFile={inspectArchitectureFile} assistant={assistant} harnesses={models} onOpenAssistant={()=>setAssistantOpen(true)} onDiscover={discoverArchitecture} busy={!!busy} progress={job?.message||''} error={error}/></div>}
      <div className="topics-view-panel" hidden={!!report.architecture&&mapView!=='topics'}><TopicReview key={report.id} report={report} assistant={assistant} harnesses={models} onAssistantChange={setAssistant} viewedAvailable={!!viewedFiles?.available} viewedStates={viewedFiles?.states||{}} viewedBusy={viewedFileBusy} viewedError={viewedFilesError} onToggleViewed={toggleViewedFile} hideViewed={hideViewedFiles} onShowViewed={()=>setHideViewedFiles(false)} focusPath={reviewFocus?.path||null} focusRequest={reviewFocus?.request||0} active={mapView==='topics'||!report.architecture} focusMode={focusMode} onToggleFocus={()=>setFocusMode(value=>!value)} onFileChange={changeFile}/></div>

     </section>}
    </>}
   </main>
   <footer className="footer"><span><span className="footer-dot"/> Local-first code intelligence</span><span>Prism v0.2.0 · Built for Linux & macOS</span></footer>
  </div>
 </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>)
