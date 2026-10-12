import { useEffect, useState, type ReactNode } from 'react'
import type { Token, TokenStream } from 'prismjs'
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

type DiffRow = { kind: 'added' | 'removed' | 'context' | 'meta'; prefix?: string; code: string }

function parseDiffRows(patch: string): DiffRow[] {
  let inHunk = false
  return patch.split('\n').slice(0, 120).map(line => {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      return { kind: 'meta', code: line || ' ' }
    }
    if (line.startsWith('@@')) {
      inHunk = true
      return { kind: 'meta', code: line }
    }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) {
      return { kind: 'meta', code: line || ' ' }
    }

    const prefix = line[0]
    if (prefix === '+') return { kind: 'added', prefix, code: line.slice(1) }
    if (prefix === '-') return { kind: 'removed', prefix, code: line.slice(1) }
    if (prefix === ' ') return { kind: 'context', prefix: ' ', code: line.slice(1) }
    return { kind: 'meta', code: line || ' ' }
  })
}

export function CodeDiff({ patch, path }: { patch: string; path: string }) {
  const language = languageForPath(path)
  const readyLanguage = useReadyLanguage(language)
  const rows = parseDiffRows(patch)

  return (
    <pre className="diff-code" aria-label={`Code diff for ${path}`}>
      <code className="diff-lines">
        {rows.map((row, index) => (
          <span className={`diff-line diff-${row.kind}`} key={index}>
            {row.prefix !== undefined && <span className="diff-prefix" aria-hidden="true">{row.prefix}</span>}
            <span className="diff-source"><HighlightedCode code={row.code} language={readyLanguage} /></span>
          </span>
        ))}
      </code>
    </pre>
  )
}
