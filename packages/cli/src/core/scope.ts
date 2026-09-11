import type { Manifest } from './types.ts'

function isPrefix(prefix: string, target: string): boolean {
  return prefix === target || target.startsWith(`${prefix}/`)
}

/** The scope whose `path` is the longest path-segment prefix of `relDir`; null = global. */
export function resolveScope(manifest: Manifest, relDir: string): string | null {
  let best: string | null = null
  let bestLen = -1
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    if (isPrefix(entry.path, relDir) && entry.path.length > bestLen) {
      best = name
      bestLen = entry.path.length
    }
  }
  return best
}

/** `scope` then its transitive `extends`, nearest first, de-duplicated. Throws on a cycle. */
export function scopeChain(manifest: Manifest, scope: string | null): string[] {
  if (scope === null) return []
  const chain: string[] = []
  const seen = new Set<string>()
  const visit = (name: string, stack: Set<string>): void => {
    if (stack.has(name)) throw new Error(`extends cycle at scope "${name}"`)
    if (seen.has(name)) return
    seen.add(name)
    chain.push(name)
    stack.add(name)
    const entry = Object.hasOwn(manifest.scopes, name) ? manifest.scopes[name] : undefined
    for (const target of entry?.extends ?? []) visit(target, stack)
    stack.delete(name)
  }
  visit(scope, new Set())
  return chain
}
