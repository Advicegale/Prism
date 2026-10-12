import type { GraphNode } from './types'

const componentRoles = [
  'ViewModel', 'Repository', 'Controller', 'Middleware', 'Serializer', 'Validator',
  'Coordinator', 'Producer', 'Consumer', 'Decorator', 'Resolver', 'Adapter',
  'Provider', 'Factory', 'Manager', 'Service', 'Gateway', 'Strategy', 'Listener',
  'Command', 'Query', 'Request', 'Response', 'Component', 'Mapper', 'Store', 'Cache',
  'Client', 'Builder', 'Settings', 'Inventory', 'Extension', 'Utility', 'Helper',
  'Entity', 'Model', 'Config', 'Data', 'Enum', 'Flags', 'DTO',
].sort((a, b) => b.length - a.length)

function roleFromName(name: string): string | null {
  const withoutCodeExtension = name.replace(/\.(cs|ts|tsx|js|jsx|py|java|go|rs|swift|php|rb|cpp|c|h|hpp)$/i, '')
  const compact = withoutCodeExtension.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const singular = compact.endsWith('s') ? compact.slice(0, -1) : compact
  const role = componentRoles.find(candidate => {
    const suffix = candidate.toLowerCase()
    return compact.endsWith(suffix) || singular.endsWith(suffix)
  })
  return role || null
}

/** Infer a component group from a symbol's owner, then its file and containing folders. */
export function inferComponentRole(node: Pick<GraphNode, 'label' | 'qualified' | 'kind' | 'path'>): string {
  const qualifiedParts = (node.qualified || '').split(/[.:/\\]+/).filter(Boolean)
  const isMember = /method|function|property/i.test(node.kind)
  const owner = isMember && qualifiedParts.length > 1
    ? qualifiedParts[qualifiedParts.length - 2]
    : qualifiedParts[qualifiedParts.length - 1]
  const pathParts = node.path.split(/[\\/]/).filter(Boolean)
  const leaf = pathParts.pop() || ''
  const candidates = [owner, node.label, leaf, ...pathParts.reverse()].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    const role = roleFromName(candidate)
    if (role) return role
  }
  return 'Other'
}
