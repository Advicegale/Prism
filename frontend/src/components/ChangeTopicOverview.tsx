import {ArrowRight,GitBranch,Network} from 'lucide-react'
import type {ChangeTopic} from '../types'

interface Props {
 topics:ChangeTopic[]
 groupTitles:Record<string,string>
 onSelectTopic:(id:string)=>void
 onShowAllGraph:()=>void
}

export function ChangeTopicOverview({topics,groupTitles,onSelectTopic,onShowAllGraph}:Props){
 const topicById=new Map(topics.map(topic=>[topic.id,topic]))
 return <section className="topic-overview" aria-label="Review topics">
  <div className="topic-overview-heading">
   <button className="topic-full-graph" onClick={onShowAllGraph}><Network size={14}/> View full graph</button>
  </div>
  {topics.length?<div className="topic-list">{topics.map(topic=>{
   const groupNames=topic.group_ids.map(id=>groupTitles[id]||id)
   const visibleGroups=groupNames.slice(0,2)
   const extraGroups=Math.max(0,groupNames.length-visibleGroups.length)
   const links=topic.connections.slice(0,1).map(connection=>({connection,other:topicById.get(connection.topic_id)})).filter(item=>item.other)
   return <button className="topic-row" key={topic.id} onClick={()=>onSelectTopic(topic.id)}>
    <span className="topic-row-main">
     <span className="topic-row-title"><strong>{topic.title}</strong><ArrowRight size={15}/></span>
     {topic.focus&&<span className="topic-row-focus">{topic.focus}</span>}
     <span className="topic-row-facts"><span>{topic.changed_count} {topic.changed_count===1?'symbol':'symbols'}</span><span>{topic.files.length} {topic.files.length===1?'file':'files'}</span><span>{topic.group_ids.length} {topic.group_ids.length===1?'group':'groups'}</span></span>
    </span>
    <span className="topic-row-context">
     <span className="topic-origin">{topic.source==='ai'?'AI suggested':'Grouped by file area'}</span>
     {visibleGroups.length>0&&<span className="topic-row-groups">{visibleGroups.join(' · ')}{extraGroups>0?` · +${extraGroups}`:''}</span>}
     {links.map(({connection,other})=><span className="topic-row-link" key={connection.topic_id}><GitBranch size={12}/>{connection.kind==='shared context'?'Shares '+connection.count+' code symbols with':'Connected to'} {other!.title}</span>)}
    </span>
   </button>
  })}</div>:<div className="topic-empty">No change topics were generated for this report.</div>}
 </section>
}
