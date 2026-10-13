import type {ArchitectureData,ArchitectureEdge,ArchitectureNode} from '../types'
import type {LayoutInput} from './architectureLayout'
export const architectureColor=(status:string)=>status==='added'?'#89c8a5':status==='context'?'#89b6d4':status==='deleted'?'#ec9398':'#dfb66d'
export function architectureCardHeight(label:string){
 const ctx=typeof document!=='undefined'?document.createElement('canvas').getContext('2d'):null
 if(ctx)ctx.font='650 13px system-ui'
 const lines=Math.max(1,Math.ceil((ctx?ctx.measureText(label).width:label.length*8)/168))
 return Math.ceil(Math.max(96,(lines+1)*17+48)/6)*6
}
export function buildArchitectureDiagram(data:ArchitectureData,nodes:ArchitectureNode[]=data.nodes,measureHeight=architectureCardHeight){
 const support=new Set(data.layers.filter(l=>l.supporting).map(l=>l.id)),runtime=nodes.filter(n=>!support.has(n.layer)),ids=new Set(runtime.map(n=>n.id)),edges=data.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))
  const cards:{id:string;layer:string;label:string;folder:string;status:string;color:string;path:string;fileIds:string[];rank:number;height:number}[]=[]
  const memberships=new Map<string,string>()
  for(const n of runtime){const layer=data.layers.find(l=>l.id===n.layer)!,id=layer.presentation==='bundle'?'bundle:'+n.layer:n.id;memberships.set(n.id,id);const prior=cards.find(b=>b.id===id);if(prior){prior.fileIds.push(n.id);prior.folder=`${prior.fileIds.length} files`;if(prior.status!==(n.status==='context'?'Unchanged context':n.status))prior.status='Mixed changes'}else{const label=layer.presentation==='bundle'?layer.title:n.label;cards.push({id,layer:n.layer,label,folder:layer.presentation==='bundle'?'1 file':n.path.includes('/')?n.path.slice(0,n.path.lastIndexOf('/')):'repository root',status:n.status==='context'?'Unchanged context':n.status,color:architectureColor(n.status),path:n.path,fileIds:[n.id],rank:n.rank??0,height:measureHeight(label)})}}
  const pairs=new Map<string,{id:string;source:string;target:string;refs:ArchitectureEdge[]}>();for(const edge of edges){const source=memberships.get(edge.source)!,target=memberships.get(edge.target)!;if(source===target)continue;const id=JSON.stringify([source,target]);if(!pairs.has(id))pairs.set(id,{id,source,target,refs:[]});pairs.get(id)!.refs.push(edge)}
  const input:LayoutInput={cards:cards.map(c=>({id:c.id,layer:c.layer,rank:c.rank,height:c.height})),groups:data.layers.filter(l=>cards.some(c=>c.layer===l.id)).map(l=>({id:l.id,title:l.title})),pairs:[...pairs.values()].map(p=>({id:p.id,source:p.source,target:p.target}))}
  return {cards,pairs:[...pairs.values()],input}
}
