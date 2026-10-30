import {useEffect, useRef} from 'react'

// Collapsible live view of what the assistant CLI is doing (messages and repository-tool calls), newest last.
export function AgentActivity({lines, defaultOpen = false}: {lines?: string[]; defaultOpen?: boolean}) {
  const body = useRef<HTMLPreElement>(null)
  const count = lines?.length ?? 0
  useEffect(() => { const el = body.current; if (el) el.scrollTop = el.scrollHeight }, [count])
  return <details className="agent-activity" open={defaultOpen}>
    <summary>Agent output{count ? ` (${count} ${count === 1 ? 'line' : 'lines'})` : ''}</summary>
    <pre ref={body} tabIndex={0} aria-label="Agent output">{count ? lines!.join('\n') : 'Waiting for the assistant to produce output…'}</pre>
  </details>
}
