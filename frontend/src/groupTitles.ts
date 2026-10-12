import type { ChangeGroup } from './types'

function cleanTitle(title: string) {
  return title.replace(/\s+/g, ' ').trim() || 'Change group'
}

function basename(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

function fileSuffix(group: ChangeGroup) {
  const files = [...new Set(group.files)].sort()
  if (!files.length) return ''
  if (files.length === 1) return basename(files[0])
  return `${basename(files[0])} +${files.length - 1} more`
}

export function buildGroupDisplayTitles(groups: ChangeGroup[]) {
  const buckets = new Map<string, ChangeGroup[]>()
  for (const group of groups) {
    const base = cleanTitle(group.title)
    const key = base.toLocaleLowerCase()
    buckets.set(key, [...(buckets.get(key) || []), group])
  }

  const titles: Record<string, string> = {}
  for (const siblings of buckets.values()) {
    if (siblings.length === 1) {
      titles[siblings[0].id] = cleanTitle(siblings[0].title)
      continue
    }

    const suffixes = siblings.map(fileSuffix)
    const suffixCounts = new Map<string, number>()
    for (const suffix of suffixes) {
      const key = suffix.toLocaleLowerCase()
      suffixCounts.set(key, (suffixCounts.get(key) || 0) + 1)
    }

    const decorated = siblings.map((group, index) => {
      const suffix = suffixes[index]
      if (suffix && (suffixCounts.get(suffix.toLocaleLowerCase()) || 0) === 1) return suffix
      return [...new Set(group.files)].sort().join(', ') || `Segment ${index + 1}`
    })
    const decoratedCounts = new Map<string, number>()
    for (const suffix of decorated) {
      const key = suffix.toLocaleLowerCase()
      decoratedCounts.set(key, (decoratedCounts.get(key) || 0) + 1)
    }

    siblings.forEach((group, index) => {
      const base = cleanTitle(group.title)
      const suffix = decoratedCounts.get(decorated[index].toLocaleLowerCase())! > 1
        ? `${decorated[index]} · Segment ${index + 1}`
        : decorated[index]
      titles[group.id] = `${base} · ${suffix}`
    })
  }

  const titleCounts = new Map<string, number>()
  for (const title of Object.values(titles)) {
    const key = title.toLocaleLowerCase()
    titleCounts.set(key, (titleCounts.get(key) || 0) + 1)
  }
  for (const [index, group] of groups.entries()) {
    const title = titles[group.id]
    if ((titleCounts.get(title.toLocaleLowerCase()) || 0) > 1) {
      const suffix = [...new Set(group.files)].sort().join(', ') || `Segment ${index + 1}`
      titles[group.id] = `${title} · ${suffix}`
    }
  }
  return titles
}
