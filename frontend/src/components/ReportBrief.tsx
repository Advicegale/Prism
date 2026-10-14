import { useId, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { Report } from '../types'
import { MarkdownContent } from './MarkdownContent'

interface Props {
  report: Report
  busy: boolean
  canGenerate: boolean
  onGenerate: () => void
}

// The brief sits above the Ask bar: a clamped overview that expands on demand, or a one-line prompt to generate notes.
export function ReportBrief({ report, busy, canGenerate, onGenerate }: Props) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const ai = report.ai
  if (!ai) {
    if (report.demo) return null
    return <div className="review-summary-empty"><p>File diffs are ready. Generate review notes to add change summaries and a suggested reading order.</p><button type="button" className="secondary-btn" disabled={busy || !canGenerate} onClick={onGenerate}><Sparkles size={14}/> Generate review notes</button></div>
  }
  const changes = ai.key_changes || []
  const expandable = !!ai.overview || !!changes.length
  return <section className="report-brief" aria-label="Pull request brief">
    <div className="report-brief-head"><h3>Pull request brief</h3>{expandable && <button type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}<ChevronDown size={14}/></button>}</div>
    <div id={bodyId} className={'report-brief-body' + (expanded ? ' expanded' : '')}>
      {ai.overview && <MarkdownContent text={ai.overview}/>}
      {expanded && !!changes.length && <ul aria-label="Key changes">{changes.map((change, index) => <li key={index}><MarkdownContent text={change}/></li>)}</ul>}
    </div>
  </section>
}
