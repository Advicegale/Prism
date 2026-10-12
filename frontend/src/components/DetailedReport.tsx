import { useState } from 'react'
import { Check, ChevronRight, Code2, Eye, EyeOff, FileCode2, LoaderCircle } from 'lucide-react'
import type { AIChange, ChangeGroup, GraphNode, Harnesses, Report, ReviewAssistantSettings, ReviewStep } from '../types'
import { CodeDiff, SyntaxCode, type DiffLineReference } from './CodeDiff'
import { InlineMarkdown } from './InlineMarkdown'

interface Props {
  report: Report
  harnesses: Harnesses | null
  assistant: ReviewAssistantSettings
  onAssistantChange: (settings: ReviewAssistantSettings) => void
  activeGroup: ChangeGroup | null
  groupTitles: Record<string, string>
  showRoute: boolean
  onNavigate: (groupId:string, symbolId:string)=>void
  viewedAvailable: boolean
  viewedStates: Record<string,string>
  viewedError?: string
  viewedBusyPaths: Set<string>
  hideViewedFiles: boolean
  onHideViewedFilesChange: (hidden:boolean)=>void
  onToggleViewedFile: (path:string,viewed:boolean)=>void
}

interface ChangeEntry {group:ChangeGroup;node:GraphNode;groupIndex:number}

function canonicalPath(report:Report,path:string){
 const file=report.files.find(item=>item.path===path||item.old_path===path)
 return file?.path||file?.old_path||path
}

function diffForSymbol(patch: string, node: GraphNode, evidence?: NonNullable<Report['evidence']>[string]): {patch:string;lineReferences:(DiffLineReference|null)[]} | null {
  const starts = [node.line, evidence?.start_line].filter((line): line is number => typeof line === 'number' && Number.isFinite(line) && line > 0)
  const ends = [node.end, evidence?.end_line].filter((line): line is number => typeof line === 'number' && Number.isFinite(line) && line > 0)
  const symbolStart = Math.min(...(starts.length ? starts : [1]))
  const symbolEnd = Math.max(symbolStart, ...(ends.length ? ends : [symbolStart]))
  const headerMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const sourceIsBase = evidence?.side === 'base' || node.status === 'deleted'
  const selected: {lines:string[];references:(DiffLineReference|null)[]}[] = []
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
    const relevantReferences:(DiffLineReference|null)[] = [null]
    for (const line of current.lines.slice(1)) {
      if (line.startsWith('+')) {
        if (newLine >= newSymbolStart && newLine <= newSymbolEnd) { relevantLines.push(line); relevantReferences.push({newLine}) }
        newLine++
      } else if (line.startsWith('-')) {
        if (oldLine >= oldSymbolStart && oldLine <= oldSymbolEnd) { relevantLines.push(line); relevantReferences.push({oldLine}) }
        oldLine++
      } else if (line.startsWith(' ')) {
        if ((oldLine >= oldSymbolStart && oldLine <= oldSymbolEnd) ||
            (newLine >= newSymbolStart && newLine <= newSymbolEnd)) { relevantLines.push(line); relevantReferences.push({oldLine,newLine}) }
        oldLine++
        newLine++
      } else if (line.startsWith('\\') && relevantLines.length > 1) {
        relevantLines.push(line)
        relevantReferences.push(null)
      }
    }
    if (relevantLines.length > 1) selected.push({lines:relevantLines,references:relevantReferences})
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
  if(!selected.length)return null
  const lines=[diffHeader,...selected.flatMap(item=>item.lines)]
  const lineReferences:(DiffLineReference|null)[]=[null,...selected.flatMap(item=>item.references)]
  return {patch:lines.join('\n'),lineReferences}
}

function Excerpt({ node, report, harnesses, assistant, onAssistantChange }: {node:GraphNode,report:Report,harnesses:Harnesses|null,assistant:ReviewAssistantSettings,onAssistantChange:Props['onAssistantChange']}) {
  const evidence=report.evidence?.[node.id]
  const file=report.files.find(f=>f.path===node.path||f.old_path===node.path)
  const diff=file?diffForSymbol(file.patch,node,evidence):null
  const patch=diff?.patch||''
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
    {patch?<CodeDiff patch={patch} path={path} lineReferences={diff?.lineReferences} inlineQuestion={{reportId:report.id,assistant,harnesses,onAssistantChange}}/>:<pre className="source-code"><SyntaxCode code={code} path={path}/></pre>}
    {!patch&&evidence?.truncated&&<div className="snippet-footnote">Excerpt shortened for readability · source file contains more code</div>}
   </div>
  </>
}

function ReviewRoute({steps,paths,viewedStates}:{steps?:ReviewStep[],paths:string[],viewedStates:Record<string,string>}){
 const seen=new Set<string>()
 const listed=(steps||[]).filter(s=>paths.includes(s.path)&&!seen.has(s.path)&&!!seen.add(s.path))
 const ordered=[...listed,...paths.filter(path=>!seen.has(path)).map(path=>({path,reason:''}))]
 if(!ordered.length)return null
 return <details className="review-order">
  <summary><span>Review order</span><small>{ordered.length} {ordered.length===1?'file':'files'}</small><ChevronRight size={15}/></summary>
  <ol>{ordered.map((step,i)=><li key={step.path} className={viewedStates[step.path]==='VIEWED'?'viewed':''}>
   <span className="review-order-number">{String(i+1).padStart(2,'0')}</span>
   <div className="review-order-file"><code>{step.path}</code>{viewedStates[step.path]==='VIEWED'&&<small className="review-order-viewed">Viewed in GitHub</small>}{step.reason?.trim()&&<details className="review-order-reason"><summary>Why</summary><p><InlineMarkdown text={step.reason}/></p></details>}</div>
  </li>)}</ol>
 </details>
}

function ChangeCard({node,change,report,onNavigate,groupId,harnesses,assistant,onAssistantChange}:{node:GraphNode,change?:AIChange,report:Report,onNavigate:Props['onNavigate'],groupId:string,harnesses:Harnesses|null,assistant:ReviewAssistantSettings,onAssistantChange:Props['onAssistantChange']}) {
 const legacyAI=(report.ai?.schema_version||0)<5
 const file=report.files.find(file=>file.path===node.path||file.old_path===node.path)
 const evidence=report.evidence?.[node.id]
 const hasPatch=!!file&&!!diffForSymbol(file.patch,node,evidence)?.patch
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
   {hasPatch&&<Excerpt node={node} report={report} harnesses={harnesses} assistant={assistant} onAssistantChange={onAssistantChange}/>}
   {!hasPatch&&hasEvidence&&<details className="review-secondary"><summary>Source context</summary><Excerpt node={node} report={report} harnesses={harnesses} assistant={assistant} onAssistantChange={onAssistantChange}/></details>}
 </article>
}

function ReviewFileSection({entries,report,onNavigate,viewedAvailable,viewedStates,viewedBusyPaths,onToggleViewedFile,harnesses,assistant,onAssistantChange}:Pick<Props,'report'|'onNavigate'|'viewedAvailable'|'viewedStates'|'viewedBusyPaths'|'onToggleViewedFile'|'harnesses'|'assistant'|'onAssistantChange'>&{entries:ChangeEntry[]}){
 const path=canonicalPath(report,entries[0]?.node.path||'')
 const viewed=viewedStates[path]==='VIEWED'
 const busy=viewedBusyPaths.has(path)
 return <section className="review-file-section" aria-label={`Changed file ${path}`}>
  <header className="review-file-heading">
   <div className="review-file-title"><span className={'review-file-marker'+(viewed?' viewed':'')}>{viewed?<Check size={12}/>:<FileCode2 size={13}/>}</span><div><strong>{path}</strong><small>{entries.length} changed {entries.length===1?'symbol':'symbols'}{viewed?' · Viewed in GitHub':''}</small></div></div>
   <button className={'review-file-action'+(viewed?' viewed':'')} type="button" disabled={!viewedAvailable||busy} onClick={()=>onToggleViewedFile(path,!viewed)} title={!viewedAvailable?'GitHub CLI must be installed and authenticated to update this status':viewed?'Mark this file as unviewed on GitHub':'Mark this file as viewed on GitHub'}>
    {busy?<LoaderCircle size={13} className="spinning"/>:viewed?<Check size={13}/>:<Eye size={13}/>}{busy?'Saving…':viewed?'Mark unviewed':'Mark viewed'}
   </button>
  </header>
  {entries.map(({group,node})=><ChangeCard key={node.id} node={node} change={report.ai?.groups.find(item=>item.id===group.id)?.changes?.find(item=>item.symbol_id===node.id)} report={report} onNavigate={onNavigate} groupId={group.id} harnesses={harnesses} assistant={assistant} onAssistantChange={onAssistantChange}/>)}
 </section>
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

export function DetailedReport({report,activeGroup,groupTitles,showRoute,onNavigate,viewedAvailable,viewedStates,viewedError,viewedBusyPaths,hideViewedFiles,onHideViewedFilesChange,onToggleViewedFile,harnesses,assistant,onAssistantChange}:Props){
 const [selectedTopicId,setSelectedTopicId]=useState<string|null>(null)
 const globalRoute=report.ai?.review_order
 const reviewRanks=new Map((globalRoute||[]).map((step,index)=>[step.path,index]))
 const topics=reportTopics(report)
 const selectedTopic=topics.find(topic=>topic.id===selectedTopicId)||topics[0]
 const sortedChanges=(groups:ChangeGroup[])=>{
  const seen=new Set<string>()
  return groups.flatMap((group,groupIndex)=>group.changed_ids.map(id=>({group,node:group.graph.nodes.find(item=>item.id===id),groupIndex})).filter((item):item is ChangeEntry=>!!item.node&&!seen.has(item.node.id)&&!!seen.add(item.node.id)))
   .filter(item=>!hideViewedFiles||viewedStates[canonicalPath(report,item.node.path)]!=='VIEWED')
   .sort((a,b)=>(reviewRanks.get(canonicalPath(report,a.node.path))??Number.POSITIVE_INFINITY)-(reviewRanks.get(canonicalPath(report,b.node.path))??Number.POSITIVE_INFINITY)||a.groupIndex-b.groupIndex||a.node.line-b.node.line)
 }
 const fileSections=(changes:ChangeEntry[])=>{
  const byFile=new Map<string,ChangeEntry[]>()
  for(const item of changes){const path=canonicalPath(report,item.node.path);byFile.set(path,[...(byFile.get(path)||[]),item])}
  return [...byFile.entries()]
 }
 const selectedTopicGroups=selectedTopic?.group_ids.map(id=>report.groups.find(group=>group.id===id)).filter((group):group is ChangeGroup=>!!group)||[]
 const topicChanges=selectedTopic?sortedChanges(selectedTopicGroups):[]
 const activeChanges=activeGroup?sortedChanges([activeGroup]):[]
 const changedCount=sortedChanges(report.groups).length
 const reportPaths=Array.from(new Set(report.files.map(file=>file.path||file.old_path).filter((path):path is string=>!!path))).filter(path=>!hideViewedFiles||viewedStates[path]!=='VIEWED')
 return <section className="detailed-report" aria-label="Detailed change review">
   <div className="review-heading"><h3>{activeGroup?'Review this group':'Review changes'}</h3><span>{activeGroup?`${countLabel(activeChanges.length,'symbol')} across ${countLabel(new Set(activeChanges.map(item=>canonicalPath(report,item.node.path))).size,'file')}`:`${countLabel(changedCount,'changed symbol')} across ${countLabel(topics.length,'topic')}`}</span></div>
   {viewedError&&<div className="review-viewed-error" role="status">{viewedError}</div>}
   {showRoute&&!activeGroup&&<ReviewRoute steps={globalRoute} paths={reportPaths} viewedStates={viewedStates}/>}
   <div className={'review-workbench'+(activeGroup?' group-review':'')}>
    {!activeGroup&&topics.length>0&&<nav className="review-topic-rail" aria-label="Review topics">
     <div className="review-topic-rail-heading"><span>Topics</span></div>
     <div className="review-topic-links">{topics.map((topic,index)=>{
      const topicGroups=topic.group_ids.map(id=>report.groups.find(group=>group.id===id)).filter((group):group is ChangeGroup=>!!group)
      const topicEntries=sortedChanges(topicGroups)
      const count=topicEntries.length
      const fileCount=new Set(topicEntries.map(item=>canonicalPath(report,item.node.path))).size
      const fullyViewed=topic.files.length>0&&topic.files.every(path=>viewedStates[canonicalPath(report,path)]==='VIEWED')
      const selected=selectedTopic?.id===topic.id
      return <button type="button" key={topic.id} className={'review-topic-link'+(selected?' selected':'')+(fullyViewed?' completed':'')} title={fullyViewed?'All files in this topic have been viewed in GitHub':undefined} aria-label={`${topic.title} — ${countLabel(count,'symbol')}, ${countLabel(fileCount,'file')}${fullyViewed?', all files viewed':''}`} aria-pressed={selected} onClick={()=>setSelectedTopicId(topic.id)}>
       <span className="review-topic-number">{String(index+1).padStart(2,'0')}</span>
       <span className="review-topic-link-copy"><strong>{topic.title}</strong><small>{countLabel(count,'symbol')}, {countLabel(fileCount,'file')}</small></span>
      </button>
     })}</div>
    </nav>}
    <div className="review-reading-column">
     {activeGroup&&<div className="review-reading-title"><h4>{groupTitles[activeGroup.id]||activeGroup.title}</h4><span>{countLabel(activeChanges.length,'symbol')} across {countLabel(new Set(activeChanges.map(item=>canonicalPath(report,item.node.path))).size,'file')}</span></div>}
     {!activeGroup&&selectedTopic&&<>
      <div className="review-reading-title"><h4>{selectedTopic.title}</h4><span>{countLabel(topicChanges.length,'symbol')} across {countLabel(new Set(topicChanges.map(item=>canonicalPath(report,item.node.path))).size,'file')}</span></div>
      {selectedTopic.focus?.trim()&&<p className="review-topic-focus"><InlineMarkdown text={selectedTopic.focus}/></p>}
      {!topicChanges.length&&hideViewedFiles?<div className="review-filter-empty"><EyeOff size={18}/><span>All files in this topic are marked viewed.</span><button type="button" onClick={()=>onHideViewedFilesChange(false)}>Show viewed files</button></div>:<div className="review-symbol-list">{fileSections(topicChanges).map(([path,entries])=><ReviewFileSection key={path} entries={entries} report={report} onNavigate={onNavigate} viewedAvailable={viewedAvailable} viewedStates={viewedStates} viewedBusyPaths={viewedBusyPaths} onToggleViewedFile={onToggleViewedFile} harnesses={harnesses} assistant={assistant} onAssistantChange={onAssistantChange}/>)}</div>}
     </>}
     {activeGroup&&(!activeChanges.length&&hideViewedFiles?<div className="review-filter-empty"><EyeOff size={18}/><span>All files in this group are marked viewed.</span><button type="button" onClick={()=>onHideViewedFilesChange(false)}>Show viewed files</button></div>:<div className="review-symbol-list">{fileSections(activeChanges).map(([path,entries])=><ReviewFileSection key={path} entries={entries} report={report} onNavigate={onNavigate} viewedAvailable={viewedAvailable} viewedStates={viewedStates} viewedBusyPaths={viewedBusyPaths} onToggleViewedFile={onToggleViewedFile} harnesses={harnesses} assistant={assistant} onAssistantChange={onAssistantChange}/>)}</div>)}
    </div>
   </div>
 </section>
}
