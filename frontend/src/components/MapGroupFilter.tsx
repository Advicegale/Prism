import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ChevronDown,Filter} from 'lucide-react'

export interface MapGroupOption {name:string;count:number}

interface Props {
 groups:MapGroupOption[]
 hidden:Set<string>
 onToggle:(name:string)=>void
 onShowAll:()=>void
 onHideAll:()=>void
}

export function MapGroupFilter({groups,hidden,onToggle,onShowAll,onHideAll}:Props){
 const detailsRef=useRef<HTMLDetailsElement|null>(null)
 const menuRef=useRef<HTMLDivElement|null>(null)
 const [open,setOpen]=useState(false)
 const [position,setPosition]=useState<{top:number;left:number}|null>(null)
 const visible=groups.length-groups.filter(group=>hidden.has(group.name)).length

 useLayoutEffect(()=>{
  if(!open||!groups.length)return
  const placeMenu=()=>{
   const trigger=detailsRef.current?.querySelector('summary')
   const menu=menuRef.current
   if(!trigger||!menu)return
   const anchor=trigger.getBoundingClientRect()
   const bounds=menu.getBoundingClientRect()
   const gap=7
   const below=window.innerHeight-anchor.bottom
   const top=below>=bounds.height+gap+10?anchor.bottom+gap:Math.max(10,anchor.top-bounds.height-gap)
   const left=Math.min(Math.max(10,anchor.right-bounds.width),window.innerWidth-bounds.width-10)
   setPosition({top,left})
  }
  placeMenu()
  window.addEventListener('resize',placeMenu)
  window.addEventListener('scroll',placeMenu,true)
  return()=>{
   window.removeEventListener('resize',placeMenu)
   window.removeEventListener('scroll',placeMenu,true)
  }
 },[open,groups.length])

 useEffect(()=>{
  if(!open||!groups.length)return
  const closeOutside=(event:PointerEvent)=>{
   const target=event.target as Node
   if(detailsRef.current?.contains(target)||menuRef.current?.contains(target))return
   if(detailsRef.current)detailsRef.current.open=false
   setOpen(false)
  }
  const closeOnEscape=(event:KeyboardEvent)=>{
   if(event.key!=='Escape')return
   if(detailsRef.current)detailsRef.current.open=false
   setOpen(false)
   detailsRef.current?.querySelector('summary')?.focus()
  }
  document.addEventListener('pointerdown',closeOutside)
  document.addEventListener('keydown',closeOnEscape)
  return()=>{
   document.removeEventListener('pointerdown',closeOutside)
   document.removeEventListener('keydown',closeOnEscape)
  }
 },[open,groups.length])

 if(!groups.length)return null
 return <details className="map-group-filter" ref={detailsRef} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary aria-label={`Filter map groups, ${visible} of ${groups.length} visible`} title="Show or hide inferred groups in every map layout">
   <Filter size={14}/><span>Groups</span><small>{visible}/{groups.length}</small><ChevronDown className="map-group-chevron" size={13}/>
  </summary>
  {open&&createPortal(<div ref={menuRef} className="map-group-menu" role="dialog" aria-label="Inferred map groups" style={{top:position?.top??10,left:position?.left??10,visibility:position?'visible':'hidden'}}>
   <div className="map-group-menu-heading"><strong>Visible groups</strong><span>{visible} of {groups.length}</span></div>
   <div className="map-group-menu-actions"><button type="button" onClick={onShowAll}>Show all</button><button type="button" onClick={onHideAll}>Hide all</button></div>
   <div className="map-group-options" role="group" aria-label="Inferred map groups">
    {groups.map(group=><label key={group.name} className="map-group-option">
     <input type="checkbox" checked={!hidden.has(group.name)} onChange={()=>onToggle(group.name)}/>
     <span>{group.name}</span><small>{group.count}</small>
    </label>)}
   </div>
  </div>,document.body)}
 </details>
}
