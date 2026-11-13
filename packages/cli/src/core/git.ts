import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { GitCredentials } from './provider.ts'

const execFileP = promisify(execFile)

// Answers git's `get` with what the environment holds. The token is never in
// an argument, a URL or a config file: only in the child's environment.
const ENV_HELPER =
  '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$RNESS_GIT_USERNAME" "$RNESS_GIT_TOKEN"; }; f'

/**
 * How one git command is given credentials (spec 0004 §4): the helpers git
 * would otherwise consult are cleared, and one that lives for this command
 * only reads the child's environment. Nothing when there are none.
 */
export function withCredentials(
  credentials: GitCredentials | null | undefined
): {
  args: string[]
  env: Record<string, string>
} {
  if (credentials === null || credentials === undefined)
    return { args: [], env: {} }
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${ENV_HELPER}`],
    env: {
      RNESS_GIT_USERNAME: credentials.username,
      RNESS_GIT_TOKEN: credentials.password,
    },
  }
}

/** Variables set for one git command over the caller's environment; `undefined` removes one. */
export type GitEnv = Readonly<Record<string, string | undefined>>

/** The environment of one git command: the caller's, then `extra`, a variable set to `undefined` left out. */
function childEnv(cwd: string | undefined, extra: GitEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // Pin the command to `cwd` itself: without a ceiling, git walks up and
    // a plain directory under `org/` would report, or be pulled into,
    // whatever repository happens to sit above the workspace root. git
    // ignores a relative ceiling entry, hence the resolve().
    ...(cwd === undefined
      ? {}
      : { GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) }),
    ...extra,
  }))
    if (value !== undefined) env[key] = value
  return env
}

/** git's first line of complaint, as the error of `git <command>`. */
function gitError(command: string, e: unknown): Error {
  const err = e as { stderr?: string | Buffer; message?: string }
  const stderr = err.stderr?.toString() ?? ''
  const text = stderr !== '' ? stderr : (err.message ?? 'unknown error')
  const first = text.split('\n').find((l) => l.trim() !== '') ?? 'unknown error'
  return new Error(`git ${command} failed: ${first.trim()}`, { cause: e })
}

async function git(
  args: readonly string[],
  cwd?: string,
  credentials?: GitCredentials | null,
  config: readonly string[] = [],
  env: GitEnv = {}
): Promise<string> {
  const auth = withCredentials(credentials)
  try {
    const { stdout } = await execFileP(
      'git',
      [...auth.args, ...config, ...args],
      {
        ...(cwd === undefined ? {} : { cwd }),
        env: childEnv(cwd, { ...auth.env, ...env }),
        maxBuffer: 16 * 1024 * 1024,
      }
    )
    return stdout
  } catch (e) {
    throw gitError(args[0] ?? '', e)
  }
}

/** `git <args>` in `cwd` with `env`, `input` on its standard input; its standard output as bytes. */
function gitBytes(
  args: readonly string[],
  cwd: string,
  env: GitEnv,
  input: string
): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: childEnv(cwd, env),
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) done(stdout)
        else fail(gitError(args[0] ?? '', Object.assign(error, { stderr })))
      }
    )
    child.stdin?.end(input)
  })
}

/** Reject a value git could parse as an option (e.g. a `rness.json` URL starting with `-`). */
export function positional(value: string, what: string): string {
  if (value.startsWith('-'))
    throw new Error(`refusing suspicious ${what}: ${value}`)
  return value
}

/** `git clone <url> <dir>`; `dir` must not exist. */
export async function clone(
  url: string,
  dir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  await git(
    [
      'clone',
      '--quiet',
      '--',
      positional(url, 'repository url'),
      positional(dir, 'directory'),
    ],
    undefined,
    credentials
  )
}

/**
 * Fetch one commit of `url` into the empty directory `dir` and check it out
 * (spec 0041 §3): `ref` is a tag, a branch or a full 40-character SHA, `HEAD`
 * when null. Returns the commit it resolved to. Shallow, so a short SHA,
 * which git cannot fetch, is refused with the reason.
 */
export async function fetchRef(
  url: string,
  ref: string | null,
  dir: string,
  credentials?: GitCredentials | null
): Promise<string> {
  const target = positional(ref ?? 'HEAD', 'ref')
  const from = positional(url, 'repository url')
  await git(['init', '-q'], dir)
  try {
    await git(
      ['fetch', '--depth', '1', '--quiet', '--', from, target],
      dir,
      credentials,
      // A redirect must never carry the credentials to another host.
      credentials === null || credentials === undefined
        ? []
        : ['-c', 'http.followRedirects=false']
    )
  } catch (e) {
    if (/^[0-9a-f]{4,39}$/i.test(target))
      throw new Error('a commit ref needs its 40 hexadecimal characters', {
        cause: e,
      })
    throw e
  }
  await git(['checkout', '-q', 'FETCH_HEAD'], dir)
  return (await git(['rev-parse', 'FETCH_HEAD^{commit}'], dir)).trim()
}

/**
 * True when `git status --porcelain` prints nothing, ignoring the paths in
 * `ignore` (rness-managed files such as `AGENTS.md`/`CLAUDE.md` that sync
 * itself writes into every clone and that should never veto an auto-pull).
 */
export async function isClean(
  dir: string,
  ignore: readonly string[] = []
): Promise<boolean> {
  const pathspec = ignore.map((p) => `:!${p}`)
  return (
    (
      await git(
        [
          'status',
          '--porcelain',
          // Every untracked file on its own line: a directory folded into one
          // `?? dir/` entry would slip past a pathspec naming a file inside it.
          '--untracked-files=all',
          ...(pathspec.length > 0 ? ['--', ...pathspec] : []),
        ],
        dir
      )
    ).trim() === ''
  )
}

/**
 * Which of `paths` differ from `HEAD` in `dir` — modified, added or untracked
 * (ignored ones are not). Paths relative to `dir`, in git's order.
 */
export async function changedPaths(
  dir: string,
  paths: readonly string[]
): Promise<string[]> {
  if (paths.length === 0) return []
  const entries = (
    await git(
      ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths],
      dir
    )
  ).split('\0')
  const changed: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    changed.push(entry.slice(3))
    // A rename or copy is followed by its source path.
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return changed
}

/**
 * Which of `paths` the history of `HEAD` in `dir` holds — a document gone
 * from the working tree was there (spec 0018 §2). One `git log` a path,
 * nothing fetched. `HEAD`, not every ref: a teammate's document fetched but
 * not merged is not this clone's. `--full-history`: a path added and removed
 * on a branch merged back counts. A path is literal, never an option or a
 * glob. One git cannot answer for — no repository, no commit yet, outside
 * the repository — is not seen: git does not vouch for it.
 */
export async function seenPaths(
  dir: string,
  paths: readonly string[]
): Promise<Set<string>> {
  const seen = new Set<string>()
  for (const path of new Set(paths)) {
    try {
      const commit = await git(
        [
          'log',
          '-1',
          '--full-history',
          '--format=%H',
          'HEAD',
          '--',
          `:(literal)${path}`,
        ],
        dir
      )
      if (commit.trim() !== '') seen.add(path)
    } catch {
      // Not seen: see above.
    }
  }
  return seen
}

/**
 * Which of `paths` (relative to `dir`, the root of a repository) git tracks:
 * a file at the path or under it, in the index (`git ls-files`). A path is
 * literal, never a glob. Throws when `dir` is no repository.
 */
export async function trackedPaths(
  dir: string,
  paths: readonly string[]
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const files = (
    await git(
      ['ls-files', '-z', '--', ...paths.map((p) => `:(literal)${p}`)],
      dir
    )
  )
    .split('\0')
    .filter((f) => f !== '')
  return new Set(
    paths.filter((p) => files.some((f) => f === p || f.startsWith(`${p}/`)))
  )
}

// ---- Trees of `.rness` (spec 0041 decision 8) ----

/**
 * Where git commands on the objects of `.rness` run: its directory, and an
 * environment that never inherits the caller's `GIT_DIR`, `GIT_WORK_TREE`
 * or `GIT_INDEX_FILE`. `validate` runs inside the `.rness` pre-commit, where
 * git sets them for the commit's own index (ruling R31).
 */
export interface ObjectStore {
  dir: string
  env: GitEnv
}

const ISOLATED: GitEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
}

/** The objects of the repository at `dir`, read with no caller's index or directory. */
export const objectStore = (dir: string): ObjectStore => ({
  dir,
  env: ISOLATED,
})

/** One entry of `git ls-tree -r -t -l`: a path relative to the tree listed. */
export interface TreeEntry {
  /** `040000`, `100644`, `100755`, `120000` (a symbolic link), `160000` (a gitlink). */
  mode: string
  type: string
  id: string
  /** Bytes of a blob; null for a tree or a gitlink. */
  size: number | null
  path: string
}

/**
 * Every entry of `treeish` under `paths` (all when none), trees included,
 * recursively (`ls-tree -r -t -l -z`): names as git holds them, never
 * quoted. Throws when `treeish` names nothing (an unborn `HEAD`).
 */
export async function listTree(
  store: ObjectStore,
  treeish: string,
  paths: readonly string[] = []
): Promise<TreeEntry[]> {
  const out = await git(
    [
      'ls-tree',
      '-r',
      '-t',
      '-l',
      '-z',
      '--full-tree',
      positional(treeish, 'tree'),
      ...(paths.length > 0 ? ['--', ...paths] : []),
    ],
    store.dir,
    null,
    [],
    store.env
  )
  return out
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode = '', type = '', id = '', size = '-'] = line
        .slice(0, tab)
        .split(/ +/)
      return {
        mode,
        type,
        id,
        size: size === '-' ? null : Number(size),
        path: line.slice(tab + 1),
      }
    })
}

/**
 * The content of each object `names` names (an id, or `<tree>:<path>`), by
 * name, read in one `git cat-file --batch`; null for one git does not have.
 */
export async function readObjects(
  store: ObjectStore,
  names: readonly string[]
): Promise<Map<string, Buffer | null>> {
  const found = new Map<string, Buffer | null>()
  const wanted = [...new Set(names)]
  if (wanted.length === 0) return found
  if (wanted.some((n) => /[\n\r]/.test(n) || n.startsWith('-')))
    throw new Error('refusing an object name holding a line break')
  const out = await gitBytes(
    ['cat-file', '--batch'],
    store.dir,
    store.env,
    wanted.map((n) => `${n}\n`).join('')
  )
  let at = 0
  for (const name of wanted) {
    const end = out.indexOf(0x0a, at)
    const header = out.subarray(at, end).toString()
    at = end + 1
    const size = /^[0-9a-f]+ \S+ (\d+)$/.exec(header)?.[1]
    if (size === undefined) {
      found.set(name, null)
      continue
    }
    found.set(name, out.subarray(at, at + Number(size)))
    at += Number(size) + 1
  }
  return found
}

/**
 * The blob id git gives each file of `files` (absolute), as it is on disk:
 * `hash-object --no-filters`, so no line-ending conversion or filter of the
 * repository at `store.dir` changes the bytes. One id per file, in order.
 */
export async function blobIds(
  store: ObjectStore,
  files: readonly string[]
): Promise<string[]> {
  if (files.length === 0) return []
  if (files.some((f) => /[\n\r]/.test(f)))
    throw new Error('refusing a file name holding a line break')
  const out = await gitBytes(
    ['hash-object', '--no-filters', '--stdin-paths'],
    store.dir,
    store.env,
    files.map((f) => `${f}\n`).join('')
  )
  return out.toString().split('\n').slice(0, files.length)
}

/** A temporary index over the working tree at `dir`, its objects in that repository's database. */
export interface ScratchIndex extends ObjectStore {
  /** `git add` of `paths` (relative to `dir`, literal), as a commit would take them. */
  add: (paths: readonly string[]) => Promise<void>
  /** The index emptied (`read-tree --empty`). */
  clear: () => Promise<void>
  /** `git write-tree`: the id of the tree the index holds. */
  writeTree: () => Promise<string>
}

/**
 * Run `work` with an index of its own over the working tree at `dir`: an
 * absolute `GIT_INDEX_FILE` in a fresh temporary directory, never the
 * index of a commit in progress (ruling R31). `git add` writes the blobs
 * and trees it makes into the repository's object database: loose objects,
 * collected by git's own gc when nothing reaches them. When `dir` is no
 * repository yet, a temporary one holds them, so the ids are the ones git
 * will give the same files there.
 */
export async function withScratchIndex<T>(
  dir: string,
  work: (index: ScratchIndex) => Promise<T>
): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), 'rness-index-'))
  try {
    let env: GitEnv = { ...ISOLATED, GIT_INDEX_FILE: join(tmp, 'index') }
    const repository = await git(
      ['rev-parse', '--git-dir'],
      dir,
      null,
      [],
      ISOLATED
    ).then(
      () => true,
      () => false
    )
    if (!repository) {
      const gitDir = join(tmp, 'objects.git')
      await git(['init', '-q', '--bare', gitDir], tmp, null, [], ISOLATED)
      env = { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: dir }
    }
    const run = (args: string[]) => git(args, dir, null, [], env)
    const index: ScratchIndex = {
      dir,
      env,
      add: async (paths) => {
        if (paths.length > 0)
          await run(['add', '--', ...paths.map((p) => `:(literal)${p}`)])
      },
      clear: async () => {
        await run(['read-tree', '--empty'])
      },
      writeTree: async () => (await run(['write-tree'])).trim(),
    }
    await index.clear()
    return await work(index)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * `name` in the git directory of `dir`, absolute — its worktree's own for a
 * linked worktree (`git rev-parse --git-path`). Never pushed. Null when
 * `dir` is no repository.
 */
export async function gitPath(
  dir: string,
  name: string
): Promise<string | null> {
  try {
    const path = (await git(['rev-parse', '--git-path', name], dir)).trim()
    return path === '' ? null : resolve(dir, path)
  } catch {
    return null
  }
}

/** The value of git config `key` as git resolves it in `dir`; null when unset or `dir` is no repository. */
export async function configValue(
  dir: string,
  key: string
): Promise<string | null> {
  try {
    const value = (await git(['config', '--get', key], dir)).trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

export async function pullFastForward(
  dir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  await git(['pull', '--ff-only', '--quiet'], dir, credentials)
}

/** `git remote add origin <url>` then `git push -u origin main`, in `dir`. */
export async function publish(
  dir: string,
  url: string,
  credentials?: GitCredentials | null
): Promise<void> {
  await git(['remote', 'add', 'origin', positional(url, 'repository url')], dir)
  await git(['push', '--quiet', '-u', 'origin', 'main'], dir, credentials)
}

/** The commit `HEAD` names in `dir`; null without a repository or a commit. */
export async function headOf(dir: string): Promise<string | null> {
  try {
    return (
      (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir)).trim() ||
      null
    )
  } catch {
    return null
  }
}

/** The branch checked out in `dir`; null when `HEAD` is detached, or without a repository. */
export async function branchOf(dir: string): Promise<string | null> {
  try {
    return (
      (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir)).trim() ||
      null
    )
  } catch {
    return null
  }
}

/** The commits reachable from `to` and not from `from`, oldest first, abbreviated. */
export async function commitsBetween(
  dir: string,
  from: string,
  to = 'HEAD'
): Promise<string[]> {
  const range = `${positional(from, 'revision')}..${positional(to, 'revision')}`
  return (await git(['rev-list', '--reverse', '--abbrev-commit', range], dir))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** The `origin` URL, or null when `dir` is not a clone with an origin. */
export async function originUrl(dir: string): Promise<string | null> {
  try {
    return (await git(['remote', 'get-url', 'origin'], dir)).trim()
  } catch {
    return null
  }
}

/** `git init -q -b main <dir>` (the directory must exist). */
export async function init(dir: string): Promise<void> {
  await git(['init', '-q', '-b', 'main'], dir)
}

/** `git add -A && git commit -q -m <message>` in `dir`. */
export async function commitAll(dir: string, message: string): Promise<void> {
  await git(['add', '-A'], dir)
  await git(['commit', '-q', '-m', message], dir)
}
