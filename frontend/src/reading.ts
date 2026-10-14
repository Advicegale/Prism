// Pure reading-layout helpers: diff layout from available width and keyboard shortcuts for the Topics reader.
export type DiffMode = 'unified' | 'split'
export type ReadingAction = 'next-file' | 'prev-file' | 'next-change' | 'toggle-mode' | 'toggle-focus' | 'help'
export interface ShortcutTarget {tagName?: string; isContentEditable?: boolean; closest(selector: string): unknown}
export interface ShortcutEvent {key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean; target: ShortcutTarget | null}

const SPLIT_MIN_WIDTH = 960
const UNIFIED_BELOW_WIDTH = 900
const ACTIONS = new Map<string, ReadingAction>([['j', 'next-file'], ['k', 'prev-file'], [']', 'next-change'], ['s', 'toggle-mode'], ['f', 'toggle-focus'], ['?', 'help']])
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export const READING_SHORTCUTS: [string, string][] = [
  ['J / K', 'Next or previous file'],
  [']', 'Next change in this file'],
  ['S', 'Switch split and unified diff'],
  ['F', 'Focus mode for this topic'],
  ['?', 'Show or hide these shortcuts'],
  ['Esc', 'Close this panel or leave focus mode'],
]

// Stateless default: split only when the diff pane has room for two readable columns.
export function defaultDiffMode(width: number): DiffMode {
  return width >= SPLIT_MIN_WIDTH ? 'split' : 'unified'
}

// Hysteresis: split is kept until the pane drops below 900px, unified is kept until it reaches 960px.
export function nextDefaultMode(width: number, current: DiffMode): DiffMode {
  if (!(width > 0)) return 'unified'
  if (current === 'split') return width < UNIFIED_BELOW_WIDTH ? 'unified' : 'split'
  return width >= SPLIT_MIN_WIDTH ? 'split' : 'unified'
}

// Shortcuts never fire while typing, with browser/OS modifiers, or inside the symbol explorer window.
export function readingShortcut(event: ShortcutEvent): ReadingAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const target = event.target
  if (TEXT_ENTRY_TAGS.has(String(target?.tagName || '').toUpperCase()) || target?.isContentEditable) return null
  if (target?.closest?.('.symbol-exploration')) return null
  return ACTIONS.get(event.key.toLowerCase()) ?? null
}
