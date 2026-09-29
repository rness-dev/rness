import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { ScaffoldFile } from './scaffold-copy.ts'

/**
 * The scaffold as git history in `.rness/` (spec 0013): the commits in which
 * rness wrote the scaffold, found by their subject; the commit holding a
 * target version's scaffold, built on the last one; the three-way merge git
 * does from there.
 */

const execFileP = promisify(execFile)

export const CREATE_SUBJECT = 'chore: rness workspace context'
const SCAFFOLD_SUBJECT = /^chore: rness scaffold (\S+)$/
export const SCAFFOLD_TRAILER = 'Rness-Scaffold'

interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** git in `dir` only (no walking up), with extra environment; never throws. */
async function run(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<Ran> {
  try {
    const { stdout, stderr } = await execFileP('git', [...args], {
      cwd: dir,
      env: {
        ...process.env,
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CEILING_DIRECTORIES: dirname(resolve(dir)),
      },
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string }
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(e),
    }
  }
}

async function must(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<string> {
  const r = await run(dir, args, env)
  if (r.code !== 0) {
    const first =
      r.stderr.split('\n').find((l) => l.trim() !== '') ?? 'unknown error'
    throw new Error(`git ${args[0] ?? ''} failed: ${first.trim()}`)
  }
  return r.stdout.trim()
}

/** The message of a scaffold commit: its subject names the version. */
export function scaffoldMessage(subject: string, version: string): string {
  return `${subject}\n\n${SCAFFOLD_TRAILER}: ${version}`
}

/**
 * Commit everything in `rnessDir` — the end of an upgrade, which found it
 * clean (spec 0013 §8). The hooks run: a refusal hands back what they said,
 * and leaves everything staged. Nothing to commit and no merge: `nothing`.
 */
export async function commitUpgrade(
  rnessDir: string,
  message: string
): Promise<
  { kind: 'committed' | 'nothing' } | { kind: 'refused'; output: string }
> {
  const add = await run(rnessDir, ['add', '-A'])
  if (add.code !== 0) return { kind: 'refused', output: add.stderr.trim() }
  const staged = await run(rnessDir, ['diff', '--cached', '--quiet'])
  if (staged.code === 0 && !(await mergeInProgress(rnessDir)))
    return { kind: 'nothing' }
  const commit = await run(rnessDir, ['commit', '-q', '-m', message])
  if (commit.code !== 0)
    return {
      kind: 'refused',
      output: `${commit.stdout}\n${commit.stderr}`.trim(),
    }
  return { kind: 'committed' }
}

/** Whether a merge waits for its commit in `dir` (`MERGE_HEAD` exists). */
export async function mergeInProgress(dir: string): Promise<boolean> {
  const r = await run(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  return r.code === 0
}

/**
 * The last commit in which rness wrote the scaffold (spec 0013 §1): the most
 * recent `chore: rness scaffold <v>`, else a root `chore: rness workspace
 * context`. The subject decides: a squash carries the trailer in its body
 * but mixes the team's edits in. Null when there is none — adoption.
 */
export async function findScaffoldBase(
  rnessDir: string
): Promise<{ commit: string; version: string | null } | null> {
  // Topological order: a child before its parent, whatever the commit dates
  // (two commits in the same second otherwise come in either order). A merge
  // in progress counts: the commit recording it runs the pre-commit hook
  // before it exists (spec 0013 §8).
  const merging = await mergeInProgress(rnessDir)
  const log = await run(rnessDir, [
    'log',
    '--topo-order',
    `--format=%H%x1f%P%x1f%s%x1f%(trailers:key=${SCAFFOLD_TRAILER},valueonly,separator=%x2C)%x1e`,
    'HEAD',
    ...(merging ? ['MERGE_HEAD'] : []),
  ])
  if (log.code !== 0) return null
  const commits = log.stdout
    .split('\x1e')
    .map((r) => r.trim())
    .filter((r) => r !== '')
    .map((r) => {
      const [hash = '', parents = '', subject = '', trailer = ''] =
        r.split('\x1f')
      return { hash, parents: parents.trim(), subject, trailer: trailer.trim() }
    })
  for (const c of commits) {
    const m = SCAFFOLD_SUBJECT.exec(c.subject)
    if (m !== null) return { commit: c.hash, version: m[1] ?? null }
  }
  const root = commits.find(
    (c) => c.parents === '' && c.subject === CREATE_SUBJECT
  )
  if (root === undefined) return null
  return {
    commit: root.hash,
    version: root.trailer === '' ? null : root.trailer,
  }
}

/**
 * The commit holding `version`'s scaffold: the base's tree with `files`
 * written over it, the base as parent (none on adoption). Built with a
 * temporary index — the working tree and the real index are untouched.
 */
export async function buildScaffoldCommit(
  rnessDir: string,
  base: string | null,
  files: readonly ScaffoldFile[],
  version: string
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'rness-scaffold-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    await must(
      rnessDir,
      ['read-tree', ...(base === null ? ['--empty'] : [base])],
      env
    )
    for (const [i, file] of files.entries()) {
      const tmp = join(scratch, `blob-${i}`)
      await writeFile(tmp, file.content, 'utf8')
      const blob = await must(rnessDir, [
        'hash-object',
        '-w',
        '--no-filters',
        '--',
        tmp,
      ])
      await must(
        rnessDir,
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `${file.executable ? '100755' : '100644'},${blob},${file.path}`,
        ],
        env
      )
    }
    const tree = await must(rnessDir, ['write-tree'], env)
    return await must(rnessDir, [
      'commit-tree',
      tree,
      ...(base === null ? [] : ['-p', base]),
      '-m',
      scaffoldMessage(`chore: rness scaffold ${version}`, version),
    ])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export type ScaffoldChange = 'added' | 'updated' | 'merged' | 'removed'

async function blobAt(
  rnessDir: string,
  rev: string,
  path: string
): Promise<string | null> {
  const r = await run(rnessDir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${rev}:${path}`,
  ])
  return r.code === 0 ? r.stdout.trim() : null
}

/**
 * `git merge --no-commit` of a scaffold commit: what changed, and what
 * conflicts. `updated` is a file the team never touched since `base`,
 * `merged` one it had edited; without a base, histories are unrelated.
 */
export async function mergeScaffold(
  rnessDir: string,
  commit: string,
  base: string | null
): Promise<{ conflicts: string[]; changes: Array<[ScaffoldChange, string]> }> {
  await run(rnessDir, [
    'merge',
    '--no-commit',
    '--no-ff',
    ...(base === null ? ['--allow-unrelated-histories'] : []),
    commit,
  ])
  const conflicts = (
    await must(rnessDir, ['diff', '--name-only', '--diff-filter=U'])
  )
    .split('\n')
    .filter((l) => l !== '')
  const changes: Array<[ScaffoldChange, string]> = []
  const status = await must(rnessDir, [
    'diff',
    '--cached',
    '--name-status',
    'HEAD',
  ])
  for (const line of status.split('\n')) {
    const [letter = '', path = ''] = line.split('\t')
    if (path === '' || conflicts.includes(path)) continue
    if (letter === 'A') changes.push(['added', path])
    else if (letter === 'D') changes.push(['removed', path])
    else if (letter === 'M') {
      const untouched =
        base !== null &&
        (await blobAt(rnessDir, 'HEAD', path)) ===
          (await blobAt(rnessDir, base, path))
      changes.push([untouched ? 'updated' : 'merged', path])
    }
  }
  return { conflicts, changes }
}

/** A one-commit checkout (CI): the history to read is not there. */
export async function isShallow(rnessDir: string): Promise<boolean> {
  const r = await run(rnessDir, ['rev-parse', '--is-shallow-repository'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** Whether `rnessDir` is itself a git repository (not merely inside one). */
export async function isRepository(rnessDir: string): Promise<boolean> {
  const r = await run(rnessDir, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) return false
  // Real paths on both sides: /tmp is a link to /private/tmp on macOS.
  const real = (p: string) => realpath(p).catch(() => resolve(p))
  return (await real(r.stdout.trim())) === (await real(rnessDir))
}

/**
 * Adoption only: `<dir>/.gitkeep` holds a directory open until it has files.
 * Where `HEAD` already tracks something in that directory, the scaffold
 * commit leaves it out, so the merge does not add a placeholder the team
 * never needed.
 */
export async function withoutRedundantKeeps(
  rnessDir: string,
  files: readonly ScaffoldFile[]
): Promise<ScaffoldFile[]> {
  const kept: ScaffoldFile[] = []
  for (const file of files) {
    if (file.path.endsWith('/.gitkeep')) {
      const dir = file.path.slice(0, -'/.gitkeep'.length)
      const listed = await run(rnessDir, [
        'ls-tree',
        '--name-only',
        'HEAD',
        '--',
        `${dir}/`,
      ])
      if (listed.code === 0 && listed.stdout.trim() !== '') continue
    }
    kept.push(file)
  }
  return kept
}
