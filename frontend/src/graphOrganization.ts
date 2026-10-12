import type { GraphNode } from './types'

const CODE_EXTENSION = /\.(cs|ts|tsx|js|jsx|py|java|go|rs|swift|php|rb|cpp|c|h|hpp)$/i
const TEST_TOKEN = /(?:^|[._-])(?:test|tests|spec|specs)(?:$|[._-])/i
const CAMEL_TEST_SUFFIX = /[a-z0-9](?:Test|Tests|Spec|Specs)$/
const TEST_PREFIX = /^(?:Test|Tests|Spec|Specs)(?:[A-Z0-9_.-]|$)/

function pathParts(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean)
}

function isTestPath(path: string): boolean {
  const parts = pathParts(path)
  const isTestName = (name: string) => TEST_TOKEN.test(name) || CAMEL_TEST_SUFFIX.test(name) || TEST_PREFIX.test(name)
  return parts.slice(0, -1).some(isTestName) || isTestName((parts.at(-1) || '').replace(CODE_EXTENSION, ''))
}

function identifierTokens(rawName: string): string[] {
  const name = rawName.replace(CODE_EXTENSION, '')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean)
}

function qualifiedParts(node: GraphNode): string[] {
  return (node.qualified || '').split(/[.:/\\]+/).filter(Boolean)
}

function typeName(node: GraphNode): string {
  const qualified = qualifiedParts(node)
  return node.label || qualified.at(-1) || pathParts(node.path).at(-1)?.replace(CODE_EXTENSION, '') || ''
}

function isTypeNode(node: GraphNode): boolean {
  return /^(?:class|interface|struct|enum|trait|record|type)(?:_|$)/i.test(node.kind)
}

function titleCase(value: string): string {
  return identifierTokens(value).map(token => token === token.toUpperCase()
    ? token
    : token[0].toUpperCase() + token.slice(1)).join(' ')
}

function learnedSuffixes(nodes: GraphNode[]): Map<string, string> {
  const candidates = new Map<string, { names: Set<string>; labels: Map<string, number> }>()
  for (const node of nodes) {
    if (!isTypeNode(node) || isTestPath(node.path)) continue
    const tokens = identifierTokens(typeName(node))
    if (tokens.length < 2) continue

    const suffix = tokens[tokens.length - 1]
    const key = suffix.toLowerCase()
    const profile = candidates.get(key) || { names: new Set<string>(), labels: new Map<string, number>() }
    profile.names.add(tokens.join('').toLowerCase())
    profile.labels.set(suffix, (profile.labels.get(suffix) || 0) + 1)
    candidates.set(key, profile)
  }

  const learned = new Map<string, string>()
  for (const [key, profile] of candidates) {
    // A suffix becomes a component family only when distinct type names in
    // this graph demonstrate that the repository uses it as a convention.
    if (profile.names.size < 2) continue
    const label = [...profile.labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    learned.set(key, label)
  }
  return learned
}

function nameCandidates(node: GraphNode): string[] {
  const qualified = qualifiedParts(node)
  const isMember = /method|function|property/i.test(node.kind)
  const owner = isMember && qualified.length > 1 ? qualified[qualified.length - 2] : ''
  const file = pathParts(node.path).at(-1)?.replace(CODE_EXTENSION, '') || ''
  return [owner, node.label, qualified.at(-1) || '', file].filter(Boolean)
}

function moduleName(path: string): string {
  const parts = pathParts(path)
  const directory = parts.length > 1 ? parts[parts.length - 2] : ''
  return directory ? titleCase(directory) : 'Other'
}

/** Infer graph-specific component groups from recurring type-name patterns and source modules. */
export function inferComponentGroups(nodes: GraphNode[]): Map<string, string> {
  const suffixes = learnedSuffixes(nodes)
  const roles = new Map<string, string>()
  for (const node of nodes) {
    if (isTestPath(node.path)) {
      roles.set(node.id, 'Tests')
      continue
    }

    let group = ''
    for (const candidate of nameCandidates(node)) {
      const suffix = identifierTokens(candidate).at(-1)?.toLowerCase()
      if (suffix && suffixes.has(suffix)) {
        group = suffixes.get(suffix) || ''
        break
      }
    }
    roles.set(node.id, group || moduleName(node.path))
  }
  return roles
}
