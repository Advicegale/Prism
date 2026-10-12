import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, CircleHelp, ExternalLink, LoaderCircle, MessageSquareText, Sparkles } from 'lucide-react'
import type { Harnesses, Job, QuestionAnswer, Report, ReviewAssistantSettings } from '../types'
import { InlineMarkdown } from './InlineMarkdown'

interface Props {
  report: Report
  harnesses: Harnesses | null
  assistant: ReviewAssistantSettings
  onAssistantChange: (settings: ReviewAssistantSettings) => void
  onCitationClick: (symbolId: string) => void
}

interface Turn {
  id: string
  question: string
  answer?: QuestionAnswer
}

const API = '/api'

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function label(harness: string) { return harness === 'claude' ? 'Claude Code' : 'Codex' }

export function ReviewQuestionPanel({ report, harnesses, assistant, onAssistantChange, onCitationClick }: Props) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const { harness, model, effort } = assistant
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const reportId = useRef(report.id)
  const textarea = useRef<HTMLTextAreaElement>(null)
  reportId.current = report.id

  const providerInfo = harnesses?.[harness]
  const installed = !!providerInfo?.installed
  const otherHarness: 'codex' | 'claude' = harness === 'codex' ? 'claude' : 'codex'
  const options = harness === 'codex'
    ? (harnesses?.codex.models || []).map(item => ({ id: item.id, label: item.label || item.id }))
    : (harnesses?.claude.aliases || ['default', 'sonnet', 'opus', 'haiku']).map(id => ({ id, label: id }))
  const selectedModel = harnesses?.[harness]?.models.find(item => item.id === model)
  const efforts = selectedModel?.efforts?.length ? selectedModel.efforts : (providerInfo?.efforts || ['low', 'medium', 'high'])

  useEffect(() => {
    localStorage.setItem('prism:question-harness', harness)
    localStorage.setItem('prism:question-model', model)
    localStorage.setItem('prism:question-effort', effort)
  }, [harness, model, effort])

  useEffect(() => {
    setTurns([])
    setQuestion('')
    setBusy(false)
    setProgress('')
    setError('')
  }, [report.id])

  useEffect(() => {
    if (!harnesses) return
    if (!harnesses[harness].installed && harnesses[otherHarness].installed) {
      onAssistantChange({ harness: otherHarness, model: 'default', effort: 'default' })
    }
  }, [harnesses, harness, otherHarness, onAssistantChange])

  async function ask(value = question) {
    const text = value.trim()
    if (!text || busy || !installed) return
    const turnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const nextTurns = [...turns, { id: turnId, question: text }]
    setTurns(nextTurns)
    setQuestion('')
    setError('')
    setBusy(true)
    setProgress('Sending report context to the selected CLI')
    try {
      const response = await call<{ job_id: string }>(`/reports/${report.id}/questions`, {
        method: 'POST',
        body: JSON.stringify({
          harness, model: model.trim() || 'default', effort,
          question: text,
          history: turns.filter(turn => turn.answer).slice(-6).map(turn => ({ question: turn.question, answer: turn.answer!.answer })),
        }),
      })
      for (;;) {
        await new Promise(resolve => window.setTimeout(resolve, 1200))
        const job = await call<Job>(`/jobs/${response.job_id}`)
        if (reportId.current !== report.id) return
        setProgress(job.message)
        if (job.state === 'failed') throw new Error(job.error || 'The selected CLI could not answer this question.')
        if (job.state === 'completed') {
          const answer = job.result
          if (!answer?.answer) throw new Error('The selected CLI returned no answer.')
          setTurns(current => current.map(turn => turn.id === turnId ? { ...turn, answer } : turn))
          setProgress('')
          setBusy(false)
          window.setTimeout(() => document.getElementById(`question-answer-${turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0)
          return
        }
      }
    } catch (cause) {
      if (reportId.current !== report.id) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setQuestion(text)
      setTurns(current => current.filter(turn => turn.id !== turnId))
      setProgress('')
      setBusy(false)
    }
  }

  const hasProviders = !!harnesses && (harnesses.codex.installed || harnesses.claude.installed)
  const suggestions = [
    'What behavior changed for users?',
    'Which part of this flow deserves the closest review?',
    'What could go wrong at the boundary cases?',
  ]

  return <section className="review-questions" aria-label="Ask a question about this pull request">
    <div className="review-questions-heading">
      <div className="review-questions-title">
        <span className="review-question-icon"><MessageSquareText size={17}/></span>
        <div><h3>Ask this PR</h3><p>Get a focused answer grounded in the changed code.</p></div>
      </div>
      <div className="review-question-settings">
        <label><span>Assistant</span><span className="review-question-select"><select aria-label="Assistant" value={harness} onChange={event => onAssistantChange({ harness: event.target.value as 'codex' | 'claude', model: 'default', effort: 'default' })}>
          <option value="codex" disabled={!harnesses?.codex.installed}>Codex{harnesses && !harnesses.codex.installed ? ' · not installed' : ''}</option>
          <option value="claude" disabled={!harnesses?.claude.installed}>Claude Code{harnesses && !harnesses.claude.installed ? ' · not installed' : ''}</option>
        </select><ChevronDown size={13}/></span></label>
        <label><span>Model</span><input aria-label="Model" list={`question-models-${report.id}`} value={model === 'default' ? '' : model} placeholder="CLI default" onChange={event => onAssistantChange({ ...assistant, model: event.target.value.trim() || 'default' })}/>
          <datalist id={`question-models-${report.id}`}>{options.filter(item => item.id !== 'default').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist>
        </label>
        <label><span>Effort</span><span className="review-question-select"><select aria-label="Reasoning effort" value={effort} onChange={event => onAssistantChange({ ...assistant, effort: event.target.value })}>
          <option value="default">Default</option>{efforts.map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}
        </select><ChevronDown size={13}/></span></label>
      </div>
    </div>

    {!hasProviders && <div className="review-question-unavailable"><CircleHelp size={16}/><span>{harnesses ? 'Install and sign in to Codex CLI or Claude Code to ask questions here.' : 'Checking installed AI assistants…'}</span></div>}

    {!!turns.length && <div className="review-question-thread" aria-live="polite">
      {turns.map(turn => <article className="review-question-turn" key={turn.id}>
        <div className="review-question-user"><span>You</span><p>{turn.question}</p></div>
        {turn.answer ? <div className="review-question-answer" id={`question-answer-${turn.id}`}>
          <div className="review-answer-meta"><span><Sparkles size={13}/>{label(turn.answer.harness)} · {turn.answer.model}</span><a href={report.meta.url} target="_blank" rel="noreferrer" aria-label="Open pull request on GitHub"><ExternalLink size={13}/></a></div>
          <div className="review-answer-copy"><InlineMarkdown text={turn.answer.answer}/></div>
          {!!turn.answer.citations.length && <div className="review-answer-citations"><span>Source</span>{turn.answer.citations.map((citation, index) => citation.symbol_id ? <button key={`${citation.symbol_id}-${index}`} type="button" onClick={() => onCitationClick(citation.symbol_id!)} title={citation.reason || `${citation.path}:${citation.line}`}>
            <span>{citation.path.split(/[\\/]/).pop()}:{citation.line}</span><ArrowUp size={12}/>
          </button> : <span className="review-answer-source" key={`${citation.path}-${citation.line}-${index}`} title={citation.reason}>{citation.path.split(/[\\/]/).pop()}:{citation.line}</span>)}</div>}
        </div> : <div className="review-answer-pending"><LoaderCircle size={14} className="spinning"/><span>{busy ? progress || 'Reading the report evidence' : 'Waiting for an answer'}</span></div>}
      </article>)}
    </div>}

    {!turns.length && hasProviders && <div className="review-question-suggestions" aria-label="Suggested questions">{suggestions.map(item => <button key={item} type="button" onClick={() => { setQuestion(item); textarea.current?.focus() }}>{item}</button>)}</div>}

    <form className="review-question-composer" onSubmit={event => { event.preventDefault(); void ask() }}>
      <textarea ref={textarea} aria-label="Question about the pull request" rows={2} maxLength={2000} value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask() } }} placeholder="Ask about behavior, dependencies, or a review concern…" disabled={!installed || busy}/>
      <div className="review-question-compose-footer"><span>{error ? <span className="review-question-error">{error}</span> : <span>Report excerpts and diffs go to the selected CLI provider.</span>}</span><button type="submit" disabled={!installed || busy || !question.trim()}>{busy ? <LoaderCircle size={15} className="spinning"/> : <ArrowUp size={15}/>}<span>{busy ? 'Thinking' : 'Ask'}</span></button></div>
    </form>
    {error && <button className="review-question-retry" type="button" onClick={() => { setError(''); void ask(question) }}>Retry question</button>}
  </section>
}
