import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, MessageSquareText } from 'lucide-react'

// Collapsible wrapper for the Ask panel. The children stay mounted while collapsed so conversations and drafts survive.
export function AskShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return <div className={'ask-shell' + (open ? ' open' : '')}>
    <button type="button" className="ask-shell-bar" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span className="review-question-icon"><MessageSquareText size={17}/></span>
      <strong>Ask this PR</strong>
      <span className="ask-shell-hint">Get a focused answer from changed code</span>
      <ChevronDown size={15} className="ask-shell-chevron" aria-hidden="true"/>
    </button>
    <div id={panelId} hidden={!open}>{children}</div>
  </div>
}
