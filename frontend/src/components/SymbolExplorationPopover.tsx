import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {FileCode2, GitBranch, LoaderCircle, X} from 'lucide-react'
import {fileMapLayout, popoverBounds, sourceClick, type SymbolSelection} from '../exploration'
import type {ExplorationConnection, ExplorationProjection, ExplorationResult, ExplorationSource, SourceAnchor} from '../types'
import {SyntaxCode} from './CodeDiff'

type Direction = 'consumers' | 'origins'
interface Props {reportId:string; selection:SymbolSelection|null; onSelect:(s:SymbolSelection)=>void}
const basename=(path:string)=>path.split('/').pop()||path
const labels:Record<string,string>={usage:'Usage endpoint',unresolved:'Unresolved relationship',unsupported:'Unsupported construct',cycle:'Composition cycle',
  no_further_changed_files:'No further changed files',no_further_eligible_connections:'No further eligible connections',partial:'Analysis is incomplete'}

async function request<T>(url:string, signal:AbortSignal, body?:unknown):Promise<T> {
  const response=await fetch(url,{signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})
  const data=await response.json()
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'Source exploration failed.')
  return data as T
}
function pause(signal:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'))}
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},350)
    signal.addEventListener('abort',abort,{once:true})
  })
}

export function SymbolExplorationPopover({reportId,selection,onSelect}:Props) {
  const [open,setOpen]=useState(false),[bounds,setBounds]=useState<ReturnType<typeof popoverBounds>|null>(null)
  const [result,setResult]=useState<ExplorationResult|null>(null),[projection,setProjection]=useState<ExplorationProjection|null>(null)
  const [direction,setDirection]=useState<Direction>('consumers'),[changed,setChanged]=useState(true)
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[anchor,setAnchor]=useState<SourceAnchor|null>(null)
  const [connection,setConnection]=useState<ExplorationConnection|null>(null),[source,setSource]=useState<ExplorationSource|null>(null),[sourceError,setSourceError]=useState('')
  const box=useRef<HTMLDivElement>(null),closeButton=useRef<HTMLButtonElement>(null),returnFocus=useRef<HTMLElement|null>(null)
  const pending=useRef<AbortController|null>(null),generation=useRef(0),views=useRef(new Map<string,ExplorationProjection>())
  const current=useRef({result,direction,changed});current.current={result,direction,changed}

  function dismiss() {setOpen(false);returnFocus.current?.focus({preventScroll:true})}
  useEffect(()=>{
    if(!open)return
    closeButton.current?.focus({preventScroll:true})
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();dismiss()}}
    const outside=(e:PointerEvent)=>{if(box.current&&!box.current.contains(e.target as Node)&&!(e.target as HTMLElement).closest('.exploration-reopen'))setOpen(false)}
    document.addEventListener('keydown',key);document.addEventListener('pointerdown',outside)
    const resize=()=>setBounds(b=>b?{...b,left:Math.max(12,Math.min(b.left,window.innerWidth-b.width-12)),top:Math.max(12,Math.min(b.top,window.innerHeight-b.height-12)),width:Math.min(b.width,window.innerWidth-24),height:Math.min(b.height,window.innerHeight-24)}:null)
    window.addEventListener('resize',resize)
    return()=>{document.removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resize)}
  },[open])
  useEffect(()=>{
    pending.current?.abort();generation.current++;views.current.clear();setOpen(false);setResult(null);setProjection(null);setAnchor(null);setConnection(null);setSource(null);setBounds(null);setError('');setBusy('')
    return()=>{pending.current?.abort()}
  },[reportId])

  useEffect(()=>{
    if(!selection)return
    pending.current?.abort();const controller=new AbortController();pending.current=controller
    const gen=++generation.current
    setError('');setBusy('Resolving symbol')
    async function resolve() {
      let first=true
      for(;;){
        const data=await request<ExplorationResult>(`/api/reports/${reportId}/exploration/resolve`,controller.signal,{path:selection!.path,side:selection!.side,line:selection!.line,column:selection!.column})
        if(gen!==generation.current)return
        if(data.status==='ignored'){setBusy('');return}
        if(first){
          setBounds(b=>b||popoverBounds(selection!.x,selection!.y,window.innerWidth,window.innerHeight));setOpen(true)
          if(!selection!.returnFocus?.closest('.symbol-exploration'))returnFocus.current=selection!.returnFocus||returnFocus.current
          setResult(data);setProjection(null);setAnchor(null);setConnection(null);views.current.clear();first=false
        }
        if(data.status==='indexing'){
          setBusy(data.message||'Indexing committed source');await pause(controller.signal);continue
        }
        setBusy('');setResult(data);setDirection('consumers');setChanged(true)
        if(data.status==='resolved'&&data.projection){
          setProjection(data.projection);views.current.set('consumers:true',data.projection)
          setAnchor(data.root!.definition)
        }else if(data.occurrence)setAnchor(data.occurrence)
        return
      }
    }
    void resolve().catch(e=>{if(!controller.signal.aborted&&gen===generation.current){setBusy('');setError(String(e.message));setBounds(b=>b||popoverBounds(selection.x,selection.y,window.innerWidth,window.innerHeight));setOpen(true)}})
    return()=>controller.abort()
  },[selection,reportId])

  useEffect(()=>{
    if(!anchor||!result?.side){setSource(null);return}
    const controller=new AbortController();setSource(null);setSourceError('')
    const params=new URLSearchParams({path:anchor.path,side:result.side,line:String(anchor.line),end_line:String(Math.min(anchor.line+30,Math.max(anchor.line+8,anchor.end_line+3)))})
    void request<ExplorationSource>(`/api/reports/${reportId}/exploration/source?${params}`,controller.signal).then(data=>{
      if(!controller.signal.aborted){if(data.status!=='ready')setSourceError('Source is still indexing. Select this anchor again when indexing finishes.');else setSource(data)}
    }).catch(e=>{if(!controller.signal.aborted)setSourceError(e.message)})
    return()=>controller.abort()
  },[anchor,result?.side,reportId])

  async function changeView(nextDirection:Direction,nextChanged:boolean,expand=false) {
    const root=current.current.result?.root,side=current.current.result?.side
    if(!root||!side)return
    setDirection(nextDirection);setChanged(nextChanged)
    pending.current?.abort();const gen=++generation.current
    const key=`${nextDirection}:${nextChanged}`,cached=views.current.get(key)
    if(cached&&!expand){setProjection(cached);setBusy('');return}
    const controller=new AbortController();pending.current=controller
    setBusy(expand?'Following compositions and imports':'Reading connections');setError('')
    try{
      const data=await request<ExplorationProjection>(`/api/reports/${reportId}/exploration/expand`,controller.signal,{side,root_id:root.id,direction:nextDirection,changed_only:nextChanged,...(expand&&cached?{query_id:cached.query_id}:{})})
      if(gen!==generation.current)return
      if(!data.nodes)throw new Error('The revision index is unavailable. Select the symbol again.')
      views.current.set(key,data);setProjection(data)
    }catch(e){if(!controller.signal.aborted)setError((e as Error).message)}finally{if(gen===generation.current)setBusy('')}
  }

  function inspect(next:SourceAnchor,edge:ExplorationConnection|null=null){setAnchor(next);setConnection(edge)}
  const layout=projection?fileMapLayout(projection):null
  const selectedNode=projection?.nodes.find(n=>n.path===anchor?.path)
  const boundaryList=projection?.boundaries.filter(b=>!anchor||b.anchor.path===anchor.path)||[]
  const sourceLines=source?.code.split('\n')||[]
  const highlights=anchor&&source?source.anchors.filter(a=>a.path===anchor.path&&a.start_byte===anchor.start_byte):[]
  const snippet=source&&<pre className="exploration-source" aria-label={`Source for ${source.path}`} tabIndex={0}>{sourceLines.map((code,i)=>{
    if(i===sourceLines.length-1&&!code)return null
    const line=source.start_line+i,active=anchor&&line>=anchor.line&&line<=anchor.end_line
    const spans=highlights.filter(a=>a.line===line).map(a=>({start:a.column,end:a.end_line===line?a.end_column:code.length}))
    return <span className={`exploration-source-line${active?' active':''}`} key={line}><span aria-hidden="true" className="exploration-line-number">{line}</span><span className="exploration-source-code" onClick={e=>{const s=sourceClick(e,source.path,source.side,line);if(s)onSelect(s)}}><SyntaxCode code={code||' '} path={source.path} changes={spans}/></span>{'\n'}</span>
  })}</pre>

  return <>
    {result&&<button type="button" className="exploration-reopen" onClick={()=>setOpen(true)}><GitBranch size={13}/> Connections{result.root&&<span>{result.root.name}</span>}</button>}
    {open&&bounds&&createPortal(<div className="symbol-exploration" ref={box} style={bounds} role="dialog" aria-modal="false" aria-labelledby="exploration-title" aria-describedby="exploration-description">
      <header className="exploration-heading"><div><h3 id="exploration-title">{result?.root?.name||result?.name||'Symbol connections'}</h3><p id="exploration-description">{result?.root?.kind&&<span>{result.root.kind} </span>}{result?.side==='old'?'Before':'After'}{result?.revision&&<code>{result.revision.slice(0,8)}</code>}{result?.root&&<span title={result.root.definition.path}>{result.root.definition.path}</span>}</p></div><button type="button" className="exploration-close" aria-label="Close symbol exploration" ref={closeButton} onClick={dismiss}><X size={19}/></button></header>
      {result?.root&&<div className="exploration-controls"><div role="group" aria-label="Exploration direction"><button type="button" aria-pressed={direction==='consumers'} onClick={()=>void changeView('consumers',changed)}>Where it goes</button><button type="button" aria-pressed={direction==='origins'} onClick={()=>void changeView('origins',changed)}>Where it comes from</button></div><label><input type="checkbox" checked={changed} onChange={e=>void changeView(direction,e.target.checked)}/> Changed files only</label><button type="button" className="exploration-definition" onClick={()=>inspect(result.root!.definition)}>Definition</button>{result.occurrence&&<button type="button" onClick={()=>inspect(result.occurrence!)}>Clicked source</button>}</div>}
      {!!busy&&<div className="exploration-progress" role="status"><LoaderCircle size={14} className="spinning"/>{busy}<button type="button" onClick={()=>{pending.current?.abort();generation.current++;setBusy('');setError('Analysis was cancelled. Select the symbol again to continue.')}}>Cancel</button></div>}
      {!!error&&<p className="exploration-error" role="alert">{error}</p>}
      {!projection&&!busy&&!error&&result?.status!=='resolved'&&<div className="exploration-empty"><strong>{result?.status==='unsupported'?'Unsupported language':result?.status==='partial'?'Analysis is incomplete':result?.status==='failed'?'Source indexing failed':'Symbol could not be resolved'}</strong><p>{result?.reason||result?.error||'The retained source does not provide an unambiguous definition.'}</p>{snippet}{sourceError&&<p>{sourceError}</p>}</div>}
      {projection&&layout&&<>
        <div className="exploration-map" aria-label="Composition and import file map"><div className="exploration-map-canvas" style={{width:layout.width,height:layout.height}}>
          <svg width={layout.width} height={layout.height} aria-label="File connections"><defs><marker id="exploration-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#82b4dc"/></marker></defs>{projection.connections.map(edge=>{
            const a=layout.positions.get(edge.source),b=layout.positions.get(edge.target);if(!a||!b)return null
            const parallel=projection.connections.filter(e=>e.source===edge.source&&e.target===edge.target)
            const lane=(parallel.findIndex(e=>e.id===edge.id)-(parallel.length-1)/2)*20
            const x=a.x+210,y=a.y+47+lane,endX=b.x,endY=b.y+47+lane,mid=(x+endX)/2
            return <g key={edge.id} className={edge.indirect?'exploration-indirect':''}><path d={`M${x},${y} C${mid},${y} ${mid},${endY} ${endX},${endY}`} className="exploration-edge" markerEnd="url(#exploration-arrow)"/><path d={`M${x},${y} C${mid},${y} ${mid},${endY} ${endX},${endY}`} className="exploration-edge-hit" role="button" tabIndex={0} aria-label={`Inspect connection from ${edge.source} to ${edge.target}${edge.indirect?` via ${edge.hidden_paths.length} unchanged files`:''}`} onClick={()=>inspect(edge.evidence.at(-1)!.anchor,edge)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(edge.evidence.at(-1)!.anchor,edge)}}}/>{edge.indirect&&<text x={mid} y={(y+endY)/2-7} textAnchor="middle">via {edge.hidden_paths.length} unchanged {edge.hidden_paths.length===1?'file':'files'}</text>}</g>
          })}</svg>
          {projection.nodes.map(node=>{const pos=layout.positions.get(node.path)!;return <div key={node.path} className={`exploration-file${node.path===anchor?.path?' selected':''}${node.path===projection.root.definition.path?' root':''}`} style={{left:pos.x,top:pos.y}}>
            <button type="button" className="exploration-file-name" onClick={()=>inspect(node.symbols[0].anchor)} title={node.path}><FileCode2 size={14}/><strong>{basename(node.path)}</strong><span>{node.changed?'Changed':'Source'}</span></button><small>{node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):'Repository root'}</small><div className="exploration-file-symbols">{node.symbols.filter((symbol,i,all)=>all.findIndex(s=>s.name===symbol.name)===i).map((symbol,i)=><button type="button" key={`${symbol.anchor.start_byte}-${i}`} onClick={()=>inspect(symbol.anchor)} title={`${symbol.name} · line ${symbol.anchor.line}`}>{symbol.name}</button>)}</div>
          </div>})}
        </div></div>
        <div className="exploration-map-footer"><span>{projection.nodes.length} {projection.nodes.length===1?'file':'files'}{projection.status!=='expandable'&&` · ${labels[projection.status]||projection.status}`}</span>{projection.has_more&&<button type="button" disabled={!!busy} onClick={()=>void changeView(direction,changed,true)}>Show more</button>}</div>
        {!projection.coverage.complete&&<details className="exploration-coverage"><summary>Some source could not be analyzed</summary><ul>{projection.coverage.omitted.map((o,i)=><li key={i}>{o.path&&<code>{o.path}: </code>}{o.reason}</li>)}</ul></details>}
        <section className="exploration-inspector" aria-label="Revision source snippets"><header><strong>{anchor?.path||'Select a file or connection'}</strong>{anchor&&<span>Line {anchor.line} · {projection.side==='old'?'Before':'After'}</span>}</header>
          <div className="exploration-anchor-list">{connection?connection.evidence.map((e,i)=><button type="button" key={`${e.id}-${i}`} aria-pressed={anchor?.start_byte===e.anchor.start_byte&&anchor?.path===e.anchor.path} onClick={()=>inspect(e.anchor,connection)}>{e.kind} · {basename(e.anchor.path)}:{e.anchor.line}</button>):selectedNode?.symbols.map((s,i)=><button type="button" key={`${s.anchor.start_byte}-${i}`} aria-pressed={s.anchor.start_byte===anchor?.start_byte} onClick={()=>inspect(s.anchor)}>{s.name}:{s.anchor.line}:{s.anchor.column+1}</button>)}</div>
          <div className="exploration-source-scroll">
            {sourceError&&<p role="alert">{sourceError}</p>}
            {!source&&!sourceError&&anchor&&<p role="status">Reading committed source…</p>}
            {snippet}
            {boundaryList.length>0&&<ul className="exploration-boundaries">{boundaryList.map(b=><li key={b.id}><button type="button" onClick={()=>inspect(b.anchor)}><span>{labels[b.kind]||b.kind}</span> {basename(b.anchor.path)}:{b.anchor.line}{b.hidden&&' · unchanged'}</button><p>{b.reason}</p></li>)}</ul>}
            {projection.boundaries.some(b=>b.hidden)&&<details className="exploration-hidden-boundaries"><summary>Stops in unchanged source</summary><ul>{projection.boundaries.filter(b=>b.hidden).map(b=><li key={b.id}><button type="button" onClick={()=>inspect(b.anchor)}>{labels[b.kind]||b.kind} · {b.anchor.path}:{b.anchor.line}</button><p>{b.reason}</p></li>)}</ul></details>}
          </div>
        </section>
      </>}
    </div>,document.body)}
  </>
}
