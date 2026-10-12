import { useEffect, useRef, useState } from 'react'
import cytoscape, { type Core } from 'cytoscape'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import type { GraphData, GraphLayout } from '../types'
import { inferComponentRole } from '../graphOrganization'

interface Props { graph:GraphData; selected:string|null; onSelect:(id:string)=>void; layoutMode:GraphLayout }

function treeRoots(graph:GraphData):string[]{
 const byId=new Map(graph.nodes.map(node=>[node.id,node]))
 const neighbors=new Map(graph.nodes.map(node=>[node.id,new Set<string>()]))
 for(const edge of graph.edges){neighbors.get(edge.source)?.add(edge.target);neighbors.get(edge.target)?.add(edge.source)}
 const visited=new Set<string>()
 const roots:string[]=[]
 for(const node of graph.nodes){
  if(visited.has(node.id))continue
  const component:string[]=[]
  const pending=[node.id]
  visited.add(node.id)
  while(pending.length){
   const id=pending.pop()!
   component.push(id)
   for(const next of neighbors.get(id)||[])if(!visited.has(next)){visited.add(next);pending.push(next)}
  }
  const changed=component.map(id=>byId.get(id)!).filter(item=>item.status!=='context')
  const candidates=changed.length?changed:component.map(id=>byId.get(id)!).filter(Boolean)
  candidates.sort((a,b)=>(neighbors.get(b.id)?.size||0)-(neighbors.get(a.id)?.size||0))
  if(candidates[0])roots.push(candidates[0].id)
 }
 return roots
}

function componentPositions(graph:GraphData,nodeRoles:Map<string,string>,width:number):Map<string,{x:number;y:number}>{
 const groups=new Map<string,GraphData['nodes']>()
 for(const node of graph.nodes){const role=nodeRoles.get(node.id)||'Other';groups.set(role,[...(groups.get(role)||[]),node])}
 const preferred=['Controller','Service','Repository','Handler','Provider','Factory','Manager','Client','Adapter','Middleware','Validator','Serializer','Mapper','Store','Cache','Gateway','Strategy','Command','Query','Event','Listener','Consumer','Producer','Decorator','Builder','Coordinator','Resolver','Component','ViewModel','Entity','Model','Request','Response','Config','Settings','Data','Inventory','Utility','Helper','Extension','Enum','Flags','Other']
 const roles=[...groups.keys()].sort((a,b)=>{
  const count=(groups.get(b)?.length||0)-(groups.get(a)?.length||0)
  const ai=preferred.indexOf(a),bi=preferred.indexOf(b)
  return count||((ai<0?preferred.length:ai)-(bi<0?preferred.length:bi))||a.localeCompare(b)
 })
 const columns=Math.min(3,Math.max(1,Math.ceil(Math.sqrt(roles.length))))
 const margin=24
 const cellWidth=(Math.max(width,columns*176)-margin*2)/columns
 const positions=new Map<string,{x:number;y:number}>()
 let rowTop=40
 for(let start=0;start<roles.length;start+=columns){
  const row=roles.slice(start,start+columns)
  const rowSize=Math.max(...row.map(role=>groups.get(role)?.length||1))
  for(let column=0;column<row.length;column++){
   const role=row[column]
   const members=groups.get(role)||[]
   const x=margin+column*cellWidth+cellWidth/2
   members.forEach((node,index)=>positions.set(node.id,{x,y:rowTop+42+index*58}))
  }
  rowTop+=56+rowSize*58
 }
 return positions
}

export function GraphCanvas({graph,selected,onSelect,layoutMode}:Props){
 const container=useRef<HTMLDivElement|null>(null)
 const graphRef=useRef<Core|null>(null)
 const [zoomPercent,setZoomPercent]=useState(100)
 const selectRef=useRef(onSelect)
 selectRef.current=onSelect
 useEffect(()=>{
  if(!container.current)return
  const nodeRoles=new Map(graph.nodes.map(n=>[n.id,inferComponentRole(n)]))
  const roleCounts=new Map<string,number>()
  if(layoutMode==='roles')for(const role of nodeRoles.values())roleCounts.set(role,(roleCounts.get(role)||0)+1)
  const roleParents=layoutMode==='roles'?[...roleCounts].map(([role,count])=>({data:{id:`component-${role.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,label:`${role} · ${count}`},classes:'role-group'})):[]
  const rolesPositions=layoutMode==='roles'?componentPositions(graph,nodeRoles,container.current.clientWidth||640):new Map<string,{x:number;y:number}>()
  const nodes=graph.nodes.map(n=>({data:{id:n.id,label:n.label,kind:n.kind,status:n.status,...(layoutMode==='roles'?{parent:`component-${nodeRoles.get(n.id)?.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`}:{})},...(layoutMode==='roles'?{position:rolesPositions.get(n.id)}:{})}))
  const edges=graph.edges.filter(e=>graph.nodes.some(n=>n.id===e.source)&&graph.nodes.some(n=>n.id===e.target)).map((e,i)=>({data:{id:`edge-${i}`,source:e.source,target:e.target,relation:e.relation,confidence:e.confidence,status:(e as {status?:string}).status||"unchanged"}}))
  const layout=layoutMode==='roles'
   ? {name:'preset',fit:true,padding:32,animate:false} as cytoscape.LayoutOptions
   : layoutMode==='tree'
   ? {name:'breadthfirst',directed:false,circle:false,direction:'rightward',roots:treeRoots(graph),spacingFactor:1.2,avoidOverlap:true,fit:true,padding:60,animate:false} as cytoscape.LayoutOptions
   : {name:'cose',animate:false,randomize:false,fit:true,padding:60,nodeRepulsion:()=>800000,idealEdgeLength:()=>130,edgeElasticity:()=>70,gravity:0.32,componentSpacing:90,numIter:1200} as cytoscape.LayoutOptions
  const cy=cytoscape({container:container.current,elements:[...roleParents,...nodes,...edges],wheelSensitivity:1.3,
   minZoom:0.15,maxZoom:4,
   style:[
    {selector:'node',style:{'shape':'round-rectangle','width':142,'height':52,'background-color':'#171a1a','border-width':1.6,'border-color':'#404545','label':'data(label)','color':'#ecf0ee','font-family':'Inter, system-ui, sans-serif','font-size':12,'font-weight':600,'text-valign':'center','text-halign':'center','text-wrap':'ellipsis','text-max-width':'120px','overlay-opacity':0,'text-outline-width':0}},
    {selector:'node.role-group',style:{'shape':'round-rectangle','background-color':'#1a382b','background-opacity':0.2,'border-width':1.2,'border-color':'#365c42','padding':'14px','label':'data(label)','color':'#a5c9aa','font-size':12,'font-weight':700,'text-valign':'top','text-halign':'center','text-margin-y':7,'text-wrap':'none','overlay-opacity':0}},
    {selector:'node[status="modified"]',style:{'border-color':'#36c5ad','background-color':'#10352e','color':'#adfff0'}},
    {selector:'node[status="added"]',style:{'border-color':'#6e9cff','background-color':'#172a3d','color':'#d0e2ff'}},
    {selector:'node[status="deleted"]',style:{'border-color':'#ff8c89','background-color':'#382128','color':'#ffd9d8'}},
    {selector:'node[status="context"]',style:{'opacity':0.73}},
    {selector:'node[status="renamed"]',style:{'border-color':'#dca4ef'}},
    {selector:'node.is-selected',style:{'border-width':3.5,'border-color':'#f2f7fd','opacity':1,'z-index':90}},
    {selector:'edge',style:{'width':1.6,'line-color':'#535b59','target-arrow-color':'#65716d','target-arrow-shape':'triangle','arrow-scale':0.75,'curve-style':'bezier','opacity':0.65,'label':'data(relation)','color':'#a0aaa6','font-size':8,'text-background-color':'#0d0f0e','text-background-opacity':0.85,'text-background-padding':'3px','text-rotation':'autorotate'}},
    {selector:'edge[status="added"]',style:{'line-color':'#36c5ad','target-arrow-color':'#36c5ad','opacity':.85,'width':2.2}},
    {selector:'edge[status="removed"]',style:{'line-color':'#f58f92','target-arrow-color':'#f58f92','line-style':'dashed','opacity':.78,'width':2}},
    {selector:'edge[confidence="INFERRED"]',style:{'line-style':'dashed','opacity':0.38}},
    {selector:'edge[confidence="AST"]',style:{'line-style':'dashed'}},
   ],
   layout,
  })
  cy.on('tap','node',(event)=>{if(!event.target.hasClass('role-group'))selectRef.current(event.target.id())})
  cy.on('tap',(event)=>{if(event.target===cy)selectRef.current('')})
  graphRef.current=cy
  cy.on('zoom',()=>setZoomPercent(Math.round(cy.zoom()*100)))
  setZoomPercent(Math.round(cy.zoom()*100))
  const resize=new ResizeObserver(()=>cy.resize())
  resize.observe(container.current)
  return()=>{resize.disconnect();cy.destroy();graphRef.current=null}
 },[graph,layoutMode])
 useEffect(()=>{
  const cy=graphRef.current
  if(!cy)return
  cy.nodes().removeClass('is-selected')
  if(selected){const n=cy.getElementById(selected);if(n.length)n.addClass('is-selected')}
 },[selected,graph])
 const zoomTo=(level:number)=>{const cy=graphRef.current;if(cy)cy.zoom({level:Math.max(cy.minZoom(),Math.min(cy.maxZoom(),level)),renderedPosition:{x:cy.width()/2,y:cy.height()/2}})}
 const zoom=(factor:number)=>{const cy=graphRef.current;if(cy)zoomTo(cy.zoom()*factor)}
 return <div className="graph-shell">
   <div ref={container} className="graph-canvas" aria-label="Interactive knowledge graph" role="img"/>
   <div className="graph-controls">
    <button title="Zoom in by 65%" onClick={()=>zoom(1.65)}><ZoomIn size={16}/></button>
    <button title="Zoom out by 39%" onClick={()=>zoom(1/1.65)}><ZoomOut size={16}/></button>
    <span className="ctl-separator"/>
    <label className="graph-zoom-label" title="Drag to set graph zoom">
      <input aria-label="Graph zoom level" type="range" min="15" max="400" step="5" value={Math.min(400,Math.max(15,zoomPercent))} onChange={e=>zoomTo(Number(e.target.value)/100)}/>
      <span>{zoomPercent}%</span>
    </label>
    <span className="ctl-separator"/>
    <button title="Fit graph" onClick={()=>graphRef.current?.fit(undefined,48)}><Maximize2 size={16}/></button>
   </div>
   <div className="graph-gesture-tip">Scroll to zoom · drag to pan</div>
   <div className="graph-legend"><span><i className="legend-dot modified"/> Modified</span><span><i className="legend-dot added"/> Added</span><span><i className="legend-dot deleted"/> Deleted</span>{graph.nodes.some(node=>node.status==='context')&&<span><i className="legend-dot context"/> Context</span>}</div>
   {graph.truncated&&<div className="graph-truncated">Graph limited for readability · select a smaller change group</div>}
  </div>
}
