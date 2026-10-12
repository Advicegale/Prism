import {ArrowRight,GitBranch,Layers3,Network} from 'lucide-react'
import type {ChangeTopic} from '../types'

interface Props {
 topics:ChangeTopic[]
 groupTitles:Record<string,string>
 onSelectTopic:(id:string)=>void
 onShowAllGraph:()=>void
}

export function ChangeTopicOverview({topics,groupTitles,onSelectTopic,onShowAllGraph}:Props){
 const topicById=new Map(topics.map(topic=>[topic.id,topic]))
 const changedCount=topics.reduce((sum,topic)=>sum+topic.changed_count,0)
 return <section className="topic-overview" aria-label="Review topics">
  <div className="topic-overview-heading">
   <div><strong>Start with a change topic</strong><span>{changedCount} changed symbols across {topics.length} topics. Open a topic to inspect its verified code graph.</span></div>
   <button className="topic-full-graph" onClick={onShowAllGraph}><Network size={14}/> Full symbol graph</button>
  </div>
  {topics.length?<div className="topic-grid">{topics.map(topic=>{
   const groupNames=topic.group_ids.map(id=>groupTitles[id]||id)
   const visibleGroups=groupNames.slice(0,2)
   const extraGroups=Math.max(0,groupNames.length-visibleGroups.length)
   const links=topic.connections.slice(0,2).map(connection=>({connection,other:topicById.get(connection.topic_id)})).filter(item=>item.other)
   return <button className="topic-card" key={topic.id} onClick={()=>onSelectTopic(topic.id)}>
    <div className="topic-card-top"><span className={'topic-source '+(topic.source==='ai'?'ai':'paths')}>{topic.source==='ai'?'AI suggested':'Path based'}</span><ArrowRight size={16}/></div>
    <strong className="topic-card-title">{topic.title}</strong>
    <span className="topic-card-count"><Layers3 size={13}/>{topic.changed_count} changed {topic.changed_count===1?'symbol':'symbols'} <i/> {topic.group_ids.length} structural {topic.group_ids.length===1?'group':'groups'} <i/> {topic.files.length} {topic.files.length===1?'file':'files'}</span>
    <span className="topic-card-groups">{visibleGroups.map(name=><span key={name}>{name}</span>)}{extraGroups>0&&<small>+{extraGroups} more groups</small>}</span>
    {links.length>0&&<span className="topic-card-links">{links.map(({connection,other})=><span key={connection.topic_id}><GitBranch size={12}/>{connection.kind==='shared context'?`Shares ${connection.count} context nodes with`:`Has ${connection.count} direct links to`} {other!.title}</span>)}</span>}
   </button>
  })}</div>:<div className="topic-empty">No change topics were generated for this report.</div>}
 </section>
}
