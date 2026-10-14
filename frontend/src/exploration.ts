import type {MouseEvent} from 'react'
import type {ExplorationNode, ExplorationProjection} from './types'
import type {DiffSide, IndexedDiffRow} from './diff'

export interface SymbolSelection {
  path: string; side: 'old' | 'new'; line: number; column: number
  x: number; y: number; returnFocus?: HTMLElement; request?: number
}

export function diffSourcePosition(row:IndexedDiffRow,side:DiffSide,path:string,oldPath=path) {
  const revisionSide=side==='old'||(side==='both'&&row.kind==='removed')?'old':'new'
  return {side:revisionSide as 'old'|'new',path:revisionSide==='old'?oldPath:path,line:revisionSide==='old'?row.oldLine:row.newLine}
}

/** Source-only UTF-16 offsets survive syntax spans, word marks and soft wrapping. */
export function sourceClick(event: MouseEvent<HTMLElement>, path: string, side: 'old' | 'new', line: number): SymbolSelection | null {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !window.getSelection()?.isCollapsed) return null
  const source = event.currentTarget
  const doc = source.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => {offsetNode: Node; offset: number} | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
  const caret = position ? null : doc.caretRangeFromPoint?.(event.clientX, event.clientY)
  const node = position?.offsetNode || caret?.startContainer, offset = position?.offset ?? caret?.startOffset
  if (!node || offset === undefined || !source.contains(node)) return null
  const range = doc.createRange()
  range.selectNodeContents(source); range.setEnd(node, offset)
  const column = range.toString().length
  // Clicks in the trailing empty area of a wrapped line aren't source positions.
  if (column >= (source.textContent?.length || 0)) return null
  return {path, side, line, column, x: event.clientX, y: event.clientY, returnFocus: source.closest<HTMLElement>('[tabindex]') || source}
}

export function popoverBounds(x: number, y: number, viewportWidth: number, viewportHeight: number) {
  const width = Math.max(280, Math.min(880, viewportWidth - 24)), height = Math.max(240, Math.min(680, viewportHeight - 24))
  return {width, height, left: Math.max(12, Math.min(x - width * .45, viewportWidth - width - 12)), top: Math.max(12, Math.min(y + 14, viewportHeight - height - 12))}
}

export function fileMapLayout(projection: ExplorationProjection) {
  const root = projection.root.definition.path, rank = new Map<string, number>([[root, 0]])
  const queue = [root]
  for (let i = 0; i < queue.length; i++) for (const edge of projection.connections) {
    if (edge.source !== queue[i] || rank.has(edge.target)) continue
    rank.set(edge.target, (rank.get(edge.source) || 0) + 1); queue.push(edge.target)
  }
  const columns = new Map<number, ExplorationNode[]>()
  for (const node of projection.nodes) {
    const column = rank.get(node.path) ?? 1
    columns.set(column, [...(columns.get(column) || []), node])
  }
  const positions = new Map<string, {x: number; y: number}>()
  let height = 140, width = 240
  for (const [column, nodes] of columns) {
    nodes.sort((a, b) => a.path.localeCompare(b.path))
    nodes.forEach((node, row) => positions.set(node.path, {x: 18 + column * 340, y: 18 + row * 120}))
    width = Math.max(width, 240 + column * 340); height = Math.max(height, 28 + nodes.length * 120)
  }
  return {positions, width, height}
}
