import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { Token, TokenStream } from 'prismjs'
import type { Harnesses, ReviewAssistantSettings } from '../types'
import {alignSplitRows, buildDiffBlocks, diffAnchor, parseDiffRows, type DiffLineReference, type DiffSide, type IndexedDiffRow, type SplitRow, type TextRange} from '../diff'
export type {DiffLineReference} from '../diff'
import { InlineDiffChat } from './InlineDiffChat'
import {diffSourcePosition, sourceClick, type SymbolSelection} from '../exploration'
import {nextDefaultMode, type DiffMode} from '../reading'
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

export async function loadLanguage(language: string) {
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

export function languageForPath(path: string): string | undefined {
  const filename = path.split('/').pop() || path
  const dot = filename.lastIndexOf('.')
  return LANGUAGE_BY_EXTENSION[dot < 0 ? '' : filename.slice(dot).toLowerCase()]
}

function markedText(text: string, ranges: TextRange[], offset: number): ReactNode {
  let cursor = 0
  const parts: ReactNode[] = []
  for (const range of ranges) {
    const start = Math.max(0, range.start - offset), end = Math.min(text.length, range.end - offset)
    if (start >= end) continue
    if (cursor < start) parts.push(text.slice(cursor, start))
    parts.push(<mark className="diff-word-change" key={`${offset}-${start}`}>{text.slice(start, end)}</mark>)
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function tokenNodes(stream: TokenStream, ranges: TextRange[] = [], position = {offset: 0}, key = 'token'): ReactNode {
  if (typeof stream === 'string') {
    const content = ranges.length ? markedText(stream, ranges, position.offset) : stream
    position.offset += stream.length
    return content
  }
  if (Array.isArray(stream)) return stream.map((item, index) => <span key={`${key}-${index}`}>{tokenNodes(item, ranges, position, `${key}-${index}`)}</span>)
  const token = stream as Token
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : []
  return <span className={['token', token.type, ...aliases].join(' ')}>{tokenNodes(token.content, ranges, position, key)}</span>
}

function HighlightedCode({code, language, changes = []}: {code: string; language?: string; changes?: TextRange[]}) {
  const grammar = language && prism?.languages[language]
  if (!grammar || !prism || code.length > 8000) return <>{markedText(code || ' ', changes, 0)}</>
  return <>{tokenNodes(prism.tokenize(code, grammar), changes)}</>
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

export function SyntaxCode({ code, path, changes = [] }: { code: string; path: string; changes?: TextRange[] }) {
  const language = languageForPath(path)
  const readyLanguage = useReadyLanguage(language)
  return <code className="syntax-code"><HighlightedCode code={code} language={readyLanguage} changes={changes} /></code>
}

interface InlineQuestionConfig {reportId: string; assistant: ReviewAssistantSettings; harnesses: Harnesses | null; onAssistantChange: (settings: ReviewAssistantSettings) => void}
interface CodeDiffProps {expanded?: boolean; interactive?: boolean; patch: string; path: string; oldPath?: string; lineReferences?: (DiffLineReference | null)[]; inlineQuestion?: InlineQuestionConfig; onSymbolSelect?: (selection: SymbolSelection) => void}
interface InlineChatSlot {id: string; start: number; end: number; side: DiffSide; locked: boolean}

function preference(key: string): string | null {
  try {return typeof localStorage === 'undefined' ? null : localStorage.getItem(`prism:diff-${key}`)} catch {return null}
}
function savePreference(key: string, value: string) {
  try {localStorage.setItem(`prism:diff-${key}`, value)} catch { /* The reader still works when browser storage is unavailable. */ }
}

export function CodeDiff({patch, path, oldPath, lineReferences, inlineQuestion, onSymbolSelect, expanded = false, interactive = true}: CodeDiffProps) {
  const language = languageForPath(path)
  const readyLanguage = useReadyLanguage(language)
  const allRows = useMemo(() => parseDiffRows(patch, lineReferences).filter(row => row.hunk >= 0), [patch, lineReferences])
  const allBlocks = useMemo(() => buildDiffBlocks(allRows), [allRows])
  const [limit, setLimit] = useState(120)
  const [chatSlots, setChatSlots] = useState<InlineChatSlot[]>([])
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null)
  const [chosenMode, setChosenMode] = useState<DiffMode | null>(() => {
    const value = interactive ? preference('mode') : null
    return value === 'split' || value === 'unified' ? value : null
  })
  // Until the pane is measured, guess from the viewport; a missing window (static render) keeps the split default.
  const [autoMode, setAutoMode] = useState<DiffMode>(() => typeof window === 'undefined' || window.innerWidth >= 1500 ? 'split' : 'unified')
  const [wrap, setWrap] = useState(() => !interactive || preference('wrap') !== 'false')
  const [words, setWords] = useState(() => interactive && preference('words') !== 'false')
  const [focusHunk, setFocusHunk] = useState(-1)
  const [jumpRequest, setJumpRequest] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const mode = interactive ? chosenMode || autoMode : 'unified'
  // Finish small replacement blocks rather than separating their two sides at the display limit.
  const cutBlock = allBlocks.find(block => block.start < limit && block.end >= limit)
  const visibleCount = expanded ? allRows.length : Math.min(allRows.length, cutBlock && cutBlock.end - limit < 80 ? cutBlock.end + 1 : limit)
  const blocks = useMemo(() => allBlocks.filter(block => block.start < visibleCount).map(block => ({...block, rows: block.rows.filter(row => row.index < visibleCount), end: Math.min(block.end, visibleCount - 1)})), [allBlocks, visibleCount])
  const splitBlocks = useMemo(() => mode === 'split' || words ? new Map(blocks.map(block => [block.start, alignSplitRows(block)])) : new Map<number, SplitRow[]>(), [blocks, mode, words])
  const longestLine = useMemo(() => Math.max(0, ...allRows.filter(row => row.kind !== 'meta').map(row => row.code.replace(/\t/g, '    ').length)), [allRows])
  const changesByIndex = useMemo(() => {
    const ranges = new Map<number, TextRange[]>()
    for (const pairs of splitBlocks.values()) for (const pair of pairs) {
      if (pair.left && pair.leftChanges) ranges.set(pair.left.index, pair.leftChanges)
      if (pair.right && pair.rightChanges) ranges.set(pair.right.index, pair.rightChanges)
    }
    return ranges
  }, [splitBlocks])
  const hunks = useMemo(() => allRows.map((row, index) => ({row, index})).filter(({row}) => row.kind === 'meta' && row.code.startsWith('@@')), [allRows])

  useEffect(() => {setLimit(120); setChatSlots([]); setActiveSlotId(null); setFocusHunk(-1); setJumpRequest(0)}, [patch, path])
  useEffect(() => {
    const element = scroller.current
    if (!interactive || !element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setAutoMode(current => nextDefaultMode(entry.contentRect.width, current)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [interactive])
  useEffect(() => {
    if (focusHunk < 0) return
    const container = scroller.current, header = container?.querySelector<HTMLElement>(`[data-hunk-id="${focusHunk}"]`)
    if (container && header) container.scrollTop += header.getBoundingClientRect().top - container.getBoundingClientRect().top - (mode === 'split' ? 34 : 8)
  }, [focusHunk, jumpRequest, visibleCount, mode])
  // Keyboard shortcuts from TopicReview reuse the same handlers as the visible controls.
  const command = useRef<(name: string) => void>(() => {})
  command.current = name => {
    if (name === 'next-change' && hunks.length) nextChange()
    if (name === 'toggle-mode') chooseMode(mode === 'split' ? 'unified' : 'split')
  }
  useEffect(() => {
    if (!interactive) return
    const listener = (event: Event) => command.current((event as CustomEvent<string>).detail)
    document.addEventListener('prism:diff-command', listener)
    return () => document.removeEventListener('prism:diff-command', listener)
  }, [interactive])

  function chooseMode(value: DiffMode) {setChosenMode(value); savePreference('mode', value)}
  function nextChange() {
    const next = (focusHunk + 1) % hunks.length
    setLimit(current => Math.max(current, hunks[next].index + 120))
    setFocusHunk(next)
    setJumpRequest(current => current + 1)
  }
  function selectLine(index: number, side: DiffSide, event: MouseEvent<HTMLButtonElement>) {
    const row = allRows[index], active = chatSlots.find(slot => slot.id === activeSlotId)
    const extend = event.shiftKey && active?.side === side && allRows[active.start]?.hunk === row.hunk
    if (active && !active.locked) {
      setChatSlots(current => current.map(slot => slot.id === active.id ? {...slot, side, start: extend ? slot.start : index, end: index} : slot))
      return
    }
    if (active?.locked && active.side === side && index >= Math.min(active.start, active.end) && index <= Math.max(active.start, active.end)) return
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setChatSlots(current => [...current, {id, start: extend && active ? active.start : index, end: index, side, locked: false}])
    setActiveSlotId(id)
  }
  function closeSlot(id: string) {
    setChatSlots(current => current.filter(slot => slot.id !== id))
    if (activeSlotId === id) setActiveSlotId(chatSlots.filter(slot => slot.id !== id).at(-1)?.id || null)
  }
  function selected(index: number, side: DiffSide) {
    return chatSlots.some(slot => index >= Math.min(slot.start, slot.end) && index <= Math.max(slot.start, slot.end) && (slot.side === 'both' || (side === 'both' ? allRows[index][slot.side === 'old' ? 'oldLine' : 'newLine'] !== undefined : slot.side === side)))
  }
  function sourceLine(row: IndexedDiffRow, side: DiffSide, ranges?: TextRange[]) {
    const split = side !== 'both'
    const line = side === 'old' ? row.oldLine : row.newLine ?? row.oldLine
    const hasAnchor = split ? line !== undefined : row.oldLine !== undefined || row.newLine !== undefined
    const label = split ? `${side === 'old' ? 'before' : 'after'} line ${line}` : `${row.kind === 'added' ? 'added' : row.kind === 'removed' ? 'removed' : 'context'} line ${line}`
    const header = row.kind === 'meta' && row.code.startsWith('@@')
    return <div className={`diff-line diff-${row.kind}${split ? ' diff-split-cell' : ''}${header ? ' diff-hunk-header' : ''}${selected(row.index, side) ? ' diff-line-selected' : ''}`} data-hunk-id={header ? row.hunk : undefined} data-side={split ? side : undefined} data-line={split ? line : undefined}>
      {header ? <><span className="diff-hunk-label" aria-hidden="true">HUNK</span><code className="diff-hunk-code">{row.code}</code></> : <>
        <span className="diff-line-numbers" aria-hidden="true">{split ? <span>{line ?? ''}</span> : <><span>{row.oldLine ?? ''}</span><span>{row.newLine ?? ''}</span></>}</span>
        {row.prefix !== undefined && <span className="diff-prefix" aria-hidden="true">{row.prefix}</span>}
        <span className="diff-source" onClick={interactive && onSymbolSelect && hasAnchor ? event => {
          const position=diffSourcePosition(row,side,path,oldPath)
          if (position.line === undefined) return
          const selection = sourceClick(event, position.path, position.side, position.line)
          if (selection) onSymbolSelect(selection)
        } : undefined}><HighlightedCode code={row.code} language={readyLanguage} changes={words ? ranges : undefined}/></span>
      </>}
      {inlineQuestion && row.kind !== 'meta' && hasAnchor && <button className="diff-ask-line" type="button" aria-label={`Ask about ${label}`} title="Ask about this diff line · Shift-click another line on this side to include a range" onClick={event => selectLine(row.index, side, event)}><MessageSquareText size={13}/></button>}
    </div>
  }
  return <div className="diff-review-patch">
    {interactive && <div className="diff-reader-controls">
      <div className="diff-mode-controls" role="group" aria-label="Diff layout"><button type="button" aria-pressed={mode === 'unified'} onClick={() => chooseMode('unified')}>Unified</button><button type="button" aria-pressed={mode === 'split'} onClick={() => chooseMode('split')}>Split</button></div>
      <label><input type="checkbox" checked={wrap} onChange={event => {setWrap(event.target.checked); savePreference('wrap', String(event.target.checked))}}/> Wrap lines</label>
      <label><input type="checkbox" checked={words} onChange={event => {setWords(event.target.checked); savePreference('words', String(event.target.checked))}}/> Highlight words</label>
      <button type="button" className="diff-next-change" disabled={!hunks.length} onClick={nextChange}>Next change{focusHunk >= 0 && <span> {focusHunk + 1}/{hunks.length}</span>}</button>
    </div>}
    <div className={`diff-code${mode === 'split' ? ' diff-code-split' : ''}${wrap ? '' : ' diff-no-wrap'}`} ref={scroller} style={{'--diff-pane-width': `calc(${longestLine}ch + 80px)`} as CSSProperties} role="region" aria-label={`Code diff for ${path}`} tabIndex={0}>
      {mode === 'split' && <div className="diff-split-heading"><span>Before · base</span><span>After · head</span></div>}
      <div className="diff-lines">{blocks.map(block => <div className="diff-block" key={block.start}>
        <div className="diff-block-source">{mode === 'unified' ? block.rows.map(row => <div className="diff-row-wrap" key={row.index}>{sourceLine(row, 'both', changesByIndex.get(row.index))}</div>) : splitBlocks.get(block.start)!.map((pair, index) => pair.note ? <div className="diff-row-wrap" key={`note-${pair.note.index}`}>{sourceLine(pair.note, 'both')}</div> : <div className="diff-split-row diff-row-wrap" key={index}>
          {pair.left ? sourceLine(pair.left, 'old', pair.leftChanges) : <div className="diff-split-gap" aria-hidden="true"/>}
          {pair.right ? sourceLine(pair.right, 'new', pair.rightChanges) : <div className="diff-split-gap" aria-hidden="true"/>}
        </div>)}</div>
        {inlineQuestion && chatSlots.filter(slot => Math.max(slot.start, slot.end) >= block.start && Math.max(slot.start, slot.end) <= block.end).map(slot => <InlineDiffChat key={slot.id} reportId={inlineQuestion.reportId} anchor={diffAnchor(path, allRows, slot.start, slot.end, slot.side)} assistant={inlineQuestion.assistant} harnesses={inlineQuestion.harnesses} onAssistantChange={inlineQuestion.onAssistantChange} onConversationStarted={() => setChatSlots(current => current.map(item => item.id === slot.id ? {...item, locked: true} : item))} onClose={() => closeSlot(slot.id)}/>)}
      </div>)}</div>
    </div>
    {!expanded && visibleCount < allRows.length && <div className="diff-more-lines"><span>{visibleCount} of {allRows.length} diff lines shown</span><button type="button" onClick={() => setLimit(Math.min(allRows.length, visibleCount + 160))}>Show {Math.min(160, allRows.length - visibleCount)} more lines</button></div>}
  </div>
}
