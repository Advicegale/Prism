import {isTestPath} from './testPaths'
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

export interface Frame {left: number; top: number; width: number; height: number}
export type PopoverMode = 'half' | 'full'
export interface ResizeEdges {left?: boolean; right?: boolean; top?: boolean; bottom?: boolean}
export const MIN_FRAME_WIDTH = 440
export const MIN_FRAME_HEIGHT = 380
/** At this width the map and source sit side by side; narrower frames stack them. */
export const WIDE_FRAME_WIDTH = 1100
const MIN_PANE = 220
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** Full is the original near-viewport workspace. Half takes the horizontal half
 * opposite the clicked token so the token and its surrounding diff stay visible. */
export function popoverBounds(x: number, _y: number, viewportWidth: number, viewportHeight: number, mode: PopoverMode = 'full'): Frame {
  const margin = viewportWidth < 700 ? 12 : 24
  const height = Math.min(1100, Math.max(0, viewportHeight - margin * 2)), top = (viewportHeight - height) / 2
  if (mode === 'half' && viewportWidth >= 900) {
    const width = Math.floor((viewportWidth - margin * 3) / 2)
    return {width, height, top, left: x < viewportWidth / 2 ? viewportWidth - margin - width : margin}
  }
  const width = Math.min(1760, Math.max(0, viewportWidth - margin * 2))
  return {width, height, left: (viewportWidth - width) / 2, top}
}

export function clampFrame(frame: Frame, viewportWidth: number, viewportHeight: number): Frame {
  const width = Math.min(Math.max(frame.width, Math.min(MIN_FRAME_WIDTH, viewportWidth)), viewportWidth)
  const height = Math.min(Math.max(frame.height, Math.min(MIN_FRAME_HEIGHT, viewportHeight)), viewportHeight)
  return {width, height, left: clamp(frame.left, 0, viewportWidth - width), top: clamp(frame.top, 0, viewportHeight - height)}
}

export function moveFrame(frame: Frame, dx: number, dy: number, viewportWidth: number, viewportHeight: number): Frame {
  return clampFrame({...frame, left: frame.left + dx, top: frame.top + dy}, viewportWidth, viewportHeight)
}

export function resizeFrame(frame: Frame, edges: ResizeEdges, dx: number, dy: number, viewportWidth: number, viewportHeight: number): Frame {
  const minWidth = Math.min(MIN_FRAME_WIDTH, viewportWidth), minHeight = Math.min(MIN_FRAME_HEIGHT, viewportHeight)
  let {left, top, width, height} = frame
  const right = left + width, bottom = top + height
  if (edges.left) {left = clamp(left + dx, 0, right - minWidth); width = right - left}
  else if (edges.right) width = clamp(width + dx, minWidth, viewportWidth - left)
  if (edges.top) {top = clamp(top + dy, 0, bottom - minHeight); height = bottom - top}
  else if (edges.bottom) height = clamp(height + dy, minHeight, viewportHeight - top)
  return {left, top, width, height}
}

/** Keep both panes at least a readable size when the user drags the splitter. */
export function clampSplit(ratio: number, size: number) {
  const low = size > 0 ? Math.min(MIN_PANE / size, 0.5) : 0.5
  return Number.isFinite(ratio) ? clamp(ratio, low, 1 - low) : 0.5
}

export type ExplorationDirection = 'consumers' | 'origins'
export type ExplorationViews = Partial<Record<ExplorationDirection, ExplorationProjection>>
export type ExplorationTree = Omit<ExplorationProjection, 'direction' | 'query_id'> & {direction: 'both'; focus: SourceAnchor}
export const FILE_CARD_WIDTH = 268
export const FILE_CARD_HEIGHT = 160
/** Extra room, and the divider label's height, for a column's test group. */
export const TEST_GROUP_GAP = 32
export const TEST_LABEL_HEIGHT = 22

export {isTestPath}

/** Drop test files (never the clicked file) with their edges, then anything that was
 * only reachable through them, so no card is left floating without a connection. */
export function hideTests<T extends Pick<ExplorationTree, 'nodes' | 'connections' | 'boundaries'>>(tree: T, focusPath: string): T & {hiddenTests: number} {
  const keep = new Set(tree.nodes.filter(n => n.path === focusPath || !isTestPath(n.path)).map(n => n.path))
  const connections = tree.connections.filter(c => keep.has(c.source) && keep.has(c.target))
  const reached = new Set([focusPath]), queue = [focusPath]
  while (queue.length) {
    const path = queue.pop()!
    for (const c of connections) {
      const next = c.source === path ? c.target : c.target === path ? c.source : null
      if (next && !reached.has(next)) {reached.add(next); queue.push(next)}
    }
  }
  const nodes = tree.nodes.filter(n => reached.has(n.path)), removed = new Set(tree.nodes.filter(n => !reached.has(n.path)).map(n => n.path))
  return {...tree, nodes, connections: connections.filter(c => reached.has(c.source) && reached.has(c.target)),
    boundaries: tree.boundaries.filter(b => reached.has(b.anchor.path) || (!removed.has(b.anchor.path) && !isTestPath(b.anchor.path))), hiddenTests: tree.nodes.filter(n => !reached.has(n.path) && isTestPath(n.path)).length}
}

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
  // Test files sit in their own group below the other cards of each column. The clicked file always stays with the first group so the map keeps its centre.
  const gapX = FILE_CARD_WIDTH + 112, gapY = FILE_CARD_HEIGHT + 40
  const split = new Map<number, {main: ExplorationNode[]; tests: ExplorationNode[]}>()
  for (const [rank, nodes] of columns) {
    nodes.sort((a, b) => a.path === focusPath ? -1 : b.path === focusPath ? 1 : a.path.localeCompare(b.path))
    const tests = nodes.filter(n => n.path !== focusPath && isTestPath(n.path))
    split.set(rank, {main: nodes.filter(n => !tests.includes(n)), tests})
  }
  const lowestRow = (count: number) => count ? Math.ceil((count - 1) / 2) : -1
  const above = Math.max(0, ...[...split.values()].map(g => g.main.length ? Math.floor((g.main.length - 1) / 2) : 0))
  const bottom = Math.max(0, ...[...split.values()].map(g => g.tests.length ? (lowestRow(g.main.length) + g.tests.length) * gapY + (g.main.length ? TEST_GROUP_GAP : 0) : lowestRow(g.main.length) * gapY))
  const marginX = Math.max(28, (viewport.width - FILE_CARD_WIDTH) / 2), marginY = Math.max(28, (viewport.height - FILE_CARD_HEIGHT) / 2)
  const centerY = marginY + above * gapY
  const positions = new Map<string, {x: number; y: number}>(), testGroups: {x: number; y: number}[] = []
  for (const [rank, {main, tests}] of split) {
    const x = marginX + (rank - minRank) * gapX
    main.forEach((node, i) => {
      const row = i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2
      positions.set(node.path, {x, y: centerY + row * gapY})
    })
    const start = lowestRow(main.length) + 1, offset = main.length ? TEST_GROUP_GAP : 0
    tests.forEach((node, i) => positions.set(node.path, {x, y: centerY + (start + i) * gapY + offset}))
    if (tests.length) testGroups.push({x, y: centerY + start * gapY + offset - TEST_LABEL_HEIGHT})
  }
  return {positions, testGroups, width: marginX * 2 + FILE_CARD_WIDTH + (maxRank - minRank) * gapX, height: marginY * 2 + FILE_CARD_HEIGHT + above * gapY + bottom}
}

export type MapPositions = Map<string, {x: number; y: number}>
export interface MapScrollMemory {version: number; x: number; y: number; left: number; top: number; width: number; height: number}

/** When every card fits inside the viewport with `pad` to spare, center the whole
 * graph (`fitted`); otherwise center the focused card. */
export function initialMapScroll(positions: MapPositions, focusPath: string, viewport: {width: number; height: number}, card: {width: number; height: number}, pad = 24) {
  const points = [...positions.values()]
  if (points.length) {
    const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x + card.width))
    const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y + card.height))
    if (right - left <= viewport.width - 2 * pad && bottom - top <= viewport.height - 2 * pad)
      return {left: (left + right) / 2 - viewport.width / 2, top: (top + bottom) / 2 - viewport.height / 2, fitted: true}
  }
  const focus = positions.get(focusPath)
  if (!focus) return {left: 0, top: 0, fitted: false}
  return {left: focus.x + card.width / 2 - viewport.width / 2, top: focus.y + card.height / 2 - viewport.height / 2, fitted: false}
}

/** Recenter only when the investigation changes or the previous viewport was never measured.
 * Any other layout change (resize, splitter, progress, expansion) keeps the focused card at
 * the same on-screen offset, because the layout itself moves with the viewport size. */
export function nextMapScroll(previous: MapScrollMemory | null, version: number, positions: MapPositions, focusPath: string, viewport: {width: number; height: number}, card: {width: number; height: number}) {
  if (!previous || previous.version !== version || previous.width === 0 || previous.height === 0) {
    const start = initialMapScroll(positions, focusPath, viewport, card)
    return {left: start.left, top: start.top, recentered: true}
  }
  const point = positions.get(focusPath) || {x: previous.x, y: previous.y}
  return {left: previous.left + point.x - previous.x, top: previous.top + point.y - previous.y, recentered: false}
}

/** One-line account of a connection: its distinct evidence kinds in order, how many
 * connections back it, and the unchanged files an indirect edge passes through. */
export function describeConnection(edge: Pick<ExplorationConnection, 'indirect' | 'hidden_paths' | 'evidence'>) {
  const kinds = [...new Set(edge.evidence.map(e => e.kind))], count = edge.evidence.length, hidden = edge.hidden_paths.length
  const via = edge.indirect ? `, via ${hidden} unchanged ${hidden === 1 ? 'file' : 'files'}` : ''
  return {kinds, text: `${kinds.join(' → ')} · ${count} ${count === 1 ? 'connection' : 'connections'}${via}`}
}

export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 2
export const clampZoom = (zoom: number) => Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1

/** Exponential wheel zoom: equal wheel travel scales by the same factor in both directions. */
export function wheelZoom(zoom: number, deltaY: number) {
  return clampZoom(zoom * Math.exp(-Math.max(-240, Math.min(240, deltaY)) * 0.0015))
}

/** Scroll offset that keeps the content point under `cursor` (viewport coordinates) fixed while zooming.
 * `pad` is the constant empty margin around the scaled content inside the scroll area. */
export function zoomScroll(scroll: {left: number; top: number}, cursor: {x: number; y: number}, from: number, to: number, pad = {x: 0, y: 0}) {
  const ratio = to / from
  return {left: (scroll.left + cursor.x - pad.x) * ratio + pad.x - cursor.x, top: (scroll.top + cursor.y - pad.y) * ratio + pad.y - cursor.y}
}

/** Empty space kept around the map so it can always be dragged, even when everything fits. */
export const PAN_SLACK = 0.35
export const panPadding = (viewport: {width: number; height: number}) => ({x: Math.round(viewport.width * PAN_SLACK), y: Math.round(viewport.height * PAN_SLACK)})

/** Card positions in scroll-area pixels: scaled by `zoom`, then shifted by the pan padding. */
export function scalePositions(positions: MapPositions, zoom: number, pad = {x: 0, y: 0}): MapPositions {
  return new Map([...positions].map(([path, point]) => [path, {x: point.x * zoom + pad.x, y: point.y * zoom + pad.y}]))
}

/** Largest zoom (never above 100%) at which every card fits the viewport with padding. */
export function fitZoom(positions: MapPositions, card: {width: number; height: number}, viewport: {width: number; height: number}, pad = 24) {
  const points = [...positions.values()]
  if (!points.length || viewport.width <= 0 || viewport.height <= 0) return 1
  const width = Math.max(...points.map(p => p.x + card.width)) - Math.min(...points.map(p => p.x))
  const height = Math.max(...points.map(p => p.y + card.height)) - Math.min(...points.map(p => p.y))
  return clampZoom(Math.min(1, (viewport.width - 2 * pad) / width, (viewport.height - 2 * pad) / height))
}
