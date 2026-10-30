import { useEffect, useRef, useState } from 'react'
import { ArrowUp, CircleHelp, ExternalLink, LoaderCircle, MessageSquareText, Sparkles } from 'lucide-react'
import type { Harnesses, Job, QuestionAnswer, Report, ReviewAssistantSettings } from '../types'
import { assistantSummary } from '../assistantSettings'
import { MarkdownContent } from './MarkdownContent'
import { AgentActivity } from './AgentActivity'

interface Props {
  report: Report
  harnesses: Harnesses | null
  assistant: ReviewAssistantSettings
  onOpenAssistant: () => void
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

export function ReviewQuestionPanel({ report, harnesses, assistant, onOpenAssistant, onCitationClick }: Props) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const { harness, model, effort } = assistant
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [activity, setActivity] = useState<string[]>([])
  const [error, setError] = useState('')
  const reportId = useRef(report.id)
  const textarea = useRef<HTMLTextAreaElement>(null)
  reportId.current = report.id

  const installed = !!harnesses?.[harness]?.installed

  useEffect(() => {
    setTurns([])
    setQuestion('')
    setBusy(false)
    setProgress('')
    setError('')
  }, [report.id])

  async function ask(value = question) {
    const text = value.trim()
    if (!text || busy || !installed) return
    const turnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const nextTurns = [...turns, { id: turnId, question: text }]
    setTurns(nextTurns)
    setQuestion('')
    setError('')
    setBusy(true)
    setActivity([])
    setProgress('Reading PR and repository context')
    try {
      const response = await call<{ job_id: string }>(`/reports/${report.id}/questions`, {
        method: 'POST',
        body: JSON.stringify({
          harness, model: model.trim() || 'default', effort, timeout_seconds: assistant.timeout_seconds,
          question: text,
          history: turns.filter(turn => turn.answer).slice(-6).map(turn => ({ question: turn.question, answer: turn.answer!.answer })),
        }),
      })
      for (;;) {
        await new Promise(resolve => window.setTimeout(resolve, 1200))
        const job = await call<Job>(`/jobs/${response.job_id}`)
        if (reportId.current !== report.id) return
        setProgress(job.message)
        setActivity(job.activity || [])
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
        <div><h3>Ask this PR</h3><p>Explore this change and its surrounding implementation.</p></div>
      </div>
      <div className="assistant-line"><span>Assistant: <strong>{assistantSummary(assistant)}</strong>{harnesses && !installed ? ' · not installed' : ''}</span><button type="button" className="assistant-change-btn" aria-label="Change assistant" onClick={onOpenAssistant}>Change</button></div>
    </div>

    {!hasProviders && <div className="review-question-unavailable"><CircleHelp size={16}/><span>{harnesses ? 'Install and sign in to Codex CLI or Claude Code to ask questions here.' : 'Checking installed AI assistants…'}</span></div>}

    {!!turns.length && <div className="review-question-thread" aria-live="polite">
      {turns.map(turn => <article className="review-question-turn" key={turn.id}>
        <div className="review-question-user"><span>You</span><p>{turn.question}</p></div>
        {turn.answer ? <div className="review-question-answer" id={`question-answer-${turn.id}`}>
          <div className="review-answer-meta"><span><Sparkles size={13}/>{label(turn.answer.harness)} · {turn.answer.model}</span><a href={report.meta.url} target="_blank" rel="noreferrer" aria-label="Open pull request on GitHub"><ExternalLink size={13}/></a></div>
          <MarkdownContent className="review-answer-copy" text={turn.answer.answer}/>
          {!!turn.answer.citations.length && <div className="review-answer-citations"><span>Source</span>{turn.answer.citations.map((citation, index) => citation.symbol_id ? <button key={`${citation.symbol_id}-${index}`} type="button" onClick={() => onCitationClick(citation.symbol_id!)} title={citation.reason || `${citation.path}:${citation.line}`}>
            <span>{citation.path.split(/[\\/]/).pop()}:{citation.line}</span><ArrowUp size={12}/>
          </button> : <span className="review-answer-source" key={`${citation.path}-${citation.line}-${index}`} title={citation.reason}>{citation.path.split(/[\\/]/).pop()}:{citation.line}</span>)}</div>}
        </div> : <div className="review-answer-pending"><LoaderCircle size={14} className="spinning"/><span>{busy ? progress || 'Reading the report evidence' : 'Waiting for an answer'}</span>{busy && <AgentActivity lines={activity}/>}</div>}
      </article>)}
    </div>}

    {!turns.length && hasProviders && <div className="review-question-suggestions" aria-label="Suggested questions">{suggestions.map(item => <button key={item} type="button" onClick={() => { setQuestion(item); textarea.current?.focus() }}>{item}</button>)}</div>}

    <form className="review-question-composer" onSubmit={event => { event.preventDefault(); void ask() }}>
      <textarea ref={textarea} aria-label="Question about the pull request" rows={2} maxLength={2000} value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask() } }} placeholder="Ask about behavior, dependencies, or a review concern…" disabled={!installed || busy}/>
      <div className="review-question-compose-footer">
        <div className="review-question-footer-info">
          <span className="review-question-compose-note">{error ? <span className="review-question-error">{error}</span> : 'Relevant PR and repository context goes to your assistant.'}</span>
        </div>
        <button type="submit" disabled={!installed || busy || !question.trim()}>{busy ? <LoaderCircle size={15} className="spinning"/> : <ArrowUp size={15}/>}<span>{busy ? 'Thinking' : 'Ask'}</span></button>
      </div>
    </form>
    {error && <button className="review-question-retry" type="button" onClick={() => { setError(''); void ask(question) }}>Retry question</button>}
  </section>
}
