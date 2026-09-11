import { join } from 'node:path'
import { collectMarkdown } from './collect.ts'
import { scopeChain } from './scope.mjs'

const COLLECTIONS = ['standards', 'adr', 'specs', 'plans', 'skills']

function frontMatterScopes(fields) {
  if (!fields || !fields.scopes) return []
  return fields.scopes.split(/[,\s]+/).filter(Boolean)
}

function ownerScope(rel) {
  const slash = rel.indexOf('/')
  return slash === -1 ? null : rel.slice(0, slash)
}

async function assembleCollection(dir, name, chain) {
  const items = await collectMarkdown(dir)
  const chainSet = new Set(chain)
  const groups = new Map(chain.map((s) => [s, []]))
  const rootFiles = []

  for (const item of items) {
    const owner = ownerScope(item.rel)
    const fmScopes = frontMatterScopes(item.fields)
    const isGlobalRoot = owner === null
    const globalTagged = item.fields?.scope === 'global'

    if (isGlobalRoot) {
      rootFiles.push({ ...item, scope: null })
      continue
    }
    if (globalTagged) continue
    if (chainSet.has(owner)) {
      groups.get(owner).push({ ...item, scope: owner })
      continue
    }
    const via = fmScopes.find((s) => chainSet.has(s))
    if (via) groups.get(via).push({ ...item, scope: via })
  }

  const files = []
  const seen = new Set()
  const push = (f) => {
    if (seen.has(f.path)) return
    seen.add(f.path)
    files.push({ rel: f.rel, scope: f.scope, title: f.title, body: f.body })
  }
  for (const s of chain) for (const f of groups.get(s)) push(f)
  for (const f of rootFiles) push(f)
  return { name, files }
}

export async function assembleContext({ rnessDir, manifest, scope }) {
  const chain = scopeChain(manifest, scope)
  const collections = await Promise.all(
    COLLECTIONS.map((name) => assembleCollection(join(rnessDir, name), name, chain)),
  )
  return { scope: scope ?? null, collections }
}
