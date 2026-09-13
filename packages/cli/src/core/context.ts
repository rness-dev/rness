import { join } from 'node:path'

import { collectMarkdown } from './collect.ts'
import { scopeChain } from './scope.ts'
import type {
  CollectionName,
  Context,
  ContextCollection,
  ContextFile,
  Manifest,
  MarkdownItem,
} from './types.ts'

export const COLLECTIONS: readonly CollectionName[] = [
  'standards',
  'adr',
  'specs',
  'plans',
  'skills',
]

/** The first path segment of `rel`, or null for a file at the collection root. */
export function ownerScope(rel: string): string | null {
  const slash = rel.indexOf('/')
  return slash === -1 ? null : rel.slice(0, slash)
}

type Owned = MarkdownItem & { scope: string | null }

/**
 * The file's place defines its scope (spec 0003 §4.0): collection-root files
 * are global, `<scope>/**` files belong to that scope. A file under a
 * directory outside the chain is ignored; front matter never re-routes.
 */
async function assembleCollection(
  dir: string,
  name: CollectionName,
  chain: string[]
): Promise<ContextCollection> {
  const items = await collectMarkdown(dir)
  const groups = new Map<string, Owned[]>(chain.map((s) => [s, []]))
  const rootFiles: Owned[] = []
  for (const item of items) {
    const owner = ownerScope(item.rel)
    if (owner === null) rootFiles.push({ ...item, scope: null })
    else groups.get(owner)?.push({ ...item, scope: owner })
  }
  const files: ContextFile[] = []
  const push = (f: Owned): void => {
    files.push({
      rel: f.rel,
      scope: f.scope,
      title: f.title,
      body: f.body,
      content: f.content,
    })
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
export async function assembleContext({
  rnessDir,
  manifest,
  scope,
}: AssembleInput): Promise<Context> {
  const chain = scopeChain(manifest, scope)
  const collections = await Promise.all(
    COLLECTIONS.map((name) =>
      assembleCollection(join(rnessDir, name), name, chain)
    )
  )
  return { scope, collections }
}
