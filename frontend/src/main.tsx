import {StrictMode,useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Activity,ArrowDownRight,ArrowLeft,ArrowRight,Braces,Check,CheckCircle2,ChevronDown,ChevronRight,Clock3,Code2,Copy,Download,EyeOff,ExternalLink,FileCode2,GitBranch,GitCompareArrows,GitPullRequest, Layers3, LoaderCircle, Menu, Network, PanelRightClose, PanelRightOpen, Play, Plus, RefreshCcw, Search, Settings2, ShieldCheck, Sparkles, Terminal, X, AlertCircle} from 'lucide-react'
import {GraphCanvas} from './components/GraphCanvas'
import {MapGroupFilter} from './components/MapGroupFilter'
import {CodeDiff} from './components/CodeDiff'
import {DetailedReport} from './components/DetailedReport'
import {ChangeTopicOverview} from './components/ChangeTopicOverview'
import {ReviewPathRail} from './components/ReviewPathRail'
import {buildGroupDisplayTitles} from './groupTitles'
import {inferComponentGroups} from './graphOrganization'
import type { GraphLayout,GraphNode,Harnesses,Job,Report } from './types'
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
 const [mode,setMode]=useState<'overview'|'topic'|'group'|'all'>('overview')
 const [topicId,setTopicId]=useState('')
 const [groupId,setGroupId]=useState('')
 const [selected,setSelected]=useState<string|null>(null)
 const [reviewFocusPath,setReviewFocusPath]=useState<string|null>(null)
 const [search,setSearch]=useState('')
 const [graphLayout,setGraphLayout]=useState<GraphLayout>(()=>{
  const saved=localStorage.getItem('prism:graph-layout')
  return saved==='tree'||saved==='roles'?saved:'network'
 })
 const [hideUnchanged,setHideUnchanged]=useState(()=>localStorage.getItem('prism:hide-unchanged')==='true')
 const [hiddenGroups,setHiddenGroups]=useState<Set<string>>(()=>new Set())
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
 async function loadReport(id:string){setLoading(true);setError('');try{setReport(await call<Report>('/reports/'+id));setTopicId('');setGroupId('');setMode('overview');setSelected(null);setReviewFocusPath(null);setHiddenGroups(new Set());setShowHistory(false)}catch(e){setError(String(e))}finally{setLoading(false)}}
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
 const topics=report?.ai?.topics?.length?report.ai.topics:report?.topics||[]
 const selectedTopic=topics.find(topic=>topic.id===topicId)
 const topicGroups=selectedTopic?report?.groups.filter(item=>selectedTopic.group_ids.includes(item.id))||[]:[]
 function selectTopic(id:string){setTopicId(id);setGroupId('');setMode('topic');setSelected(null);setReviewFocusPath(null)}
 function selectGroup(id:string){setGroupId(id);setMode('group');setSelected(null);setReviewFocusPath(null)}
 const group=report?.groups.find(g=>g.id===groupId)
 const graph=mode==='group'&&group?group.graph:mode==='topic'&&selectedTopic?selectedTopic.graph:mode==='all'?report?.overview:undefined
 const componentGroups=useMemo(()=>inferComponentGroups(graph?.nodes||[]),[graph])
 const inferredGroups=useMemo(()=>{
  const counts=new Map<string,number>()
  for(const name of componentGroups.values())counts.set(name,(counts.get(name)||0)+1)
  return [...counts].map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name))
 },[componentGroups])
 function toggleGroupVisibility(name:string){setHiddenGroups(current=>{const next=new Set(current);if(next.has(name))next.delete(name);else next.add(name);return next})}
 const filteredGraph=useMemo(()=>{
  if(!graph)return {nodes:[],edges:[],truncated:false}
  const q=search.trim().toLowerCase()
  if(!q&&!hideUnchanged&&!hiddenGroups.size)return graph
  const nodes=graph.nodes.filter(node=>
   (!hideUnchanged||node.status!=='context')&&
   !hiddenGroups.has(componentGroups.get(node.id)||'Other'))
  const nodeIds=new Set(nodes.map(n=>n.id))
  const edges=graph.edges.filter(e=>nodeIds.has(e.source)&&nodeIds.has(e.target))
  if(!q)return {nodes,edges,truncated:graph.truncated}
  const matching=new Set(nodes.filter(n=>n.label.toLowerCase().includes(q)||n.path.toLowerCase().includes(q)).map(n=>n.id))
  const ids=new Set(matching)
  for(const e of edges){if(matching.has(e.source))ids.add(e.target);if(matching.has(e.target))ids.add(e.source)}
  return {nodes:nodes.filter(n=>ids.has(n.id)),edges:edges.filter(e=>ids.has(e.source)&&ids.has(e.target)),truncated:graph.truncated}
 },[graph,search,hideUnchanged,hiddenGroups,componentGroups])
 const reviewFocusNodes=graph?.nodes.filter(node=>node.path===reviewFocusPath&&node.status!=='context')||[]
 const reviewFocusVisible=filteredGraph.nodes.some(node=>node.path===reviewFocusPath&&node.status!=='context')
 const reviewFocusHiddenGroup=reviewFocusNodes.map(node=>componentGroups.get(node.id)||'Other').find(name=>hiddenGroups.has(name))
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
 const currentMapFileSet=useMemo(()=>new Set(mode==='group'?group?.files||[]:mode==='topic'?selectedTopic?.files||[]:mode==='all'?(report?.files||[]).map(file=>file.path||file.old_path):[]),[mode,group?.files,selectedTopic?.files,report?.files])
 const reviewOrderSource=mode==='group'&&currentAiGroup?.review_order?.length?currentAiGroup.review_order:report?.ai?.review_order||[]
 const reviewPathSteps=useMemo(()=>reviewOrderSource.filter(step=>currentMapFileSet.has(step.path)),[reviewOrderSource,currentMapFileSet])
 const reviewFocusStep=reviewPathSteps.find(step=>step.path===reviewFocusPath)
 const reviewFocusIndex=reviewPathSteps.findIndex(step=>step.path===reviewFocusPath)
 const changedGraphNodes=useMemo(()=>graph?.nodes.filter(node=>node.status!=='context')||[],[graph])
 function focusReviewFile(path:string){setSearch('');setSelected(null);setReviewFocusPath(current=>current===path?null:path)}
 const groupTopic=topics.find(topic=>topic.group_ids.includes(groupId))
 const activeTopic=mode==='topic'?selectedTopic:groupTopic
 const activeTopicGroups=activeTopic?report?.groups.filter(item=>activeTopic.group_ids.includes(item.id))||[]:[]
 const activeTopicSummaries=activeTopic?report?.ai?.groups.filter(item=>activeTopic.group_ids.includes(item.id)).map(item=>item.summary).filter(Boolean)||[]:[]
 const topicReport=mode==='topic'&&selectedTopic&&report?{...report,groups:topicGroups,stats:{...report.stats,groups:topicGroups.length}}:report
 const mapTitle=mode==='overview'?'Review topics':mode==='all'?'Complete change landscape':mode==='topic'?selectedTopic?.title||'Change topic':group?(groupTitles[group.id]||group.title):''
 const mapSubtitle=mode==='overview'?`${topics.length} topics · ${report?.stats.changed_symbols||0} changed symbols`:mode==='topic'?`${filteredGraph.nodes.length} nodes · ${filteredGraph.edges.length} relationships`:graph?`${filteredGraph.nodes.length} nodes · ${filteredGraph.edges.length} relationships`:''
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
      <div className="group-switcher topic-switcher"><button className={mode==='overview'?'group-tab active':'group-tab'} onClick={()=>{setMode('overview');setGroupId('');setSelected(null);setReviewFocusPath(null)}}><Layers3 size={15}/> Topics <span>{topics.length}</span></button>{mode==='topic'&&selectedTopic&&<span className="group-tab active current-topic">{selectedTopic.title}<span>{selectedTopic.changed_count}</span></span>}{mode==='group'&&groupTopic&&<button className="group-tab" onClick={()=>selectTopic(groupTopic.id)}>{groupTopic.title}<span>{groupTopic.changed_count}</span></button>}{mode==='group'&&group&&<span className="group-tab active current-topic">{groupTitles[group.id]||group.title}<span>{group.changed_count}</span></span>}{mode==='all'&&<span className="group-tab active current-topic"><Network size={15}/> All symbols</span>}{mode!=='overview'&&mode!=='all'&&<button className="group-tab" onClick={()=>{setMode('all');setGroupId('');setSelected(null);setReviewFocusPath(null)}}><Network size={15}/> All symbols</button>}</div>
      <div className={'graph-layout '+(!details?'no-details':'')}>
       <div className="graph-main"><div className="graph-header"><div className="graph-title"><strong>{mapTitle}</strong><small>{mapSubtitle}</small></div>{graph&&<div className="graph-actions"><label className="graph-organization" title="Discovers recurring type-name patterns in this graph, then falls back to source folders."><Layers3 size={14}/><span>Arrange</span><select aria-label="Change map arrangement" value={graphLayout} onChange={e=>setGraphLayout(e.target.value as GraphLayout)}><option value="network">Network</option><option value="tree">Tree</option><option value="roles">By inferred group</option></select></label><MapGroupFilter groups={inferredGroups} hidden={hiddenGroups} onToggle={toggleGroupVisibility} onShowAll={()=>setHiddenGroups(new Set())} onHideAll={()=>setHiddenGroups(new Set(inferredGroups.map(group=>group.name)))}/><label className={'graph-filter-toggle'+(hideUnchanged?' active':'')} title={hideUnchanged?'Show unchanged context nodes':`Hide ${unchangedCount} unchanged context nodes`}><EyeOff size={14}/><input type="checkbox" aria-label="Hide unchanged components" checked={hideUnchanged} onChange={e=>setHideUnchanged(e.target.checked)}/><span>Hide unchanged</span></label><div className="search-wrap"><Search size={14}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find a symbol..."/></div><button className="icon-btn" title="Toggle details panel" onClick={()=>setDetails(v=>!v)}>{details?<PanelRightClose size={18}/>:<PanelRightOpen size={18}/>}</button></div>}</div>{mode!=='overview'&&graph&&<ReviewPathRail steps={reviewPathSteps} changedNodes={changedGraphNodes as GraphNode[]} organizationNodes={graph.nodes} selectedPath={reviewFocusPath} onSelect={focusReviewFile}/ >}{mode==='overview'?<ChangeTopicOverview topics={topics} groupTitles={groupTitles} onSelectTopic={selectTopic} onShowAllGraph={()=>{setMode('all');setGroupId('');setSelected(null);setReviewFocusPath(null)}}/>:graph?filteredGraph.nodes.length?<GraphCanvas graph={filteredGraph} organizationNodes={graph.nodes} selected={selected} onSelect={id=>setSelected(id||null)} layoutMode={graphLayout} focusPath={reviewFocusPath}/>:<div className="graph-filter-empty"><Layers3 size={22}/><strong>No symbols are visible</strong><span>Show a group above, clear the search, or include unchanged context.</span></div>:<div className="topic-empty">Select a topic to explore its graph.</div>}</div>
       {details&&<div className="details-panel">{selectedNode?<><div className="details-top"><span className="eyebrow">SELECTED SYMBOL</span><span className={'status-tag '+selectedNode.status}>{selectedNode.status}</span></div><div className="detail-title"><div className="symbol-icon"><Code2 size={18}/></div><div><strong>{selectedNode.label}</strong><span>{selectedNode.kind||'symbol'}</span></div></div><div className="detail-file"><FileCode2 size={15}/>{selectedNode.path}:{selectedNode.line}</div><div className="detail-divider"/><strong className="detail-subhead">Relationships <span>({relations.length})</span></strong><div className="relation-list">{relations.length?relations.map((edge,i)=>{const other=filteredGraph.nodes.find(n=>n.id===(edge.source===selected?edge.target:edge.source));return <button key={i} className="relation-item" onClick={()=>setSelected(other?.id||null)}><span className="relation-direction">{edge.source===selected?<ArrowRight size={14}/>:<ArrowLeft size={14}/>}</span><span><strong>{other?.label||'Unknown'}</strong><small>{edge.relation}{edge.status==='added'?' · new':''}{edge.status==='removed'?' · removed':''}{edge.confidence==='INFERRED'?' · inferred':''}</small></span><ChevronRight size={14}/></button>}):<span className="muted small">No relationships in this view</span>}</div>{selectedFile&&<><div className="detail-divider"/><strong className="detail-subhead">Code diff</strong><CodeDiff patch={selectedFile.patch} path={selectedFile.path||selectedFile.old_path}/></>}</>:reviewFocusStep?<div className="review-step-details"><div className="details-top"><span className="eyebrow">REVIEW STEP {String(reviewFocusIndex+1).padStart(2,'0')} / {reviewPathSteps.length}</span><span className="status-tag">Suggested</span></div><div className="detail-title"><div className="symbol-icon"><FileCode2 size={18}/></div><div><strong>{reviewFocusStep.path.split(/[\\/]/).pop()}</strong><span>{reviewFocusStep.path}</span></div></div><div className="detail-divider"/><strong className="detail-subhead">Why review it here</strong><p className="review-step-reason">{reviewFocusStep.reason}</p><div className="review-step-note">{reviewFocusVisible?'The map highlights changed symbols in this file and their linked context. Solid edges remain extracted code relationships.':reviewFocusHiddenGroup?`This file’s inferred group (${reviewFocusHiddenGroup}) is hidden. Re-enable it in the Groups filter to show it in the map.`:reviewFocusNodes.length?'This file’s changed symbols are hidden by the current map filters.':'This file has no mapped symbol in this graph; use its change summary and source diff below.'}</div><button className="review-step-clear" onClick={()=>setReviewFocusPath(null)}>Clear file focus</button></div>:mode==='overview'?<div className="topic-details"><div className="empty-detail-icon"><Layers3 size={28}/></div><strong>Choose a topic</strong><p>Start with a small change area, then inspect the source graph and its related code.</p><span>Topic links come from verified relationships in the source graph.</span></div>:selectedTopic&&mode==='topic'?<div className="topic-details"><div className="details-top"><span className="eyebrow">{selectedTopic.source==='ai'?'AI SUGGESTED TOPIC':'PATH BASED TOPIC'}</span><span className="status-tag">{selectedTopic.changed_count} symbols</span></div><div className="detail-title"><div className="symbol-icon"><Layers3 size={18}/></div><div><strong>{selectedTopic.title}</strong><span>{selectedTopic.group_ids.length} structural groups · {selectedTopic.files.length} files</span></div></div><div className="detail-divider"/><strong className="detail-subhead">Open a structural group</strong><div className="segment-list">{topicGroups.map((item,index)=><button key={item.id} className="segment-item" onClick={()=>selectGroup(item.id)}><div className="segment-num">{String(index+1).padStart(2,'0')}</div><div><strong>{groupTitles[item.id]||item.title}</strong><small>{item.changed_count} symbols · {item.files.length} files</small></div><ArrowDownRight size={16}/></button>)}</div></div>:<div className="empty-detail"><div className="empty-detail-icon"><Network size={29}/></div><strong>Explore the graph</strong><p>Select a class, method, or function to inspect its changes and relationships.</p><span>Drag to pan · Scroll to zoom</span></div>}</div>}
      </div>
      <div className={`report-bottom ${mode==='overview'||mode==='all'?'single-column':''}`}>
       <div className="narrative-panel"><div className="panel-title-row"><div><div className="panel-label"><Sparkles size={15}/> AI ANALYSIS</div><h3>{mode==='overview'||mode==='all'?'Pull request breakdown':mode==='topic'?`${selectedTopic?.title||'Change topic'} breakdown`:(group?(groupTitles[group.id]||group.title):'Change group')+' breakdown'}</h3></div>{report.ai?<span className="ai-provider">{display(report.ai.harness)} · {report.ai.model}</span>:<span className="ai-provider">Not generated</span>}</div>
        {report.ai?<>
         <p className="analysis-overview">{mode==='overview'||mode==='all'?report.ai.overview:mode==='topic'?(activeTopicSummaries.join(' ')||`This topic contains ${selectedTopic?.changed_count||0} changed symbols across ${topicGroups.length} structural groups.`):currentAiGroup?.summary||'No explanation available for this group.'}</p>
         {(mode==='overview'||mode==='all')&&report.ai.key_changes?.length>0&&<><h4>Key changes</h4>{renderList(report.ai.key_changes)}</>}
         {mode==='topic'&&activeTopicSummaries.length>0&&<><h4>Included change summaries</h4><ul className="topic-summary-list">{activeTopicSummaries.slice(0,5).map((summary,index)=><li key={index}>{summary}</li>)}</ul>{activeTopicSummaries.length>5&&<div className="muted small">+{activeTopicSummaries.length-5} more groups. Open a group below for its details.</div>}</>}
         {mode==='group'&&currentAiGroup&&<><h4>Before & after</h4><p>{currentAiGroup.before_after}</p><h4>Architectural impact</h4><p>{currentAiGroup.impact}</p><h4>Potential risks</h4>{renderList(currentAiGroup.risks,'No specific risks identified.')}<h4>Test considerations</h4>{renderList(currentAiGroup.tests,'No specific tests suggested.')}</>}
        </>:<div className="no-ai"><Sparkles size={24}/><strong>{mode==='topic'?'Topic overview ready':'Ready for deeper analysis'}</strong><p>{mode==='topic'?`This ${selectedTopic?.source==='ai'?'AI suggested':'path based'} topic contains ${selectedTopic?.changed_count||0} changed symbols. Generate an explanation for grounded summaries and review guidance.`:'Generate an explanation with Claude Code or Codex. The structural graph works independently of an AI harness.'}</p>{!report.demo&&harness!=='none'&&<button className="secondary-btn" disabled={busy} onClick={explain}><Sparkles size={15}/> Generate explanation</button>}{report.demo&&<span className="muted small">Open a real PR to analyze with your installed CLI.</span>}</div>}
       </div>
       {activeTopic&&(mode==='topic'||mode==='group')&&<div className="changes-panel"><div className="panel-title-row"><div><div className="panel-label"><Layers3 size={15}/> STRUCTURAL GROUPS</div><h3>{activeTopic.title} <span className="subtle-count">{activeTopicGroups.length}</span></h3></div></div><div className="segment-list">{activeTopicGroups.map((item,index)=><button key={item.id} className="segment-item" onClick={()=>selectGroup(item.id)}><div className="segment-num">{String(index+1).padStart(2,'0')}</div><div><strong>{groupTitles[item.id]||item.title}</strong><small>{item.changed_count} symbols · {item.files.length} files</small></div><ArrowDownRight size={17}/></button>)}</div><div className="panel-note"><Activity size={16}/> {report.stats.indexed_files} files indexed in the repository snapshot</div></div>}
      </div>
      {report.ai&&!hasDetailedAI&&!report.demo&&<div className="legacy-notice"><AlertCircle size={17}/><span>This cached report uses the older summary-only format. Regenerate it to get per-symbol explanations, source walkthroughs, and a recommended review order.</span><button className="secondary-btn" onClick={explain} disabled={busy||harness==='none'}>Regenerate details</button></div>}
      <DetailedReport report={topicReport!} activeGroup={mode==='group'&&group?group:null} groupTitles={groupTitles} onNavigate={(id,symbol)=>{selectGroup(id);setSelected(symbol);document.querySelector('.graph-layout')?.scrollIntoView({behavior:'smooth',block:'center'})}}/>
     </section>}
    </>}
   </main>
   <footer className="footer"><span><span className="footer-dot"/> Local-first code intelligence</span><span>Prism v0.2.0 · Built for Linux & macOS</span></footer>
  </div>
 </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>)
