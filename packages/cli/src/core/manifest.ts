import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { writeFileAtomic } from './fs.ts'
import { repoUrl } from './remote.ts'
import type { Manifest, RepoEntry, ScopeEntry } from './types.ts'

export const NAME = /^[a-z0-9][a-z0-9-]*$/

/** Every top-level key contract 1 defines. */
const KEYS = ['contract', 'org', 'repos', 'scopes']

function fail(message: string): never {
  throw new Error(`rness.json: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkPath(scope: string, path: unknown): string {
  if (typeof path !== 'string' || path === '')
    fail(`scope "${scope}" needs a string "path"`)
  if (path.startsWith('/')) fail(`scope "${scope}" path must be relative`)
  if (path.split('/').includes('..'))
    fail(`scope "${scope}" path must not contain ".."`)
  if (path.split('/').some((segment) => segment === ''))
    fail(`scope "${scope}" path must not contain empty segments`)
  return path
}

function readOrg(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !NAME.test(value)) {
    fail(
      `"org" must be a name matching [a-z0-9-] (got ${JSON.stringify(value)})`
    )
  }
  return value
}

/** The organisation name every block and `add` use: `org`, else the root directory's name. */
export function resolveOrg(
  manifest: Manifest,
  root: string
): { org: string; warning: string | null } {
  if (manifest.org !== null) return { org: manifest.org, warning: null }
  const name = basename(root)
  return {
    org: name,
    warning: `rness.json: no "org"; using the directory name "${name}"`,
  }
}

function readRepos(value: unknown): Record<string, RepoEntry> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail('"repos" must be an object')
  const repos: Record<string, RepoEntry> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name)) fail(`repo name "${name}" is not [a-z0-9-]`)
    if (!isRecord(entry) || typeof entry.url !== 'string')
      fail(`repo "${name}" needs a string "url"`)
    repos[name] = { url: entry.url }
  }
  return repos
}

function readScopes(value: unknown): Record<string, ScopeEntry> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail('"scopes" must be an object')
  const scopes: Record<string, ScopeEntry> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name)) fail(`scope name "${name}" is not [a-z0-9-]`)
    if (!isRecord(entry)) fail(`scope "${name}" must be an object`)
    const path = checkPath(name, entry.path)
    const ext = entry.extends ?? []
    if (!Array.isArray(ext) || !ext.every((t) => typeof t === 'string')) {
      fail(`scope "${name}" extends must be an array of scope names`)
    }
    scopes[name] = { path, extends: ext as string[] }
  }
  for (const [name, entry] of Object.entries(scopes)) {
    for (const target of entry.extends) {
      if (!Object.hasOwn(scopes, target))
        fail(`scope "${name}" extends unknown scope "${target}"`)
    }
  }
  return scopes
}

/** Read and validate `<rnessDir>/rness.json`. Every error starts with `rness.json:`. */
export async function loadManifest(rnessDir: string): Promise<Manifest> {
  let raw: string
  try {
    raw = await readFile(join(rnessDir, 'rness.json'), 'utf8')
  } catch {
    fail('not found')
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    fail(`invalid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!isRecord(data)) fail('must be a JSON object')
  if (data.contract !== 1)
    fail(`unsupported contract: ${JSON.stringify(data.contract)} (expected 1)`)
  // Refuse what this contract does not define: a typo (`scope`, `repo`) or a
  // key from a later contract would otherwise be read as nothing at all.
  for (const key of Object.keys(data)) {
    if (!KEYS.includes(key)) fail(`unknown key ${JSON.stringify(key)}`)
  }
  return {
    contract: 1,
    org: readOrg(data.org),
    repos: readRepos(data.repos),
    scopes: readScopes(data.scopes),
  }
}

/** Serialise in the contract's key order; atomic write. */
export async function writeManifest(
  rnessDir: string,
  manifest: Manifest
): Promise<void> {
  const repos = Object.entries(manifest.repos).map(
    ([name, r]) =>
      `    ${JSON.stringify(name)}: { "url": ${JSON.stringify(r.url)} }`
  )
  const scopes = Object.entries(manifest.scopes).map(([name, s]) => {
    const ext =
      s.extends.length === 0
        ? ''
        : `, "extends": [${s.extends.map((e) => JSON.stringify(e)).join(', ')}]`
    return `    ${JSON.stringify(name)}: { "path": ${JSON.stringify(s.path)}${ext} }`
  })
  const lines = ['{', '  "contract": 1,']
  if (manifest.org !== null)
    lines.push(`  "org": ${JSON.stringify(manifest.org)},`)
  lines.push(
    '  "repos": {',
    repos.join(',\n'),
    '  },',
    '  "scopes": {',
    scopes.join(',\n'),
    '  }',
    '}'
  )
  const text = `${lines.filter((l) => l !== '').join('\n')}\n`
  await writeFileAtomic(join(rnessDir, 'rness.json'), text)
}

const FULL_URL = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/

/** `web` → `<host><org>/web.git`; `other/api` → `<host>other/api.git`; a full URL is kept. */
export function parseRepoSpec(
  spec: string,
  org: string,
  host: string
): { name: string; url: string } {
  let url: string
  if (FULL_URL.test(spec)) {
    url = spec
  } else {
    const parts = spec.split('/')
    if (parts.length === 1) url = repoUrl(host, org, spec)
    else if (
      parts.length === 2 &&
      parts[0] !== undefined &&
      parts[1] !== undefined
    )
      url = repoUrl(host, parts[0], parts[1])
    else
      throw new Error(
        `repository name "${spec}" is not [a-z0-9-] (use <repo>, <owner>/<repo>, or a URL)`
      )
  }
  const last = url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? ''
  const name = last.endsWith('.git') ? last.slice(0, -4) : last
  if (!NAME.test(name))
    throw new Error(`repository name "${name}" is not [a-z0-9-]`)
  return { name, url }
}
