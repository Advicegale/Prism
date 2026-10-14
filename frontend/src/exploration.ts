import type {MouseEvent} from 'react'
import type {ExplorationBoundary, ExplorationConnection, ExplorationNode, ExplorationProjection, SourceAnchor} from './types'
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

export function popoverBounds(_x: number, _y: number, viewportWidth: number, viewportHeight: number) {
  const margin = viewportWidth < 700 ? 12 : 24
  const width = Math.min(1760, Math.max(0, viewportWidth - margin * 2))
  const height = Math.min(1100, Math.max(0, viewportHeight - margin * 2))
  return {width, height, left: (viewportWidth - width) / 2, top: (viewportHeight - height) / 2}
}

export type ExplorationDirection = 'consumers' | 'origins'
export type ExplorationViews = Partial<Record<ExplorationDirection, ExplorationProjection>>
export type ExplorationTree = Omit<ExplorationProjection, 'direction' | 'query_id'> & {direction: 'both'; focus: SourceAnchor}
export const FILE_CARD_WIDTH = 268
export const FILE_CARD_HEIGHT = 160

/** Display the independently scoped queries together; never traverse through a
 * shared origin into another consumer. Origins edges become causal arrows. */
export function mergeExplorationViews(views: ExplorationViews, focus: SourceAnchor): ExplorationTree | null {
  const first = views.consumers || views.origins
  if (!first) return null
  const nodes = new Map<string, ExplorationNode>(), connections = new Map<string, ExplorationConnection>()
  const boundaries = new Map<string, ExplorationBoundary>()
  const included: ExplorationProjection[] = []
  for (const direction of ['origins', 'consumers'] as const) {
    const view = views[direction]
    if (!view || view.revision !== first.revision || view.root.id !== first.root.id || view.side !== first.side || view.changed_only !== first.changed_only) continue
    included.push(view)
    for (const node of view.nodes) {
      const merged = nodes.get(node.path) || {...node, symbols: []}
      for (const symbol of node.symbols) if (!merged.symbols.some(s => s.entity_id === symbol.entity_id && s.name === symbol.name && s.anchor.start_byte === symbol.anchor.start_byte && s.anchor.end_byte === symbol.anchor.end_byte)) merged.symbols.push(symbol)
      nodes.set(node.path, merged)
    }
    for (const connection of view.connections) {
      const edge = direction === 'origins' ? {...connection, source: connection.target, target: connection.source, evidence: [...connection.evidence].reverse()} : connection
      const key = JSON.stringify([edge.source, edge.target, edge.evidence.map(e => e.id).sort()])
      if (!connections.has(key)) connections.set(key, {...edge, id: key})
    }
    for (const boundary of view.boundaries) {
      const key = JSON.stringify([boundary.kind, boundary.from, boundary.anchor.path, boundary.anchor.start_byte, boundary.reason])
      if (!boundaries.has(key)) boundaries.set(key, boundary)
    }
  }
  if (!nodes.has(focus.path)) nodes.set(focus.path, {id: focus.path, path: focus.path, changed: false, symbols: [{name: first.root.name, anchor: focus, entity_id: first.root.ref.entity}]})
  const has_more = included.some(view => view.has_more)
  return {...first, direction: 'both', focus, nodes: [...nodes.values()], connections: [...connections.values()], boundaries: [...boundaries.values()], has_more,
    status: !first.coverage.complete || included.some(v => v.status === 'partial') ? 'partial' : has_more ? 'expandable' : first.changed_only ? 'no_further_changed_files' : 'no_further_eligible_connections'}
}

/** Condense file cycles before assigning causal columns, then center the clicked
 * file's column. Shared nodes have one card; extra space permits actual centering
 * even when the focus is the first/last file or the only file. */
export function fileMapLayout(projection: Pick<ExplorationProjection, 'root' | 'nodes' | 'connections'>, focusPath = projection.root.definition.path, viewport = {width: 0, height: 0}) {
  const files = [...new Set(projection.nodes.map(n => n.path))].sort()
  const outgoing = new Map(files.map(path => [path, new Set<string>()])), incoming = new Map(files.map(path => [path, new Set<string>()]))
  for (const edge of projection.connections) if (outgoing.has(edge.source) && outgoing.has(edge.target)) {
    outgoing.get(edge.source)!.add(edge.target); incoming.get(edge.target)!.add(edge.source)
  }
  const visited = new Set<string>(), finish: string[] = []
  for (const file of files) {
    const stack: [string, boolean][] = [[file, false]]
    while (stack.length) {
      const [path, done] = stack.pop()!
      if (done) {finish.push(path); continue}
      if (visited.has(path)) continue
      visited.add(path); stack.push([path, true])
      for (const next of [...outgoing.get(path)!].sort().reverse()) if (!visited.has(next)) stack.push([next, false])
    }
  }
  const component = new Map<string, number>(), groups: string[][] = []
  for (const file of finish.reverse()) {
    if (component.has(file)) continue
    const id = groups.length, group: string[] = [], stack = [file]
    while (stack.length) {
      const path = stack.pop()!
      if (component.has(path)) continue
      component.set(path, id); group.push(path)
      for (const next of incoming.get(path)!) if (!component.has(next)) stack.push(next)
    }
    groups.push(group.sort())
  }
  const edges = groups.map(() => new Set<number>()), degrees = groups.map(() => 0), depths = groups.map(() => 0)
  for (const edge of projection.connections) {
    const a = component.get(edge.source), b = component.get(edge.target)
    if (a === undefined || b === undefined || a === b || edges[a].has(b)) continue
    edges[a].add(b); degrees[b]++
  }
  const queue = degrees.flatMap((degree, i) => degree === 0 ? [i] : [])
  for (let i = 0; i < queue.length; i++) for (const target of edges[queue[i]]) {
    depths[target] = Math.max(depths[target], depths[queue[i]] + 1)
    if (--degrees[target] === 0) queue.push(target)
  }
  const focus = component.get(focusPath), focusDepth = focus === undefined ? 0 : depths[focus]
  const columns = new Map<number, ExplorationNode[]>()
  for (const node of projection.nodes) {
    const rank = depths[component.get(node.path)!] - focusDepth
    columns.set(rank, [...(columns.get(rank) || []), node])
  }
  const ranks = [...columns.keys()], minRank = Math.min(0, ...ranks), maxRank = Math.max(0, ...ranks)
  const maxRows = Math.max(1, ...[...columns.values()].map(nodes => nodes.length)), above = Math.floor((maxRows - 1) / 2), below = Math.ceil((maxRows - 1) / 2)
  const gapX = FILE_CARD_WIDTH + 112, gapY = FILE_CARD_HEIGHT + 40
  const marginX = Math.max(28, (viewport.width - FILE_CARD_WIDTH) / 2), marginY = Math.max(28, (viewport.height - FILE_CARD_HEIGHT) / 2)
  const centerY = marginY + above * gapY
  const positions = new Map<string, {x: number; y: number}>()
  for (const [rank, nodes] of columns) {
    nodes.sort((a, b) => a.path === focusPath ? -1 : b.path === focusPath ? 1 : a.path.localeCompare(b.path))
    nodes.forEach((node, i) => {
      const row = i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2
      positions.set(node.path, {x: marginX + (rank - minRank) * gapX, y: centerY + row * gapY})
    })
  }
  return {positions, width: marginX * 2 + FILE_CARD_WIDTH + (maxRank - minRank) * gapX, height: marginY * 2 + FILE_CARD_HEIGHT + (above + below) * gapY}
}
