import { realpath } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { BLOCK_FILES } from '../core/agent-targets.ts'
import { takeModNotice } from '../core/claude-code.ts'
import { COLLECTIONS } from '../core/context.ts'
import { checkContract } from '../core/contract.ts'
import {
  type Replayed,
  editRefusal,
  ownedRefusal,
  ownedWhole,
  replayEdit,
  writeRefusal,
} from '../core/edit-guard.ts'
import { readOrNull } from '../core/fs.ts'
import { loadManifest, parseManifest } from '../core/manifest.ts'
import { safetyNet } from '../core/safety-net.ts'
import { resolveScope, scopeChain } from '../core/scope.ts'
import { plansInProgress } from '../core/status.ts'
import type { Workspace } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { type Spawn, detached, takeFailure } from '../pulse/detached.ts'
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
  /** Runs `rness <args>` detached (the pulse); tests record instead. */
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

/** Whether the workspace declares a pulse; never throws. */
async function hasPulse(ws: Workspace): Promise<boolean> {
  try {
    return (await loadManifest(ws.rnessDir)).projects !== null
  } catch {
    return false
  }
}

/**
 * Starts `pulse mark` detached when the workspace declares a pulse and the
 * input names a session. The hooks never fail the session over it.
 */
async function markDetached(
  ws: Workspace,
  input: Input,
  io: HookIo,
  rest: (session: string) => string[] | null
): Promise<void> {
  try {
    const session = sessionOf(input)
    if (session === null || !(await hasPulse(ws))) return
    const args = rest(session)
    if (args !== null)
      (io.spawn ?? detached)(['pulse', 'mark', ...args], ws.root)
  } catch {
    // The pulse is a courtesy: nothing here may reach the session.
  }
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
    ]
    notes = await safetyNet(ws, manifest)
    const paths = await plansInProgress(ws, manifest, scope)
    await markDetached(ws, input, io, (session) =>
      paths.length === 0
        ? null
        : ['--session', session, ...paths.flatMap((p) => ['--path', p])]
    )
  } catch (e) {
    notes = [message(e)]
  }
  const failure = await takeFailure()
  if (failure !== null) notes.push(`pulse not updated — ${failure}`)
  const warnings = noteLines(notes)
  // For the developer only: the model has nothing to do about it.
  const tooOld = await takeModNotice(io.env)
  const shown = [
    ...(banner !== null && input['source'] !== 'compact' ? [banner] : []),
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
  // Marked after the check, broken or not: the agent is at work on it.
  if (rel.endsWith('.md'))
    await markDetached(ws, input, io, (session) => [
      '--session',
      session,
      '--path',
      rel,
    ])
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
  return will.filter((p) => !was.includes(p))
}

/**
 * Before an `Edit` or a `Write` (spec 0029 §4): refused, exit 2 with the
 * reason on stderr — Claude Code does not run the tool and the model reads
 * why — when it would change what `sync` generates (the block, the plugin's
 * files) or add a contract problem to `.rness/`. Else 0, silent; and 0 on
 * any failure of its own: the guard never stops a session. The path is
 * checked before anything is read: this runs before every edit.
 */
async function preToolUse(input: Input, io: HookIo): Promise<number> {
  const toolInput = input['tool_input']
  if (toolInput === null || typeof toolInput !== 'object') return 0
  const args = toolInput as Input
  const path = args['file_path']
  if (typeof path !== 'string' || path === '') return 0
  try {
    const cwd = cwdOf(input, io.env)
    const ws = await findWorkspace(cwd)
    const file = resolve(cwd, path)
    const label = await within(ws.root, file)
    if (label === null) return 0
    if (ownedWhole(label)) return refuse(io, [ownedRefusal(label)])
    const rel = await within(ws.rnessDir, file)
    const blocked = BLOCK_FILES.includes(posix.basename(label))
    if (rel === null && !blocked) return 0
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
    if (rel === null) return 0
    const added = await addedProblems(ws, rel, before, after)
    if (added.length === 0) return 0
    return refuse(io, [
      ...added.map((p) => `rness: ${p}`),
      `Fix the edit of ${rel}; rness validate checks the whole workspace.`,
    ])
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
    const ws = await findWorkspace(cwdOf(input, io.env))
    await markDetached(ws, input, io, (session) => [
      '--end',
      '--session',
      session,
    ])
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
