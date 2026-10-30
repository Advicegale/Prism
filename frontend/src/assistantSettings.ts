import type {HarnessInfo, Harnesses, ReviewAssistantSettings} from './types'

// One saved assistant (CLI harness, model, effort) plus whether the Analyze form asks it for review notes.
export type AssistantSetting = ReviewAssistantSettings
export interface AssistantState {assistant: AssistantSetting; analyzeWithAi: boolean}
export interface ReadableStorage {getItem(key: string): string | null}
export interface WritableStorage {setItem(key: string, value: string): void}

export const ASSISTANT_KEY = 'prism:assistant'
export const ANALYZE_AI_KEY = 'prism:analyze-ai'
export const DEFAULT_ASSISTANT: AssistantSetting = {harness: 'codex', model: 'default', effort: 'default'}

type Harness = AssistantSetting['harness']
const isHarness = (value: unknown): value is Harness => value === 'codex' || value === 'claude'
const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.trim() : fallback

function parseAssistant(raw: string): AssistantSetting {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return {...DEFAULT_ASSISTANT} }
  if (!value || typeof value !== 'object') return {...DEFAULT_ASSISTANT}
  const record = value as Record<string, unknown>
  return {
    harness: isHarness(record.harness) ? record.harness : DEFAULT_ASSISTANT.harness,
    model: text(record.model, DEFAULT_ASSISTANT.model),
    effort: text(record.effort, DEFAULT_ASSISTANT.effort),
    ...(typeof record.timeout_seconds === 'number' && record.timeout_seconds >= 0 ? {timeout_seconds: record.timeout_seconds} : {}),
  }
}

// Reads the saved state. When prism:assistant is absent (first run or an older profile), it migrates the
// question keys first, then the Analyze keys, and only when the old Analyze harness was a real CLI.
export function loadAssistantState(storage: ReadableStorage): AssistantState {
  const saved = storage.getItem(ASSISTANT_KEY)
  const savedAnalyze = storage.getItem(ANALYZE_AI_KEY)
  if (saved !== null) return {assistant: parseAssistant(saved), analyzeWithAi: savedAnalyze === 'true'}

  const analysisHarness = storage.getItem('prism:harness')
  const analysisUsedAi = isHarness(analysisHarness)
  const analyzeWithAi = savedAnalyze !== null ? savedAnalyze === 'true' : analysisUsedAi

  const questionHarness = storage.getItem('prism:question-harness')
  if (questionHarness !== null) {
    return {
      assistant: {
        harness: questionHarness === 'claude' ? 'claude' : 'codex',
        model: text(storage.getItem('prism:question-model'), 'default'),
        effort: text(storage.getItem('prism:question-effort'), 'default'),
      },
      analyzeWithAi,
    }
  }
  if (analysisUsedAi) {
    return {
      assistant: {
        harness: analysisHarness,
        model: text(storage.getItem('prism:model'), 'default'),
        effort: text(storage.getItem('prism:effort'), 'default'),
      },
      analyzeWithAi,
    }
  }
  return {assistant: {...DEFAULT_ASSISTANT}, analyzeWithAi}
}

export function saveAssistantState(storage: WritableStorage, state: AssistantState): void {
  storage.setItem(ASSISTANT_KEY, JSON.stringify({harness: state.assistant.harness, model: state.assistant.model, effort: state.assistant.effort, timeout_seconds: state.assistant.timeout_seconds}))
  storage.setItem(ANALYZE_AI_KEY, String(state.analyzeWithAi))
}

// Per-call limit for the assistant CLI. undefined = Prism's server default (30 min); 0 = no limit.
export const TIMEOUT_OPTIONS: {value: number | undefined; label: string}[] = [
  {value: undefined, label: 'Server default (30 min)'}, {value: 600, label: '10 minutes'}, {value: 1800, label: '30 minutes'},
  {value: 3600, label: '1 hour'}, {value: 14400, label: '4 hours'}, {value: 0, label: 'No limit'},
]

export function harnessLabel(harness: Harness): string {
  return harness === 'claude' ? 'Claude Code' : 'Codex'
}

// "Codex · default model" or "Claude Code · sonnet"; used on the topbar button, the Analyze summary and the panels.
export function assistantSummary(assistant: AssistantSetting): string {
  return `${harnessLabel(assistant.harness)} · ${assistant.model === 'default' ? 'default model' : assistant.model}`
}

// The harness's model list without the implicit "default" entry (the UI adds "CLI default" itself).
export function assistantModelOptions(harnesses: Harnesses | null, harness: Harness): {id: string; label: string}[] {
  const info: HarnessInfo | undefined = harnesses?.[harness]
  const listed = info?.models?.length
    ? info.models.map(item => ({id: item.id, label: item.label || item.id}))
    : harness === 'claude'
      ? (info?.aliases?.length ? info.aliases : ['default', 'sonnet', 'opus', 'haiku']).map(id => ({id, label: id}))
      : []
  return listed.filter(item => item.id !== 'default')
}

export function assistantEffortOptions(harnesses: Harnesses | null, harness: Harness, model: string): string[] {
  const info = harnesses?.[harness]
  const selected = info?.models.find(item => item.id === model)
  if (selected?.efforts?.length) return selected.efforts
  return info?.efforts?.length ? info.efforts : ['low', 'medium', 'high']
}

// When the saved harness is missing but the other CLI is installed, switch to the installed one with default settings.
export function installedFallback(assistant: AssistantSetting, harnesses: Harnesses): AssistantSetting | null {
  if (harnesses[assistant.harness].installed) return null
  const other: Harness = assistant.harness === 'codex' ? 'claude' : 'codex'
  return harnesses[other].installed ? {harness: other, model: 'default', effort: 'default'} : null
}
