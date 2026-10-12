import {ArrowRight} from 'lucide-react'
import {inferComponentRole} from '../graphOrganization'
import type {GraphNode,ReviewStep} from '../types'

interface Props {
 steps:ReviewStep[]
 changedNodes:GraphNode[]
 selectedPath:string|null
 onSelect:(path:string)=>void
}

function shortPath(path:string){
 const parts=path.split(/[\\/]/).filter(Boolean)
 return parts.length>2?parts.slice(-2).join('/'):path
}

function fileArea(path:string,nodes:GraphNode[]){
 if(/(?:^|\/)(?:api|route|routes|schema|schemas|type|types|contract|contracts|dto|request|response)(?:\/|\.|$)/i.test(path))return 'API contract'
 const counts=new Map<string,number>()
 for(const node of nodes){
  const role=inferComponentRole(node)
  if(role!=='Other')counts.set(role,(counts.get(role)||0)+1)
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||''
}

export function ReviewPathRail({steps,changedNodes,selectedPath,onSelect}:Props){
 if(!steps.length)return null
 return <section className="review-path" aria-label="Suggested file review order">
  <div className="review-path-heading"><strong>Suggested review order</strong><span>{steps.length} files · AI suggestion · scroll to follow</span></div>
  <div className="review-path-track">
   {steps.map((step,index)=>{
    const nodes=changedNodes.filter(node=>node.path===step.path&&node.status!=='context')
    const area=fileArea(step.path,nodes)
    return <div className="review-path-item" key={step.path}>
     <button className={'review-path-step'+(selectedPath===step.path?' active':'')} aria-pressed={selectedPath===step.path} aria-label={`Review step ${index+1}: ${step.path}. ${step.reason}`} title={`${step.path}\n${step.reason}`} onClick={()=>onSelect(step.path)}>
      <span className="review-path-number">{String(index+1).padStart(2,'0')}</span>
      <span className="review-path-copy">{area&&<small>{area}</small>}<strong>{shortPath(step.path)}</strong><small>{nodes.length?`${nodes.length} changed symbols`:'File change'}</small></span>
     </button>
     {index<steps.length-1&&<ArrowRight className="review-path-arrow" size={14}/>}
    </div>
   })}
  </div>
 </section>
}
