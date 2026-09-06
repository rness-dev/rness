function isPrefix(prefix, target) {
  if (prefix === target) return true
  return target.startsWith(`${prefix}/`)
}

export function resolveScope(manifest, relDir) {
  let best = null
  let bestLen = -1
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    if (isPrefix(entry.path, relDir) && entry.path.length > bestLen) {
      best = name
      bestLen = entry.path.length
    }
  }
  return best
}

export function scopeChain(manifest, scope) {
  if (scope == null) return []
  const chain = []
  const seen = new Set()
  const visit = (name, stack) => {
    if (stack.has(name)) throw new Error(`extends cycle at scope "${name}"`)
    if (seen.has(name)) return
    seen.add(name)
    chain.push(name)
    stack.add(name)
    for (const target of manifest.scopes[name]?.extends ?? []) visit(target, stack)
    stack.delete(name)
  }
  visit(scope, new Set())
  return chain
}
