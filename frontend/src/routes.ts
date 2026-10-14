export type ReportView = 'architecture' | 'topics'

export type Route =
  | {name: 'home'}
  | {name: 'history'}
  | {name: 'settings'}
  | {name: 'report'; id: string; view: ReportView; file?: string}

const REPORT_ID = /^[0-9a-f]{24}$/
const HOME: Route = {name: 'home'}

// Reads the first `file` parameter. Returns null when the percent-encoding is malformed.
function readFileParam(query: string): {file?: string} | null {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq) !== 'file') continue
    try {
      const file = decodeURIComponent(part.slice(eq + 1))
      return file ? {file} : {}
    } catch {
      return null
    }
  }
  return {}
}

/** Parses a location hash such as `#/reports/<id>/topics?file=...`. Anything unrecognized is home. */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const question = raw.indexOf('?')
  const path = question >= 0 ? raw.slice(0, question) : raw
  const query = question >= 0 ? raw.slice(question + 1) : ''
  if (path === '' || path === '/') return HOME
  if (!path.startsWith('/')) return HOME
  const segments = path.slice(1).split('/')
  if (segments.length === 1 && segments[0] === 'reports' && !query) return {name: 'history'}
  if (segments.length === 1 && segments[0] === 'settings' && !query) return {name: 'settings'}
  if (segments[0] !== 'reports' || segments.length < 2 || segments.length > 3) return HOME
  const id = segments[1]
  if (!REPORT_ID.test(id)) return HOME
  const view = segments.length === 3 ? segments[2] : 'architecture'
  if (view !== 'architecture' && view !== 'topics') return HOME
  const params = readFileParam(query)
  if (!params) return HOME
  return {name: 'report', id, view, ...params}
}

/** Formats a route as a hash. `parseRoute(formatRoute(route))` returns the same route. */
export function formatRoute(route: Route): string {
  if (route.name === 'home') return '#/'
  if (route.name === 'history') return '#/reports'
  if (route.name === 'settings') return '#/settings'
  const base = `#/reports/${route.id}/${route.view}`
  return route.file ? `${base}?file=${encodeURIComponent(route.file)}` : base
}

/** Browser tab title for the screen a route shows. `pr` is set only when the report for the route is loaded. */
export function documentTitle(route: Route, pr: {repo: string; number: number} | null): string {
  if (route.name === 'history') return 'Prism · Recent reports'
  if (route.name === 'settings') return 'Prism · Configuration'
  if (route.name === 'report' && pr) return `Prism · ${pr.repo} #${pr.number}`
  return 'Prism · Structural PR Review'
}
