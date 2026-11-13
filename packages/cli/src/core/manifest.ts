import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  BoardRefused,
  PULSE,
  parseBoard,
  readPresetEntry,
} from './board-declaration.ts'
import { writeFileAtomic } from './fs.ts'
import { currentSshUrl, repoUrl } from './remote.ts'
import { scopeChain } from './scope.ts'
import type {
  BoardEntry,
  Boards,
  JiraTarget,
  Manifest,
  ProviderName,
  RefusedBoard,
  Repository,
  ScopeEntry,
  SkillEntry,
} from './types.ts'

/**
 * A repository or scope name: what GitHub allows in a repository name, in
 * lowercase — letters, digits, `.`, `_` and `-`. Not `.` or `..` (the name is
 * a directory under `org/`), and no leading `-` (git would read an option).
 * Lowercase because the key in `rness.json`, the directory `org/<name>` and
 * the scope directories must agree on every file system: `dApp` and `dapp`
 * are one directory on macOS and two on Linux. A name typed in another case
 * is lowercased (`parseRepoSpec`), never refused. Not `__proto__` either:
 * `rness.json` is read into objects by name, and that key would set the
 * object's prototype. JavaScript's other built-in names are own keys there,
 * read with `Object.hasOwn`, never `[]` alone.
 */
export const NAME = /^(?!\.{1,2}$)(?!__proto__$)[a-z0-9._][a-z0-9._-]*$/

/**
 * The organization's context repository. It holds the catalogue and is cloned
 * as `<root>/.rness`, so it is never a member of the workspace it defines:
 * `create` does not offer it and `add` refuses it (spec 0009).
 */
export const CONTEXT_REPO = '.rness'

/**
 * The context repository's name on the host of `provider`: `.rness`, but
 * `rness` on GitLab, whose project slugs start with a letter or a digit
 * (spec 0037 §5.4). The directory is `.rness/` on every host.
 */
export function contextRepo(provider: ProviderName | null): string {
  return provider === 'gitlab' ? 'rness' : CONTEXT_REPO
}

/**
 * The context project's name on GitLab, as its pages list it; its path is
 * `rness`. GitLab refuses `.rness` as a name and `_rness` as a path: the
 * underscore sets the project apart from the group's others (spec 0037
 * §5.4).
 */
export const GITLAB_CONTEXT_NAME = '_rness'

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
export function isMemberRepo(
  repo: {
    name: string
    archived: boolean
  },
  provider: ProviderName | null = null
): boolean {
  const name = repo.name.toLowerCase()
  return (
    !repo.archived &&
    !EXCLUDED_NAMES.has(name) &&
    name !== contextRepo(provider)
  )
}

/**
 * Whether a directory under `org/` is one of the workspace's clones. It must
 * be a name the catalogue could hold: `org/dApp` is not the clone `dapp`, and
 * `sync` names it on a `not read:` line, pointing at `rness add`, which
 * renames it (plan 0052).
 */
export function isWorkspaceClone(
  name: string,
  provider: ProviderName | null = null
): boolean {
  return (
    NAME.test(name) &&
    !EXCLUDED_NAMES.has(name) &&
    name !== contextRepo(provider)
  )
}
/** How the rule reads in an error message. */
export const NAME_RULE =
  "lowercase letters, digits, '.', '_' and '-', not starting with '-', not __proto__"

/**
 * A GitHub organization (or user) name: alphanumerics and single hyphens, not
 * at either end, at most 39 characters. Used exactly as typed — GitHub
 * resolves names case-insensitively, but the URLs and `rness.json` keep the
 * spelling the user chose.
 */
export const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/**
 * A GitLab top-level group path (spec 0037 §2, `path_regex.rb` read
 * 2026-10-08): letters, digits, `_`, `-` and `.`, not starting with `-`,
 * not ending in `.`, `.git` or `.atom`. No `/`: a subgroup is not a
 * workspace.
 */
const GITLAB_GROUP = /^(?!-)[A-Za-z0-9_.-]{1,255}(?<!\.)(?<!\.git)(?<!\.atom)$/

/**
 * A Bitbucket workspace slug (spec 0039 §2): lowercase letters, digits, `-`
 * and `_`, not starting with `-`. Atlassian's page says only "lowercase
 * letters with no spaces or special characters" (read 2026-10-23), yet the
 * workspace `rness-dev` exists: the rule is the specification's, not
 * verified against Bitbucket's form.
 */
const BITBUCKET_WORKSPACE = /^[a-z0-9_][a-z0-9_-]*$/

/** The rule `org` follows on a provider, and how its message names it. */
export function orgNameRule(provider: ProviderName | null): {
  pattern: RegExp
  /** `GitHub organization name`, for "a …" or "a valid …". */
  noun: string
} {
  if (provider === 'atlassian')
    return { pattern: BITBUCKET_WORKSPACE, noun: 'Bitbucket workspace slug' }
  return provider === 'gitlab'
    ? { pattern: GITLAB_GROUP, noun: 'GitLab group path' }
    : { pattern: ORG_NAME, noun: 'GitHub organization name' }
}

/** A Jira Cloud site, by its host, and a space key (spec 0039 §2). */
const JIRA_SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/
const JIRA_SPACE = /^[A-Z][A-Z0-9]{1,9}$/

/** `jira`, when present: Atlassian's only, a site and a space key, nothing else. */
function readJira(
  value: unknown,
  provider: ProviderName | null
): JiraTarget | undefined {
  if (value === undefined) return undefined
  if (provider !== 'atlassian')
    fail(
      '"jira" is for an Atlassian workspace: it needs "provider": "atlassian"'
    )
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value['site'] !== 'string' ||
    !JIRA_SITE.test(value['site']) ||
    typeof value['space'] !== 'string' ||
    !JIRA_SPACE.test(value['space'])
  )
    fail(
      `"jira" must be { "site": "<name>.atlassian.net", "space": "<KEY>" } (got ${JSON.stringify(value)})`
    )
  return { site: value['site'], space: value['space'] }
}

/**
 * Every top-level key contract 2 defines (spec 0038 §1). `repos`, and
 * `projects` and `pulse`, the former names of `boards`, are contract 1's.
 */
const KEYS = [
  'contract',
  'provider',
  'org',
  'jira',
  'agents',
  'boards',
  'skills',
  'scopes',
]

/**
 * The top-level keys of contract 1, as 0.24.0 read them: `repos` beside a
 * flat `scopes`, and `projects` and `pulse`, the former names of `boards`.
 */
const FORMER_KEYS = [...KEYS, 'projects', 'pulse', 'repos']

function fail(message: string): never {
  throw new Error(`rness.json: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A scope's `path`: relative, without `..` or an empty segment. A `.`
 * segment is refused by contract 2; 0.24.0 read it in contract 1, and so
 * does `readContract1`, which refuses it as it shapes the file.
 */
function checkPath(scope: string, path: unknown, contract: 1 | 2 = 2): string {
  if (typeof path !== 'string' || path === '')
    fail(`scope "${scope}" needs a string "path"`)
  if (path.startsWith('/')) fail(`scope "${scope}" path must be relative`)
  if (path.split('/').includes('..'))
    fail(`scope "${scope}" path must not contain ".."`)
  if (contract === 2 && path.split('/').includes('.'))
    fail(`scope "${scope}" path must not contain "."`)
  if (path.split('/').some((segment) => segment === ''))
    fail(`scope "${scope}" path must not contain empty segments`)
  return path
}

function readOrg(value: unknown, provider: ProviderName | null): string | null {
  if (value === undefined || value === null) return null
  const rule = orgNameRule(provider)
  if (typeof value !== 'string' || !rule.pattern.test(value))
    fail(`"org" must be a ${rule.noun} (got ${JSON.stringify(value)})`)
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
/**
 * How a provider names a created board: GitHub by its project `number`,
 * GitLab by `ids`, one issue board per view (spec 0037 §2). The other
 * key on a provider is refused, naming it.
 */
function wrongKey(
  name: string,
  entry: BoardEntry,
  provider: ProviderName | null
): BoardRefused | null {
  const numbered =
    typeof entry === 'number' ||
    (typeof entry === 'object' && entry.number !== null)
  // On Atlassian the board is the space's own: nothing names it (spec 0039 §2).
  if (provider === 'atlassian') {
    const said =
      "on Atlassian the board is the Jira space's own: nothing names it"
    if (numbered)
      return new BoardRefused(`boards.${name}.number`, `is GitHub's: ${said}`)
    if (typeof entry === 'object' && entry.ids !== null)
      return new BoardRefused(`boards.${name}.ids`, `are GitLab's: ${said}`)
    return null
  }
  if (provider === 'gitlab' && numbered)
    return new BoardRefused(
      `boards.${name}.number`,
      `is GitHub's: a GitLab board is named by "ids", one per view`
    )
  if (provider !== 'gitlab' && typeof entry === 'object' && entry.ids !== null)
    return new BoardRefused(
      `boards.${name}.ids`,
      `are GitLab's: a GitHub board is named by "number"`
    )
  return null
}

function readBoardEntries(
  value: unknown,
  provider: ProviderName | null
): {
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
    try {
      const read: BoardEntry = isProjectNumber(entry)
        ? entry
        : typeof entry === 'string'
          ? readPresetEntry(name, entry)
          : parseBoard(name, entry)
      const wrong = wrongKey(name, read, provider)
      if (wrong !== null) throw wrong
      boards[name] = read
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
function readBoardsOrFormer(
  data: Record<string, unknown>,
  provider: ProviderName | null
): {
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
  const read = readBoardEntries(data[key], provider)
  return key === 'boards' ? read : { ...read, formerKey: key }
}

/**
 * The repositories of `rness.json`: the scopes with a `url`, in the order
 * written, each cloned at `org/<name>` (spec 0038 §2).
 */
export function repositories(manifest: Manifest): Repository[] {
  return Object.entries(manifest.scopes).flatMap(([name, scope]) =>
    scope.url === null ? [] : [{ name, url: scope.url, dir: `org/${name}` }]
  )
}

/** The key, else the first repository URL's host (github.com → github), else github. */
export function providerOf(manifest: Manifest): ProviderName {
  if (manifest.provider !== null) return manifest.provider
  const url = repositories(manifest)[0]?.url ?? ''
  const host = /^(?:[a-z+]+:\/\/(?:[^@/]*@)?|[^@/]+@)([^/:]+)/i.exec(url)?.[1]
  const name = host?.toLowerCase()
  if (name?.includes('gitlab')) return 'gitlab'
  if (name === 'bitbucket.org' || name === 'ssh.bitbucket.org')
    return 'atlassian'
  return 'github'
}

const SKILL_KEYS = ['source', 'path', 'ref', 'commit', 'hash']
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The shape `rness skill` writes (spec 0041 §2): `sha256-` and a base64 SHA-256 digest. */
const SKILL_HASH = /^sha256-[A-Za-z0-9+/]{43}=$/
const SKILL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * `skills` of the top or of a scope (spec 0041 §2): each key a skill's name
 * (lowercase letters, digits and hyphens, at most 64 characters, not
 * `rness`, the plugin's own directory), each entry `source`, `path`, `ref`,
 * `commit` and `hash`. `where` prefixes the error, `scope "web": ` or empty.
 */
function readSkills(value: unknown, where: string): Record<string, SkillEntry> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail(`${where}"skills" must be an object`)
  const skills: Record<string, SkillEntry> = {}
  for (const [name, entry] of Object.entries(raw)) {
    const at = `${where}skill ${JSON.stringify(name)}`
    if (!SKILL_NAME.test(name) || name.length > 64)
      fail(
        `${at}: the name may only contain lowercase letters, digits and hyphens, at most 64 characters`
      )
    if (name === 'rness')
      fail(`${at}: "rness" is the name of the plugin's own directory`)
    if (!isRecord(entry)) fail(`${at} must be an object`)
    for (const key of Object.keys(entry))
      if (!SKILL_KEYS.includes(key))
        fail(`${at}: unknown key ${JSON.stringify(key)}`)
    const { source, path, ref, commit, hash } = entry
    if (
      typeof source !== 'string' ||
      !/^(?:github:[^/\s]+\/[^/\s]+|git:\S+|path:\S.*)$/.test(source)
    )
      fail(
        `${at}: "source" must be github:<owner>/<repo>, git:<url> or path:<directory>`
      )
    if (path !== undefined) {
      if (typeof path !== 'string' || path === '')
        fail(`${at}: "path" must be a non-empty string`)
      if (path.startsWith('/')) fail(`${at}: "path" must be relative`)
      if (path.split('/').includes('..'))
        fail(`${at}: "path" must not contain ".."`)
    }
    if (ref !== undefined && (typeof ref !== 'string' || ref === ''))
      fail(`${at}: "ref" must be a non-empty string`)
    if (
      commit !== undefined &&
      (typeof commit !== 'string' || !SKILL_COMMIT.test(commit))
    )
      fail(`${at}: "commit" must be a full commit hash (40 or 64 hex digits)`)
    if (typeof hash !== 'string' || !SKILL_HASH.test(hash))
      fail(`${at}: "hash" must be sha256- and a base64 SHA-256 digest`)
    skills[name] = {
      source,
      ...(path === undefined ? {} : { path }),
      ...(ref === undefined ? {} : { ref }),
      ...(commit === undefined ? {} : { commit }),
      hash,
    }
  }
  return skills
}

/** The keys of a scope of contract 2 (spec 0038 §1): any other is a slip. */
const SCOPE_KEYS = ['url', 'path', 'extends', 'scopes', 'skills']

/**
 * `scopes`, a tree (spec 0038 §1), read flat in the order written: a
 * repository at the top by its `url`, at `org/<name>`; a part under its
 * parent by a `path` relative to it, its parent first in `extends`. A name
 * is unique across the tree. An ancestor named in `extends` is inherited by
 * nesting already: left out of `extends`, kept in `redundant` for
 * `validate` to say (ADR 0012).
 */
function readScopes(value: unknown): Record<string, ScopeEntry> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail('"scopes" must be an object')
  const scopes: Record<string, ScopeEntry> = {}
  /** The names `extends` lists, as written, for the unknown ones. */
  const named = new Map<string, string[]>()
  const ancestors = (parent: string | null): string[] =>
    parent === null
      ? []
      : [parent, ...ancestors(scopes[parent]?.parent ?? null)]
  const declared = (parent: string | null): string =>
    parent === null ? 'as a repository' : `under ${parent}`

  const readLevel = (
    level: Record<string, unknown>,
    parent: string | null
  ): void => {
    for (const [name, entry] of Object.entries(level)) {
      if (!NAME.test(name))
        fail(`scope name "${name}" may only contain ${NAME_RULE}`)
      if (Object.hasOwn(scopes, name))
        fail(
          `scope "${name}" is declared twice: ${declared(scopes[name]?.parent ?? null)} and ${declared(parent)}`
        )
      if (!isRecord(entry)) fail(`scope "${name}" must be an object`)
      for (const key of Object.keys(entry))
        if (!SCOPE_KEYS.includes(key))
          fail(`scope "${name}": unknown key ${JSON.stringify(key)}`)
      const skills = readSkills(entry.skills, `scope "${name}": `)
      const above = ancestors(parent)
      let path: string
      let url: string | null = null
      if (parent === null) {
        if (entry.path !== undefined)
          fail(`scope "${name}": a repository has no path; it is org/${name}`)
        if (typeof entry.url !== 'string')
          fail(`scope "${name}" needs a string "url"`)
        path = `org/${name}`
        url = entry.url
      } else {
        if (entry.url !== undefined)
          fail(
            `scope "${name}": a part has no url; its repository is ${above.at(-1)}`
          )
        path = `${scopes[parent]?.path}/${checkPath(name, entry.path)}`
      }
      const ext = entry.extends ?? []
      if (!Array.isArray(ext) || !ext.every((t) => typeof t === 'string'))
        fail(`scope "${name}" extends must be an array of scope names`)
      const names = ext as string[]
      named.set(name, names)
      const redundant = names.filter((t) => above.includes(t))
      scopes[name] = {
        path,
        url,
        parent,
        extends: [
          ...above.slice(0, 1),
          ...names.filter((t) => !above.includes(t)),
        ],
        ...(redundant.length === 0 ? {} : { redundant }),
        ...(Object.keys(skills).length === 0 ? {} : { skills }),
      }
      if (entry.scopes === undefined) continue
      if (!isRecord(entry.scopes))
        fail(`scope "${name}": "scopes" must be an object`)
      readLevel(entry.scopes, name)
    }
  }
  readLevel(raw, null)

  for (const [name, targets] of named)
    for (const target of targets)
      if (!Object.hasOwn(scopes, target))
        fail(`scope "${name}" extends unknown scope "${target}"`)
  return scopes
}

/**
 * The lines `validate` says of the ancestors a scope's `extends` names: one
 * per name, in the order read (ADR 0012). Reported, never refused: nesting
 * gives the scope what the name would.
 */
export function redundantExtends(manifest: Manifest): string[] {
  return Object.entries(manifest.scopes).flatMap(([name, scope]) =>
    (scope.redundant ?? []).map(
      (target) =>
        `scope "${name}": extends "${target}" is already its ${target === scope.parent ? 'parent' : 'ancestor'}; remove it`
    )
  )
}

/**
 * Read and validate `<rnessDir>/rness.json`. Every error starts with
 * `rness.json`: `rness.json: <what is wrong>`, or the contract-1 line.
 */
export async function loadManifest(rnessDir: string): Promise<Manifest> {
  let raw: string
  try {
    raw = await readFile(join(rnessDir, 'rness.json'), 'utf8')
  } catch {
    fail('not found')
  }
  return parseManifest(raw)
}

/**
 * The upgrade a contract-1 `rness.json` asks for, the second of the two
 * steps of spec 0038 §11. `upgrade` never delegates, so a bare `rness
 * upgrade` may run a global copy below 0.25.0, which cannot rewrite the
 * file; the latest copy can, whatever ran this one.
 */
export const CONTRACT_1_UPGRADE = 'npx @rness/cli@latest upgrade'

/**
 * A `rness.json` still on contract 1: every command but `upgrade` and
 * `create` says this one line, alone (spec 0038 §2). A class of its own so
 * that the callers which wrap or soften a failure (the policy hooks, the
 * guard, `note`) can tell it from a file that is merely broken.
 */
export class Contract1Error extends Error {
  constructor() {
    super(`rness.json is contract 1: run ${CONTRACT_1_UPGRADE} (ADR 0012)`)
  }
}

/**
 * Throws `Contract1Error` when the `rness.json` in `rnessDir` declares
 * contract 1; says nothing of a file that is missing or broken. For the
 * commands that read no manifest of their own (`doc new`).
 */
export async function refuseContract1(rnessDir: string): Promise<void> {
  let data: unknown
  try {
    data = JSON.parse(await readFile(join(rnessDir, 'rness.json'), 'utf8'))
  } catch {
    return
  }
  if (isRecord(data) && data.contract === 1) throw new Contract1Error()
}

/** The text of a `rness.json` as an object, whatever its contract. */
function readObject(raw: string): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    fail(`invalid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!isRecord(data)) fail('must be a JSON object')
  return data
}

/** Validate the text of a `rness.json`, as `loadManifest` does the file's. */
export function parseManifest(raw: string): Manifest {
  const data = readObject(raw)
  // The former shape is `upgrade`'s to read and rewrite (ADR 0012): said
  // before its keys, which this contract does not know.
  if (data.contract === 1) throw new Contract1Error()
  if (data.contract !== 2)
    fail(`unsupported contract: ${JSON.stringify(data.contract)} (expected 2)`)
  // Refuse what this contract does not define: a typo (`scope`, `repo`) or a
  // key from a later contract would otherwise be read as nothing at all.
  for (const key of Object.keys(data)) {
    if (!KEYS.includes(key)) fail(`unknown key ${JSON.stringify(key)}`)
  }
  const provider = readProvider(data.provider)
  const { boards, refused, formerKey } = readBoardsOrFormer(data, provider)
  const jira = readJira(data.jira, provider)
  const skills = readSkills(data.skills, '')
  return {
    contract: 2,
    provider,
    org: readOrg(data.org, provider),
    ...(jira === undefined ? {} : { jira }),
    agents: readAgents(data.agents),
    boards,
    ...(refused.length === 0 ? {} : { refused }),
    ...(formerKey === undefined ? {} : { formerKey }),
    ...(Object.keys(skills).length === 0 ? {} : { skills }),
    scopes: readScopes(data.scopes),
  }
}

/** A scope of contract 1, as 0.24.0 read it: its path from the workspace root, the names it extends. */
interface FormerScope {
  path: string
  extends: string[]
}

/**
 * `repos` of contract 1, names to clone URLs, as 0.24.0 read it. A key
 * besides `url` was read as nothing; contract 2 has no place for it, so it
 * is a line of `refusals` rather than lost in the rewrite.
 */
function readFormerRepos(
  value: unknown,
  refusals: string[]
): Map<string, string> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail('"repos" must be an object')
  const repos = new Map<string, string>()
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name))
      fail(`repo name "${name}" may only contain ${NAME_RULE}`)
    if (!isRecord(entry) || typeof entry.url !== 'string')
      fail(`repo "${name}" needs a string "url"`)
    for (const key of Object.keys(entry))
      if (key !== 'url')
        refusals.push(`repo "${name}": unknown key ${JSON.stringify(key)}`)
    repos.set(name, entry.url)
  }
  return repos
}

/**
 * The flat `scopes` of contract 1, as 0.24.0 read it; a key besides `path`
 * and `extends` is a line of `refusals`, as in `readFormerRepos`.
 */
function readFormerScopes(
  value: unknown,
  refusals: string[]
): Map<string, FormerScope> {
  const raw = value ?? {}
  if (!isRecord(raw)) fail('"scopes" must be an object')
  const scopes = new Map<string, FormerScope>()
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME.test(name))
      fail(`scope name "${name}" may only contain ${NAME_RULE}`)
    if (!isRecord(entry)) fail(`scope "${name}" must be an object`)
    const path = checkPath(name, entry.path, 1)
    const ext = entry.extends ?? []
    if (!Array.isArray(ext) || !ext.every((t) => typeof t === 'string'))
      fail(`scope "${name}" extends must be an array of scope names`)
    for (const key of Object.keys(entry))
      if (key !== 'path' && key !== 'extends')
        refusals.push(`scope "${name}": unknown key ${JSON.stringify(key)}`)
    scopes.set(name, { path, extends: ext as string[] })
  }
  for (const [name, scope] of scopes)
    for (const target of scope.extends)
      if (!scopes.has(target))
        fail(`scope "${name}" extends unknown scope "${target}"`)
  return scopes
}

/** A scope of contract 1 in its repository: `rel` its path below `org/<repo>`, empty for the repository's own. */
interface Placed {
  name: string
  repo: string
  rel: string
  /** The path as the file wrote it, for the lines. */
  written: string
  extends: string[]
}

/**
 * The extends loop `start` reaches, as the names around it (`a, b, a`);
 * null when its chain ends. The walk of `scopeChain`, which throws there.
 */
function loopFrom(
  extendsOf: ReadonlyMap<string, readonly string[]>,
  start: string
): string[] | null {
  const stack: string[] = []
  const done = new Set<string>()
  const visit = (name: string): string[] | null => {
    const at = stack.indexOf(name)
    if (at !== -1) return [...stack.slice(at), name]
    if (done.has(name)) return null
    stack.push(name)
    for (const target of extendsOf.get(name) ?? []) {
      const loop = visit(target)
      if (loop !== null) return loop
    }
    stack.pop()
    done.add(name)
    return null
  }
  return visit(start)
}

/** A manifest of `scopes` alone, for `scopeChain`. */
const ofScopes = (scopes: Record<string, ScopeEntry>): Manifest => ({
  contract: 2,
  provider: null,
  org: null,
  agents: null,
  boards: null,
  scopes,
})

/**
 * Contract 1's repositories and flat scopes as contract 2's tree (spec 0038
 * §2, §11). Each repository meets the scope at `org/<name>`, compared
 * case-insensitively; a scope below nests under the deepest scope whose
 * path holds it, segment by segment, as written, its ancestors dropped from
 * `extends`. What contract 2 cannot hold is a line of `refusals`, one per
 * cause, the repositories first, then the scopes in the order written. A
 * scope whose chain nesting changes is a line of `notes`.
 */
function shapeFormer(
  repos: ReadonlyMap<string, string>,
  former: ReadonlyMap<string, FormerScope>
): { scopes: Record<string, ScopeEntry>; refusals: string[]; notes: string[] } {
  const segments = (path: string) => {
    const [first, seg, ...below] = path.split('/')
    const top = first?.toLowerCase() === 'org' ? seg?.toLowerCase() : undefined
    return { inOrg: first?.toLowerCase() === 'org', top, below }
  }
  // The directories `org/<name>` some scope is at, by lowercase name.
  const atTop = new Set<string>()
  for (const { path } of former.values()) {
    const { top, below } = segments(path)
    if (top !== undefined && below.length === 0) atTop.add(top)
  }

  const placed: Placed[] = []
  const scopeLines: string[] = []
  for (const [name, scope] of former) {
    const { inOrg, top, below } = segments(scope.path)
    const rel = below.join('/')
    if (!inOrg)
      // The path as a directory, as the line names `org/`.
      scopeLines.push(`scope "${name}" at ${scope.path}/ is outside org/`)
    else if (top === undefined || (!repos.has(top) && rel !== '')) {
      // Below a scope that has no repository, that scope's line says it.
      if (top === undefined || !atTop.has(top))
        scopeLines.push(
          `scope "${name}" at ${scope.path} is inside no repository of rness.json`
        )
    } else if (!repos.has(top))
      scopeLines.push(
        `scope "${name}" at ${scope.path} has no repository: add its url, or remove it`
      )
    else if (below.includes('.'))
      scopeLines.push(`scope "${name}" path must not contain "."`)
    else {
      if (rel !== '' && repos.has(name))
        scopeLines.push(
          `scope "${name}" at ${scope.path} has the name of repo "${name}": rename it`
        )
      placed.push({
        name,
        repo: top,
        rel,
        written: scope.path,
        extends: scope.extends,
      })
    }
  }

  const repoLines: string[] = []
  const roots = new Map<string, Placed>()
  for (const repo of repos.keys()) {
    const here = placed.filter((p) => p.repo === repo && p.rel === '')
    const own = here.find((p) => p.name === repo) ?? here[0]
    if (own === undefined)
      repoLines.push(`repo "${repo}" has no scope at org/${repo}`)
    else if (own.name !== repo)
      repoLines.push(
        `repo "${repo}": its scope at org/${repo} is named "${own.name}"; rename it ${repo}`
      )
    else roots.set(repo, own)
    for (const p of here)
      if (p !== own)
        repoLines.push(
          `scope "${p.name}" at ${p.written} is a second scope of repo "${repo}": remove it`
        )
  }
  const refusals = [...repoLines, ...scopeLines]
  if (refusals.length > 0) return { scopes: {}, refusals, notes: [] }

  // The deepest scope holding each part; of two at one path, the first written.
  const depth = (rel: string) => (rel === '' ? 0 : rel.split('/').length)
  const parentOf = new Map<Placed, Placed>()
  for (const part of placed) {
    let parent = roots.get(part.repo)
    if (part.rel === '' || parent === undefined) continue
    for (const p of placed)
      if (
        p.repo === part.repo &&
        p.rel !== '' &&
        part.rel.startsWith(`${p.rel}/`) &&
        depth(p.rel) > depth(parent.rel)
      )
        parent = p
    parentOf.set(part, parent)
  }

  // Read flat as `parseManifest` reads the written tree: a scope, then its parts.
  const scopes: Record<string, ScopeEntry> = {}
  const visit = (p: Placed, above: string[]): void => {
    scopes[p.name] = {
      path: p.rel === '' ? `org/${p.repo}` : `org/${p.repo}/${p.rel}`,
      url: p.rel === '' ? (repos.get(p.repo) ?? null) : null,
      parent: above[0] ?? null,
      extends: [
        ...above.slice(0, 1),
        ...p.extends.filter((t) => !above.includes(t)),
      ],
    }
    for (const part of placed)
      if (parentOf.get(part) === p) visit(part, [p.name, ...above])
  }
  for (const root of roots.values()) visit(root, [])

  // Nesting adds a parent to each part's chain: a loop it closes would make
  // every scopeChain through it throw once the file is rewritten.
  const before = new Map([...former].map(([n, s]) => [n, s.extends]))
  const after = new Map(Object.entries(scopes).map(([n, s]) => [n, s.extends]))
  const flat = ofScopes(
    Object.fromEntries(
      [...former].map(([n, s]) => [
        n,
        { path: s.path, url: null, parent: null, extends: s.extends },
      ])
    )
  )
  const notes: string[] = []
  const loops = new Set<string>()
  for (const name of Object.keys(scopes)) {
    // A loop 0.24.0 had already: left to scopeChain, as contract 2 leaves it.
    if (loopFrom(before, name) !== null) continue
    const loop = loopFrom(after, name)
    if (loop !== null) {
      const key = [...new Set(loop)].sort().join(' ')
      if (!loops.has(key))
        refusals.push(
          `scope "${name}": once nested, its chain loops (${loop.join(', ')}); remove an extends on that loop`
        )
      loops.add(key)
      continue
    }
    const was = scopeChain(flat, name)
    const now = scopeChain(ofScopes(scopes), name)
    if (now.join(' ') !== was.join(' '))
      notes.push(
        `scope "${name}" now inherits ${now.slice(1).join(', ')} (nested)`
      )
  }
  return refusals.length > 0
    ? { scopes: {}, refusals, notes: [] }
    : { scopes, refusals, notes }
}

/**
 * What `readContract1` gives `upgrade` (spec 0038 §2, §11): the manifest to
 * write as contract 2 and the notes to say; or, with no manifest, every
 * line that stops it before anything changes.
 */
export type Contract1 =
  | { manifest: Manifest; refusals: []; notes: string[] }
  | { manifest: null; refusals: string[]; notes: [] }

/**
 * The former `rness.json`, contract 1, for `upgrade` alone (ADR 0012, spec
 * 0038 §2, §11): read as 0.24.0 read it, then shaped as contract 2. A file
 * 0.24.0 refused throws its line, prefixed `rness.json: `, as does a text
 * that is not JSON or not contract 1: the team's CLI refuses it too. What
 * contract 1 held and contract 2 cannot is given as lines, all of them.
 * `projects` or `pulse` is read as `boards`, `formerKey` naming it, through
 * the reader of 0.24.0; `jira` as it is.
 */
export function readContract1(raw: string): Contract1 {
  const data = readObject(raw)
  if (data.contract !== 1)
    fail(`unsupported contract: ${JSON.stringify(data.contract)} (expected 1)`)
  for (const key of Object.keys(data))
    if (!FORMER_KEYS.includes(key)) fail(`unknown key ${JSON.stringify(key)}`)
  const provider = readProvider(data.provider)
  const { boards, refused, formerKey } = readBoardsOrFormer(data, provider)
  const jira = readJira(data.jira, provider)
  const org = readOrg(data.org, provider)
  const agents = readAgents(data.agents)
  const refusals: string[] = []
  const repos = readFormerRepos(data.repos, refusals)
  const former = readFormerScopes(data.scopes, refusals)
  const shape = shapeFormer(repos, former)
  refusals.push(...shape.refusals)
  if (refusals.length > 0) return { manifest: null, refusals, notes: [] }
  return {
    manifest: {
      contract: 2,
      provider,
      org,
      ...(jira === undefined ? {} : { jira }),
      agents,
      boards,
      ...(refused.length === 0 ? {} : { refused }),
      ...(formerKey === undefined ? {} : { formerKey }),
      scopes: shape.scopes,
    },
    refusals: [],
    notes: shape.notes,
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

/**
 * The ancestors of each scope, nearest first, once the tree is checked as
 * the reader would give it: otherwise the writer would drop a scope, or
 * write a file the reader refuses. Each error is a manifest built wrong in
 * memory, never one read from the file.
 */
function ancestorsOf(
  scopes: Record<string, ScopeEntry>
): Map<string, string[]> {
  const wrong = (message: string): never => {
    throw new Error(`rness.json: ${message}`)
  }
  for (const [name, scope] of Object.entries(scopes)) {
    if (scope.parent === null) {
      if (scope.url === null) wrong(`scope "${name}" has no url and no parent`)
    } else if (scope.url !== null)
      wrong(`scope "${name}" is a part of ${scope.parent} and has a url`)
    else if (!Object.hasOwn(scopes, scope.parent))
      wrong(
        `scope "${name}" is a part of ${scope.parent}, which is not a scope`
      )
  }
  const ancestors = new Map<string, string[]>()
  for (const [name, scope] of Object.entries(scopes)) {
    const above: string[] = []
    for (let p = scope.parent; p !== null; p = scopes[p]?.parent ?? null) {
      if (p === name || above.includes(p))
        wrong(`scope "${name}": its parents never reach a repository`)
      above.push(p)
    }
    const parent = scope.parent === null ? undefined : scopes[scope.parent]
    if (parent !== undefined && !scope.path.startsWith(`${parent.path}/`))
      wrong(`scope "${name}" at ${scope.path} is not inside ${scope.parent}`)
    ancestors.set(name, above)
  }
  return ancestors
}

/** The entries of a `skills` object, each on its own lines, keys in the order of spec 0041 §2. */
function skillLines(
  skills: Record<string, SkillEntry>,
  indent: string
): string[] {
  const entries = Object.entries(skills)
  return entries.flatMap(([name, skill], i) => {
    const keys = [
      ['source', skill.source],
      ['path', skill.path],
      ['ref', skill.ref],
      ['commit', skill.commit],
      ['hash', skill.hash],
    ].filter((kv): kv is [string, string] => kv[1] !== undefined)
    return [
      `${indent}${JSON.stringify(name)}: {`,
      ...keys.map(
        ([k, v], j) =>
          `${indent}  ${JSON.stringify(k)}: ${JSON.stringify(v)}${j === keys.length - 1 ? '' : ','}`
      ),
      `${indent}}${i === entries.length - 1 ? '' : ','}`,
    ]
  })
}

/**
 * The scopes nested under `parent` (null: the repositories), as written
 * (spec 0038 §3): a scope on one line, `url` or `path` then `extends` when
 * it names any but an ancestor; one with parts on several, its `scopes`
 * indented under it.
 */
function scopeLines(
  scopes: Record<string, ScopeEntry>,
  ancestors: ReadonlyMap<string, string[]>,
  parent: string | null,
  indent: string
): string[] {
  const entries = Object.entries(scopes).filter(([, s]) => s.parent === parent)
  return entries.map(([name, scope], i) => {
    const own =
      parent === null
        ? [`"url": ${JSON.stringify(scope.url)}`]
        : [
            `"path": ${JSON.stringify(scope.path.slice(`${scopes[parent]?.path}/`.length))}`,
          ]
    // An ancestor is inherited by nesting, never written (ADR 0012).
    const above = ancestors.get(name) ?? []
    const named = scope.extends.filter((e) => !above.includes(e))
    if (named.length > 0)
      own.push(`"extends": [${named.map((e) => JSON.stringify(e)).join(', ')}]`)
    const comma = i === entries.length - 1 ? '' : ','
    const parts = scopeLines(scopes, ancestors, name, `${indent}    `)
    const skills = skillLines(scope.skills ?? {}, `${indent}    `)
    if (parts.length === 0 && skills.length === 0)
      return `${indent}${JSON.stringify(name)}: { ${own.join(', ')} }${comma}`
    const blocks = [
      ...(skills.length === 0
        ? []
        : [[`${indent}  "skills": {`, ...skills, `${indent}  }`]]),
      ...(parts.length === 0
        ? []
        : [[`${indent}  "scopes": {`, ...parts, `${indent}  }`]]),
    ]
    return [
      `${indent}${JSON.stringify(name)}: {`,
      ...own.map((line) => `${indent}  ${line},`),
      ...blocks.flatMap((block, b) =>
        b === blocks.length - 1
          ? block
          : [...block.slice(0, -1), `${block.at(-1)},`]
      ),
      `${indent}}${comma}`,
    ].join('\n')
  })
}

/** Serialise as contract 2, in its key order (spec 0038 §1, §3); atomic write. */
export async function writeManifest(
  rnessDir: string,
  manifest: Manifest
): Promise<void> {
  const lines = ['{', '  "contract": 2,']
  if (manifest.provider !== null)
    lines.push(`  "provider": ${JSON.stringify(manifest.provider)},`)
  if (manifest.org !== null)
    lines.push(`  "org": ${JSON.stringify(manifest.org)},`)
  if (manifest.jira !== undefined)
    lines.push(
      `  "jira": { "site": ${JSON.stringify(manifest.jira.site)}, "space": ${JSON.stringify(manifest.jira.space)} },`
    )
  if (manifest.agents !== null)
    lines.push(
      `  "agents": [${manifest.agents.map((a) => JSON.stringify(a)).join(', ')}],`
    )
  lines.push(...boardsLines(manifest))
  const skills = skillLines(manifest.skills ?? {}, '    ')
  if (skills.length > 0) lines.push('  "skills": {', ...skills, '  },')
  const scopes = scopeLines(
    manifest.scopes,
    ancestorsOf(manifest.scopes),
    null,
    '    '
  )
  if (scopes.length === 0) lines.push('  "scopes": {}')
  else lines.push('  "scopes": {', ...scopes, '  }')
  lines.push('}')
  await writeFileAtomic(join(rnessDir, 'rness.json'), `${lines.join('\n')}\n`)
}

const FULL_URL = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/

/**
 * `web` → `<host><org>/web.git`; `other/api` → `<host>other/api.git`; a full
 * URL is kept. The name is the key in `rness.json` and the directory under
 * `org/`, so it is lowercased, as `create` declares it: `dApp` is `dapp`. The
 * URL keeps the spelling typed, since a host may tell cases apart (a
 * `file://` remote on Linux) even where GitHub does not.
 */
export function parseRepoSpec(
  spec: string,
  org: string | null,
  host: string,
  /** On GitLab, a project of a subgroup goes by its full path (spec 0037 §5.2). */
  provider: ProviderName | null = null
): { name: string; url: string } {
  let url: string
  if (FULL_URL.test(spec)) {
    // Bitbucket's old SSH host, as its API still gives it (spec 0039 §5.2).
    url = currentSshUrl(spec)
  } else {
    const parts = spec.split('/')
    if (parts.length === 1) {
      // A blank workspace has no owner to expand a bare name with (spec 0012).
      if (org === null)
        throw new Error(
          provider === 'gitlab'
            ? 'this workspace has no GitLab group: give <group>/<project> or a git URL'
            : 'this workspace has no GitHub organization: give <owner>/<repo> or a git URL'
        )
      url = repoUrl(host, org, spec)
    } else if (
      parts.length === 2 &&
      parts[0] !== undefined &&
      parts[1] !== undefined
    )
      url = repoUrl(host, parts[0], parts[1])
    else if (provider === 'gitlab' && parts.every((p) => p !== ''))
      url = `${host}${spec}.git`
    else
      throw new Error(
        `repository name "${spec}" is not a name (use <repo>, <owner>/<repo>, or a URL)`
      )
  }
  const last = url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? ''
  const typed = last.endsWith('.git') ? last.slice(0, -4) : last
  const name = typed.toLowerCase()
  if (!NAME.test(name))
    throw new Error(`repository name "${typed}" may only contain ${NAME_RULE}`)
  return { name, url }
}
