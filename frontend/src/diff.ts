import type {DiffLineAnchor} from './types'

export interface DiffLineReference {oldLine?: number; newLine?: number}
export interface DiffRow {
  kind: 'added' | 'removed' | 'context' | 'meta'
  prefix?: string
  code: string
  oldLine?: number
  newLine?: number
  hunk: number
}
export type DiffSide = 'old' | 'new' | 'both'
export interface IndexedDiffRow extends DiffRow {index: number}
export interface DiffBlock {start: number; end: number; change: boolean; rows: IndexedDiffRow[]}
export interface TextRange {start: number; end: number}
export interface SplitRow {left?: IndexedDiffRow; right?: IndexedDiffRow; note?: IndexedDiffRow; leftChanges?: TextRange[]; rightChanges?: TextRange[]}

export function parseDiffRows(patch: string, references?: (DiffLineReference | null)[]): DiffRow[] {
  let inHunk = false, hunk = -1, oldLine = 0, newLine = 0
  return patch.split('\n').map((line, index) => {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      return {kind: 'meta', code: line || ' ', hunk: -1}
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      inHunk = true
      hunk++
      oldLine = Number(header[1]); newLine = Number(header[2])
      return {kind: 'meta', code: line, hunk}
    }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) return {kind: 'meta', code: line || ' ', hunk: inHunk ? hunk : -1}
    const prefix = line[0]
    if (prefix === '+') {
      const row = {kind: 'added' as const, prefix, code: line.slice(1), newLine: references ? references[index]?.newLine : newLine, hunk}
      newLine++
      return row
    }
    if (prefix === '-') {
      const row = {kind: 'removed' as const, prefix, code: line.slice(1), oldLine: references ? references[index]?.oldLine : oldLine, hunk}
      oldLine++
      return row
    }
    if (prefix === ' ') {
      const row = {kind: 'context' as const, prefix, code: line.slice(1), oldLine: references ? references[index]?.oldLine : oldLine, newLine: references ? references[index]?.newLine : newLine, hunk}
      oldLine++; newLine++
      return row
    }
    return {kind: 'meta', code: line || ' ', hunk}
  })
}

export function buildDiffBlocks(rows: DiffRow[]): DiffBlock[] {
  const blocks: DiffBlock[] = []
  rows.forEach((row, index) => {
    const change = row.kind === 'added' || row.kind === 'removed'
    const previous = blocks.at(-1)
    // A no-newline marker belongs to its change block, not to another hunk.
    if (previous?.change && previous.rows[0].hunk === row.hunk && (change || row.code.startsWith('\\ No newline'))) {
      previous.rows.push({...row, index}); previous.end = index
    } else blocks.push({start: index, end: index, change, rows: [{...row, index}]})
  })
  return blocks
}

function lineSimilarity(a: string, b: string): number {
  if (a.trim() === b.trim()) return 1
  const words = (s: string) => new Set(s.slice(0, 2000).match(/[\p{L}\p{N}_]+/gu) || [])
  const left = words(a), right = words(b)
  if (!left.size || !right.size) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return 2 * common / (left.size + right.size)
}

/** Align replacements within one change block; gaps preserve pure additions/deletions. */
export function alignSplitRows(block: DiffBlock): SplitRow[] {
  if (!block.change) {
    const row = block.rows[0]
    return row.kind === 'meta' ? [{note: row}] : [{left: row, right: row}]
  }
  const left = block.rows.filter(r => r.kind === 'removed'), right = block.rows.filter(r => r.kind === 'added')
  const result: SplitRow[] = []
  // Bounded dynamic alignment. For a large block, pair similar corresponding lines only.
  if (left.length * right.length > 6400) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i] && right[i] && lineSimilarity(left[i].code, right[i].code) >= .35) result.push({left: left[i], right: right[i]})
      else {if (left[i]) result.push({left: left[i]}); if (right[i]) result.push({right: right[i]})}
    }
  } else {
    const width = right.length + 1, costs = new Float32Array((left.length + 1) * width), moves = new Uint8Array(costs.length)
    for (let i = 1; i <= left.length; i++) {costs[i * width] = i; moves[i * width] = 1}
    for (let j = 1; j <= right.length; j++) {costs[j] = j; moves[j] = 2}
    for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
      const score = lineSimilarity(left[i - 1].code, right[j - 1].code)
      const pair = score >= .35 ? costs[(i - 1) * width + j - 1] + 1 - score : Infinity
      const remove = costs[(i - 1) * width + j] + 1, add = costs[i * width + j - 1] + 1, pos = i * width + j
      if (pair <= remove && pair <= add) {costs[pos] = pair; moves[pos] = 0}
      else if (add <= remove) {costs[pos] = add; moves[pos] = 2}
      else {costs[pos] = remove; moves[pos] = 1}
    }
    let i = left.length, j = right.length
    while (i || j) {
      const move = moves[i * width + j]
      if (move === 0) result.push({left: left[--i], right: right[--j]})
      else if (move === 1) result.push({left: left[--i]})
      else result.push({right: right[--j]})
    }
    result.reverse()
  }
  for (const row of result) if (row.left && row.right) {
    const changes = changedWordRanges(row.left.code, row.right.code)
    row.leftChanges = changes.left; row.rightChanges = changes.right
  }
  // Preserve the marker on the side it described, without inventing a line coordinate.
  for (const note of block.rows.filter(r => r.kind === 'meta')) {
    const previous = block.rows.find(r => r.index === note.index - 1)
    const at = result.findIndex(r => r.left?.index === previous?.index || r.right?.index === previous?.index)
    result.splice(at < 0 ? result.length : at + 1, 0, {note})
  }
  return result
}

export function changedWordRanges(left: string, right: string): {left: TextRange[]; right: TextRange[]} {
  if (left === right) return {left: [], right: []}
  const tokenize = (s: string) => [...s.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s]/gu)].map(m => ({text: m[0], start: m.index, end: m.index + m[0].length}))
  // Avoid tokenizing or comparing arbitrarily long lines.
  if (left.length > 8000 || right.length > 8000) return {left: [], right: []}
  const a = tokenize(left), b = tokenize(right)
  if (a.length * b.length > 40000) {
    let start = 0, suffix = 0
    while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++
    while (suffix < Math.min(left.length, right.length) - start && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++
    return {left: start < left.length - suffix ? [{start, end: left.length - suffix}] : [], right: start < right.length - suffix ? [{start, end: right.length - suffix}] : []}
  }
  const width = b.length + 1, lcs = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * width + j] = a[i].text === b[j].text ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
  const matchedA = new Set<number>(), matchedB = new Set<number>()
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i].text === b[j].text) {matchedA.add(i++); matchedB.add(j++)}
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++
    else j++
  }
  function ranges(tokens: typeof a, matched: Set<number>): TextRange[] {
    const result: TextRange[] = []
    tokens.forEach((t, index) => {
      if (matched.has(index)) return
      const last = result.at(-1)
      if (last?.end === t.start) last.end = t.end
      else result.push({start: t.start, end: t.end})
    })
    return result
  }
  return {left: ranges(a, matchedA), right: ranges(b, matchedB)}
}

export function diffAnchor(path: string, rows: DiffRow[], start: number, end: number, side: DiffSide): DiffLineAnchor {
  const selected = rows.slice(Math.min(start, end), Math.max(start, end) + 1).filter(r => r.kind !== 'meta')
  const lines = (key: 'oldLine' | 'newLine') => [...new Set(selected.map(r => r[key]).filter((n): n is number => n !== undefined))].sort((a, b) => a - b)
  return {path, old_lines: side === 'new' ? [] : lines('oldLine'), new_lines: side === 'old' ? [] : lines('newLine')}
}
