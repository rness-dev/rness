import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  BoardRefused,
  PULSE,
  parseBoard,
  readPresetEntry,
} from './board-declaration.ts'
import { writeFileAtomic } from './fs.ts'
import { repoUrl } from './remote.ts'
import type {
  BoardEntry,
  Boards,
  Manifest,
  ProviderName,
  RefusedBoard,
  RepoEntry,
  ScopeEntry,
} from './types.ts'

/**
 * A repository or scope name: what GitHub allows in a repository name, in
 * lowercase — letters, digits, `.`, `_` and `-`. Not `.` or `..` (the name is
 * a directory under `org/`), and no leading `-` (git would read an option).
 */
export const NAME = /^(?!\.{1,2}$)[a-z0-9._][a-z0-9._-]*$/

/**
 * The organization's context repository. It holds the catalogue and is cloned
 * as `<root>/.rness`, so it is never a member of the workspace it defines:
 * `create` does not offer it and `add` refuses it (spec 0009).
 */
export const CONTEXT_REPO = '.rness'

/**
 * Names that are never a repository of the workspace, whatever they look like
 * (spec 0009). A leading dot is an ordinary first character — `.github`
 * carries an organization's profile, its templates and its shared workflows —
 * so the rule cannot be a shape: it is this list. Add a name here rather than
 * inventing another filter.
 *
 * - `.rness` — the context repository: it holds the catalogue and is already
 *   cloned as `<root>/.rness`.
 * - `.git` — a git directory, were `org/` ever to sit inside a repository.
 * - `node_modules` — an install run one directory too high.
 */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  CONTEXT_REPO,
  '.git',
  'node_modules',
])

/**
 * Whether a repository of the organization can become a member of the
 * workspace. Everything active is, but an excluded name; an archived
 * repository is read-only on GitHub, so a block written into it could never be
 * pushed back. `create` filters its listing with this, and counts with it, so
 * the number it announces and the list it offers cannot disagree.
 */
export function isMemberRepo(repo: {
  name: string
  archived: boolean
}): boolean {
  return !repo.archived && !EXCLUDED_NAMES.has(repo.name.toLowerCase())
}

/**
 * Whether a directory under `org/` is one of the workspace's clones. It must
 * be a name the catalogue could hold: a directory `rness add` could never
 * declare is not reported as an undeclared clone, since the command suggested
 * to bring it in would refuse it.
 */
export function isWorkspaceClone(name: string): boolean {
  return NAME.test(name) && !EXCLUDED_NAMES.has(name)
}
/** How the rule reads in an error message. */
export const NAME_RULE =
  "lowercase letters, digits, '.', '_' and '-', not starting with '-'"

/**
 * A GitHub organization (or user) name: alphanumerics and single hyphens, not
 * at either end, at most 39 characters. Used exactly as typed — GitHub
 * resolves names case-insensitively, but the URLs and `rness.json` keep the
 * spelling the user chose.
 */
export const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** Every top-level key contract 1 defines. */
const KEYS = [
  'contract',
  'provider',
  'org',
  'agents',
  'boards',
  // Former names of `boards`, still read: `sync` renames them (spec 0033 §3).
  'projects',
  'pulse',
  'repos',
  'scopes',
]

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
  if (typeof value !== 'string' || !ORG_NAME.test(value)) {
    fail(
      `"org" must be a GitHub organization name (got ${JSON.stringify(value)})`
    )
  }
  return value
}

/**
 * The name the workspace goes by — in its blocks and its session titles: the
 * organization, else the root directory's name. A workspace without `org` is
 * a blank one (spec 0012), a normal state rather than a slip to warn about.
 */
export function workspaceName(manifest: Manifest, root: string): string {
  return manifest.org ?? basename(root)
}

/** An agent name as `agents` holds it: lowercase letters, digits and `-`. */
const AGENT_NAME = /^[a-z][a-z0-9-]*$/

/** `agents`, when present: a list of unique agent names (spec 0011 §3.1). */
function readAgents(value: unknown): string[] | null {
  if (value === undefined) return null
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === 'string' && AGENT_NAME.test(v)) ||
    new Set(value).size !== value.length
  )
    fail(
      `"agents" must be a list of unique agent names (got ${JSON.stringify(value)})`
    )
  return [...(value as string[])]
}

/** The hosting providers `provider` may name (spec 0017 §2.1). */
export const PROVIDER_NAMES: readonly ProviderName[] = [
  'github',
  'gitlab',
  'atlassian',
]

/** `provider`, when present: one of {@link PROVIDER_NAMES}. */
function readProvider(value: unknown): ProviderName | null {
  if (value === undefined) return null
  const name = PROVIDER_NAMES.find((n) => n === value)
  if (name === undefined)
    fail(
      `"provider" must be one of ${PROVIDER_NAMES.join(', ')} (got ${JSON.stringify(value)})`
    )
  return name
}

/** The former `pulse`, 0.12 to 0.16: Agent Pulse alone, by number. */
function readPulse(value: unknown): Boards {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.project !== 'number' ||
    !Number.isInteger(value.project) ||
    value.project < 1
  )
    fail(
      `"pulse" must be { "project": <number> } (got ${JSON.stringify(value)})`
    )
  return { [PULSE]: value.project }
}

/** A board's project number, whatever its form in `boards`; null until `board push` creates it. */
export const projectNumber = (entry: BoardEntry): number | null =>
  typeof entry === 'number'
    ? entry
    : typeof entry === 'string'
      ? null
      : entry.number

export { PULSE }
/** A name `boards` takes: a directory name, never hidden or a path. */
const BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const isProjectNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1

/**
 * `boards`, when present: names to boards — one declared whole (spec 0031
 * §2), a preset not created yet (spec 0033 §4), or a number (a board made
 * before 0.21.0) — the projects of those created distinct. A board refused
 * is set aside with its reason; the rest is read.
 */
function readBoardEntries(value: unknown): {
  boards: Boards | null
  refused: RefusedBoard[]
} {
  const entries = isRecord(value) ? Object.entries(value) : []
  const numbers = entries.flatMap(([, n]) =>
    isRecord(n) ? (isProjectNumber(n['number']) ? [n['number']] : []) : [n]
  )
  if (
    entries.length === 0 ||
    !entries.every(
      ([name, n]) =>
        BOARD_NAME.test(name) &&
        (isProjectNumber(n) || typeof n === 'string' || isRecord(n))
    ) ||
    new Set(numbers).size !== numbers.length
  )
    fail(
      `"boards" must map names to boards on distinct projects, as { "pulse": "agent-pulse", "marketing": 5 } (got ${JSON.stringify(value)})`
    )
  const boards: Boards = {}
  const refused: RefusedBoard[] = []
  for (const [name, entry] of entries) {
    if (isProjectNumber(entry)) {
      boards[name] = entry
      continue
    }
    try {
      boards[name] =
        typeof entry === 'string'
          ? readPresetEntry(name, entry)
          : parseBoard(name, entry)
    } catch (e) {
      if (!(e instanceof BoardRefused)) throw e
      refused.push({ name, reason: e.message, source: entry })
    }
  }
  return {
    boards: Object.keys(boards).length === 0 ? null : boards,
    refused,
  }
}

/** The keys that have held the boards, newest first (spec 0033 §3). */
const HOLDERS = ['boards', 'projects', 'pulse'] as const

/**
 * `boards`, else the former `projects` read as `boards`, else the former
 * `pulse` read as `boards.pulse`; more than one of them refused.
 */
function readBoardsOrFormer(data: Record<string, unknown>): {
  boards: Boards | null
  refused: RefusedBoard[]
  formerKey?: 'projects' | 'pulse'
} {
  const present = HOLDERS.filter((k) => data[k] !== undefined)
  if (present.length > 1)
    fail(
      `${present.map((k) => JSON.stringify(k)).join(' and ')} at once: keep "boards" only`
    )
  const key = present[0]
  if (key === undefined) return { boards: null, refused: [] }
  if (key === 'pulse')
    return { boards: readPulse(data.pulse), refused: [], formerKey: key }
  const read = readBoardEntries(data[key])
  return key === 'boards' ? read : { ...read, formerKey: key }
}

/** The key, else the first repository URL's host (github.com → github), else github. */
export function providerOf(manifest: Manifest): ProviderName {
  if (manifest.provider !== null) return manifest.provider
  const url = Object.values(manifest.repos)[0]?.url ?? ''
  const host = /^(?:[a-z+]+:\/\/(?:[^@/]*@)?|[^@/]+@)([^/:]+)/i.exec(url)?.[1]
  if (host?.toLowerCase().includes('gitlab')) return 'gitlab'
  return 'github'
}

function readRepos(value: unknown): Record<string, RepoEntry> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail('"repos" must be an object')
  const repos: Record<string, RepoEntry> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name))
      fail(`repo name "${name}" may only contain ${NAME_RULE}`)
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
    if (!NAME.test(name))
      fail(`scope name "${name}" may only contain ${NAME_RULE}`)
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
  return parseManifest(raw)
}

/** Validate the text of a `rness.json`, as `loadManifest` does the file's. */
export function parseManifest(raw: string): Manifest {
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
  const { boards, refused, formerKey } = readBoardsOrFormer(data)
  return {
    contract: 1,
    provider: readProvider(data.provider),
    org: readOrg(data.org),
    agents: readAgents(data.agents),
    boards,
    ...(refused.length === 0 ? {} : { refused }),
    ...(formerKey === undefined ? {} : { formerKey }),
    repos: readRepos(data.repos),
    scopes: readScopes(data.scopes),
  }
}

/** A value of `boards` as written: a number, a preset, or a board's JSON indented under its key. */
const boardEntry = (name: string, value: unknown): string =>
  `    ${JSON.stringify(name)}: ${JSON.stringify(value, null, 2).replaceAll('\n', '\n    ')}`

const isScalar = (v: unknown): boolean =>
  typeof v === 'number' || typeof v === 'string'

/**
 * `boards` as written, whatever key it was read from: on one line while
 * every board is a number or a preset; else each entry on its own lines, a
 * refused board kept as it was written.
 */
function boardsLines(manifest: Manifest): string[] {
  const entries: (readonly [string, unknown])[] = [
    ...Object.entries(manifest.boards ?? {}).map(
      ([name, b]) =>
        [name, isScalar(b) ? b : (b as { source: unknown }).source] as const
    ),
    ...(manifest.refused ?? []).map((r) => [r.name, r.source] as const),
  ]
  if (entries.length === 0) return []
  if (entries.every(([, v]) => isScalar(v)))
    return [
      `  "boards": { ${entries
        .map(([name, v]) => `${JSON.stringify(name)}: ${JSON.stringify(v)}`)
        .join(', ')} },`,
    ]
  return [
    '  "boards": {',
    entries.map(([name, v]) => boardEntry(name, v)).join(',\n'),
    '  },',
  ]
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
  if (manifest.provider !== null)
    lines.push(`  "provider": ${JSON.stringify(manifest.provider)},`)
  if (manifest.org !== null)
    lines.push(`  "org": ${JSON.stringify(manifest.org)},`)
  if (manifest.agents !== null)
    lines.push(
      `  "agents": [${manifest.agents.map((a) => JSON.stringify(a)).join(', ')}],`
    )
  lines.push(...boardsLines(manifest))
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
  org: string | null,
  host: string
): { name: string; url: string } {
  let url: string
  if (FULL_URL.test(spec)) {
    url = spec
  } else {
    const parts = spec.split('/')
    if (parts.length === 1) {
      // A blank workspace has no owner to expand a bare name with (spec 0012).
      if (org === null)
        throw new Error(
          'this workspace has no GitHub organization: give <owner>/<repo> or a git URL'
        )
      url = repoUrl(host, org, spec)
    } else if (
      parts.length === 2 &&
      parts[0] !== undefined &&
      parts[1] !== undefined
    )
      url = repoUrl(host, parts[0], parts[1])
    else
      throw new Error(
        `repository name "${spec}" is not a name (use <repo>, <owner>/<repo>, or a URL)`
      )
  }
  const last = url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? ''
  const name = last.endsWith('.git') ? last.slice(0, -4) : last
  if (!NAME.test(name))
    throw new Error(`repository name "${name}" may only contain ${NAME_RULE}`)
  return { name, url }
}
