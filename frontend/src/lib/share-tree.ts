// Immutable JSON-shaped settings/snapshots only. Neither input is modified:
// a reordered draft may already contain references from an older undo entry.
export function shareTree<T>(previous: T, next: T): T {
  if (Object.is(previous, next) || !previous || !next || typeof previous !== 'object' ||
      typeof next !== 'object' || Array.isArray(next) !== Array.isArray(previous)) return next
  const old = previous as Record<string, unknown>
  const fresh = next as Record<string, unknown>
  const keys = Object.keys(fresh)
  let equal = keys.length === Object.keys(old).length
  let copy: Record<string, unknown> | undefined
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const exists = Object.hasOwn(old, key)
    const child = exists ? shareTree(old[key], fresh[key]) : fresh[key]
    if (equal && exists && Object.is(child, old[key])) continue
    if (equal) {
      equal = false
      copy = (Array.isArray(next) ? next.slice() : { ...fresh }) as Record<string, unknown>
      for (let j = 0; j < i; j++) copy[keys[j]] = old[keys[j]]
    }
    if (!Object.is(child, fresh[key])) {
      copy ??= (Array.isArray(next) ? next.slice() : { ...fresh }) as Record<string, unknown>
      copy[key] = child
    }
  }
  return equal ? previous : (copy as T | undefined) ?? next
}
