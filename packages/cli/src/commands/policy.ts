import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname, posix, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { POLICY_REFUSED_EXIT } from '../core/git-hooks.ts'
import { Contract1Error, loadManifest } from '../core/manifest.ts'
import { rnessCommand } from '../core/pm.ts'
import {
  type AddedLinesFile,
  type Ancestry,
  type CommitMessageOptions,
  type PolicyAction,
  type PolicyFailure,
  type PushUpdate,
  checkAddedLines,
  checkCommitMessage,
  checkPush,
  refusalText,
} from '../core/policy-check.ts'
import {
  type PolicyWorkspace,
  placeOf,
  policiesByPath,
  rnessOutputProofs,
  scopesOf,
} from '../core/policy-workspace.ts'
import {
  type Policy,
  type PolicyCheck,
  policiesFor,
  policiesNotApplied,
} from '../core/policy.ts'
import { recordRefusalsIn, refusalsOf } from '../core/refusals.ts'
import { findWorkspace } from '../core/workspace.ts'

/**
 * `rness policy check <hook>`: what the git hooks of every clone run (spec
 * 0040 §4.2). It reads what git hands the hook, applies the enabled
 * policies of the clone's scopes, and answers as a hook: 20 and the refusal
 * on stderr (the hook scripts turn it into 1), else 0. It fails open: anything that keeps it from checking
 * (no workspace, its own error) is 0 and one line,
 * `rness: policies not checked: <why>`; a clone that holds no scope, where
 * no policy applies, is 0 and silent. Hidden: a person never runs it.
 * Like `hook`, one of the launcher's own commands: never installs, never
 * delegates.
 */

export const POLICY_HOOKS = ['pre-commit', 'commit-msg', 'pre-push'] as const
export type PolicyHook = (typeof POLICY_HOOKS)[number]

/** What a hook's refusal says it refused. */
const ACTION: Readonly<Record<PolicyHook, PolicyAction>> = {
  'pre-commit': 'commit',
  'commit-msg': 'commit',
  'pre-push': 'push',
}

export interface PolicyIo {
  /** What git writes to the hook: the ref updates of a push. */
  input: Readable & { isTTY?: boolean }
  error: Writable
  /** The hook's environment, handed to git untouched (`GIT_INDEX_FILE`). */
  env: NodeJS.ProcessEnv
  /** Where git started the hook: the root of the work tree. */
  cwd: string
}

const defaultIo = (): PolicyIo => ({
  input: process.stdin,
  error: process.stderr,
  env: process.env,
  cwd: process.cwd(),
})

const NOT_CHECKED = 'rness: policies not checked: '
/** Why policies are not checked on a contract-1 `rness.json`, as the hooks say it. */
const contract1Cause = (): string =>
  `rness.json is contract 1: run ${rnessCommand()} upgrade`
const NOT_APPLIED = 'rness: policy not applied (invalid, run rness validate): '

/** A large staged diff is still read whole; past this, the hook fails open. */
const MAX_OUTPUT = 256 * 1024 * 1024

interface GitRun {
  code: number
  stdout: string
  stderr: string
}

/**
 * `git <args>` where the hook runs, with its environment as git set it:
 * resolved with the exit code, rejected only when git cannot run.
 */
function runGit(args: readonly string[], io: PolicyIo): Promise<GitRun> {
  return new Promise((ok, fail) => {
    execFile(
      'git',
      [...args],
      { cwd: io.cwd, env: io.env, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          ok({ code: 0, stdout, stderr })
          return
        }
        const code = (error as { code?: unknown }).code
        if (typeof code === 'number') ok({ code, stdout, stderr })
        else fail(error)
      }
    )
  })
}

/** `git <args>`'s output; its first line of error when it fails. */
async function git(args: readonly string[], io: PolicyIo): Promise<string> {
  const run = await runGit(args, io)
  if (run.code === 0) return run.stdout
  const first =
    run.stderr.split('\n').find((l) => l.trim() !== '') ?? `exit ${run.code}`
  throw new Error(`git ${args[0] ?? ''} failed: ${first.trim()}`)
}

/** A config value, or null when unset or unreadable. */
async function gitConfig(
  args: readonly string[],
  io: PolicyIo
): Promise<string | null> {
  const run = await runGit(['config', ...args], io)
  return run.code === 0 ? run.stdout.trim() : null
}

interface WorkTree {
  /** The work tree the hook runs in. */
  top: string
  /** The clone it belongs to: the same, or a linked worktree's main work tree. */
  clone: string
  /** The clone's git directory, as git found it for the hook: the record's. */
  gitDir: string
  /** The work tree's own git directory: a linked worktree's, where its merge state is. */
  ownGitDir: string
}

/**
 * Where the hook runs, as git tells it in the hook's environment: for a
 * linked worktree, the clone is its main work tree, which `sync` knows and
 * whose hooks git runs, and the common directory is the clone's.
 */
async function workTree(io: PolicyIo): Promise<WorkTree> {
  let out: string
  try {
    out = await git(
      ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
      io
    )
  } catch {
    throw new Error('not in the work tree of a git repository')
  }
  const [top, gitDir, commonDir] = out.split('\n').map((l) => l.trim())
  if (top === undefined || top === '' || gitDir === undefined)
    throw new Error('not in the work tree of a git repository')
  const own = resolve(io.cwd, gitDir)
  const common = resolve(io.cwd, commonDir ?? gitDir)
  const linked = own !== common && basename(common) === '.git'
  return {
    top,
    clone: linked ? dirname(common) : top,
    gitDir: common,
    ownGitDir: own,
  }
}

interface StagedFile {
  /** Relative to the work tree. */
  path: string
  added: { line: number; text: string }[]
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** The added lines of one file's `-U0` patch, numbered in the new file. */
function addedLines(patch: readonly string[]): StagedFile['added'] {
  const added: StagedFile['added'] = []
  let next = 0
  let inHunk = false
  for (const line of patch) {
    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      next = Number(hunk[1])
      inHunk = true
      continue
    }
    // Before the first hunk: the header (`+++ b/x` among it).
    if (!inHunk) continue
    if (line.startsWith('+')) {
      added.push({ line: next, text: line.slice(1).replace(/\r$/, '') })
      next += 1
    } else if (line.startsWith(' ')) next += 1
    // `-` lines and `\ No newline at end of file` take no line of the new file.
  }
  return added
}

/**
 * The staged changes, each file with the lines it adds: the patch git
 * commits (`git diff --cached -U0`, against HEAD or `base`), deletions left
 * out, renames detected (a moved line is not added), binary files and
 * submodules adding none. Lines are numbered in the staged file, whatever
 * the base. The names come from `-z`, in the patch's order, so no quoted
 * path is parsed; two outputs that disagree make the hook fail open, said.
 */
async function stagedChanges(
  io: PolicyIo,
  base?: string
): Promise<StagedFile[]> {
  const common = [
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    '-M',
    '--diff-filter=d',
  ]
  const against = base === undefined ? [] : [base, '--']
  const [names, patch] = await Promise.all([
    git([...common, '--name-only', '-z', ...against], io),
    git([...common, '-U0', ...against], io),
  ])
  const paths = names.split('\0').filter((n) => n !== '')
  const sections: string[][] = []
  for (const line of patch.split('\n')) {
    // A patch line starts with +, -, space or \: this is always a header.
    if (line.startsWith('diff --git ')) sections.push([])
    else sections.at(-1)?.push(line)
  }
  if (sections.length !== paths.length)
    throw new Error(
      `the staged diff names ${sections.length} files and lists ${paths.length}`
    )
  return paths.map((path, i) => ({
    path,
    added: addedLines(sections[i] ?? []),
  }))
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** The other parents of a merge being concluded (`MERGE_HEAD`, one per line), or none. */
async function mergeHeads(ownGitDir: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(resolve(ownGitDir, 'MERGE_HEAD'), 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => OID.test(l))
}

/**
 * What the commit adds. Concluding a merge (`MERGE_HEAD`), a line is added
 * only when it is added against every parent: a conflict resolution or a
 * new line is checked, a line taken from either branch passes, since that
 * branch's own commit was checked. Lines are matched by their number in
 * the staged file, the same in every diff.
 */
async function addedByCommit(
  io: PolicyIo,
  ownGitDir: string
): Promise<StagedFile[]> {
  const [files, heads] = await Promise.all([
    stagedChanges(io),
    mergeHeads(ownGitDir),
  ])
  if (heads.length === 0) return files
  const others = await Promise.all(
    heads.map(async (head) => {
      const byPath = new Map<string, Set<number>>()
      for (const f of await stagedChanges(io, head))
        byPath.set(f.path, new Set(f.added.map((a) => a.line)))
      return byPath
    })
  )
  return files.map((f) => ({
    ...f,
    added: f.added.filter((a) =>
      others.every((o) => o.get(f.path)?.has(a.line) === true)
    ),
  }))
}

/** The staged blob of a path (stage 0 of the index the hook was given). */
const stagedBlob = (path: string, io: PolicyIo): Promise<string> =>
  git(['cat-file', 'blob', `:0:${path}`], io)

const uses = (policies: readonly Policy[], check: PolicyCheck): boolean =>
  policies.some((p) => p.rules.some((r) => r.check === check))

/**
 * pre-commit: the lines the commit adds, each file under its own scope's
 * policies. A file is read from the index only when one of its lines is
 * refused before the exemptions; only those files' exemptions are proved.
 */
async function preCommit(
  ws: PolicyWorkspace,
  prefix: string,
  scopes: readonly string[],
  ownGitDir: string,
  io: PolicyIo
): Promise<PolicyFailure[]> {
  if (!uses(await policiesFor(ws, scopes), 'added-lines')) return []
  const files = (await addedByCommit(io, ownGitDir))
    .filter((f) => f.added.length > 0)
    .map((f) => ({ ...f, at: posix.join(prefix, f.path) }))
  const policiesOf = await policiesByPath(
    ws,
    files.map((f) => f.at)
  )
  const suspects = files.filter(
    (f) =>
      checkAddedLines([{ path: f.at, added: f.added, after: '' }], policiesOf)
        .length > 0
  )
  if (suspects.length === 0) return []
  const proofs = await rnessOutputProofs(
    ws,
    suspects.map((f) => f.at)
  )
  const checked: AddedLinesFile[] = []
  for (const f of suspects)
    checked.push({
      path: f.at,
      added: f.added,
      after: await stagedBlob(f.path, io),
      ...proofs,
    })
  return checkAddedLines(checked, policiesOf)
}

/** The effective comment character, or null when git's cannot be known. */
function commentCharOf(
  char: string | null,
  string: string | null
): string | null {
  const set = [...new Set([char, string].filter((v) => v !== null))]
  if (set.length === 0) return '#'
  const only = set.length === 1 ? set[0] : undefined
  return only === undefined || only === '' || only === 'auto' ? null : only
}

/**
 * Whether git will cut the message at its scissors line, as far as a hook
 * can tell. Only a message git opened in the editor: git sets `GIT_EDITOR`
 * to `:` for the hooks when no editor runs, and a message given with `-m`
 * or `-F`, or a merge's (`MERGE_MSG`, `commit.verbose` ignored), can carry a
 * scissors block git keeps (verified 2026-11-03, git 2.56.0). Then
 * `commit.verbose` on or `commit.cleanup=scissors`, at git's comment
 * character. A command-line `-v` is not visible to the hook (the check is
 * then stricter); `--no-verbose` or `--cleanup` against the configuration,
 * on an edited message, is not either.
 */
async function scissorsOf(
  io: PolicyIo,
  file: string
): Promise<CommitMessageOptions> {
  if (io.env['GIT_EDITOR'] === ':' || basename(file) === 'MERGE_MSG')
    return { cutAtScissors: false }
  const [verbose, cleanup, char, string] = await Promise.all([
    gitConfig(['--bool', '--get', 'commit.verbose'], io),
    gitConfig(['--get', 'commit.cleanup'], io),
    gitConfig(['--get', 'core.commentChar'], io),
    gitConfig(['--get', 'core.commentString'], io),
  ])
  const commentChar = commentCharOf(char, string)
  if (commentChar === null) return { cutAtScissors: false }
  return {
    cutAtScissors: verbose === 'true' || cleanup === 'scissors',
    commentChar,
  }
}

/** commit-msg: the message file, `$1`, relative to the work tree's root. */
async function commitMsg(
  ws: PolicyWorkspace,
  scopes: readonly string[],
  top: string,
  args: readonly string[],
  io: PolicyIo
): Promise<PolicyFailure[]> {
  const policies = await policiesFor(ws, scopes)
  if (!uses(policies, 'commit-message')) return []
  const file = args[0]
  if (file === undefined || file === '')
    throw new Error('no commit message file was given')
  let text: string
  try {
    text = await readFile(resolve(top, file), 'utf8')
  } catch {
    throw new Error(`the commit message file ${file} cannot be read`)
  }
  return checkCommitMessage(text, policies, await scissorsOf(io, file))
}

async function readAll(input: PolicyIo['input']): Promise<string> {
  if (input.isTTY === true) return ''
  let text = ''
  for await (const chunk of input) text += String(chunk)
  return text
}

const UPDATE = /^(\S+) ([0-9a-f]+) (\S+) ([0-9a-f]+)$/
const ZEROS = /^0+$/

/**
 * pre-push: each ref update git hands the hook on stdin, `<local ref>
 * <local object> <remote ref> <remote object>`, judged on what it does.
 * `git merge-base --is-ancestor` is asked once per update that is neither
 * a new branch nor a deletion: 0 ancestor, 1 not, else not here (128).
 */
async function prePush(
  ws: PolicyWorkspace,
  scopes: readonly string[],
  io: PolicyIo
): Promise<PolicyFailure[]> {
  const policies = await policiesFor(ws, scopes)
  if (!uses(policies, 'push')) return []
  const updates: PushUpdate[] = []
  for (const line of (await readAll(io.input)).split('\n')) {
    const m = UPDATE.exec(line.trim())
    if (m === null) continue
    updates.push({
      ref: m[3] ?? '',
      localOid: m[2] ?? '',
      remoteOid: m[4] ?? '',
    })
  }
  const answers = new Map<string, Ancestry>()
  for (const u of updates) {
    if (ZEROS.test(u.remoteOid) || ZEROS.test(u.localOid)) continue
    const key = `${u.remoteOid} ${u.localOid}`
    if (answers.has(key)) continue
    const { code } = await runGit(
      ['merge-base', '--is-ancestor', u.remoteOid, u.localOid],
      io
    )
    answers.set(
      key,
      code === 0 ? 'ancestor' : code === 1 ? 'not-ancestor' : 'missing'
    )
  }
  return checkPush(
    updates,
    (remote, local) => answers.get(`${remote} ${local}`) ?? 'missing',
    policies
  )
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

const isHook = (value: string | undefined): value is PolicyHook =>
  (POLICY_HOOKS as readonly unknown[]).includes(value)

/**
 * Run one hook's check. `POLICY_REFUSED_EXIT` with the refusal on stderr when a policy refuses;
 * 0 otherwise, silent when it passes, one line when it could not check.
 */
export async function policyCheckCommand(
  hook: string | undefined,
  args: readonly string[],
  io: PolicyIo = defaultIo()
): Promise<number> {
  const say = (line: string): void => {
    io.error.write(`${line}\n`)
  }
  try {
    if (!isHook(hook))
      throw new Error(
        `unknown hook ${JSON.stringify(hook ?? '')} (expected ${POLICY_HOOKS.join(', ')})`
      )
    const { top, clone, gitDir, ownGitDir } = await workTree(io)
    const found = await findWorkspace(clone).catch(() => null)
    if (found === null)
      throw new Error(`.rness/ is not reachable from ${clone}`)
    const ws: PolicyWorkspace = {
      ...found,
      manifest: await loadManifest(found.rnessDir),
    }
    const place = placeOf(ws, clone)
    // A clone no scope declares: no policy applies there, so nothing is left
    // unchecked and there is nothing to say (sync writes no hook there).
    if (place.kind === 'outside') return 0
    const scopes = scopesOf(place)
    const invalid = await policiesNotApplied(ws, scopes)
    // Said once the check is done: a failure after it says one line only.
    const notApplied =
      invalid.length > 0 ? `${NOT_APPLIED}${invalid.join(', ')}` : null

    const failures =
      hook === 'pre-commit'
        ? await preCommit(ws, place.prefix, scopes, ownGitDir, io)
        : hook === 'commit-msg'
          ? await commitMsg(ws, scopes, top, args, io)
          : await prePush(ws, scopes, io)
    if (notApplied !== null) say(notApplied)
    if (failures.length === 0) return 0
    say(refusalText(failures, ACTION[hook]))
    // In the clone's git directory, as git found it in the hook's own
    // environment (the common directory of a linked worktree, a separate
    // git directory named by `GIT_DIR`): where `startOf(clone)` keeps the
    // sessions. A git hook knows the session only when Claude Code's Bash
    // tool ran it.
    await recordRefusalsIn(
      gitDir,
      refusalsOf(failures, hook, io.env['CLAUDE_CODE_SESSION_ID'])
    )
    return POLICY_REFUSED_EXIT
  } catch (e) {
    // The line of `upgrade` without the ADR pointer: the hook says why in one line (spec 0038 §11).
    say(
      `${NOT_CHECKED}${e instanceof Contract1Error ? contract1Cause() : message(e)}`
    )
    return 0
  }
}
