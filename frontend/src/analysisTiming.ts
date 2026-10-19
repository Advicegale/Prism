import type {Report} from './types'

export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'Not recorded'
  if (seconds < 1) return '<1s'
  const value = Math.round(seconds), hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), rest = value % 60
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', rest || (!hours && !minutes) ? `${rest}s` : ''].filter(Boolean).join(' ')
}

export function analysisDurationTooltip(report: Pick<Report, 'analysis_timings'>): string {
  const timing = report.analysis_timings
  const graph = `Graph ready (viewable): ${formatDuration(timing?.graph_seconds)}`
  if (!timing) return `${graph}\nReview finalized: Not recorded for this saved report`
  if (timing.review_status === 'not_requested') return `${graph}\nReview: Not requested (graph only)`
  if (timing.review_status === 'running') return `${graph}\nReview: Still generating`
  if (timing.review_status === 'failed') return `${graph}\nReview: Not finalized${timing.review_seconds === undefined ? '' : ` (stopped after ${formatDuration(timing.review_seconds)})`}`
  if (timing.review_kind === 'regenerated') return `${graph}\nReview regenerated: ${formatDuration(timing.review_seconds)}`
  return `${graph}\nReview finalized: ${formatDuration(timing.total_seconds)} total (${formatDuration(timing.review_seconds)} after graph)`
}
