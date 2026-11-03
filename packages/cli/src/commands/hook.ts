import { realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { type Spawn, detached, takeFailure } from '../board/detached.ts'
import { recordStart, takeNotices } from '../board/journal-state.ts'
import { BLOCK_FILES } from '../core/agent-targets.ts'
import type { BoardDeclaration, HookEvent } from '../core/board-declaration.ts'
import { takeModNotice } from '../core/claude-code.ts'
import { COLLECTIONS } from '../core/context.ts'
import { checkContract } from '../core/contract.ts'
import {
  type AddedLine,
  type Replayed,
  addedLines,
  editRefusal,
  ownedRefusal,
  ownedWhole,
  replayEdit,
  writeRefusal,
} from '../core/edit-guard.ts'
import { readOrNull } from '../core/fs.ts'
import {
  type GitBypass,
  type SkippedHook,
  gitBypasses,
} from '../core/git-bypass.ts'
import { loadManifest, parseManifest } from '../core/manifest.ts'
import {
  type PolicyFailure,
  checkAddedLines,
  refusalText,
} from '../core/policy-check.ts'
import {
  type PolicyWorkspace,
  placeOf,
  policiesByPath,
  rnessOutputProofs,
  scopesOf,
} from '../core/policy-workspace.ts'
import { type Policy, type PolicyCheck, policiesFor } from '../core/policy.ts'
import { type NamedBoard, readBoards } from '../core/preset-board.ts'
import {
  type RefusalEntry,
  recordRefusals,
  refusalsOf,
} from '../core/refusals.ts'
import { cloneHolding } from '../core/repos.ts'
import { safetyNet } from '../core/safety-net.ts'
import { resolveScope, scopeChain } from '../core/scope.ts'
import { documentsIn, plansInProgress } from '../core/status.ts'
import type { Manifest, Workspace } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { noteLines, scopeBanner } from './snapshot.ts'

/**
 * `rness hook <event>`: what Claude Code runs for the hooks the Claude
 * target writes (spec 0015). Never installs, delegates or writes a file:
 * `hook` is one of the launcher's own commands (`OWN_COMMANDS`).
 */

export interface HookIo {
  input: Readable & { isTTY?: boolean }
  output: Writable
  error: Writable
  env: NodeJS.ProcessEnv
  /** Runs `rness <args>` detached (the boards); tests record instead. */
  spawn?: Spawn
}

type Input = Record<string, unknown>

/** The hook's JSON on stdin; `{}` from a terminal or for anything else. */
async function readInput(input: HookIo['input']): Promise<Input> {
  if (input.isTTY === true) return {}
  let text = ''
  for await (const chunk of input) text += String(chunk)
  try {
    const data: unknown = JSON.parse(text)
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Input)
      : {}
  } catch {
    return {}
  }
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

/** The session's directory: the input's, else the project's, else ours. */
function cwdOf(input: Input, env: NodeJS.ProcessEnv): string {
  const cwd = input['cwd']
  if (typeof cwd === 'string' && cwd !== '') return cwd
  return env['CLAUDE_PROJECT_DIR'] ?? process.cwd()
}

const toPosix = (p: string): string => p.split(sep).join(posix.sep)

/** `claude · <first 8 of session_id>`, with the agent type when there is one. */
function sessionOf(input: Input): string | null {
  const id = input['session_id']
  if (typeof id !== 'string' || id === '') return null
  const type = input['agent_type']
  return [
    'claude',
    ...(typeof type === 'string' && type !== '' ? [type] : []),
    id.slice(0, 8),
  ].join(' · ')
}

type HookBoard = NamedBoard

/** The boards `rness.json` declares (see {@link readBoards}). */
const boardsOf = (ws: Workspace): Promise<HookBoard[]> =>
  readBoards(ws.rnessDir)

/** Whether a board holds a document: one that takes all, any; else one of its collections'. */
const holds = (board: BoardDeclaration, path: string): boolean =>
  board.collections === 'all' ||
  Object.hasOwn(board.collections, path.split('/')[0] ?? '')

/**
 * Starts `board run <event>` detached (spec 0032 §4), when the input names
 * a session, some board declares an action at the event, and `rest` finds
 * something for it to do. The hooks never fail the session over it.
 */
async function runDetached(
  ws: Workspace,
  input: Input,
  io: HookIo,
  event: HookEvent,
  rest: (
    session: string,
    boards: readonly HookBoard[]
  ) => Promise<string[] | null>
): Promise<void> {
  try {
    const session = sessionOf(input)
    if (session === null) return
    const boards = (await boardsOf(ws)).filter(
      (b) => (b.declaration.hooks[event] ?? []).length > 0
    )
    if (boards.length === 0) return
    const args = await rest(session, boards)
    if (args !== null)
      (io.spawn ?? detached)(['board', 'run', event, ...args], ws.root)
  } catch {
    // The board is a courtesy: nothing here may reach the session.
  }
}

/**
 * The journal at session start (spec 0030 §6, §7), with no network: what
 * the model is told, when a board keeps one and the scope has a plan in
 * progress; and the session's start in the clone it works in, for the
 * summary. Never throws.
 */
async function journalStart(
  ws: Workspace,
  manifest: Manifest,
  scope: string | null,
  cwd: string,
  input: Input
): Promise<string[]> {
  try {
    for (const { declaration } of await boardsOf(ws))
      for (const a of declaration.hooks['session-start'] ?? []) {
        if (a.action !== 'journal') continue
        const plans = await plansInProgress(ws, manifest, scope)
        if (plans.length === 0) return []
        const session = sessionOf(input)
        const clone = cloneHolding(ws.root, manifest.repos, cwd)
        const summarised = (declaration.hooks['session-end'] ?? []).some(
          (e) => e.action === 'journal-summary'
        )
        if (session !== null && clone !== null && summarised)
          await recordStart(clone.dir, session)
        // `rness note` reads the session from the Bash tool's
        // environment; `rness_note` cannot, so it is spelt for it.
        const tool =
          session === null
            ? 'rness_note'
            : `rness_note, its session "${session}"`
        const which =
          plans.length === 1
            ? plans.join('')
            : `${plans.join(' or ')} (pass --plan)`
        return [
          [
            `Journal: post a note with \`rness note\` (or ${tool}) when you choose an approach, deviate from plan ${which}, are blocked, and when done.`,
            `At most ${a.limit}: decisions and their reasons, not steps.`,
            ...(a.to === 'repo'
              ? [
                  'The first note prints the issue to reference; the pull request that completes this plan here carries `Closes <issue>`, an earlier one `Refs <issue>`.',
                ]
              : []),
          ].join(' '),
        ]
      }
  } catch {
    // The journal is a courtesy: nothing here may reach the session.
  }
  return []
}

/**
 * A banner for the developer and the scope's summary for the model (spec
 * 0015 §3). One JSON object, always, and exit 0: a failure is a line of it.
 */
async function sessionStart(
  input: Input,
  io: HookIo
): Promise<Record<string, unknown>> {
  const cwd = cwdOf(input, io.env)
  let banner: string | null = null
  let context: string[] = []
  let notes: string[]
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const scope = resolveScope(manifest, toPosix(relative(ws.root, cwd)))
    const view = await scopeBanner(ws, manifest, scope)
    banner = view.banner
    const at = toPosix(relative(cwd, ws.rnessDir)) || '.rness'
    context = [
      ...view.lines,
      `These documents are in ${at}: read one there, or with rness_read when the rness MCP server is connected.`,
      ...(await journalStart(ws, manifest, scope, cwd, input)),
    ]
    notes = await safetyNet(ws, manifest)
    // Only when some board has documents of the scope to mark: no process
    // started for nothing.
    await runDetached(
      ws,
      input,
      io,
      'session-start',
      async (session, boards) => {
        for (const { declaration } of boards)
          for (const a of declaration.hooks['session-start'] ?? [])
            if (
              a.action === 'mark-in-progress' &&
              (
                await documentsIn(
                  ws,
                  manifest,
                  scope,
                  a.collections,
                  a.statuses
                )
              ).some((p) => holds(declaration, p))
            )
              return [
                '--session',
                session,
                ...(scope === null ? [] : ['--scope', scope]),
              ]
        return null
      }
    )
  } catch (e) {
    notes = [message(e)]
  }
  const failure = await takeFailure()
  if (failure !== null) notes.push(`board not updated: ${failure}`)
  notes.push(...(await takeNotices()))
  const warnings = noteLines(notes)
  const compact = input['source'] === 'compact'
  // For the developer only: the model has nothing to do about it.
  const tooOld = compact ? null : await takeModNotice(io.env)
  const shown = [
    ...(banner !== null && !compact ? [banner] : []),
    ...warnings,
    ...(tooOld !== null ? [tooOld] : []),
  ]
  return {
    ...(shown.length > 0 ? { systemMessage: shown.join('\n') } : {}),
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: [...context, ...warnings].join('\n'),
    },
  }
}

/** `relative(from, to)` when `to` is inside `from`, else null. */
function inside(from: string, to: string): string | null {
  const rel = relative(from, to)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel)
    ? null
    : toPosix(rel)
}

/**
 * After an edit (spec 0015 §4): the problems the edited file of `.rness/`
 * now has, or those of `rness.json`. Exit 2 with them on stderr — Claude
 * Code hands them to the model — else 0, silent. The path is checked before
 * anything is read: this runs after every edit of the session.
 */
async function postToolUse(input: Input, io: HookIo): Promise<number> {
  const toolInput = input['tool_input']
  const path =
    toolInput !== null && typeof toolInput === 'object'
      ? (toolInput as Input)['file_path']
      : undefined
  if (typeof path !== 'string' || path === '') return 0
  const cwd = cwdOf(input, io.env)
  let ws: Workspace
  try {
    ws = await findWorkspace(cwd)
  } catch {
    return 0
  }
  const rel = await within(ws.rnessDir, resolve(cwd, path))
  if (rel === null) return 0
  const first = rel.split('/')[0] ?? ''
  let problems: string[] = []
  if (rel === 'rness.json') {
    try {
      const manifest = await loadManifest(ws.rnessDir)
      for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
    } catch (e) {
      problems = [message(e)]
    }
  } else if (
    (COLLECTIONS as readonly string[]).includes(first) &&
    rel.endsWith('.md')
  )
    problems = (await checkContract(ws.rnessDir)).filter((p) =>
      p.startsWith(`${rel}:`)
    )
  // Marked after the check, broken or not: the agent is at work on it — by
  // a board that declares `mark` and holds its collection (spec 0032 §2).
  if (rel.endsWith('.md') && rel.includes('/'))
    await runDetached(ws, input, io, 'edit', async (session, boards) =>
      boards.some(
        (b) =>
          (b.declaration.hooks.edit ?? []).some((a) => a.action === 'mark') &&
          holds(b.declaration, rel)
      )
        ? ['--session', session, '--path', rel]
        : null
    )
  if (problems.length === 0) return 0
  io.error.write(
    [
      ...problems.map((p) => `rness: ${p}`),
      `Fix it in ${rel}; rness validate checks the whole workspace.`,
      '',
    ].join('\n')
  )
  return 2
}

/** The relative path of `file` in `base`, through real paths too; null outside. */
async function within(base: string, file: string): Promise<string | null> {
  // The session may name the file through a link the workspace path does
  // not take (macOS: /tmp and /private/tmp): compare real paths as well.
  return (
    inside(base, file) ??
    inside(
      await realpath(base).catch(() => base),
      await realpath(file).catch(() => file)
    )
  )
}

/** What a `rness.json` text would make `validate` say: the manifest, then its scopes. */
function manifestProblems(text: string | null): string[] {
  if (text === null) return []
  try {
    const manifest = parseManifest(text)
    for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
    return []
  } catch (e) {
    return [message(e)]
  }
}

/**
 * The problems an edit of `.rness/<rel>` would add (spec 0029 §4.3): those
 * its text after has and the file now has not. A document already broken
 * stays editable; an edit that fixes part of it passes.
 */
async function addedProblems(
  ws: Workspace,
  rel: string,
  before: string | null,
  after: string
): Promise<string[]> {
  let was: string[]
  let will: string[]
  if (rel === 'rness.json') {
    was = manifestProblems(before)
    will = manifestProblems(after)
  } else {
    const first = rel.split('/')[0] ?? ''
    if (
      !(COLLECTIONS as readonly string[]).includes(first) ||
      !rel.endsWith('.md')
    )
      return []
    const mine = (p: string) => p.startsWith(`${rel}:`)
    was = (await checkContract(ws.rnessDir)).filter(mine)
    will = (await checkContract(ws.rnessDir, { rel, text: after })).filter(mine)
  }
  // A policy's problem names its line (`policy/x.md:4: ...`): one the edit
  // only moves is not one it adds.
  const unlined = (p: string) => p.replace(/^([^:]+):\d+: /, '$1: ')
  const had = new Set(was.map(unlined))
  return will.filter((p) => !had.has(unlined(p)))
}

/** The policies that apply to the workspace, or null when they cannot be read. */
async function policyWorkspace(ws: Workspace): Promise<PolicyWorkspace | null> {
  try {
    return { ...ws, manifest: await loadManifest(ws.rnessDir) }
  } catch {
    // A broken rness.json: the contract guard still runs, the policies not.
    return null
  }
}

/** The repository a workspace path belongs to: `.rness`, a clone, or none. */
function repositoryOf(pws: PolicyWorkspace, label: string): string | null {
  // By path, not by name: a standalone checkout of the context repository
  // is the context whatever its directory is called.
  const path = join(pws.root, ...label.split('/'))
  if (path === pws.rnessDir || inside(pws.rnessDir, path) !== null)
    return pws.rnessDir
  return cloneHolding(pws.root, pws.manifest.repos, path)?.dir ?? null
}

/** The session the hook input names, as the git hooks record it: Claude Code's id. */
function sessionIdOf(input: Input): string | null {
  const id = input['session_id']
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * The added-lines policies of the file's scope (spec 0040 §4.3) on the lines
 * the edit adds. Proofs of rness's own outputs are read only for a file one
 * of whose lines is refused before them, as the pre-commit hook does; when
 * they cannot be read, the failures found without them stand.
 */
async function addedLineFailures(
  pws: PolicyWorkspace,
  policiesOf: (path: string) => readonly Policy[],
  label: string,
  added: readonly AddedLine[],
  after: string
): Promise<PolicyFailure[]> {
  if (added.length === 0) return []
  const file = { path: label, added, after }
  const bare = checkAddedLines([file], policiesOf)
  if (bare.length === 0) return []
  try {
    return checkAddedLines(
      [{ ...file, ...(await rnessOutputProofs(pws, [label])) }],
      policiesOf
    )
  } catch {
    // The proofs cannot be read: they only ever remove a failure, so
    // without them every failure stands.
    return bare
  }
}

/**
 * Before an `Edit` or a `Write` (spec 0029 §4, spec 0040 §4.3): refused,
 * exit 2 with the reason on stderr (Claude Code does not run the tool and
 * the model reads why) when it would change what `sync` generates (the
 * block, the plugin's files), add a line a policy refuses, anywhere in the
 * workspace, or add a contract problem to `.rness/`. Else 0, silent. Nothing
 * is read for a file outside `.rness/` that holds no block, unless an
 * added-lines policy applies to it: this runs before every edit.
 */
async function editGuard(input: Input, io: HookIo): Promise<number> {
  const toolInput = input['tool_input']
  if (toolInput === null || typeof toolInput !== 'object') return 0
  const args = toolInput as Input
  const path = args['file_path']
  if (typeof path !== 'string' || path === '') return 0
  const cwd = cwdOf(input, io.env)
  const ws = await findWorkspace(cwd)
  const file = resolve(cwd, path)
  const label = await within(ws.root, file)
  if (label === null) return 0
  if (ownedWhole(label)) return refuse(io, [ownedRefusal(label)])
  const rel = await within(ws.rnessDir, file)
  const blocked = BLOCK_FILES.includes(posix.basename(label))
  const pws = await policyWorkspace(ws)
  // Policies that cannot be read are no policy here: the block and contract
  // guards below still run.
  const policiesOf =
    pws === null ? null : await policiesByPath(pws, [label]).catch(() => null)
  const policed =
    policiesOf?.(label).some((p) =>
      p.rules.some((r) => r.check === 'added-lines')
    ) === true
  if (rel === null && !blocked && !policed) return 0
  const before = await readOrNull(file)
  let after: string
  let spans: Replayed['spans'] | null = null
  if (input['tool_name'] === 'Write') {
    const content = args['content']
    if (typeof content !== 'string') return 0
    after = content
  } else {
    const { old_string, new_string, replace_all } = args
    if (
      before === null ||
      typeof old_string !== 'string' ||
      typeof new_string !== 'string'
    )
      return 0
    const replayed = replayEdit(
      before,
      old_string,
      new_string,
      replace_all === true
    )
    if (replayed === null) return 0
    after = replayed.after
    spans = replayed.spans
  }
  if (blocked && before !== null) {
    const reason =
      spans === null
        ? writeRefusal(label, before, after)
        : editRefusal(label, before, spans)
    if (reason !== null) return refuse(io, [reason])
  }
  const failures =
    pws !== null && policiesOf !== null && policed
      ? await addedLineFailures(
          pws,
          policiesOf,
          label,
          addedLines(before, after),
          after
        )
      : []
  const problems =
    rel === null ? [] : await addedProblems(ws, rel, before, after)
  if (failures.length === 0 && problems.length === 0) return 0
  if (failures.length > 0 && pws !== null) {
    const repository = repositoryOf(pws, label)
    if (repository !== null)
      await recordRefusals(
        repository,
        refusalsOf(failures, 'guard', sessionIdOf(input))
      )
  }
  return refuse(io, [
    ...(failures.length > 0 ? [refusalText(failures, 'edit')] : []),
    ...(problems.length > 0
      ? [
          ...problems.map((p) => `rness: ${p}`),
          `Fix the edit of ${rel}; rness validate checks the whole workspace.`,
        ]
      : []),
  ])
}

/** The checks each skipped hook runs (spec 0040 §3). */
const HOOK_CHECK: Readonly<Record<SkippedHook, PolicyCheck>> = {
  'pre-commit': 'added-lines',
  'commit-msg': 'commit-message',
  'pre-push': 'push',
}

const HOOKS_SKIPPED: Readonly<Record<string, string>> = {
  'pre-commit,commit-msg': 'the pre-commit and commit-msg hooks',
  'commit-msg': 'the commit-msg hook',
  'pre-push': 'the pre-push hook',
  'pre-commit,commit-msg,pre-push': 'every hook',
}

const BYPASS_CUT = 120

/** One bypass, refused: where it runs, and the policies it would skip. */
interface Skipping {
  bypass: GitBypass
  repository: string
  policies: Policy[]
}

/**
 * The policies a bypass would skip, in the repository git runs in: `.rness`
 * (the global ones) or a clone that holds scopes (theirs), those with a
 * rule the skipped hooks check. Where git runs cannot be told (an unknown
 * `cd`, `-C` or GIT_DIR), it is taken to be anywhere in the workspace the
 * command starts in: every policy of it, the record in the repository the
 * command starts in, else `.rness`. Null where git runs in no repository
 * of a workspace, or where the bypass skips nothing: a local `git config
 * core.hooksPath .githooks` in `.rness`, which is where its hooks are.
 */
async function skipping(
  bypass: GitBypass,
  cwd: string
): Promise<Skipping | null> {
  const placed = bypass.dir !== null
  const at = bypass.dir ?? cwd
  const ws = await findWorkspace(at).catch(() => null)
  if (ws === null) return null
  const pws = await policyWorkspace(ws)
  if (pws === null) return null
  const label = await within(ws.root, at)
  const found = label === null ? null : repositoryOf(pws, label)
  let scopes: string[]
  let repository: string
  if (placed) {
    if (found === null) return null
    const place = placeOf(pws, found)
    if (place.kind === 'outside') return null
    if (
      place.kind === 'context' &&
      bypass.scope === 'local' &&
      bypass.hooksPath !== undefined &&
      resolve(ws.rnessDir, bypass.hooksPath) === join(ws.rnessDir, '.githooks')
    )
      return null
    scopes = scopesOf(place)
    repository = found
  } else {
    scopes = Object.keys(pws.manifest.scopes)
    repository = found ?? ws.rnessDir
  }
  const checks = new Set(bypass.skips.map((h) => HOOK_CHECK[h]))
  const policies = (await policiesFor(pws, scopes)).filter((p) =>
    p.rules.some((r) => checks.has(r.check))
  )
  return policies.length === 0 ? null : { bypass, repository, policies }
}

/**
 * Before a `Bash` command (spec 0040 §4.3): refused, exit 2, when it would
 * skip the git hooks while an enabled policy they apply holds where git
 * runs. Nothing else of the command is judged: the hooks do that. A command
 * without `git` returns at once; one the shell would not read passes, since
 * the shell runs nothing of it.
 */
async function bashGuard(input: Input, io: HookIo): Promise<number> {
  const toolInput = input['tool_input']
  if (toolInput === null || typeof toolInput !== 'object') return 0
  const command = (toolInput as Input)['command']
  if (typeof command !== 'string') return 0
  // At once only when nothing in it could spell git: an escape or a quote
  // (`g\it`, `$'\x67it'`), an expansion, a glob or a brace (`{gi,x}t`).
  if (!/git/i.test(command) && !/[\\'"$`*?[{]/.test(command)) return 0
  const cwd = cwdOf(input, io.env)
  const bypasses = gitBypasses(command, { cwd, env: io.env })
  if (bypasses === null || bypasses.length === 0) return 0
  const refused: Skipping[] = []
  for (const bypass of bypasses) {
    const found = await skipping(bypass, cwd)
    if (found !== null) refused.push(found)
  }
  if (refused.length === 0) return 0
  // One record per policy and repository: a refused command is one refusal.
  const session = sessionIdOf(input)
  const entries = new Map<string, Map<string, RefusalEntry>>()
  const named = new Map<string, Policy>()
  for (const { bypass, repository, policies } of refused) {
    const checks = new Set(bypass.skips.map((h) => HOOK_CHECK[h]))
    const byPolicy = entries.get(repository) ?? new Map<string, RefusalEntry>()
    for (const policy of policies) {
      named.set(policy.rel, policy)
      const check = policy.rules.find((r) => checks.has(r.check))?.check
      if (check === undefined || byPolicy.has(policy.name)) continue
      byPolicy.set(policy.name, {
        policy: policy.name,
        check,
        by: 'guard',
        ...(session === null ? {} : { session }),
      })
    }
    entries.set(repository, byPolicy)
  }
  for (const [repository, byPolicy] of entries)
    await recordRefusals(repository, [...byPolicy.values()])
  const lines = [
    ...new Set(
      refused.map(({ bypass }) => {
        const text = bypass.text.replace(/\s+/g, ' ').slice(0, BYPASS_CUT)
        const hooks = HOOKS_SKIPPED[bypass.skips.join(',')] ?? 'the hooks'
        return bypass.maybe === true
          ? `  ${text} (${bypass.how} may skip the hooks)`
          : `  ${text} (${bypass.how} skips ${hooks})`
      })
    ),
  ]
  return refuse(io, [
    "rness: this command would skip the git hooks that apply the workspace's policies",
    ...lines,
    '  fix: run it without skipping the hooks (no --no-verify, -n, core.hooksPath, hook-skipping alias or config override), and fix what the hook refuses',
    ...[...named.values()].map((p) => `  policy ${p.name}: .rness/${p.rel}`),
  ])
}

/**
 * Before a tool runs: the guard of spec 0029 §4 and spec 0040 §4.3, by the
 * tool's name. It never stops a session on its own failure: 0.
 */
async function preToolUse(input: Input, io: HookIo): Promise<number> {
  try {
    return input['tool_name'] === 'Bash'
      ? await bashGuard(input, io)
      : await editGuard(input, io)
  } catch {
    return 0
  }
}

function refuse(io: HookIo, lines: readonly string[]): number {
  io.error.write(`${lines.join('\n')}\n`)
  return 2
}

/** Clears the session's marks, detached; says nothing. */
async function sessionEnd(input: Input, io: HookIo): Promise<number> {
  try {
    const cwd = cwdOf(input, io.env)
    const ws = await findWorkspace(cwd)
    await runDetached(ws, input, io, 'session-end', async (session, boards) => {
      const summarised = boards.some((b) =>
        (b.declaration.hooks['session-end'] ?? []).some(
          (a) => a.action === 'journal-summary'
        )
      )
      if (!summarised) return ['--session', session]
      // The summary's plan is the scope's; its commits, the clone's.
      const manifest = await loadManifest(ws.rnessDir)
      const scope = resolveScope(manifest, toPosix(relative(ws.root, cwd)))
      const clone = cloneHolding(ws.root, manifest.repos, cwd)
      return [
        '--session',
        session,
        ...(scope === null ? [] : ['--scope', scope]),
        ...(clone === null ? [] : ['--clone', clone.name]),
      ]
    })
  } catch {
    // No workspace, nothing to clear.
  }
  return 0
}

export async function hookCommand(
  event: string,
  io: HookIo = {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    env: process.env,
  }
): Promise<number> {
  if (
    event !== 'session-start' &&
    event !== 'pre-tool-use' &&
    event !== 'post-tool-use' &&
    event !== 'session-end'
  ) {
    io.error.write(
      `unknown hook event ${JSON.stringify(event)} (known: session-start, pre-tool-use, post-tool-use, session-end)\n`
    )
    return 1
  }
  const input = await readInput(io.input)
  if (event === 'pre-tool-use') return preToolUse(input, io)
  if (event === 'post-tool-use') return postToolUse(input, io)
  if (event === 'session-end') return sessionEnd(input, io)
  io.output.write(`${JSON.stringify(await sessionStart(input, io))}\n`)
  return 0
}
