import {useEffect,useMemo,useRef,useState,useId} from 'react'
import {ArrowRight,FileCode2,Maximize2,ZoomIn,ZoomOut,Sparkles,LoaderCircle} from 'lucide-react'
import type {ArchitectureData,ArchitectureNode,ReviewAssistantSettings,Harnesses} from '../types'
import {assistantSummary} from '../assistantSettings'
import {routeDrawing,type LayoutResult} from '../layout/architectureLayout'
import {architectureColor,buildArchitectureDiagram} from '../layout/architectureDiagram'
import ArchitectureLayoutWorker from '../layout/architectureLayout.worker?worker&inline'

type Props={data:ArchitectureData;hiddenPaths:Set<string>;onOpenFile:(path:string)=>void;assistant:ReviewAssistantSettings;harnesses:Harnesses|null;onOpenAssistant:()=>void;onDiscover:()=>void;busy:boolean;progress:string;error:string}
const color=architectureColor
const edgeColor=(kind:string)=>kind==='model'?'#d5b16d':kind==='match'?'#b1a3cf':kind==='mixed'?'#b4aecb':'#8ba9c4'

export function ArchitectureMap({data,hiddenPaths,onOpenFile,assistant,harnesses,onOpenAssistant,onDiscover,busy,progress,error}:Props){
 const host=useRef<HTMLDivElement>(null),markerId=useId().replace(/:/g,'')
 const [selected,setSelected]=useState<string|null>(null),[selectedPair,setSelectedPair]=useState<string|null>(null)
 const [showContext,setShowContext]=useState(true),[search,setSearch]=useState(''),[scale,setScale]=useState(1)
 const [layout,setLayout]=useState<LayoutResult|null>(null),[layoutError,setLayoutError]=useState('')
 useEffect(()=>{setSelected(null);setSelectedPair(null);setSearch('');setScale(1)},[data])
 const nodes=useMemo(()=>data.nodes.filter(n=>!hiddenPaths.has(n.path)&&(showContext||n.status!=='context')),[data,hiddenPaths,showContext])
 useEffect(()=>{if(selected&&!nodes.some(n=>n.id===selected)){setSelected(null);setSelectedPair(null)}},[nodes,selected])
 const supporting=data.layers.filter(layer=>layer.supporting),supportIds=new Set(supporting.map(layer=>layer.id))
 const runtime=nodes.filter(n=>!supportIds.has(n.layer)),runtimeIds=new Set(runtime.map(n=>n.id)),edges=data.edges.filter(e=>runtimeIds.has(e.source)&&runtimeIds.has(e.target))
 const diagram=useMemo(()=>{
  return buildArchitectureDiagram(data,nodes)
 },[data,nodes]) // eslint-disable-line react-hooks/exhaustive-deps
 const pairMap=useMemo(()=>new Map(diagram.pairs.map(p=>[p.id,p])),[diagram])
 const selectedEdge=selectedPair?pairMap.get(selectedPair)?.refs:null
 const file=nodes.find(n=>n.id===selected),visibleIds=new Set(nodes.map(n=>n.id))
 const refs=(selectedEdge||data.edges.filter(e=>e.source===selected||e.target===selected)).filter(e=>visibleIds.has(e.source)&&visibleIds.has(e.target))
 const incident=new Set(data.edges.filter(e=>e.source===selected||e.target===selected).flatMap(e=>[e.source,e.target]))
 useEffect(()=>{if(selectedPair&&!pairMap.has(selectedPair))setSelectedPair(null)},[pairMap,selectedPair])
 useEffect(()=>{
  setLayout(null);setLayoutError('');if(!diagram.cards.length)return
  const worker=new ArchitectureLayoutWorker()
  worker.onmessage=(event:MessageEvent<{layout?:LayoutResult;error?:string}>)=>{if(event.data.layout)setLayout(event.data.layout);else setLayoutError(event.data.error||'Layout unavailable. Files and evidence remain in the browser below.')}
  worker.onerror=()=>setLayoutError('Layout unavailable. Files and evidence remain in the browser below.')
  worker.postMessage(diagram.input)
  return()=>worker.terminate()
 },[diagram])
 function selectFile(id:string){setSelected(current=>current===id?null:id);setSelectedPair(null)}
 function selectPair(id:string){setSelectedPair(current=>current===id?null:id);setSelected(null)}
 const query=search.trim().toLowerCase()
 const drawnRoutes=layout?.routes.map(route=>{const refs=pairMap.get(route.id)?.refs||[],kinds=new Set(refs.map(e=>e.confidence)),kind=kinds.size>1?'mixed':kinds.has('LLM_INFERRED')?'model':kinds.has('SOURCE_MATCH')?'match':'resolved',lit=route.id===selectedPair||refs.some(e=>e.source===selected||e.target===selected),dim=!!(selected||selectedPair)&&!lit;return {route,...routeDrawing(route),kind,lit,dim}})||[]
 function renderFile(n:ArchitectureNode){return <button type="button" key={n.id} className={'architecture-file '+(selected===n.id?'active':'')} onClick={()=>selectFile(n.id)} aria-pressed={selected===n.id} title={n.path}><i style={{background:color(n.status)}}/><span>{n.label}<small>{n.path}</small></span><em>{n.status}</em></button>}
 return <section className="architecture-map" aria-label="File architecture map">
  <div className="architecture-discovery">
   <div><strong>{data.method==='semantic'?'Repository-specific organization':'Discover the architecture of this change'}</strong><p>{data.generation?`Saved map · ${data.generation.harness} · ${data.generation.model}`:'The assistant reads relevant source, chooses groups for this project, and cites its relationships.'}</p></div>
   <div className="architecture-discovery-controls"><span className="assistant-line">Assistant: <strong>{assistantSummary(assistant)}</strong>{harnesses&&!harnesses[assistant.harness].installed?' · not installed':''}</span><button type="button" className="assistant-change-btn" aria-label="Change assistant" onClick={onOpenAssistant}>Change</button><button type="button" disabled={busy||!harnesses?.[assistant.harness]?.installed} onClick={onDiscover}>{busy?<LoaderCircle size={14} className="spinning"/>:<Sparkles size={14}/>} {busy?'Discovering…':data.method==='semantic'?'Rebuild map':'Discover architecture'}</button></div>
   <small>Source excerpts go to the selected CLI provider. Model interpretations stay distinct from extracted references.</small>
   {busy&&<p role="status">{progress}</p>}{error&&<p role="alert">{error}</p>}
  </div>
  <div className="architecture-toolbar"><div><strong>{data.method==='semantic'?'Discovered architecture':data.method==='manifest'?'Changed-file map':'Source map'}</strong><span>{nodes.filter(n=>n.status!=='context').length} changed files · {nodes.filter(n=>n.status==='context').length} context files</span></div><div className="architecture-tools"><input aria-label="Find a file in architecture map" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find a file…"/><label><input type="checkbox" checked={showContext} onChange={e=>setShowContext(e.target.checked)}/>Context</label><button type="button" aria-label="Zoom architecture map in" onClick={()=>setScale(v=>Math.min(1.8,v*1.2))}><ZoomIn size={16}/></button><button type="button" aria-label="Zoom architecture map out" onClick={()=>setScale(v=>Math.max(1,v/1.2))}><ZoomOut size={16}/></button><button type="button" aria-label="Reset architecture zoom" onClick={()=>setScale(1)}><Maximize2 size={16}/></button></div></div>
  {!!runtime.length?<div className="architecture-canvas" ref={host}>
   {!layout?<div className="architecture-empty" role="status">{layoutError||'Organizing files and separating connections…'}</div>:<div className="architecture-drawing" style={{width:layout.width*scale,height:layout.height*scale}}>
    <div className="architecture-surface" data-shared-segments={layout.diagnostics.sharedSegments} data-shared-ports={layout.diagnostics.sharedPorts} data-card-passes={layout.diagnostics.cardPasses} style={{width:layout.width,height:layout.height,transform:`scale(${scale})`}} role="group" aria-label={`Grouped file graph with ${runtime.length} files and ${edges.length} relationships`}>
     {layout.groups.map(group=><div key={group.id} className="architecture-region" style={{left:group.x,top:group.y,width:group.width,height:group.height}}><strong>{group.title}</strong></div>)}
     <svg className="architecture-routes" width={layout.width} height={layout.height} aria-hidden="true"><defs>{['resolved','match','model','mixed'].map(kind=><marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10" fill={edgeColor(kind)}/></marker>)}</defs>
      {drawnRoutes.map(({route,path,kind,lit,dim})=><g key={route.id} opacity={dim?.12:1}><path className={`architecture-route ${kind} ${lit?'focused':''}`} d={path} markerEnd={`url(#${markerId}-${kind})`}/><path className="architecture-route-hit" d={path} onClick={()=>selectPair(route.id)}/></g>)}
      {drawnRoutes.flatMap(({route,bridges,kind,lit,dim})=>bridges.map((bridge,index)=><g key={`${route.id}-bridge-${index}`} opacity={dim?.12:1} pointerEvents="none"><path d={bridge.path} fill="none" stroke={layout.groups.some(g=>bridge.at[0]>=g.x&&bridge.at[0]<=g.x+g.width)?'#151e29':'#0e141c'} strokeWidth="4" strokeLinecap="round"/><path className={`architecture-route ${kind} ${lit?'focused':''}`} d={bridge.path}/></g>))}
     </svg>
     {diagram.cards.map(card=>{const rect=layout.positions[card.id];if(!rect)return null;const focused=card.fileIds.includes(selected||''),lit=focused||card.fileIds.some(id=>incident.has(id))||selectedPair&&pairMap.get(selectedPair)&&[pairMap.get(selectedPair)!.source,pairMap.get(selectedPair)!.target].includes(card.id),dim=selected||selectedPair?!lit:!!query&&!`${card.label} ${card.path}`.toLowerCase().includes(query);return <button type="button" key={card.id} className={`architecture-card ${focused?'focused':''} ${dim?'dim':''}`} style={{left:rect.x,top:rect.y,width:rect.width,height:rect.height,borderColor:card.color}} onClick={()=>selectFile(focused?selected!:card.fileIds[0])} aria-pressed={focused} title={card.path}><strong>{card.label}</strong><small>{card.folder}</small><em>{card.status}</em></button>})}
    </div>
   </div>}
  </div>:<div className="architecture-empty">Runtime files are hidden. Open a supporting group below.</div>}
  {!!layout?.notes.length&&<p className="architecture-note">{layout.notes.join(' ')}</p>}
  <div className="architecture-legend"><span><i style={{background:color('modified')}}/>Modified</span><span><i style={{background:color('added')}}/>Added</span><span><i style={{background:color('deleted')}}/>Deleted</span><span><i style={{background:color('context')}}/>Context</span><span>Solid: resolved references</span><span>Dashed: source matches</span><span>Dotted: model interpretations · Mixed dash: mixed evidence</span></div>
  <details className="architecture-browse"><summary>Browse runtime files <span>{runtime.length}</span></summary><div>{runtime.map(renderFile)}</div></details>
  <div className="architecture-support">{supporting.map(l=>{const files=nodes.filter(n=>n.layer===l.id);if(!files.length)return null;return <details key={l.id} className="architecture-support-group"><summary>{l.title}<span>{files.length} files</span></summary><div>{l.focus&&<p className="architecture-group-focus">{l.focus}</p>}{files.map(renderFile)}</div></details>})}</div>
  {(file||selectedEdge)&&<div className="architecture-inspector"><header><div><FileCode2 size={16}/><strong>{file?.path||`${selectedEdge?.length} relationships between these files`}</strong></div>{file&&file.status!=='context'&&<button type="button" onClick={()=>onOpenFile(file.path)}>Review file <ArrowRight size={14}/></button>}</header>
   {file&&<><p>{file.status==='context'?'Unchanged source connecting this review.':`${file.status} file in ${data.layers.find(l=>l.id===file.layer)?.title}.`} {refs.length} cited relationships.</p>{data.layers.find(l=>l.id===file.layer)?.focus&&<p>{data.layers.find(l=>l.id===file.layer)?.focus}</p>}</>}
   <div className="architecture-relations">{refs.map((e,index)=><details key={index}><summary><span>{e.source}</span><b>{e.label||e.relation}{e.status==='removed'?' · removed':''}</b><span>{e.target}</span></summary><div className="architecture-evidence"><p>{e.detail} · {e.confidence==='LLM_INFERRED'?'Model interpretation with validated source citations; the claim itself is not mechanically verified.':e.confidence==='SOURCE_MATCH'?'Matched source references; not a runtime execution trace.':'Resolved repository reference.'}</p>{e.evidence.map((ref,i)=><div key={i}><small>{ref.path}:{ref.line} · {ref.side}</small><code>{ref.code}</code></div>)}</div></details>)}</div>
   {!refs.length&&<p>No supported relationship was resolved for this file.</p>}
   {file&&data.layers.find(l=>l.id===file.layer)?.presentation==='bundle'&&<div className="architecture-file-list">{nodes.filter(n=>n.layer===file.layer).map(renderFile)}</div>}
  </div>}
  {!!data.notes.length&&<details className="architecture-browse"><summary>Source coverage and unresolved mapping <span>{data.notes.length}</span></summary>{data.notes.map((note,i)=><p className="architecture-note" key={i}>{note}</p>)}</details>}
  {data.omitted_context>0&&<p className="architecture-note">{data.omitted_context} additional context files omitted from the overview.</p>}
 </section>
}
