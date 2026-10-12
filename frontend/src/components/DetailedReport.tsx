import { useState } from 'react'
import { Check, ChevronRight, Code2, FileCode2 } from 'lucide-react'
import type { AIChange, ChangeGroup, GraphNode, Report, ReviewStep } from '../types'
import { CodeDiff, SyntaxCode } from './CodeDiff'
import { InlineMarkdown } from './InlineMarkdown'

interface Props {
  report: Report
  activeGroup: ChangeGroup | null
  groupTitles: Record<string, string>
  showRoute: boolean
  onNavigate: (groupId:string, symbolId:string)=>void
}

function diffForSymbol(patch: string, node: GraphNode, evidence?: NonNullable<Report['evidence']>[string]) {
  const starts = [node.line, evidence?.start_line].filter((line): line is number => typeof line === 'number' && Number.isFinite(line) && line > 0)
  const ends = [node.end, evidence?.end_line].filter((line): line is number => typeof line === 'number' && Number.isFinite(line) && line > 0)
  const symbolStart = Math.min(...(starts.length ? starts : [1]))
  const symbolEnd = Math.max(symbolStart, ...(ends.length ? ends : [symbolStart]))
  const headerMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const sourceIsBase = evidence?.side === 'base' || node.status === 'deleted'
  const selected: string[] = []
  let diffHeader = ''
  let current: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] } | null = null

  const keepIfRelevant = () => {
    if (!current) return
    const offset = current.oldStart - current.newStart
    const oldSymbolStart = sourceIsBase ? symbolStart : symbolStart + offset
    const oldSymbolEnd = sourceIsBase ? symbolEnd : symbolEnd + offset
    const newSymbolStart = sourceIsBase ? symbolStart - offset : symbolStart
    const newSymbolEnd = sourceIsBase ? symbolEnd - offset : symbolEnd
    let oldLine = current.oldStart
    let newLine = current.newStart
    const relevantLines = [current.lines[0]]
    for (const line of current.lines.slice(1)) {
      if (line.startsWith('+')) {
        if (newLine >= newSymbolStart && newLine <= newSymbolEnd) relevantLines.push(line)
        newLine++
      } else if (line.startsWith('-')) {
        if (oldLine >= oldSymbolStart && oldLine <= oldSymbolEnd) relevantLines.push(line)
        oldLine++
      } else if (line.startsWith(' ')) {
        if ((oldLine >= oldSymbolStart && oldLine <= oldSymbolEnd) ||
            (newLine >= newSymbolStart && newLine <= newSymbolEnd)) relevantLines.push(line)
        oldLine++
        newLine++
      } else if (line.startsWith('\\') && relevantLines.length > 1) {
        relevantLines.push(line)
      }
    }
    if (relevantLines.length > 1) selected.push(relevantLines.join('\n'))
    current = null
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      keepIfRelevant()
      diffHeader = line
      continue
    }
    const match = headerMatch.exec(line)
    if (match) {
      keepIfRelevant()
      current = {
        oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [line],
      }
    } else if (current) {
      current.lines.push(line)
    }
  }
  keepIfRelevant()
  return selected.length ? `${diffHeader}\n${selected.join('\n')}` : ''
}

function Excerpt({ node, report }: {node:GraphNode,report:Report}) {
  const evidence=report.evidence?.[node.id]
  const file=report.files.find(f=>f.path===node.path||f.old_path===node.path)
  const patch=file?diffForSymbol(file.patch,node,evidence):''
  const added=patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).length
  const removed=patch.split('\n').filter(line=>line.startsWith('-')&&!line.startsWith('---')).length
  const code=evidence?.code || file?.patch?.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).slice(0,25).map(line=>line.slice(1)).join('\n') || ''
  const [copied,setCopied]=useState(false)
  if(!code&&!patch)return null
  const line=evidence?.start_line ?? node.line
  const path=evidence?.path||file?.path||file?.old_path||node.path
  const sourceLabel=evidence?.side==='base'||node.status==='deleted'?'Previous implementation':'PR implementation'
  const copyValue=patch?patch.split('\n').filter(row=>!row.startsWith('diff --git ')&&!row.startsWith('@@ ')).join('\n'):code
  return <>
   <div className="source-evidence">
    <div className="source-diff-header">
      <span className="source-evidence-title"><Code2 size={14}/>{sourceLabel}<span className="snippet-line">{path}:{line}</span></span>
      <span className="source-evidence-actions">
       {patch&&<span className="diff-tally"><b className="added">+{added}</b><b className="removed">−{removed}</b></span>}
       <button type="button" onClick={()=>navigator.clipboard?.writeText(copyValue).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1300)})} title={patch?'Copy diff':'Copy code'}>{copied?<Check size={14}/>:<FileCode2 size={14}/>} {copied?'Copied':patch?'Copy diff':'Copy code'}</button>
      </span>
    </div>
    {patch?<CodeDiff patch={patch} path={path}/>:<pre className="source-code"><SyntaxCode code={code} path={path}/></pre>}
    {!patch&&evidence?.truncated&&<div className="snippet-footnote">Excerpt shortened for readability · source file contains more code</div>}
   </div>
  </>
}

function ReviewRoute({steps,paths}:{steps?:ReviewStep[],paths:string[]}){
 const seen=new Set<string>()
 const listed=(steps||[]).filter(s=>paths.includes(s.path)&&!seen.has(s.path)&&!!seen.add(s.path))
 const ordered=[...listed,...paths.filter(path=>!seen.has(path)).map(path=>({path,reason:''}))]
 if(!ordered.length)return null
 return <details className="review-order">
  <summary><span>Review order</span><small>{ordered.length} {ordered.length===1?'file':'files'}</small><ChevronRight size={15}/></summary>
  <ol>{ordered.map((step,i)=><li key={step.path}>
   <span className="review-order-number">{String(i+1).padStart(2,'0')}</span>
   <div className="review-order-file"><code>{step.path}</code>{step.reason?.trim()&&<details className="review-order-reason"><summary>Why</summary><p><InlineMarkdown text={step.reason}/></p></details>}</div>
  </li>)}</ol>
 </details>
}

function ChangeCard({node,change,report,onNavigate,groupId}:{node:GraphNode,change?:AIChange,report:Report,onNavigate:Props['onNavigate'],groupId:string}) {
 const legacyAI=(report.ai?.schema_version||0)<5
 const file=report.files.find(file=>file.path===node.path||file.old_path===node.path)
 const evidence=report.evidence?.[node.id]
 const hasPatch=!!file&&!!diffForSymbol(file.patch,node,evidence)
 const hasEvidence=!!evidence?.code||!!file?.patch
 return <article id={'change-'+node.id} className="review-symbol">
   <header className="review-symbol-heading">
    <span className={'change-kind '+node.status}>{node.status}</span>
    <div className="review-symbol-title"><h5>{node.qualified||node.label}</h5><div><span>{node.kind}</span><code>{node.path}:{node.line}</code></div></div>
    <button className="review-graph-link" type="button" onClick={()=>onNavigate(groupId,node.id)}>Map <ChevronRight size={14}/></button>
   </header>
   {change?.diff_summary?.trim()&&<p className="review-change-summary"><InlineMarkdown text={change.diff_summary}/></p>}
   {change?.why?.trim()&&!legacyAI&&<details className="review-secondary"><summary>Why it changed</summary><p><InlineMarkdown text={change.why}/></p></details>}
   {!!change?.review_notes?.length&&<div className="review-action-note"><span>Check</span><ul>{change.review_notes.map((note,index)=><li key={index}><InlineMarkdown text={note}/></li>)}</ul></div>}
   {hasPatch&&<Excerpt node={node} report={report}/>}
   {!hasPatch&&hasEvidence&&<details className="review-secondary"><summary>Source context</summary><Excerpt node={node} report={report}/></details>}
 </article>
}

interface ReviewTopic {id:string;title:string;focus?:string;source:'ai'|'paths';group_ids:string[];files:string[]}

function countLabel(count:number,label:string){return `${count} ${label}${count===1?'':'s'}`}

function reportTopics(report:Report):ReviewTopic[]{
 const groupsById=new Map(report.groups.map(group=>[group.id,group]))
 const availableIds=new Set(groupsById.keys())
 const sourceTopics=(report.ai?.topics?.length?report.ai.topics:report.topics)||[]
 const topics:ReviewTopic[]=[]
 const covered=new Set<string>()
 for(const topic of sourceTopics){
  const group_ids=(Array.isArray(topic.group_ids)?topic.group_ids:[]).filter(id=>availableIds.has(id)&&!covered.has(id))
  if(!group_ids.length)continue
  group_ids.forEach(id=>covered.add(id))
  topics.push({id:topic.id,title:topic.title,focus:topic.focus,source:topic.source,group_ids,files:[...new Set(group_ids.flatMap(id=>groupsById.get(id)?.files||[]))]})
 }
 const uncovered=report.groups.filter(group=>!covered.has(group.id))
 if(uncovered.length)topics.push({id:'other-changes',title:topics.length?'Other changes':'All changes',source:'paths',group_ids:uncovered.map(group=>group.id),files:[...new Set(uncovered.flatMap(group=>group.files))]})
 return topics
}

export function DetailedReport({report,activeGroup,groupTitles,showRoute,onNavigate}:Props){
 const [selectedTopicId,setSelectedTopicId]=useState<string|null>(null)
 const globalRoute=report.ai?.review_order
 const reviewRanks=new Map((globalRoute||[]).map((step,index)=>[step.path,index]))
 const topics=reportTopics(report)
 const selectedTopic=topics.find(topic=>topic.id===selectedTopicId)||topics[0]
 const sortedChanges=(groups:ChangeGroup[])=>groups.flatMap((group,groupIndex)=>group.changed_ids.map(id=>({group,node:group.graph.nodes.find(item=>item.id===id),groupIndex})).filter((item):item is {group:ChangeGroup,node:GraphNode,groupIndex:number}=>!!item.node)).sort((a,b)=>(reviewRanks.get(a.node.path)??Number.POSITIVE_INFINITY)-(reviewRanks.get(b.node.path)??Number.POSITIVE_INFINITY)||a.groupIndex-b.groupIndex||a.node.line-b.node.line)
 const selectedTopicGroups=selectedTopic?.group_ids.map(id=>report.groups.find(group=>group.id===id)).filter((group):group is ChangeGroup=>!!group)||[]
 const topicChanges=selectedTopic?sortedChanges(selectedTopicGroups):[]
 const activeChanges=activeGroup?sortedChanges([activeGroup]):[]
 const changedCount=sortedChanges(report.groups).length
 const reportPaths=Array.from(new Set(report.files.map(file=>file.path||file.old_path).filter((path):path is string=>!!path)))
 return <section className="detailed-report" aria-label="Detailed change review">
   <div className="review-heading"><h3>{activeGroup?'Review this group':'Review changes'}</h3><span>{activeGroup?`${countLabel(activeChanges.length,'symbol')} across ${countLabel(activeGroup.files.length,'file')}`:`${countLabel(changedCount,'changed symbol')} across ${countLabel(topics.length,'topic')}`}</span></div>
   {showRoute&&!activeGroup&&<ReviewRoute steps={globalRoute} paths={reportPaths}/>}
   <div className={'review-workbench'+(activeGroup?' group-review':'')}>
    {!activeGroup&&topics.length>0&&<nav className="review-topic-rail" aria-label="Review topics">
     <div className="review-topic-rail-heading"><span>Topics</span></div>
     <div className="review-topic-links">{topics.map((topic,index)=>{
      const topicGroups=topic.group_ids.map(id=>report.groups.find(group=>group.id===id)).filter((group):group is ChangeGroup=>!!group)
      const count=sortedChanges(topicGroups).length
      const selected=selectedTopic?.id===topic.id
      return <button type="button" key={topic.id} className={'review-topic-link'+(selected?' selected':'')} aria-pressed={selected} onClick={()=>setSelectedTopicId(topic.id)}>
       <span className="review-topic-number">{String(index+1).padStart(2,'0')}</span>
       <span className="review-topic-link-copy"><strong>{topic.title}</strong><small>{countLabel(count,'symbol')}, {countLabel(topic.files.length,'file')}</small></span>
      </button>
     })}</div>
    </nav>}
    <div className="review-reading-column">
     {activeGroup&&<div className="review-reading-title"><h4>{groupTitles[activeGroup.id]||activeGroup.title}</h4><span>{countLabel(activeChanges.length,'symbol')} across {countLabel(activeGroup.files.length,'file')}</span></div>}
     {!activeGroup&&selectedTopic&&<>
      <div className="review-reading-title"><h4>{selectedTopic.title}</h4><span>{countLabel(topicChanges.length,'symbol')} across {countLabel(selectedTopic.files.length,'file')}</span></div>
      {selectedTopic.focus?.trim()&&<p className="review-topic-focus"><InlineMarkdown text={selectedTopic.focus}/></p>}
      <div className="review-symbol-list">{topicChanges.map(({group,node})=><ChangeCard key={node.id} node={node} change={report.ai?.groups.find(item=>item.id===group.id)?.changes?.find(item=>item.symbol_id===node.id)} report={report} onNavigate={onNavigate} groupId={group.id}/>)}</div>
     </>}
     {activeGroup&&<div className="review-symbol-list">{activeChanges.map(({group,node})=><ChangeCard key={node.id} node={node} change={report.ai?.groups.find(item=>item.id===group.id)?.changes?.find(item=>item.symbol_id===node.id)} report={report} onNavigate={onNavigate} groupId={group.id}/>)}</div>}
    </div>
   </div>
 </section>
}
