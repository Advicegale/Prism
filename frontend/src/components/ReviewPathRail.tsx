import {ArrowRight,Check} from 'lucide-react'
import {inferComponentGroups} from '../graphOrganization'
import type {GraphNode,ReviewStep} from '../types'

interface Props {
 steps:ReviewStep[]
 changedNodes:GraphNode[]
 organizationNodes:GraphNode[]
 selectedPath:string|null
 onSelect:(path:string)=>void
 viewedStates?:Record<string,string>
}

function shortPath(path:string){
 const parts=path.split(/[\\/]/).filter(Boolean)
 return parts.length>2?parts.slice(-2).join('/'):path
}

function fileArea(nodes:GraphNode[],groups:Map<string,string>){
 const counts=new Map<string,number>()
 for(const node of nodes){
  const role=groups.get(node.id)||'Other'
  if(role!=='Other')counts.set(role,(counts.get(role)||0)+1)
 }
 return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||''
}

export function ReviewPathRail({steps,changedNodes,organizationNodes,selectedPath,onSelect,viewedStates={}}:Props){
 if(!steps.length)return null
 const groups=inferComponentGroups(organizationNodes)
 return <section className="review-path" aria-label="Suggested file review order">
  <div className="review-path-heading"><strong>Suggested review order</strong><span>{steps.length} files · {steps.filter(step=>viewedStates[step.path]==='VIEWED').length} viewed in GitHub</span></div>
  <div className="review-path-track">
   {steps.map((step,index)=>{
   const nodes=changedNodes.filter(node=>node.path===step.path&&node.status!=='context')
   const area=fileArea(nodes,groups)
   const viewed=viewedStates[step.path]==='VIEWED'
    return <div className="review-path-item" key={step.path}>
     <button className={'review-path-step'+(selectedPath===step.path?' active':'')+(viewed?' viewed':'')} aria-pressed={selectedPath===step.path} aria-label={`Review step ${index+1}: ${step.path}.${viewed?' Viewed in GitHub.':''} ${step.reason}`} title={`${step.path}${viewed?' · Viewed in GitHub':''}\n${step.reason}`} onClick={()=>onSelect(step.path)}>
      <span className="review-path-number">{String(index+1).padStart(2,'0')}</span>
      <span className="review-path-copy">{area&&<small>{area}</small>}<strong>{shortPath(step.path)}</strong><small>{viewed?<><Check size={10}/> Viewed in GitHub</>:nodes.length?`${nodes.length} changed symbols`:'File change'}</small></span>
     </button>
     {index<steps.length-1&&<ArrowRight className="review-path-arrow" size={14}/>}
    </div>
   })}
  </div>
 </section>
}
