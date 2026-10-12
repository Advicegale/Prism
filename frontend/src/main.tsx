import {StrictMode,useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Activity,ArrowDownRight,ArrowLeft,ArrowRight,Braces,Check,CheckCircle2,ChevronDown,ChevronRight,Clock3,Code2,Copy,Download,EyeOff,ExternalLink,FileCode2,GitBranch,GitCompareArrows,GitPullRequest, Layers3, LoaderCircle, Menu, Network, PanelRightClose, PanelRightOpen, Play, Plus, RefreshCcw, Search, Settings2, ShieldCheck, Sparkles, Terminal, X, AlertCircle} from 'lucide-react'
import {GraphCanvas} from './components/GraphCanvas'
import {CodeDiff} from './components/CodeDiff'
import {DetailedReport} from './components/DetailedReport'
import {buildGroupDisplayTitles} from './groupTitles'
import type { GraphLayout,Harnesses,Job,Report } from './types'
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

function App(){
 const [report,setReport]=useState<Report|null>(null)
 const [mode,setMode]=useState<'overview'|'group'>('overview')
 const [groupId,setGroupId]=useState('')
 const [selected,setSelected]=useState<string|null>(null)
 const [search,setSearch]=useState('')
 const [graphLayout,setGraphLayout]=useState<GraphLayout>(()=>{
  const saved=localStorage.getItem('prism:graph-layout')
  return saved==='tree'||saved==='roles'?saved:'network'
 })
 const [hideUnchanged,setHideUnchanged]=useState(()=>localStorage.getItem('prism:hide-unchanged')==='true')
 const [prUrl,setPrUrl]=useState('')
 const [harness,setHarness]=useState(pick('harness','none'))
 const [model,setModel]=useState(pick('model','default'))
 const [effort,setEffort]=useState(pick('effort','default'))
 const [models,setModels]=useState<Harnesses|null>(null)
 const [job,setJob]=useState<Job|null>(null)
 const [error,setError]=useState('')
 const [sidebar,setSidebar]=useState(true)
 const [details,setDetails]=useState(true)
 const [showSettings,setShowSettings]=useState(false)
 const [recent,setRecent]=useState<{id:string;meta:Report['meta'];stats:Report['stats'];created_at:string;has_ai:boolean}[]>([])
 const [loading,setLoading]=useState(false)
 const [showHistory,setShowHistory]=useState(false)
 const [copied,setCopied]=useState(false)
 const poll=useRef<ReturnType<typeof setInterval>|null>(null)
 const groupTitles=useMemo(()=>buildGroupDisplayTitles(report?.groups||[]),[report?.groups])
 useEffect(()=>{
  call<Harnesses>('/harnesses').then(setModels).catch(()=>{})
  refreshHistory()
  return()=>{if(poll.current)clearInterval(poll.current)}
 },[])
 useEffect(()=>{localStorage.setItem('prism:harness',harness);localStorage.setItem('prism:model',model);localStorage.setItem('prism:effort',effort);localStorage.setItem('prism:graph-layout',graphLayout);localStorage.setItem('prism:hide-unchanged',String(hideUnchanged))},[harness,model,effort,graphLayout,hideUnchanged])
 async function refreshHistory(){try{setRecent(await call('/reports'))}catch{/* backend not started */}}
 async function loadReport(id:string){setLoading(true);setError('');try{setReport(await call<Report>('/reports/'+id));setGroupId('');setMode('overview');setSelected(null);setShowHistory(false)}catch(e){setError(String(e))}finally{setLoading(false)}}
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
 function download(){if(!report)return;const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download=`prism-pr-${report.demo?'demo':report.meta.number}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
 function copyLink(){if(!report)return;navigator.clipboard?.writeText(report.meta.url||window.location.href).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1800)}).catch(()=>{})}
 function selectGroup(id:string){setGroupId(id);setMode('group');setSelected(null)}
 const group=report?.groups.find(g=>g.id===groupId)
 const graph=mode==='group'&&group?group.graph:report?.overview
 const filteredGraph=useMemo(()=>{
  if(!graph)return {nodes:[],edges:[],truncated:false}
  const q=search.trim().toLowerCase()
  if(!q&&!hideUnchanged)return graph
  const nodes=hideUnchanged?graph.nodes.filter(n=>n.status!=='context'):graph.nodes
  const nodeIds=new Set(nodes.map(n=>n.id))
  const edges=graph.edges.filter(e=>nodeIds.has(e.source)&&nodeIds.has(e.target))
  if(!q)return {nodes,edges,truncated:graph.truncated}
  const matching=new Set(nodes.filter(n=>n.label.toLowerCase().includes(q)||n.path.toLowerCase().includes(q)).map(n=>n.id))
  const ids=new Set(matching)
  for(const e of edges){if(matching.has(e.source))ids.add(e.target);if(matching.has(e.target))ids.add(e.source)}
  return {nodes:nodes.filter(n=>ids.has(n.id)),edges:edges.filter(e=>ids.has(e.source)&&ids.has(e.target)),truncated:graph.truncated}
 },[graph,search,hideUnchanged])
 useEffect(()=>{if(selected&&!filteredGraph.nodes.some(n=>n.id===selected))setSelected(null)},[filteredGraph,selected])
 const unchangedCount=graph?.nodes.filter(n=>n.status==='context').length||0
 const selectedNode=filteredGraph.nodes.find(n=>n.id===selected)
 const selectedFile=report?.files.find(f=>f.path===selectedNode?.path||f.old_path===selectedNode?.path)
 const relations=filteredGraph.edges.filter(e=>e.source===selected||e.target===selected).slice(0,20)
 const available=models?.[harness as keyof Harnesses]
 const modelOptions=available?.models?.length?available.models.map(m=>({id:m.id,label:m.label})):harness==='claude'?(available?.aliases||['default','sonnet','opus','haiku']).map(id=>({id,label:id})):[]
 const selectedModel=available?.models.find(m=>m.id===model)
 const effortOptions=selectedModel?.efforts?.length?selectedModel.efforts:(available?.efforts||['low','medium','high'])
 const busy=job?.state==='running'||job?.state==='queued'
 const currentAiGroup=report?.ai?.groups.find(g=>g.id===groupId)
 const hasDetailedAI=!!report?.ai?.groups.some(g=>g.changes?.length)
 function renderList(items?:string[],empty='No findings generated.'){return items?.length?<ul className="narrative-list">{items.map((x,i)=><li key={i}>{x}</li>)}</ul>:<div className="muted small">{empty}</div>}
 return <div className="app">
  <aside className={'sidebar '+(!sidebar?'sidebar-hidden':'')}>
   <div className="brand"><div className="brand-icon"><Network size={22}/></div><div><strong>prism<span className="brand-period">.</span></strong><small>Structural PR review</small></div></div>
   <div className="sidebar-main">
    <div className="side-label">WORKSPACE</div>
    <button className={!showHistory?'side-link active':'side-link'} onClick={()=>{setShowHistory(false);setShowSettings(false)}}><Layers3 size={18}/> Explorer</button>
    <button className={showHistory?'side-link active':'side-link'} onClick={()=>{setShowHistory(true);setShowSettings(false);refreshHistory()}}><Clock3 size={18}/> Recent reports <span className="side-count">{recent.length}</span></button>
    <div className="side-label side-label-section">QUICK ACCESS</div>
    <button className="side-link" onClick={()=>{setShowHistory(false);document.getElementById('pr-url')?.focus()}}><Plus size={18}/> New analysis</button>
   </div>
   <div className="sidebar-footer">
    <div className="local-status"><span className="status-pulse"/><div><strong>Running locally</strong><small>127.0.0.1:{APP_PORT}</small></div><ShieldCheck size={18}/></div>
    <button className="side-link" onClick={()=>setShowSettings(v=>!v)}><Settings2 size={18}/> Configuration</button>
    <div className="version">PRISM / v0.2.0</div>
   </div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div className="topbar-left"><button className="icon-btn" onClick={()=>setSidebar(v=>!v)} aria-label="Toggle sidebar"><Menu size={19}/></button><span className="crumb">Workspace</span><ChevronRight size={14} className="muted"/><span className="crumb-current">{showSettings?'Configuration':showHistory?'Reports':report?.demo?'Example report':report?`PR #${report.meta.number}`:'Explorer'}</span></div><div className="topbar-right">{loading&&<LoaderCircle size={16} className="spinning"/>}<span className="host-pill"><span className="status-pulse"/> Local instance</span><span className="avatar">PR</span></div></header>
   <main>
    {showSettings?<div className="settings-view"><div className="page-eyebrow"><Settings2 size={15}/> PREFERENCES</div><h1>Configuration</h1><p>Harnesses run locally using your existing CLI login and credentials. Graphify and Tree-sitter are installed by the setup script.</p><div className="settings-card"><h3>AI harnesses</h3>{(['codex','claude'] as const).map(key=><div className="setting-row" key={key}><div className="setting-title"><Terminal size={18}/><div><strong>{display(key)}</strong><small>{models?.[key]?.discovery||'Checking...'}</small></div></div><span className={'status-tag '+(models?.[key]?.installed?'ok':'')}>{models?.[key]?.installed?'Detected':'Not detected'}</span></div>)}<button className="secondary-btn" onClick={()=>call<Harnesses>('/harnesses').then(setModels).catch(e=>setError(String(e)))}><RefreshCcw size={14}/> Re-detect CLIs</button></div><div className="settings-card"><h3>Runtime</h3><p>Bind address: <code>127.0.0.1</code> · Port: <code>{APP_PORT}</code></p><p>For another port, edit <code>PORT</code> in <code>.env</code> and restart the app.</p><p>AI prompts are sent to your selected CLI provider. Graphify structural indexing is local.</p></div></div>:
    showHistory?<div className="history-view"><div className="page-eyebrow"><Clock3 size={15}/> RECENT ANALYSES</div><div className="history-head"><div><h1>Saved reports</h1><p>Reports are cached locally and ready to reopen.</p></div><button className="secondary-btn" onClick={refreshHistory}><RefreshCcw size={15}/> Refresh</button></div>{recent.length?recent.map(item=><button className="history-item" key={item.id} onClick={()=>loadReport(item.id)}><div className="history-icon"><GitPullRequest size={20}/></div><div className="history-meta"><strong>{item.meta.title}</strong><small>{item.meta.owner}/{item.meta.repo} · #{item.meta.number} · {prettyDate(item.created_at)}</small></div><span className="history-stats">{item.stats.groups} groups</span><ChevronRight size={18}/></button>):<div className="empty-panel">No cached analyses yet. Paste a PR URL to get started.</div>}</div>:
    <>
     <section className="hero-top"><div><div className="page-eyebrow"><GitBranch size={14}/> CODE INTELLIGENCE WORKSPACE</div><h1>Understand the <span>whole change.</span></h1><p>Go beyond file diffs. Explore affected classes, trace relationships, and get an architectural breakdown of any pull request.</p></div><div className="hero-icon"><GitCompareArrows size={31}/></div></section>
     <section className="analyze-box"><div className="section-top"><div className="section-title"><GitPullRequest size={17}/><strong>Analyze a pull request</strong></div><span className="subtle-label">GitHub repositories</span></div>
       <form onSubmit={e=>{e.preventDefault();begin()}} className="analyze-form"><div className="url-row"><div className="url-input-wrap"><GitPullRequest size={19}/><input id="pr-url" type="url" value={prUrl} onChange={e=>setPrUrl(e.target.value)} placeholder="https://github.com/owner/repository/pull/123" required/></div><button className="primary-btn" disabled={busy} type="submit">{busy?<LoaderCircle className="spinning" size={17}/>:<Play size={16} fill="currentColor"/>}<span>{busy?'Analyzing':'Analyze PR'}</span><ArrowRight size={16}/></button></div>
       <div className="analyze-options"><div className="form-field"><label>AI HARNESS</label><div className="select-wrap"><select value={harness} onChange={e=>{setHarness(e.target.value);setModel('default');setEffort('default')}}><option value="none">Graph only (no AI)</option><option value="codex">Codex {models&&!models.codex.installed?'(not installed)':''}</option><option value="claude">Claude Code {models&&!models.claude.installed?'(not installed)':''}</option></select><ChevronDown size={15}/></div></div>
        {harness!=='none'&&<><div className="form-field"><label>MODEL</label><div className="select-wrap"><select value={modelOptions.some(m=>m.id===model)?model:'custom'} onChange={e=>setModel(e.target.value==='custom'?'':e.target.value)}><option value="default">CLI default</option>{modelOptions.filter(m=>m.id!=='default').map(m=><option key={m.id} value={m.id}>{m.label}</option>)}<option value="custom">Custom model ID…</option></select><ChevronDown size={15}/></div>{(!modelOptions.some(m=>m.id===model)&&model!== 'default')&&<input className="custom-model" placeholder="Enter CLI model ID" value={model} onChange={e=>setModel(e.target.value)}/>}</div><div className="form-field"><label>REASONING EFFORT</label><div className="select-wrap"><select value={effort} onChange={e=>setEffort(e.target.value)}><option value="default">CLI default</option>{effortOptions.map(e=><option key={e} value={e}>{e.charAt(0).toUpperCase()+e.slice(1)}</option>)}</select><ChevronDown size={15}/></div></div></>}
        <span className="analysis-caption"><ShieldCheck size={14}/> Graph extraction runs on your machine</span></div>
       </form>
       {busy&&<div className="job-progress"><LoaderCircle className="spinning" size={16}/><span>{job?.message||'Preparing analysis...'}</span></div>}
       {error&&<div className="error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
     </section>
     {report&&<section className="report-section">
      <div className="report-header"><div><div className="section-topline"><span className="eyebrow">{report.demo?'EXAMPLE ANALYSIS':'PULL REQUEST REPORT'}</span>{report.demo?<span className="demo-tag">Sample data</span>:<span className="real-tag"><CheckCircle2 size={12}/> Analyzed</span>}</div><h2>{report.meta.title}</h2><div className="report-meta"><span><GitPullRequest size={14}/> {report.meta.owner}/{report.meta.repo} <b>#{report.meta.number}</b></span><span className="meta-sep">•</span><span><Clock3 size={14}/> {prettyDate(report.created_at)}</span></div></div><div className="report-buttons">{!report.demo&&<button className="small-btn" onClick={copyLink}>{copied?<Check size={15}/>:<Copy size={15}/>}<span>{copied?'Copied':'Copy link'}</span></button>}<button className="small-btn" onClick={download}><Download size={15}/> Export JSON</button>{!report.demo&&<a className="small-btn" href={report.meta.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/> GitHub</a>}</div></div>
      <div className="stats-grid"><div className="stat"><div className="stat-icon cyan"><Braces size={19}/></div><div><strong>{report.stats.changed_symbols}</strong><small>Changed symbols</small></div></div><div className="stat"><div className="stat-icon purple"><Layers3 size={19}/></div><div><strong>{report.stats.groups}</strong><small>Change groups</small></div></div><div className="stat"><div className="stat-icon blue"><FileCode2 size={19}/></div><div><strong>{report.stats.changed_files}</strong><small>Files touched</small></div></div><div className="stat"><div className="stat-icon orange"><Network size={19}/></div><div><strong>{report.stats.total_graph_edges.toLocaleString()}</strong><small>Graph relations</small></div></div></div>
      <div className="section-heading"><div><h3>Change map</h3><p>Explore how modified symbols interact with the surrounding codebase.</p></div><div className="graph-meta"><span className="status-pulse"/> Knowledge graph</div></div>
      <div className="group-switcher"><button className={mode==='overview'?'group-tab active':'group-tab'} onClick={()=>{setMode('overview');setSelected(null)}}><Network size={16}/> All changes <span>{report.stats.changed_symbols}</span></button>{report.groups.map((g,i)=><button key={g.id} className={mode==='group'&&groupId===g.id?'group-tab active':'group-tab'} onClick={()=>selectGroup(g.id)}><span className="group-index">{String(i+1).padStart(2,'0')}</span>{groupTitles[g.id]||g.title}<span>{g.changed_count}</span></button>)}</div>
      <div className={'graph-layout '+(!details?'no-details':'')}>
       <div className="graph-main"><div className="graph-header"><div className="graph-title"><strong>{mode==='overview'?'Complete change landscape':group?(groupTitles[group.id]||group.title):''}</strong><small>{filteredGraph.nodes.length} nodes · {filteredGraph.edges.length} relationships</small></div><div className="graph-actions"><label className="graph-organization" title="Component types are inferred from symbol and file names; unmatched symbols go in Other."><Layers3 size={14}/><span>Arrange</span><select aria-label="Change map arrangement" value={graphLayout} onChange={e=>setGraphLayout(e.target.value as GraphLayout)}><option value="network">Network</option><option value="tree">Tree</option><option value="roles">By component</option></select></label><label className={'graph-filter-toggle'+(hideUnchanged?' active':'')} title={hideUnchanged?'Show unchanged context nodes':`Hide ${unchangedCount} unchanged context nodes`}><EyeOff size={14}/><input type="checkbox" aria-label="Hide unchanged components" checked={hideUnchanged} onChange={e=>setHideUnchanged(e.target.checked)}/><span>Hide unchanged</span></label><div className="search-wrap"><Search size={14}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find a symbol..."/></div><button className="icon-btn" title="Toggle details panel" onClick={()=>setDetails(v=>!v)}>{details?<PanelRightClose size={18}/>:<PanelRightOpen size={18}/>}</button></div></div><GraphCanvas graph={filteredGraph} selected={selected} onSelect={id=>setSelected(id||null)} layoutMode={graphLayout}/></div>
       {details&&<div className="details-panel">{selectedNode?<><div className="details-top"><span className="eyebrow">SELECTED SYMBOL</span><span className={'status-tag '+selectedNode.status}>{selectedNode.status}</span></div><div className="detail-title"><div className="symbol-icon"><Code2 size={18}/></div><div><strong>{selectedNode.label}</strong><span>{selectedNode.kind||'symbol'}</span></div></div><div className="detail-file"><FileCode2 size={15}/>{selectedNode.path}:{selectedNode.line}</div><div className="detail-divider"/><strong className="detail-subhead">Relationships <span>({relations.length})</span></strong><div className="relation-list">{relations.length?relations.map((edge,i)=>{const other=filteredGraph.nodes.find(n=>n.id===(edge.source===selected?edge.target:edge.source));return <button key={i} className="relation-item" onClick={()=>setSelected(other?.id||null)}><span className="relation-direction">{edge.source===selected?<ArrowRight size={14}/>:<ArrowLeft size={14}/>}</span><span><strong>{other?.label||'Unknown'}</strong><small>{edge.relation}{edge.status==='added'?' · new':''}{edge.status==='removed'?' · removed':''}{edge.confidence==='INFERRED'?' · inferred':''}</small></span><ChevronRight size={14}/></button>}):<span className="muted small">No relationships in this view</span>}</div>{selectedFile&&<><div className="detail-divider"/><strong className="detail-subhead">Code diff</strong><CodeDiff patch={selectedFile.patch} path={selectedFile.path||selectedFile.old_path}/></>}</>:<div className="empty-detail"><div className="empty-detail-icon"><Network size={29}/></div><strong>Explore the graph</strong><p>Select a class, method, or function to inspect its changes and relationships.</p><span>Drag to pan · Scroll to zoom</span></div>}</div>}
      </div>
      <div className="report-bottom"><div className="narrative-panel"><div className="panel-title-row"><div><div className="panel-label"><Sparkles size={15}/> AI ANALYSIS</div><h3>{mode==='overview'?'Pull request breakdown':(group?(groupTitles[group.id]||group.title):'Change group')+' breakdown'}</h3></div>{report.ai?<span className="ai-provider">{display(report.ai.harness)} · {report.ai.model}</span>:<span className="ai-provider">Not generated</span>}</div>
        {report.ai?<><p className="analysis-overview">{mode==='overview'?report.ai.overview:currentAiGroup?.summary||'No explanation available for this group.'}</p>{mode==='overview'?<>{report.ai.key_changes?.length>0&&<><h4>Key changes</h4>{renderList(report.ai.key_changes)}</>}</>:currentAiGroup?<><h4>Before & after</h4><p>{currentAiGroup.before_after}</p><h4>Architectural impact</h4><p>{currentAiGroup.impact}</p><h4>Potential risks</h4>{renderList(currentAiGroup.risks,'No specific risks identified.')}<h4>Test considerations</h4>{renderList(currentAiGroup.tests,'No specific tests suggested.')}</>:null}</>:<div className="no-ai"><Sparkles size={24}/><strong>Ready for deeper analysis</strong><p>Generate an explanation with Claude Code or Codex. The structural graph above works independently of AI.</p>{!report.demo&&harness!=='none'&&<button className="secondary-btn" disabled={busy} onClick={explain}><Sparkles size={15}/> Generate explanation</button>}{report.demo&&<span className="muted small">Open a real PR to analyze with your installed CLI.</span>}</div>}
       </div><div className="changes-panel"><div className="panel-title-row"><div><div className="panel-label"><Layers3 size={15}/> CHANGE GROUPS</div><h3>Segments <span className="subtle-count">{report.groups.length}</span></h3></div></div><div className="segment-list">{report.groups.map((g,i)=><button key={g.id} className="segment-item" onClick={()=>selectGroup(g.id)}><div className="segment-num">{String(i+1).padStart(2,'0')}</div><div><strong>{groupTitles[g.id]||g.title}</strong><small>{g.changed_count} symbols · {g.files.length} files</small></div><ArrowDownRight size={17}/></button>)}</div><div className="panel-note"><Activity size={16}/> {report.stats.indexed_files} files indexed in the repository snapshot</div></div></div>
      {report.ai&&!hasDetailedAI&&!report.demo&&<div className="legacy-notice"><AlertCircle size={17}/><span>This cached report uses the older summary-only format. Regenerate it to get per-symbol explanations, source walkthroughs, and a recommended review order.</span><button className="secondary-btn" onClick={explain} disabled={busy||harness==='none'}>Regenerate details</button></div>}
      <DetailedReport report={report} activeGroup={mode==='group'&&group?group:null} groupTitles={groupTitles} onNavigate={(id,symbol)=>{selectGroup(id);setSelected(symbol);document.querySelector('.graph-layout')?.scrollIntoView({behavior:'smooth',block:'center'})}}/>
     </section>}
    </>}
   </main>
   <footer className="footer"><span><span className="footer-dot"/> Local-first code intelligence</span><span>Prism v0.2.0 · Built for Linux & macOS</span></footer>
  </div>
 </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>)
