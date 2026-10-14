import { useRef, useState } from 'react'
import { ArrowUp, ChevronDown, LoaderCircle, MessageSquareText, Sparkles, X } from 'lucide-react'
import type { DiffLineAnchor, Harnesses, Job, QuestionAnswer, ReviewAssistantSettings } from '../types'
import { MarkdownContent } from './MarkdownContent'

interface Props {
  reportId: string
  anchor: DiffLineAnchor
  assistant: ReviewAssistantSettings
  harnesses: Harnesses | null
  onAssistantChange: (settings: ReviewAssistantSettings) => void
  onConversationStarted: () => void
  onClose: () => void
}

interface Turn { id: string; question: string; answer?: QuestionAnswer }

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function lineLabel(lines: number[], sign: string) {
  if (!lines.length) return ''
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  if (sorted.length === 1) return `${sign}${sorted[0]}`
  return `${sign}${sorted[0]}–${sorted[sorted.length - 1]}`
}

function anchorLabel(anchor: DiffLineAnchor) {
  return [lineLabel(anchor.new_lines, '+'), lineLabel(anchor.old_lines, '−')].filter(Boolean).join(' · ')
}

function providerLabel(harness: string) { return harness === 'claude' ? 'Claude Code' : 'Codex' }

export function InlineDiffChat({ reportId, anchor, assistant, harnesses, onAssistantChange, onConversationStarted, onClose }: Props) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [includeRepositoryContext, setIncludeRepositoryContext] = useState(false)
  const [editingCustomModel, setEditingCustomModel] = useState(false)
  const reportIdRef = useRef(reportId)
  reportIdRef.current = reportId
  const providerInfo = harnesses?.[assistant.harness]
  const installed = !!providerInfo?.installed
  const modelOptions = assistant.harness === 'codex'
    ? (harnesses?.codex.models || []).map(item => ({ id: item.id, label: item.label || item.id }))
    : (harnesses?.claude.aliases || ['default', 'sonnet', 'opus', 'haiku']).map(id => ({ id, label: id }))
  const selectedModel = providerInfo?.models.find(item => item.id === assistant.model)
  const efforts = selectedModel?.efforts?.length ? selectedModel.efforts : (providerInfo?.efforts || ['low', 'medium', 'high'])

  async function ask(value = question) {
    const text = value.trim()
    if (!text || busy || !installed) return
    const turnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const history = turns.filter(turn => turn.answer).slice(-6)
    onConversationStarted()
    setTurns(current => [...current, { id: turnId, question: text }])
    setQuestion('')
    setError('')
    setBusy(true)
    setProgress(includeRepositoryContext ? 'Opening read-only repository tools' : 'Sending the selected diff lines to the assistant')
    try {
      const response = await call<{ job_id: string }>(`/reports/${reportId}/questions`, {
        method: 'POST',
        body: JSON.stringify({
          harness: assistant.harness,
          model: assistant.model.trim() || 'default',
          effort: assistant.effort,
          question: text,
          include_repository_context: includeRepositoryContext,
          anchor,
          history: history.map(turn => ({ question: turn.question, answer: turn.answer!.answer })),
        }),
      })
      for (;;) {
        await new Promise(resolve => window.setTimeout(resolve, 1000))
        const job = await call<Job>(`/jobs/${response.job_id}`)
        if (reportIdRef.current !== reportId) return
        setProgress(job.message)
        if (job.state === 'failed') throw new Error(job.error || 'The assistant could not answer this question.')
        if (job.state === 'completed') {
          if (!job.result?.answer) throw new Error('The assistant returned no answer.')
          setTurns(current => current.map(turn => turn.id === turnId ? { ...turn, answer: job.result! } : turn))
          setBusy(false)
          setProgress('')
          return
        }
      }
    } catch (cause) {
      if (reportIdRef.current !== reportId) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setQuestion(text)
      setTurns(current => current.filter(turn => turn.id !== turnId))
      setBusy(false)
      setProgress('')
    }
  }

  return <section className="inline-diff-chat" aria-label={`Ask about ${anchor.path} ${anchorLabel(anchor)}`}>
    <header className="inline-diff-chat-heading">
      <div className="inline-diff-chat-title"><span><MessageSquareText size={14}/></span><div><strong>Ask about these lines</strong><small><code>{anchor.path}</code> · {anchorLabel(anchor)}</small></div></div>
      <button type="button" className="inline-diff-chat-close" onClick={onClose} aria-label="Close inline chat"><X size={15}/></button>
    </header>

    {!!turns.length && <div className="inline-diff-chat-thread" aria-live="polite">
      {turns.map(turn => <article className="inline-diff-chat-turn" key={turn.id}>
        <p className="inline-diff-chat-question">{turn.question}</p>
        {turn.answer ? <div className="inline-diff-chat-answer">
          <div className="inline-diff-chat-provider"><Sparkles size={12}/>{providerLabel(turn.answer.harness)} · {turn.answer.model}</div>
          <MarkdownContent className="inline-diff-chat-copy" text={turn.answer.answer}/>
          {!!turn.answer.citations.length && <div className="inline-diff-chat-citations">Grounded in {turn.answer.citations.map((citation, index) => <span key={`${citation.path}-${citation.line}-${index}`}><code>{citation.path.split(/[\\/]/).pop()}:{citation.line}</code>{index < turn.answer!.citations.length - 1 ? ', ' : ''}</span>)}</div>}
        </div> : <div className="inline-diff-chat-pending"><LoaderCircle size={13} className="spinning"/>{busy ? progress || 'Reading the selected lines' : 'Waiting for an answer'}</div>}
      </article>)}
    </div>}

    {!installed && <p className="inline-diff-chat-unavailable">{harnesses ? `${providerLabel(assistant.harness)} is not installed. Choose an available assistant from the Assistant button in the top bar.` : 'Checking available assistants…'}</p>}
    <form className="inline-diff-chat-composer" onSubmit={event => { event.preventDefault(); void ask() }}>
      <textarea aria-label="Question about selected diff lines" rows={2} maxLength={2000} value={question} disabled={!installed || busy} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask() } }} placeholder="What should I know about this change?"/>
      <div className="inline-diff-chat-footer">
        <span className={error ? 'inline-diff-chat-status-error' : undefined} role={error ? 'alert' : undefined}>{error || `${providerLabel(assistant.harness)} CLI`}</span>
        <div className="inline-diff-chat-settings" aria-label="Inline chat model and reasoning effort">
          <label className="inline-diff-chat-model-control" title="Model"><span className="inline-diff-chat-visually-hidden">Model</span>{editingCustomModel
            ? <input className="inline-diff-chat-custom-model" aria-label="Custom inline chat model ID" autoFocus value={assistant.model === 'default' ? '' : assistant.model} placeholder="Enter model ID" onChange={event => onAssistantChange({ ...assistant, model: event.target.value.trim() || 'default' })} onBlur={() => setEditingCustomModel(false)} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); setEditingCustomModel(false) } }}/>
            : <span className="inline-diff-chat-select"><select aria-label="Inline chat model" value={assistant.model} onChange={event => { if (event.target.value === '__custom_model__') setEditingCustomModel(true); else onAssistantChange({ ...assistant, model: event.target.value }) }}>
              <option value="default">CLI default</option>{!modelOptions.some(item => item.id === assistant.model) && assistant.model !== 'default' && <option value={assistant.model}>{assistant.model}</option>}{modelOptions.filter(item => item.id !== 'default').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="__custom_model__">Custom model ID…</option>
            </select><ChevronDown size={12}/></span>}
          </label>
          <label className="inline-diff-chat-effort-control" title="Reasoning effort"><span className="inline-diff-chat-visually-hidden">Effort</span><span className="inline-diff-chat-select"><select aria-label="Inline chat reasoning effort" value={assistant.effort} onChange={event => onAssistantChange({ ...assistant, effort: event.target.value })}>
            <option value="default">Default</option>{efforts.map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}
          </select><ChevronDown size={12}/></span></label>
        </div>
        <button type="submit" disabled={!installed || busy || !question.trim()}>{busy ? <LoaderCircle size={13} className="spinning"/> : <ArrowUp size={13}/>}<span>{busy ? 'Thinking' : 'Ask'}</span></button>
      </div>
    </form>
    <div className="inline-diff-chat-hint">
      <label title="Allow the selected CLI to browse tracked source files at this PR revision through read-only Prism tools. Retrieved code is sent to that CLI.">
        <input type="checkbox" checked={includeRepositoryContext} disabled={!installed || busy} onChange={event => setIncludeRepositoryContext(event.target.checked)}/>
        <span>Allow repository browsing</span>
      </label>
      <span>Retrieved source goes to the selected CLI; diff lines stay in focus.</span>
    </div>
  </section>
}
