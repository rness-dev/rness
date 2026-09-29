import { realpath } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { checkWorkspace } from '../core/check-workspace.ts'
import { COLLECTIONS, assembleContext } from '../core/context.ts'
import { checkContract } from '../core/contract.ts'
import { parseFrontMatter } from '../core/frontmatter.ts'
import { loadManifest, workspaceName } from '../core/manifest.ts'
import { pinDrift, workspacePackageManager } from '../core/pinned.ts'
import { resolveScope, scopeChain } from '../core/scope.ts'
import type { CollectionName, Workspace } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { scopeSummary } from '../mcp/tools.ts'
import { type Spawn, detached, takeFailure } from '../pulse/detached.ts'
import { VERSION } from '../version.ts'

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

const NOUNS: Record<CollectionName, [string, string]> = {
  standards: ['standard', 'standards'],
  adr: ['decision', 'decisions'],
  specs: ['specification', 'specifications'],
  plans: ['plan', 'plans'],
  skills: ['skill', 'skills'],
}
/** How many of `validate`'s problems the session start spells out. */
const SHOWN_PROBLEMS = 3

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

function count(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Why the context may be wrong: the installed copy, then validate's problems. */
async function safetyNet(
  ws: Workspace,
  manifest: Awaited<ReturnType<typeof loadManifest>>
): Promise<string[]> {
  const notes: string[] = []
  const drift = await pinDrift(ws.rnessDir)
  if (drift !== null)
    notes.push(
      `.rness pins @rness/cli ${drift.pin} but ${drift.installed ?? 'nothing'} is installed — run ${await workspacePackageManager(ws.rnessDir)} install in .rness`
    )
  try {
    const { problems } = await checkWorkspace(ws, manifest)
    if (problems.length > 0)
      notes.push(
        `${count(problems.length, ['problem', 'problems'])} in the workspace context — run rness validate`,
        ...problems.slice(0, SHOWN_PROBLEMS).map((p) => `  ${p}`)
      )
  } catch (e) {
    notes.push(message(e))
  }
  return notes
}

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
    return (await loadManifest(ws.rnessDir)).pulse !== null
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

/** The plans of the scope whose status is In progress, as `.rness/`-relative paths. */
async function plansInProgress(
  ws: Workspace,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  scope: string | null
): Promise<string[]> {
  const context = await assembleContext({
    rnessDir: ws.rnessDir,
    manifest,
    scope,
  })
  const plans = context.collections.find((c) => c.name === 'plans')
  return (plans?.files ?? [])
    .filter((f) => {
      try {
        return parseFrontMatter(f.body)?.['status'] === 'In progress'
      } catch {
        return false
      }
    })
    .map((f) => `plans/${f.rel}`)
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
    const summary = await scopeSummary(ws, manifest, scope)
    const counts = COLLECTIONS.flatMap((c) => {
      const n = summary.counts[c]
      return n === undefined ? [] : [count(n, NOUNS[c])]
    })
    banner = `rness ${VERSION} · ${workspaceName(manifest, ws.root)} · ${scope === null ? 'global scope' : `scope ${scope}`} — ${counts.length === 0 ? 'nothing applies yet' : counts.join(', ')}`
    const at = toPosix(relative(cwd, ws.rnessDir)) || '.rness'
    context = [
      ...summary.lines,
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
  const warnings = notes.map((n) => `rness: ${n}`)
  const shown = [
    ...(banner !== null && input['source'] !== 'compact' ? [banner] : []),
    ...warnings,
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
  const file = resolve(cwd, path)
  // The session may name the file through a link the workspace path does
  // not take (macOS: /tmp and /private/tmp): compare real paths as well.
  const rel =
    inside(ws.rnessDir, file) ??
    inside(
      await realpath(ws.rnessDir).catch(() => ws.rnessDir),
      await realpath(file).catch(() => file)
    )
  if (rel === null) return 0
  if (rel.endsWith('.md'))
    await markDetached(ws, input, io, (session) => [
      '--session',
      session,
      '--path',
      rel,
    ])
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
    event !== 'post-tool-use' &&
    event !== 'session-end'
  ) {
    io.error.write(
      `unknown hook event ${JSON.stringify(event)} (known: session-start, post-tool-use, session-end)\n`
    )
    return 1
  }
  const input = await readInput(io.input)
  if (event === 'post-tool-use') return postToolUse(input, io)
  if (event === 'session-end') return sessionEnd(input, io)
  io.output.write(`${JSON.stringify(await sessionStart(input, io))}\n`)
  return 0
}
