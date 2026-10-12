import { useState } from 'react'
import { ArrowRight, Check, ChevronRight, Code2, FileCode2, GitCompareArrows, ListOrdered } from 'lucide-react'
import type { AIChange, ChangeGroup, GraphNode, Report, ReviewStep } from '../types'
import { CodeDiff, SyntaxCode } from './CodeDiff'

interface Props {
  report: Report
  activeGroup: ChangeGroup | null
  groupTitles: Record<string, string>
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
  if(!code&&!patch)return <p className="evidence-missing">No source excerpt is available for this symbol. Open its file diff to inspect the changes.</p>
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

function ReviewRoute({steps,paths,generated}:{steps?:ReviewStep[],paths:string[],generated:boolean}){
 const seen=new Set<string>()
 const listed=(steps?.length?steps.map(s=>({...s})):paths.map(path=>({path,reason:''}))).filter(s=>paths.includes(s.path)&&!seen.has(s.path)&&!!seen.add(s.path))
 const missing=paths.filter(path=>!seen.has(path)).map(path=>({path,reason:''}))
 return <section className="review-route">
  <div className="detail-section-title"><ListOrdered size={17}/><div><h4>Recommended file review order</h4><p>{generated?'Read these files in sequence to follow the change from its foundations to its consumers.':'Choose Claude Code or Codex to generate a dependency-aware review order. Files are listed for reference.'}</p></div></div>
  <div className="review-steps">{[...listed,...missing].map((step,i)=><div className="review-step" key={step.path}>
   <span className="review-position">{String(i+1).padStart(2,'0')}</span>
   <div><strong>{step.path}</strong>{step.reason&&<p>{step.reason}</p>}</div>
   {i<listed.length+missing.length-1&&<ArrowRight size={15} className="review-arrow"/>}
  </div>)}</div>
 </section>
}

function ChangeCard({node,change,report,onNavigate,groupId}:{node:GraphNode,change?:AIChange,report:Report,onNavigate:Props['onNavigate'],groupId:string}) {
 return <article id={'change-'+node.id} className="change-card">
   <div className="change-card-header">
    <div className="change-card-name"><span className={'change-kind '+node.status}>{node.status}</span><div><h5>{node.qualified||node.label}</h5><span>{node.kind} · {node.path}:{node.line}</span></div></div>
    <button className="small-btn" type="button" onClick={()=>onNavigate(groupId,node.id)}>View in graph <ChevronRight size={14}/></button>
   </div>
   <div className="change-diff-summary"><div className="explanation-label">WHAT CHANGED IN THE DIFF</div><p>{change?.diff_summary||'No symbol-specific diff summary was generated. Regenerate the explanation to include the relevant patch details.'}</p></div>
   <div className="change-explanation">
    <div><div className="explanation-label">WHY IT CHANGED</div><p>{change?.why||'No rationale generated yet. Select an AI harness and generate a detailed explanation.'}</p></div>
    <div><div className="explanation-label">HOW THE NEW IMPLEMENTATION WORKS</div><p>{change?.how_it_works||'The implementation is available below. AI analysis can explain its behavior and dependencies.'}</p></div>
   </div>
   <div className="explanation-label snippet-label">SOURCE EVIDENCE</div>
   <Excerpt node={node} report={report}/>
   {change?.snippet_explanation&&<p className="snippet-interpretation">{change.snippet_explanation}</p>}
 </article>
}

export function DetailedReport({report,activeGroup,groupTitles,onNavigate}:Props){
 const hasDetailedAI=!!report.ai?.groups.some(g=>g.changes?.length)
 const groups=activeGroup?[activeGroup]:report.groups
 const globalRoute=report.ai?.review_order
 return <section className="detailed-report" aria-label="Detailed change review">
   <div className="detailed-heading"><div className="page-eyebrow"><GitCompareArrows size={14}/> DETAILED REVIEW</div><h3>{activeGroup?`${groupTitles[activeGroup.id]||activeGroup.title} · change-by-change`:'Change-by-change walkthrough'}</h3><p>Inspect each modified symbol, the code that implements it, and the most useful path through the affected files.</p></div>
   {!activeGroup&&<ReviewRoute steps={globalRoute} paths={Array.from(new Set(report.files.map(f=>f.path||f.old_path)))} generated={hasDetailedAI}/>}
   {groups.map(group=>{
      const groupAI=report.ai?.groups.find(g=>g.id===group.id)
      const title=groupTitles[group.id]||group.title
      const changed=group.changed_ids.map(id=>group.graph.nodes.find(n=>n.id===id)).filter((n):n is GraphNode=>!!n)
      const content=<div className="group-deep-content">
       <p className="group-deep-summary">{groupAI?.summary||`This segment contains ${changed.length} changed symbols across ${group.files.length} files.`}</p>
       <ReviewRoute steps={groupAI?.review_order} paths={group.files} generated={!!groupAI?.review_order?.length}/>
       <div className="change-cards">{changed.map(node=><ChangeCard key={node.id} node={node} change={groupAI?.changes?.find(c=>c.symbol_id===node.id)} report={report} onNavigate={onNavigate} groupId={group.id}/>)}</div>
      </div>
      return activeGroup?<div key={group.id}>{content}</div>:<details className="change-group-fold" key={group.id} open={groups.length===1}>
       <summary><div><span className="change-fold-label">CHANGE GROUP</span><strong>{title}</strong><small>{changed.length} changed symbols · {group.files.length} files</small></div><ChevronRight size={18}/></summary>
       {content}
      </details>
   })}
 </section>
}
