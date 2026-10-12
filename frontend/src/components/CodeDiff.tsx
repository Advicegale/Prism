import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { Token, TokenStream } from 'prismjs'
import type { DiffLineAnchor, Harnesses, ReviewAssistantSettings } from '../types'
import { InlineDiffChat } from './InlineDiffChat'
import 'prismjs'

type PrismRuntime = typeof import('prismjs')

const prism = (globalThis as typeof globalThis & { Prism?: PrismRuntime }).Prism

type GrammarLoader = () => Promise<unknown>
const GRAMMAR_LOADERS: Record<string, GrammarLoader> = {
  python: () => import('prismjs/components/prism-python'),
  java: () => import('prismjs/components/prism-java'),
  go: () => import('prismjs/components/prism-go'),
  rust: () => import('prismjs/components/prism-rust'),
  ruby: () => import('prismjs/components/prism-ruby'),
  c: () => import('prismjs/components/prism-c'),
  cpp: () => import('prismjs/components/prism-cpp'),
  csharp: () => import('prismjs/components/prism-csharp'),
  swift: () => import('prismjs/components/prism-swift'),
  kotlin: () => import('prismjs/components/prism-kotlin'),
  json: () => import('prismjs/components/prism-json'),
  jsx: () => import('prismjs/components/prism-jsx'),
  typescript: () => import('prismjs/components/prism-typescript'),
  tsx: () => import('prismjs/components/prism-tsx'),
  'markup-templating': () => import('prismjs/components/prism-markup-templating'),
  php: () => import('prismjs/components/prism-php'),
}

async function loadLanguage(language: string) {
  if (!prism || prism.languages[language] || !GRAMMAR_LOADERS[language]) return
  if (language === 'cpp') await loadLanguage('c')
  if (language === 'tsx') {
    await loadLanguage('jsx')
    await loadLanguage('typescript')
  }
  if (language === 'php') await loadLanguage('markup-templating')
  await GRAMMAR_LOADERS[language]()
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hh': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.go': 'go', '.java': 'java', '.js': 'javascript', '.jsx': 'jsx',
  '.kt': 'kotlin', '.kts': 'kotlin', '.php': 'php', '.py': 'python', '.rb': 'ruby',
  '.rs': 'rust', '.swift': 'swift', '.ts': 'typescript', '.tsx': 'tsx', '.json': 'json',
}

function languageForPath(path: string): string | undefined {
  const filename = path.split('/').pop() || path
  const dot = filename.lastIndexOf('.')
  return LANGUAGE_BY_EXTENSION[dot < 0 ? '' : filename.slice(dot).toLowerCase()]
}

function tokenNodes(stream: TokenStream, key = 'token'): ReactNode {
  if (typeof stream === 'string') return stream
  if (Array.isArray(stream)) {
    return stream.map((item, index) => <span key={`${key}-${index}`}>{tokenNodes(item, `${key}-${index}`)}</span>)
  }

  const token = stream as Token
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : []
  const classes = ['token', token.type, ...aliases].join(' ')
  return <span className={classes}>{tokenNodes(token.content, key)}</span>
}

function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const grammar = language && prism?.languages[language]
  if (!grammar || !prism || code.length > 8000) return <>{code || ' '}</>
  return <>{tokenNodes(prism.tokenize(code, grammar))}</>
}

function useReadyLanguage(language?: string) {
  const [readyLanguage, setReadyLanguage] = useState(() => language && prism?.languages[language] ? language : '')

  useEffect(() => {
    let active = true
    if (!language || prism?.languages[language]) {
      setReadyLanguage(language || '')
      return () => { active = false }
    }
    void loadLanguage(language).then(() => {
      if (active) setReadyLanguage(language)
    }).catch(() => {
      if (active) setReadyLanguage('')
    })
    return () => { active = false }
  }, [language])

  return readyLanguage === language ? language : undefined
}

export function SyntaxCode({ code, path }: { code: string; path: string }) {
  const language = languageForPath(path)
  const readyLanguage = useReadyLanguage(language)
  return <code className="syntax-code"><HighlightedCode code={code} language={readyLanguage} /></code>
}

export interface DiffLineReference { oldLine?: number; newLine?: number }
type DiffRow = { kind: 'added' | 'removed' | 'context' | 'meta'; prefix?: string; code: string; oldLine?: number; newLine?: number; hunk: number }

function parseDiffRows(patch: string, references?: (DiffLineReference | null)[]): DiffRow[] {
  let inHunk = false
  let hunk = -1
  let oldLine = 0
  let newLine = 0
  return patch.split('\n').slice(0, 120).map((line, index) => {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      return { kind: 'meta', code: line || ' ', hunk }
    }
    if (line.startsWith('@@')) {
      inHunk = true
      hunk++
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      oldLine = match ? Number(match[1]) : 0
      newLine = match ? Number(match[3]) : 0
      return { kind: 'meta', code: line, hunk }
    }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) {
      return { kind: 'meta', code: line || ' ', hunk }
    }

    const prefix = line[0]
    if (prefix === '+') {
      const row = { kind: 'added' as const, prefix, code: line.slice(1), newLine: references ? references[index]?.newLine : newLine, hunk }
      newLine++
      return row
    }
    if (prefix === '-') {
      const row = { kind: 'removed' as const, prefix, code: line.slice(1), oldLine: references ? references[index]?.oldLine : oldLine, hunk }
      oldLine++
      return row
    }
    if (prefix === ' ') {
      const row = { kind: 'context' as const, prefix: ' ', code: line.slice(1), oldLine: references ? references[index]?.oldLine : oldLine, newLine: references ? references[index]?.newLine : newLine, hunk }
      oldLine++
      newLine++
      return row
    }
    return { kind: 'meta', code: line || ' ', hunk }
  })
}

interface InlineQuestionConfig { reportId: string; assistant: ReviewAssistantSettings; harnesses: Harnesses | null; onAssistantChange: (settings: ReviewAssistantSettings) => void }
interface CodeDiffProps { patch: string; path: string; lineReferences?: (DiffLineReference | null)[]; inlineQuestion?: InlineQuestionConfig }
interface InlineChatSlot { id: string; start: number; end: number; locked: boolean }

export function CodeDiff({ patch, path, lineReferences, inlineQuestion }: CodeDiffProps) {
  const language = languageForPath(path)
  const readyLanguage = useReadyLanguage(language)
  const rows = parseDiffRows(patch, lineReferences)
  const [chatSlots, setChatSlots] = useState<InlineChatSlot[]>([])
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null)

  function anchorFor(slot: InlineChatSlot): DiffLineAnchor {
    const start = Math.min(slot.start, slot.end)
    const end = Math.max(slot.start, slot.end)
    const selectedRows = rows.slice(start, end + 1).filter(row => row.kind !== 'meta' && (row.oldLine !== undefined || row.newLine !== undefined))
    return {
      path,
      old_lines: [...new Set(selectedRows.map(row => row.oldLine).filter((line): line is number => line !== undefined))].sort((a, b) => a - b),
      new_lines: [...new Set(selectedRows.map(row => row.newLine).filter((line): line is number => line !== undefined))].sort((a, b) => a - b),
    }
  }

  function selectLine(index: number, event: MouseEvent<HTMLButtonElement>) {
    const row = rows[index]
    const active = chatSlots.find(slot => slot.id === activeSlotId)
    if (active && !active.locked) {
      if (event.shiftKey && rows[active.start]?.hunk === row.hunk) {
        setChatSlots(current => current.map(slot => slot.id === active.id ? { ...slot, end: index } : slot))
      } else {
        setChatSlots(current => current.map(slot => slot.id === active.id ? { ...slot, start: index, end: index } : slot))
      }
      return
    }
    if (active && active.locked && index >= Math.min(active.start, active.end) && index <= Math.max(active.start, active.end)) return
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const rangeStart = active?.locked && event.shiftKey && rows[active.start]?.hunk === row.hunk ? active.start : index
    setChatSlots(current => [...current, { id, start: rangeStart, end: index, locked: false }])
    setActiveSlotId(id)
  }

  function closeSlot(id: string) {
    const remaining = chatSlots.filter(slot => slot.id !== id)
    setChatSlots(remaining)
    if (activeSlotId === id) setActiveSlotId(remaining[remaining.length - 1]?.id || null)
  }

  return (
    <div className="diff-code" role="region" aria-label={`Code diff for ${path}`} tabIndex={0}>
      <div className="diff-lines">
        {rows.map((row, index) => {
          const selected = chatSlots.some(slot => index >= Math.min(slot.start, slot.end) && index <= Math.max(slot.start, slot.end))
          const threadsHere = chatSlots.filter(slot => Math.max(slot.start, slot.end) === index)
          const side = row.kind === 'added' ? 'added' : row.kind === 'removed' ? 'removed' : 'context'
          const isHunkHeader = row.kind === 'meta' && row.code.startsWith('@@')
          return <div className="diff-row-wrap" key={index}>
            <div className={`diff-line diff-${row.kind}${isHunkHeader ? ' diff-hunk-header' : ''}${selected ? ' diff-line-selected' : ''}`}>
              {isHunkHeader ? <><span className="diff-hunk-label" aria-hidden="true">HUNK</span><code className="diff-hunk-code">{row.code}</code></> : <>
                <span className="diff-line-numbers" aria-hidden="true"><span>{row.oldLine ?? ''}</span><span>{row.newLine ?? ''}</span></span>
                {row.prefix !== undefined && <span className="diff-prefix" aria-hidden="true">{row.prefix}</span>}
                <span className="diff-source"><HighlightedCode code={row.code} language={readyLanguage} /></span>
              </>}
              {inlineQuestion && row.kind !== 'meta' && (row.oldLine !== undefined || row.newLine !== undefined) && <button className="diff-ask-line" type="button" aria-label={`Ask about ${side} line ${row.newLine ?? row.oldLine}`} title="Ask about this diff line · Shift-click another line to include a range" onClick={event => selectLine(index, event)}><MessageSquareText size={13}/></button>}
            </div>
            {inlineQuestion && threadsHere.map(slot => <InlineDiffChat key={slot.id} reportId={inlineQuestion.reportId} anchor={anchorFor(slot)} assistant={inlineQuestion.assistant} harnesses={inlineQuestion.harnesses} onAssistantChange={inlineQuestion.onAssistantChange} onConversationStarted={() => setChatSlots(current => current.map(item => item.id === slot.id ? { ...item, locked: true } : item))} onClose={() => closeSlot(slot.id)}/>)}
          </div>
        })}
      </div>
    </div>
  )
}
