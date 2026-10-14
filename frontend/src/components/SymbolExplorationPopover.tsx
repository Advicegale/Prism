import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {ArrowLeft, ArrowRight, FileCode2, GitBranch, GripHorizontal, LoaderCircle, Maximize2, Minimize2, ZoomIn, ZoomOut, X} from 'lucide-react'
import {clampFrame, clampSplit, clampZoom, describeConnection, fileMapLayout, fitZoom, hideTests as withoutTests, initialMapScroll, isTestPath, mergeExplorationViews, moveFrame, nextMapScroll, panPadding, popoverBounds, resizeFrame, scalePositions, sourceClick, wheelZoom, zoomScroll, FILE_CARD_HEIGHT, FILE_CARD_WIDTH, TEST_LABEL_HEIGHT, WIDE_FRAME_WIDTH, type ExplorationDirection, type ExplorationViews, type Frame, type PopoverMode, type ResizeEdges, type SymbolSelection} from '../exploration'
import type {ExplorationConnection, ExplorationProjection, ExplorationResult, ExplorationSource, SourceAnchor} from '../types'
import {SyntaxCode} from './CodeDiff'

interface Props {reportId:string; selection:SymbolSelection|null; onSelect:(s:SymbolSelection)=>void}
const basename=(path:string)=>path.split('/').pop()||path
/** Header presses on these start text selection or a button, never a window move or size toggle. */
const headerInteractive='button,#exploration-title,#exploration-description'
const labels:Record<string,string>={usage:'Usage endpoint',unresolved:'Unresolved relationship',unsupported:'Unsupported construct',cycle:'Composition cycle',
  no_further_changed_files:'No further changed files',no_further_eligible_connections:'No further eligible connections',partial:'Analysis is incomplete'}

interface WindowLayout {mode:PopoverMode; custom:Frame|null; wide:number; stacked:number; hideTests:boolean}
const LAYOUT_KEY='prism.exploration.layout'
const defaultLayout:WindowLayout={mode:'half',custom:null,wide:0.6,stacked:0.5,hideTests:false}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)
function loadLayout():WindowLayout {
  try{
    const saved=JSON.parse(localStorage.getItem(LAYOUT_KEY)||'null'),c=saved?.custom
    return {mode:saved?.mode==='full'?'full':'half',hideTests:saved?.hideTests===true,wide:finite(saved?.wide)?saved.wide:defaultLayout.wide,stacked:finite(saved?.stacked)?saved.stacked:defaultLayout.stacked,
      custom:c&&[c.left,c.top,c.width,c.height].every(finite)?{left:c.left,top:c.top,width:c.width,height:c.height}:null}
  }catch{return defaultLayout}
}
const resizeHandles:[string,ResizeEdges][]=[['n',{top:true}],['s',{bottom:true}],['w',{left:true}],['e',{right:true}],
  ['nw',{top:true,left:true}],['ne',{top:true,right:true}],['sw',{bottom:true,left:true}],['se',{bottom:true,right:true}]]

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
  const [open,setOpen]=useState(false),[bounds,setBounds]=useState<Frame|null>(null),[layoutState,setLayoutState]=useState(loadLayout)
  const [result,setResult]=useState<ExplorationResult|null>(null),[projections,setProjections]=useState<ExplorationViews>({})
  const [changed,setChanged]=useState(true),[focusVersion,setFocusVersion]=useState(0)
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[anchor,setAnchor]=useState<SourceAnchor|null>(null)
  const [connection,setConnection]=useState<ExplorationConnection|null>(null),[source,setSource]=useState<ExplorationSource|null>(null),[sourceError,setSourceError]=useState('')
  const [mapViewport,setMapViewport]=useState({width:0,height:0}),[focus,setFocus]=useState<'both'|'map'|'source'>('both'),[zoom,setZoom]=useState(1),[fitTick,setFitTick]=useState(0)
  const box=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null),map=useRef<HTMLDivElement>(null),sourceScroller=useRef<HTMLDivElement>(null),closeButton=useRef<HTMLButtonElement>(null),returnFocus=useRef<HTMLElement|null>(null)
  const pending=useRef<AbortController|null>(null),generation=useRef(0),views=useRef(new Map<string,ExplorationProjection>())
  const scroll=useRef<{version:number;x:number;y:number;left:number;top:number;width:number;height:number;zoom:number}|null>(null)
  const current=useRef({result,changed,projections});current.current={result,changed,projections}
  const placement=useRef({open,layout:layoutState,anchorX:typeof window==='undefined'?0:window.innerWidth/2});placement.current.open=open;placement.current.layout=layoutState
  const wide=!!bounds&&bounds.width>=WIDE_FRAME_WIDTH
  const fullTree=useMemo(()=>result?.root?mergeExplorationViews(projections,result.occurrence||result.root.definition):null,[projections,result])
  const testCount=fullTree?fullTree.nodes.filter(n=>n.path!==fullTree.focus.path&&isTestPath(n.path)).length:0
  const filtered=useMemo(()=>fullTree&&layoutState.hideTests&&testCount?withoutTests(fullTree,fullTree.focus.path):null,[fullTree,layoutState.hideTests,testCount])
  const tree=filtered||fullTree,hiddenTests=filtered?.hiddenTests||0
  const layout=useMemo(()=>tree?fileMapLayout(tree,tree.focus.path,mapViewport):null,[tree,mapViewport])
  const pad=panPadding(mapViewport),padRef=useRef(pad);padRef.current=pad
  const zoomRef=useRef(1),zoomJob=useRef<{left:number;top:number}|null>(null),fitJob=useRef(false)

  function dismiss() {setOpen(false);returnFocus.current?.focus({preventScroll:true})}
  /** A dragged/resized frame wins; otherwise sit opposite the clicked token. */
  function place(x:number,layout=placement.current.layout) {
    const width=window.innerWidth,height=window.innerHeight
    return layout.custom?clampFrame(layout.custom,width,height):popoverBounds(x,0,width,height,layout.mode)
  }
  function openAt(x:number) {
    if(placement.current.open)return
    placement.current.anchorX=x;setBounds(place(x))
  }
  useEffect(()=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(layoutState))}catch{/* storage may be unavailable */}},[layoutState])
  useEffect(()=>{
    if(!open)return
    closeButton.current?.focus({preventScroll:true})
    // The diff stays usable while this is open, so Escape must not steal it from text entry.
    const key=(e:KeyboardEvent)=>{
      const target=e.target as HTMLElement|null
      if(e.key==='Escape'&&!e.defaultPrevented&&!target?.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]')){e.stopPropagation();dismiss()}
    }
    const resize=()=>setBounds(place(placement.current.anchorX))
    document.addEventListener('keydown',key);window.addEventListener('resize',resize)
    return()=>{document.removeEventListener('keydown',key);window.removeEventListener('resize',resize)}
  },[open])
  useEffect(()=>{
    pending.current?.abort();generation.current++;views.current.clear();scroll.current=null
    setOpen(false);setResult(null);setProjections({});setAnchor(null);setConnection(null);setSource(null);setBounds(null);setError('');setBusy('');setFocus('both')
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
          openAt(selection!.x);setOpen(true)
          if(!selection!.returnFocus?.closest('.symbol-exploration'))returnFocus.current=selection!.returnFocus||returnFocus.current
          setResult(data);setProjections({});setAnchor(null);setConnection(null);views.current.clear();setFocusVersion(gen);setFocus('both');zoomRef.current=1;zoomJob.current=null;fitJob.current=false;setZoom(1);first=false
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
      openAt(selection.x);setOpen(true)
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
    const measure=()=>{if(element.clientWidth&&element.clientHeight)setMapViewport({width:element.clientWidth,height:element.clientHeight})}  // a hidden (maximized-away) map keeps its last size, so pan survives
    measure();const observer=new ResizeObserver(measure);observer.observe(element)
    return()=>observer.disconnect()
  },[open,!!tree])
  useLayoutEffect(()=>{
    const element=map.current
    if(!open||!element||!tree||!layout)return
    const point=layout.positions.get(tree.focus.path)
    if(!point)return
    const scaled=scalePositions(layout.positions,zoom,pad),card={width:FILE_CARD_WIDTH*zoom,height:FILE_CARD_HEIGHT*zoom},at=scaled.get(tree.focus.path)!
    const previous=scroll.current&&scroll.current.zoom===zoom?scroll.current:null
    let left:number,top:number
    if(zoomJob.current){({left,top}=zoomJob.current);zoomJob.current=null}
    else if(fitJob.current){fitJob.current=false;({left,top}=initialMapScroll(scaled,tree.focus.path,mapViewport,card))}
    else{const next=nextMapScroll(previous,focusVersion,scaled,tree.focus.path,mapViewport,card);left=next.left;top=next.top}
    element.scrollLeft=left;element.scrollTop=top
    scroll.current={version:focusVersion,x:at.x,y:at.y,left:element.scrollLeft,top:element.scrollTop,width:mapViewport.width,height:mapViewport.height,zoom}
  },[open,tree,layout,focusVersion,mapViewport,zoom,fitTick])
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
  /** Pointer-captured drag: `compute` maps total pointer travel to the new value. */
  function track(e:React.PointerEvent<HTMLElement>,apply:(dx:number,dy:number,done:boolean)=>void) {
    if(e.button!==0)return
    e.preventDefault()
    const sx=e.clientX,sy=e.clientY,target=e.currentTarget,id=e.pointerId
    target.setPointerCapture(id)
    const move=(ev:PointerEvent)=>apply(ev.clientX-sx,ev.clientY-sy,false)
    const end=(ev:PointerEvent)=>{
      target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end)
      apply(ev.clientX-sx,ev.clientY-sy,true)
    }
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end)
  }
  function changeFrame(compute:(dx:number,dy:number)=>Frame){
    return(dx:number,dy:number,done:boolean)=>{const next=compute(dx,dy);setBounds(next);if(done)setLayoutState(l=>({...l,custom:next}))}
  }
  function startMove(e:React.PointerEvent<HTMLElement>) {
    if(!bounds||(e.target as HTMLElement).closest(headerInteractive))return
    const start=bounds
    track(e,changeFrame((dx,dy)=>moveFrame(start,dx,dy,window.innerWidth,window.innerHeight)))
  }
  function startResize(e:React.PointerEvent<HTMLElement>,edges:ResizeEdges) {
    if(!bounds)return
    const start=bounds
    track(e,changeFrame((dx,dy)=>resizeFrame(start,edges,dx,dy,window.innerWidth,window.innerHeight)))
  }
  function startSplit(e:React.PointerEvent<HTMLElement>) {
    const element=body.current;if(!element)return
    const rect=element.getBoundingClientRect(),key=wide?'wide':'stacked',size=wide?rect.width:rect.height,origin=wide?rect.left:rect.top
    track(e,(dx,dy)=>{
      const pointer=(wide?e.clientX+dx:e.clientY+dy)-origin
      setLayoutState(l=>({...l,[key]:clampSplit(pointer/size,size)}))
    })
  }
  function nudgeSplit(e:React.KeyboardEvent<HTMLElement>) {
    const element=body.current,key=wide?'wide':'stacked',back=wide?'ArrowLeft':'ArrowUp',forward=wide?'ArrowRight':'ArrowDown'
    if(!element||(e.key!==back&&e.key!==forward&&e.key!=='Home'))return
    e.preventDefault()
    const size=wide?element.clientWidth:element.clientHeight
    setLayoutState(l=>({...l,[key]:e.key==='Home'?defaultLayout[key]:clampSplit(l[key]+(e.key===forward?0.04:-0.04),size)}))
  }
  function toggleSize() {
    const mode:PopoverMode=layoutState.mode==='half'?'full':'half',next={...layoutState,mode,custom:null}
    setLayoutState(next);setBounds(place(placement.current.anchorX,next))
  }
  function headerDoubleClick(e:React.MouseEvent<HTMLElement>) {if(!(e.target as HTMLElement).closest(headerInteractive))toggleSize()}
  /** Inspecting source from a maximized map brings the snippet back so the choice is visible. */
  function inspect(next:SourceAnchor,edge:ExplorationConnection|null=null){setAnchor(next);setConnection(edge);setFocus(f=>f==='map'?'both':f)}
  // Scroll wheel zooms about the cursor. A native non-passive listener is required to stop the page from scrolling.
  useEffect(()=>{
    const element=map.current;if(!open||!element)return
    const wheel=(e:WheelEvent)=>{
      e.preventDefault()
      const from=zoomRef.current,to=wheelZoom(from,e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*400:e.deltaY)
      if(to===from)return
      const box=element.getBoundingClientRect(),base=zoomJob.current||{left:element.scrollLeft,top:element.scrollTop}
      zoomJob.current=zoomScroll(base,{x:e.clientX-box.left,y:e.clientY-box.top},from,to,padRef.current);zoomRef.current=to;setZoom(to)
    }
    element.addEventListener('wheel',wheel,{passive:false})
    return()=>element.removeEventListener('wheel',wheel)
  },[open,!!tree])
  function zoomBy(factor:number) {
    const element=map.current;if(!element)return
    const from=zoomRef.current,to=clampZoom(from*factor);if(to===from)return
    const base=zoomJob.current||{left:element.scrollLeft,top:element.scrollTop}
    zoomJob.current=zoomScroll(base,{x:element.clientWidth/2,y:element.clientHeight/2},from,to,padRef.current);zoomRef.current=to;setZoom(to)
  }
  function fitMap() {
    if(!layout||!tree)return
    const to=fitZoom(layout.positions,{width:FILE_CARD_WIDTH,height:FILE_CARD_HEIGHT},mapViewport)
    zoomJob.current=null;fitJob.current=true;zoomRef.current=to;setZoom(to);setFitTick(tick=>tick+1)
  }
  function startPan(e:React.PointerEvent<HTMLDivElement>) {
    if(e.button!==0||(e.target as HTMLElement).closest('button,a,input,.exploration-edge-hit'))return
    const element=e.currentTarget,startX=e.clientX,startY=e.clientY,left=element.scrollLeft,top=element.scrollTop,id=e.pointerId
    let moved=false
    const move=(ev:PointerEvent)=>{
      const dx=ev.clientX-startX,dy=ev.clientY-startY
      if(!moved){if(Math.hypot(dx,dy)<3)return;moved=true;element.classList.add('panning');element.setPointerCapture(id)}
      element.scrollLeft=left-dx;element.scrollTop=top-dy
    }
    const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);element.classList.remove('panning');if(moved&&element.hasPointerCapture(id))element.releasePointerCapture(id)}
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end)
  }
  function mapKeys(e:React.KeyboardEvent<HTMLDivElement>) {
    if(e.ctrlKey||e.metaKey||e.altKey||e.target!==e.currentTarget)return
    if(e.key==='+'||e.key==='='){e.preventDefault();zoomBy(1.25)}
    else if(e.key==='-'||e.key==='_'){e.preventDefault();zoomBy(0.8)}
    else if(e.key==='0'){e.preventDefault();fitMap()}
  }
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

  // Maximizing a pane collapses the grid to one track; the hidden pane is removed by CSS on data-focus.
  const split=wide?{gridTemplateColumns:`minmax(0,${layoutState.wide}fr) 10px minmax(0,${1-layoutState.wide}fr)`}:{gridTemplateRows:`minmax(0,${layoutState.stacked}fr) 10px minmax(0,${1-layoutState.stacked}fr)`}
  const single=wide?{gridTemplateColumns:'minmax(0,1fr)'}:{gridTemplateRows:'minmax(0,1fr)'}

  return <>
    {result&&<button type="button" className="exploration-reopen" onClick={()=>setOpen(true)}><GitBranch size={16}/> Connections{result.root&&<span>{result.root.name}</span>}</button>}
    {open&&bounds&&createPortal(<div className={`symbol-exploration${wide?' wide':''}`} ref={box} style={bounds} role="dialog" aria-modal="false" aria-labelledby="exploration-title" aria-describedby="exploration-description">
      <header className="exploration-heading" onPointerDown={startMove} onDoubleClick={headerDoubleClick}><GripHorizontal className="exploration-grip" size={18}/><div className="exploration-heading-text"><h3 id="exploration-title">{result?.root?.name||result?.name||'Symbol connections'}</h3><p id="exploration-description">{result?.root?.kind&&<span>{result.root.kind} </span>}{result?.side==='old'?'Before':'After'}{result?.revision&&<code>{result.revision.slice(0,8)}</code>}{result?.occurrence&&<span title={result.occurrence.path}>{result.occurrence.path}:{result.occurrence.line}</span>}</p></div><div className="exploration-window-actions"><button type="button" className="exploration-size" aria-label={layoutState.mode==='half'?'Enlarge to full window':'Shrink to half window'} title={layoutState.mode==='half'?'Full window':'Half window, opposite the clicked token'} onClick={toggleSize}>{layoutState.mode==='half'?<Maximize2 size={19}/>:<Minimize2 size={19}/>}</button><button type="button" className="exploration-close" aria-label="Close symbol exploration" ref={closeButton} onClick={dismiss}><X size={23}/></button></div></header>
      {result?.root&&<div className="exploration-toolbar"><label title="Changed files only"><input type="checkbox" checked={changed} disabled={!!busy} onChange={e=>void changeFilter(e.target.checked)}/> Changed only</label>
        <label title={testCount?`Hide ${testCount} test ${testCount===1?'file':'files'} from the map`:'No test files in this map'}><input type="checkbox" checked={layoutState.hideTests} disabled={!testCount&&!layoutState.hideTests} onChange={e=>setLayoutState(l=>({...l,hideTests:e.target.checked}))}/> Hide tests{testCount>0&&<span className="exploration-count">{testCount}</span>}</label>
        <button type="button" aria-label={projections.origins?.has_more?'Expand upstream':'Upstream complete'} title={projections.origins?.has_more?'Expand upstream':'Upstream complete'} disabled={!!busy||!projections.origins?.has_more} onClick={()=>void expandDirection('origins')}><ArrowLeft size={16}/>{projections.origins?.has_more?'Upstream':'Upstream ✓'}</button>
        <button type="button" aria-label={projections.consumers?.has_more?'Expand downstream':'Downstream complete'} title={projections.consumers?.has_more?'Expand downstream':'Downstream complete'} disabled={!!busy||!projections.consumers?.has_more} onClick={()=>void expandDirection('consumers')}>{projections.consumers?.has_more?'Downstream':'Downstream ✓'}<ArrowRight size={16}/></button>
        <div className="exploration-toolbar-end">{result.occurrence&&<button type="button" onClick={clickedSource}>Clicked source</button>}<button type="button" className="exploration-definition" onClick={()=>inspect(result.root!.definition)}>Definition</button></div></div>}
      {!!busy&&<div className="exploration-progress" role="status"><LoaderCircle size={17} className="spinning"/>{busy}<button type="button" onClick={()=>{pending.current?.abort();generation.current++;setBusy('');setError('Analysis was cancelled. Select the symbol again to continue.')}}>Cancel</button></div>}
      {!!error&&<p className="exploration-error" role="alert">{error}</p>}
      {!tree&&!busy&&!error&&result?.status!=='resolved'&&<div className="exploration-empty"><strong>{result?.status==='unsupported'?'Unsupported language':result?.status==='partial'?'Analysis is incomplete':result?.status==='failed'?'Source indexing failed':'Symbol could not be resolved'}</strong><p>{result?.reason||result?.error||'The retained source does not provide an unambiguous definition.'}</p>{snippet}{sourceError&&<p>{sourceError}</p>}</div>}
      {tree&&layout&&<>
        {!tree.coverage.complete&&<details className="exploration-coverage"><summary>Some source could not be analyzed</summary><ul>{tree.coverage.omitted.map((o,i)=><li key={i}>{o.path&&<code>{o.path}: </code>}{o.reason}</li>)}</ul></details>}
        <div className="exploration-body" data-focus={focus} ref={body} style={focus==='both'?split:single}>
          <section className="exploration-tree-pane" aria-label="Upstream and downstream connections">
            <div className="exploration-map-wrap"><div className="exploration-map" ref={map} role="region" tabIndex={0} aria-label="Composition and import file map. Drag to pan, scroll to zoom, plus and minus keys zoom, zero fits." onPointerDown={startPan} onKeyDown={mapKeys} onScroll={()=>{if(scroll.current&&map.current){scroll.current.left=map.current.scrollLeft;scroll.current.top=map.current.scrollTop}}}><div className="exploration-map-canvas" style={{width:layout.width*zoom+2*pad.x,height:layout.height*zoom+2*pad.y}}><div className="exploration-map-scaled" style={{left:pad.x,top:pad.y,width:layout.width,height:layout.height,transform:`scale(${zoom})`}}>
              <svg width={layout.width} height={layout.height} aria-label="File connections"><defs><marker id="exploration-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#82b4dc"/></marker></defs>{tree.connections.map(edge=>{
                const a=layout.positions.get(edge.source),b=layout.positions.get(edge.target);if(!a||!b)return null
                const parallel=tree.connections.filter(e=>e.source===edge.source&&e.target===edge.target),lane=(parallel.findIndex(e=>e.id===edge.id)-(parallel.length-1)/2)*24
                const x=a.x+FILE_CARD_WIDTH,y=a.y+FILE_CARD_HEIGHT/2+lane,endX=b.x,endY=b.y+FILE_CARD_HEIGHT/2+lane,mid=(x+endX)/2
                const d=a.x===b.x?`M${x},${y} C${x+90},${y} ${endX-90},${endY} ${endX},${endY}`:`M${x},${y} C${mid},${y} ${mid},${endY} ${endX},${endY}`
                const described=describeConnection(edge)
                return <g key={edge.id} className={edge.indirect?'exploration-indirect':''}><path d={d} className={`exploration-edge${connection?.id===edge.id?' selected':''}`} markerEnd="url(#exploration-arrow)"/><path d={d} className="exploration-edge-hit" role="button" tabIndex={0} aria-label={`Inspect connection from ${edge.source} to ${edge.target}: ${described.text}`} onClick={()=>inspect(edge.evidence.at(-1)!.anchor,edge)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(edge.evidence.at(-1)!.anchor,edge)}}}><title>{described.text}</title></path>{edge.indirect&&<text x={mid} y={(y+endY)/2-9} textAnchor="middle">via {edge.hidden_paths.length} unchanged {edge.hidden_paths.length===1?'file':'files'}</text>}</g>
              })}</svg>
              {layout.testGroups.map(group=><div key={`${group.x}`} className="exploration-test-group" aria-hidden="true" style={{left:group.x,top:group.y,width:FILE_CARD_WIDTH,height:TEST_LABEL_HEIGHT}}>Tests</div>)}
              {tree.nodes.map(node=>{const pos=layout.positions.get(node.path)!;const focused=node.path===tree.focus.path,test=isTestPath(node.path);return <div key={node.path} className={`exploration-file${node.changed?' changed':' unchanged'}${test?' test':''}${node.path===anchor?.path?' selected':''}${focused?' focus':''}`} style={{left:pos.x,top:pos.y,width:FILE_CARD_WIDTH,height:FILE_CARD_HEIGHT}}>
                <button type="button" className="exploration-file-name" onClick={()=>inspect(focused?tree.focus:node.symbols[0].anchor)} title={node.path}><FileCode2 size={17}/><strong>{basename(node.path)}</strong></button><small title={node.path}>{node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):'Repository root'}</small><div className="exploration-file-context">{focused&&<span>Clicked source</span>}{test&&<span className="exploration-test-badge" title="Test file (detected from its path)">Test</span>}<span className={`exploration-status ${node.changed?'changed':'unchanged'}`}>{node.changed?'Changed':'Unchanged'}</span></div><div className="exploration-file-symbols">{node.symbols.filter((symbol,i,all)=>all.findIndex(s=>s.name===symbol.name)===i).map((symbol,i)=><button type="button" key={`${symbol.anchor.start_byte}-${i}`} onClick={()=>inspect(symbol.anchor)} title={`${symbol.name} · line ${symbol.anchor.line}`}>{symbol.name}</button>)}</div>
              </div>})}
            </div></div></div>
            <div className="exploration-zoom" role="group" aria-label="Map zoom" title="Scroll to zoom, drag to pan"><button type="button" aria-label="Zoom out" disabled={zoom<=0.4+1e-9} onClick={()=>zoomBy(0.8)}><ZoomOut size={15}/></button><output aria-live="off">{Math.round(zoom*100)}%</output><button type="button" aria-label="Zoom in" disabled={zoom>=2-1e-9} onClick={()=>zoomBy(1.25)}><ZoomIn size={15}/></button><button type="button" className="exploration-fit" onClick={fitMap} title="Fit all files (0)">Fit</button></div></div>
            <div className="exploration-map-footer"><span>{tree.nodes.length} {tree.nodes.length===1?'file':'files'}{hiddenTests>0&&` · ${hiddenTests} ${hiddenTests===1?'test':'tests'} hidden`}{tree.status==='partial'?' · Analysis is incomplete':''}</span><span className="exploration-flow">Inputs → clicked source → consumers</span><span className="exploration-swatches"><i className="changed" aria-hidden="true"/>Changed<i className="unchanged" aria-hidden="true"/>Unchanged</span><button type="button" className="exploration-pane-toggle" aria-label={focus==='map'?'Show both panes':'Maximize map'} title={focus==='map'?'Show both panes':'Maximize map'} onClick={()=>setFocus(f=>f==='map'?'both':'map')}>{focus==='map'?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button></div>
          </section>
          <div className="exploration-splitter" role="separator" tabIndex={0} aria-orientation={wide?'vertical':'horizontal'} aria-label="Resize map and source panes" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((wide?layoutState.wide:layoutState.stacked)*100)} onPointerDown={startSplit} onKeyDown={nudgeSplit} onDoubleClick={()=>setLayoutState(l=>({...l,[wide?'wide':'stacked']:defaultLayout[wide?'wide':'stacked']}))}/>
          <section className="exploration-inspector" aria-label="Revision source snippets"><header><strong title={anchor?.path}>{anchor?.path||'Select a file or connection'}</strong>{anchor&&<span>Line {anchor.line} · {tree.side==='old'?'Before':'After'}</span>}<button type="button" className="exploration-pane-toggle" aria-label={focus==='source'?'Show both panes':'Maximize source'} title={focus==='source'?'Show both panes':'Maximize source'} onClick={()=>setFocus(f=>f==='source'?'both':'source')}>{focus==='source'?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button></header>
            {connection&&<p className="exploration-connection-summary" title={`${connection.source} → ${connection.target}`}>{basename(connection.source)} → {basename(connection.target)} · {describeConnection(connection).kinds.join(' → ')}</p>}
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
      {resizeHandles.map(([name,edges])=><div key={name} className={`exploration-resize ${name}`} aria-hidden="true" onPointerDown={e=>startResize(e,edges)}/>)}
    </div>,document.body)}
  </>
}
