import { join } from 'node:path'
import { collectMarkdown } from './collect.ts'
import { scopeChain } from './scope.ts'
import type { CollectionName, Context, ContextCollection, ContextFile, Fields, Manifest, MarkdownItem } from './types.ts'

export const COLLECTIONS: readonly CollectionName[] = ['standards', 'adr', 'specs', 'plans', 'skills']

/** Front-matter `scopes`: a comma/space separated string or a YAML list. */
function frontMatterScopes(fields: Fields | null): string[] {
  const value = fields?.scopes
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean)
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string')
  return []
}

function ownerScope(rel: string): string | null {
  const slash = rel.indexOf('/')
  return slash === -1 ? null : rel.slice(0, slash)
}

type Owned = MarkdownItem & { scope: string | null }

async function assembleCollection(dir: string, name: CollectionName, chain: string[]): Promise<ContextCollection> {
  const items = await collectMarkdown(dir)
  const chainSet = new Set(chain)
  const groups = new Map<string, Owned[]>(chain.map((s) => [s, []]))
  const rootFiles: Owned[] = []

  for (const item of items) {
    const owner = ownerScope(item.rel)
    if (owner === null) {
      rootFiles.push({ ...item, scope: null })
      continue
    }
    if (item.fields?.scope === 'global') continue
    if (chainSet.has(owner)) {
      groups.get(owner)?.push({ ...item, scope: owner })
      continue
    }
    const via = frontMatterScopes(item.fields).find((s) => chainSet.has(s))
    if (via !== undefined) groups.get(via)?.push({ ...item, scope: via })
  }

  const files: ContextFile[] = []
  const seen = new Set<string>()
  const push = (f: Owned): void => {
    if (seen.has(f.path)) return
    seen.add(f.path)
    files.push({ rel: f.rel, scope: f.scope, title: f.title, body: f.body })
  }
  for (const s of chain) for (const f of groups.get(s) ?? []) push(f)
  for (const f of rootFiles) push(f)
  return { name, files }
}

export interface AssembleInput {
  rnessDir: string
  manifest: Manifest
  scope: string | null
}

/** Resolve every scoped collection for `scope` (null = global only). */
export async function assembleContext({ rnessDir, manifest, scope }: AssembleInput): Promise<Context> {
  const chain = scopeChain(manifest, scope)
  const collections = await Promise.all(
    COLLECTIONS.map((name) => assembleCollection(join(rnessDir, name), name, chain)),
  )
  return { scope, collections }
}
