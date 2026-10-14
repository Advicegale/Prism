import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {ArrowLeft, ArrowRight, FileCode2, GitBranch, LoaderCircle, X} from 'lucide-react'
import {fileMapLayout, mergeExplorationViews, popoverBounds, sourceClick, FILE_CARD_HEIGHT, FILE_CARD_WIDTH, type ExplorationDirection, type ExplorationViews, type SymbolSelection} from '../exploration'
import type {ExplorationConnection, ExplorationProjection, ExplorationResult, ExplorationSource, SourceAnchor} from '../types'
import {SyntaxCode} from './CodeDiff'

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
  const [result,setResult]=useState<ExplorationResult|null>(null),[projections,setProjections]=useState<ExplorationViews>({})
  const [changed,setChanged]=useState(true),[focusVersion,setFocusVersion]=useState(0)
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[anchor,setAnchor]=useState<SourceAnchor|null>(null)
  const [connection,setConnection]=useState<ExplorationConnection|null>(null),[source,setSource]=useState<ExplorationSource|null>(null),[sourceError,setSourceError]=useState('')
  const [mapViewport,setMapViewport]=useState({width:0,height:0})
  const box=useRef<HTMLDivElement>(null),map=useRef<HTMLDivElement>(null),sourceScroller=useRef<HTMLDivElement>(null),closeButton=useRef<HTMLButtonElement>(null),returnFocus=useRef<HTMLElement|null>(null)
  const pending=useRef<AbortController|null>(null),generation=useRef(0),views=useRef(new Map<string,ExplorationProjection>())
  const scroll=useRef<{version:number;x:number;y:number;left:number;top:number;width:number;height:number}|null>(null)
  const current=useRef({result,changed,projections});current.current={result,changed,projections}
  const tree=useMemo(()=>result?.root?mergeExplorationViews(projections,result.occurrence||result.root.definition):null,[projections,result])
  const layout=useMemo(()=>tree?fileMapLayout(tree,tree.focus.path,mapViewport):null,[tree,mapViewport])

  function dismiss() {setOpen(false);returnFocus.current?.focus({preventScroll:true})}
  useEffect(()=>{
    if(!open)return
    closeButton.current?.focus({preventScroll:true})
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();dismiss()}}
    const outside=(e:PointerEvent)=>{if(box.current&&!box.current.contains(e.target as Node)&&!(e.target as HTMLElement).closest('.exploration-reopen'))setOpen(false)}
    document.addEventListener('keydown',key);document.addEventListener('pointerdown',outside)
    const resize=()=>setBounds(popoverBounds(0,0,window.innerWidth,window.innerHeight))
    window.addEventListener('resize',resize)
    return()=>{document.removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',resize)}
  },[open])
  useEffect(()=>{
    pending.current?.abort();generation.current++;views.current.clear();scroll.current=null
    setOpen(false);setResult(null);setProjections({});setAnchor(null);setConnection(null);setSource(null);setBounds(null);setError('');setBusy('')
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
          setResult(data);setProjections({});setAnchor(null);setConnection(null);views.current.clear();setFocusVersion(gen);first=false
        }
        if(data.status==='indexing'){
          setBusy(data.message||'Indexing committed source');await pause(controller.signal);continue
        }
        setResult(data);setChanged(true)
        if(data.status==='resolved'&&data.root){
          const initial:ExplorationViews={...data.projections,consumers:data.projections?.consumers||data.projection}
          setProjections(initial);setAnchor(data.occurrence||data.root.definition)
          for(const direction of ['consumers','origins'] as const)if(initial[direction])views.current.set(`${direction}:true`,initial[direction]!)
          // Older servers still provide a single initial projection.
          if(!initial.origins&&initial.consumers){
            setBusy('Reading upstream connections')
            const origins=await request<ExplorationProjection>(`/api/reports/${reportId}/exploration/expand`,controller.signal,{side:data.side,root_id:data.root.id,direction:'origins',changed_only:true,context_query_id:initial.consumers.query_id})
            if(gen!==generation.current)return
            if(!origins.nodes)throw new Error('The revision index is unavailable. Select the symbol again.')
            views.current.set('origins:true',origins);setProjections({...initial,origins})
          }
        }else if(data.occurrence)setAnchor(data.occurrence)
        setBusy('');return
      }
    }
    void resolve().catch(e=>{if(!controller.signal.aborted&&gen===generation.current){
      setBusy('');setError(String(e.message));setResult(null);setProjections({});setAnchor(null);setSource(null)
      setBounds(b=>b||popoverBounds(selection.x,selection.y,window.innerWidth,window.innerHeight));setOpen(true)
    }})
    return()=>controller.abort()
  },[selection,reportId])

  useEffect(()=>{
    if(!anchor||!result?.side){setSource(null);return}
    const controller=new AbortController();setSource(null);setSourceError('')
    const params=new URLSearchParams({path:anchor.path,side:result.side,line:String(anchor.line),end_line:String(Math.min(anchor.line+40,Math.max(anchor.line+24,anchor.end_line+3)))})
    void request<ExplorationSource>(`/api/reports/${reportId}/exploration/source?${params}`,controller.signal).then(data=>{
      if(!controller.signal.aborted){if(data.status!=='ready')setSourceError('Source is still indexing. Select this anchor again when indexing finishes.');else setSource(data)}
    }).catch(e=>{if(!controller.signal.aborted)setSourceError(e.message)})
    return()=>controller.abort()
  },[anchor,result?.side,reportId])

  useLayoutEffect(()=>{
    const element=map.current;if(!open||!element)return
    const measure=()=>setMapViewport({width:element.clientWidth,height:element.clientHeight})
    measure();const observer=new ResizeObserver(measure);observer.observe(element)
    return()=>observer.disconnect()
  },[open,!!tree])
  useLayoutEffect(()=>{
    const element=map.current,point=tree&&layout?.positions.get(tree.focus.path)
    if(!open||!element||!point)return
    const previous=scroll.current
    const recenter=!previous||previous.version!==focusVersion||previous.width!==mapViewport.width||previous.height!==mapViewport.height
    element.scrollLeft=recenter?point.x+FILE_CARD_WIDTH/2-element.clientWidth/2:previous.left+point.x-previous.x
    element.scrollTop=recenter?point.y+FILE_CARD_HEIGHT/2-element.clientHeight/2:previous.top+point.y-previous.y
    scroll.current={version:focusVersion,x:point.x,y:point.y,left:element.scrollLeft,top:element.scrollTop,width:mapViewport.width,height:mapViewport.height}
  },[open,tree,layout,focusVersion,mapViewport])
  useLayoutEffect(()=>{
    const scroller=sourceScroller.current,active=scroller?.querySelector<HTMLElement>('.exploration-source-line.active')
    if(scroller&&active)scroller.scrollTop=Math.max(0,active.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop-80)
  },[source,anchor,open])

  async function changeFilter(nextChanged:boolean) {
    const {result:resolved,projections:present}=current.current
    if(!resolved?.root||!resolved.side)return
    setChanged(nextChanged);pending.current?.abort();const gen=++generation.current
    const cached:ExplorationViews={consumers:views.current.get(`consumers:${nextChanged}`),origins:views.current.get(`origins:${nextChanged}`)}
    if(cached.consumers&&cached.origins){setProjections(cached);setBusy('');return}
    const controller=new AbortController();pending.current=controller;setBusy('Reading connections');setError('')
    try{
      const context=present.consumers?.query_id||present.origins?.query_id
      const entries=await Promise.all((['consumers','origins'] as const).map(async direction=>{
        const data=cached[direction]||await request<ExplorationProjection>(`/api/reports/${reportId}/exploration/expand`,controller.signal,{side:resolved.side,root_id:resolved.root!.id,direction,changed_only:nextChanged,context_query_id:context})
        if(!data.nodes)throw new Error('The revision index is unavailable. Select the symbol again.')
        return [direction,data] as const
      }))
      if(gen!==generation.current)return
      for(const [direction,data] of entries)views.current.set(`${direction}:${nextChanged}`,data)
      setProjections(Object.fromEntries(entries))
    }catch(e){if(!controller.signal.aborted&&gen===generation.current){setChanged(current.current.projections.consumers?.changed_only??!nextChanged);setError((e as Error).message)}}
    finally{if(gen===generation.current)setBusy('')}
  }
  async function expandDirection(direction:ExplorationDirection) {
    const {result:resolved,changed:filter,projections:present}=current.current,cursor=present[direction]
    if(!resolved?.root||!resolved.side||!cursor?.has_more)return
    pending.current?.abort();const gen=++generation.current,controller=new AbortController();pending.current=controller
    setBusy(direction==='origins'?'Following upstream connections':'Following downstream connections');setError('')
    try{
      const data=await request<ExplorationProjection>(`/api/reports/${reportId}/exploration/expand`,controller.signal,{side:resolved.side,root_id:resolved.root.id,direction,changed_only:filter,query_id:cursor.query_id})
      if(gen!==generation.current)return
      if(!data.nodes)throw new Error('The revision index is unavailable. Select the symbol again.')
      views.current.set(`${direction}:${filter}`,data);setProjections(current=>({...current,[direction]:data}))
    }catch(e){if(!controller.signal.aborted&&gen===generation.current)setError((e as Error).message)}finally{if(gen===generation.current)setBusy('')}
  }
  function inspect(next:SourceAnchor,edge:ExplorationConnection|null=null){setAnchor(next);setConnection(edge)}
  function clickedSource(){
    if(!result?.occurrence)return
    inspect(result.occurrence)
    const point=layout?.positions.get(result.occurrence.path),element=map.current
    if(element&&point){element.scrollLeft=point.x+FILE_CARD_WIDTH/2-element.clientWidth/2;element.scrollTop=point.y+FILE_CARD_HEIGHT/2-element.clientHeight/2}
  }
  const selectedNode=tree?.nodes.find(n=>n.path===anchor?.path)
  const boundaryList=tree?.boundaries.filter(b=>!anchor||b.anchor.path===anchor.path)||[]
  const sourceLines=source?.code.split('\n')||[]
  const snippet=source&&<pre className="exploration-source" aria-label={`Source for ${source.path}`} tabIndex={0}>{sourceLines.map((code,i)=>{
    if(i===sourceLines.length-1&&!code)return null
    const line=source.start_line+i,active=anchor&&line>=anchor.line&&line<=anchor.end_line
    const spans=anchor&&source.anchors.filter(a=>a.path===anchor.path&&a.start_byte===anchor.start_byte&&a.line===line).map(a=>({start:a.column,end:a.end_line===line?a.end_column:code.length}))||[]
    return <span className={`exploration-source-line${active?' active':''}`} key={line}><span aria-hidden="true" className="exploration-line-number">{line}</span><span className="exploration-source-code" onClick={e=>{const s=sourceClick(e,source.path,source.side,line);if(s)onSelect(s)}}><SyntaxCode code={code||' '} path={source.path} changes={spans}/></span>{'\n'}</span>
  })}</pre>

  return <>
    {result&&<button type="button" className="exploration-reopen" onClick={()=>setOpen(true)}><GitBranch size={16}/> Connections{result.root&&<span>{result.root.name}</span>}</button>}
    {open&&bounds&&createPortal(<div className="symbol-exploration" ref={box} style={bounds} role="dialog" aria-modal="false" aria-labelledby="exploration-title" aria-describedby="exploration-description">
      <header className="exploration-heading"><div><h3 id="exploration-title">{result?.root?.name||result?.name||'Symbol connections'}</h3><p id="exploration-description">{result?.root?.kind&&<span>{result.root.kind} </span>}{result?.side==='old'?'Before':'After'}{result?.revision&&<code>{result.revision.slice(0,8)}</code>}{result?.occurrence&&<span title={result.occurrence.path}>{result.occurrence.path}:{result.occurrence.line}</span>}</p></div><button type="button" className="exploration-close" aria-label="Close symbol exploration" ref={closeButton} onClick={dismiss}><X size={23}/></button></header>
      {result?.root&&<div className="exploration-controls"><label><input type="checkbox" checked={changed} disabled={!!busy} onChange={e=>void changeFilter(e.target.checked)}/> Changed files only</label>{result.occurrence&&<button type="button" onClick={clickedSource}>Clicked source</button>}<button type="button" className="exploration-definition" onClick={()=>inspect(result.root!.definition)}>Definition</button></div>}
      {!!busy&&<div className="exploration-progress" role="status"><LoaderCircle size={17} className="spinning"/>{busy}<button type="button" onClick={()=>{pending.current?.abort();generation.current++;setBusy('');setError('Analysis was cancelled. Select the symbol again to continue.')}}>Cancel</button></div>}
      {!!error&&<p className="exploration-error" role="alert">{error}</p>}
      {!tree&&!busy&&!error&&result?.status!=='resolved'&&<div className="exploration-empty"><strong>{result?.status==='unsupported'?'Unsupported language':result?.status==='partial'?'Analysis is incomplete':result?.status==='failed'?'Source indexing failed':'Symbol could not be resolved'}</strong><p>{result?.reason||result?.error||'The retained source does not provide an unambiguous definition.'}</p>{snippet}{sourceError&&<p>{sourceError}</p>}</div>}
      {tree&&layout&&<>
        {!tree.coverage.complete&&<details className="exploration-coverage"><summary>Some source could not be analyzed</summary><ul>{tree.coverage.omitted.map((o,i)=><li key={i}>{o.path&&<code>{o.path}: </code>}{o.reason}</li>)}</ul></details>}
        <div className="exploration-body">
          <section className="exploration-tree-pane" aria-label="Upstream and downstream connections">
            <div className="exploration-expansion-controls"><button type="button" disabled={!!busy||!projections.origins?.has_more} onClick={()=>void expandDirection('origins')}><ArrowLeft size={16}/>{projections.origins?.has_more?'Expand upstream':'Upstream complete'}</button><button type="button" disabled={!!busy||!projections.consumers?.has_more} onClick={()=>void expandDirection('consumers')}>{projections.consumers?.has_more?'Expand downstream':'Downstream complete'}<ArrowRight size={16}/></button></div>
            <div className="exploration-map" ref={map} role="region" tabIndex={0} aria-label="Composition and import file map" onScroll={()=>{if(scroll.current&&map.current){scroll.current.left=map.current.scrollLeft;scroll.current.top=map.current.scrollTop}}}><div className="exploration-map-canvas" style={{width:layout.width,height:layout.height}}>
              <svg width={layout.width} height={layout.height} aria-label="File connections"><defs><marker id="exploration-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#82b4dc"/></marker></defs>{tree.connections.map(edge=>{
                const a=layout.positions.get(edge.source),b=layout.positions.get(edge.target);if(!a||!b)return null
                const parallel=tree.connections.filter(e=>e.source===edge.source&&e.target===edge.target),lane=(parallel.findIndex(e=>e.id===edge.id)-(parallel.length-1)/2)*24
                const x=a.x+FILE_CARD_WIDTH,y=a.y+FILE_CARD_HEIGHT/2+lane,endX=b.x,endY=b.y+FILE_CARD_HEIGHT/2+lane,mid=(x+endX)/2
                const d=a.x===b.x?`M${x},${y} C${x+90},${y} ${endX-90},${endY} ${endX},${endY}`:`M${x},${y} C${mid},${y} ${mid},${endY} ${endX},${endY}`
                return <g key={edge.id} className={edge.indirect?'exploration-indirect':''}><path d={d} className="exploration-edge" markerEnd="url(#exploration-arrow)"/><path d={d} className="exploration-edge-hit" role="button" tabIndex={0} aria-label={`Inspect connection from ${edge.source} to ${edge.target}${edge.indirect?` via ${edge.hidden_paths.length} unchanged files`:''}`} onClick={()=>inspect(edge.evidence.at(-1)!.anchor,edge)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(edge.evidence.at(-1)!.anchor,edge)}}}/>{edge.indirect&&<text x={mid} y={(y+endY)/2-9} textAnchor="middle">via {edge.hidden_paths.length} unchanged {edge.hidden_paths.length===1?'file':'files'}</text>}</g>
              })}</svg>
              {tree.nodes.map(node=>{const pos=layout.positions.get(node.path)!;const focused=node.path===tree.focus.path;return <div key={node.path} className={`exploration-file${node.path===anchor?.path?' selected':''}${focused?' focus':''}`} style={{left:pos.x,top:pos.y,width:FILE_CARD_WIDTH,height:FILE_CARD_HEIGHT}}>
                <button type="button" className="exploration-file-name" onClick={()=>inspect(focused?tree.focus:node.symbols[0].anchor)} title={node.path}><FileCode2 size={17}/><strong>{basename(node.path)}</strong></button><small title={node.path}>{node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):'Repository root'}</small><div className="exploration-file-context">{focused?<span>Clicked source</span>:<span>{node.changed?'Changed file':'Source file'}</span>}</div><div className="exploration-file-symbols">{node.symbols.filter((symbol,i,all)=>all.findIndex(s=>s.name===symbol.name)===i).map((symbol,i)=><button type="button" key={`${symbol.anchor.start_byte}-${i}`} onClick={()=>inspect(symbol.anchor)} title={`${symbol.name} · line ${symbol.anchor.line}`}>{symbol.name}</button>)}</div>
              </div>})}
            </div></div>
            <div className="exploration-map-footer"><span>{tree.nodes.length} {tree.nodes.length===1?'file':'files'}{tree.status==='partial'?' · Analysis is incomplete':''}</span><span>Inputs → clicked source → consumers</span></div>
          </section>
          <section className="exploration-inspector" aria-label="Revision source snippets"><header><strong title={anchor?.path}>{anchor?.path||'Select a file or connection'}</strong>{anchor&&<span>Line {anchor.line} · {tree.side==='old'?'Before':'After'}</span>}</header>
            <div className="exploration-anchor-list">{connection?connection.evidence.map((e,i)=><button type="button" key={`${e.id}-${i}`} aria-pressed={anchor?.start_byte===e.anchor.start_byte&&anchor?.path===e.anchor.path} onClick={()=>inspect(e.anchor,connection)}>{e.kind} · {basename(e.anchor.path)}:{e.anchor.line}</button>):selectedNode?.symbols.filter((s,i,all)=>all.findIndex(other=>other.anchor.start_byte===s.anchor.start_byte&&other.anchor.end_byte===s.anchor.end_byte)===i).map((s,i)=><button type="button" key={`${s.anchor.start_byte}-${i}`} aria-pressed={s.anchor.start_byte===anchor?.start_byte} onClick={()=>inspect(s.anchor)}>{s.name}:{s.anchor.line}</button>)}</div>
            <div className="exploration-source-scroll" ref={sourceScroller}>
              {sourceError&&<p role="alert">{sourceError}</p>}
              {!source&&!sourceError&&anchor&&<p role="status">Reading committed source…</p>}
              {snippet}
              {boundaryList.length>0&&<ul className="exploration-boundaries">{boundaryList.map(b=><li key={b.id}><button type="button" onClick={()=>inspect(b.anchor)}><span>{labels[b.kind]||b.kind}</span> {basename(b.anchor.path)}:{b.anchor.line}{b.hidden&&' · unchanged'}</button><p>{b.reason}</p></li>)}</ul>}
              {tree.boundaries.some(b=>b.hidden)&&<details className="exploration-hidden-boundaries"><summary>Stops in unchanged source</summary><ul>{tree.boundaries.filter(b=>b.hidden).map(b=><li key={b.id}><button type="button" onClick={()=>inspect(b.anchor)}>{labels[b.kind]||b.kind} · {b.anchor.path}:{b.anchor.line}</button><p>{b.reason}</p></li>)}</ul></details>}
            </div>
          </section>
        </div>
      </>}
    </div>,document.body)}
  </>
}
