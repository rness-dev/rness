import type { CommandDeps } from '../core/deps.ts'
import { GitHubMessageError } from '../core/github.ts'
import { loadManifest, providerOf, writeManifest } from '../core/manifest.ts'
import type { Board, Provider } from '../core/provider.ts'
import { openProvider } from '../core/providers.ts'
import { statusTabs } from '../core/status.ts'
import { defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { recordFailure } from '../pulse/detached.ts'
import { desiredOf, layoutOf } from '../pulse/layout.ts'
import { planSync } from '../pulse/plan.ts'
import { reportError } from '../report.ts'
import { loginCommand } from './login.ts'

export interface PulseOptions {
  yes?: boolean
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
  /** Internal (tests): GitHub API base. */
  githubApi?: string
}

const PROJECT_SCOPE = 'project'
const NEEDS_SCOPE = 'the pulse needs the project scope: run rness login'

const boardUrl = (org: string, project: number): string =>
  `https://github.com/orgs/${org}/projects/${project}`

/**
 * GitHub's own words, named as GitHub's unless they already say so. rness's
 * own errors (`the board has no field Agent`) keep their words.
 */
async function fromGithub<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (e) {
    if (e instanceof GitHubMessageError && !/github/i.test(e.message))
      throw new Error(`GitHub: ${e.message}`, { cause: e })
    throw e
  }
}

interface Context {
  rnessDir: string
  manifest: Manifest
  org: string
  provider: Provider
}

/** The refusals every pulse command shares, in order; each throws one line. */
async function context(opts: PulseOptions): Promise<Context> {
  const ws = await findWorkspace(opts.cwd ?? process.cwd())
  const manifest = await loadManifest(ws.rnessDir)
  const provider = await openProvider(manifest, apiOf(opts))
  if (manifest.org === null)
    throw new Error('the pulse needs an organization: rness.json has no "org"')
  return { rnessDir: ws.rnessDir, manifest, org: manifest.org, provider }
}

const apiOf = (opts: PulseOptions): { apiBase?: string } =>
  opts.githubApi === undefined ? {} : { apiBase: opts.githubApi }

const hasProjectScope = async (provider: Provider): Promise<boolean> =>
  (await provider.scopes())?.includes(PROJECT_SCOPE) ?? false

/** The declared board, opened; `sync` and `mark` need one. */
async function declaredBoard(c: Context): Promise<Board> {
  if (c.manifest.pulse === null)
    throw new Error('no pulse declared — rness pulse create')
  if (!(await hasProjectScope(c.provider))) throw new Error(NEEDS_SCOPE)
  const number = c.manifest.pulse.project
  const board = await fromGithub(c.provider.board(c.org, number))
  if (board === null)
    throw new Error(`GitHub has no project ${number} in ${c.org}`)
  return board
}

const plural = (n: number): string => `${n} item${n === 1 ? '' : 's'}`

/** What the layout gained, as `sync` says it: `added view Plans`, a line each. */
type SayLayout = (ui: Ui, added: readonly string[]) => void
const eachAdded: SayLayout = (ui, added) => {
  for (const a of added) ui.line('added', a)
}
/** As `create` says it: a line per kind, `created fields Collection, Agent`. */
const createdByKind: SayLayout = (ui, added) => {
  for (const kind of ['field', 'option', 'view']) {
    const names = added
      .filter((a) => a.startsWith(`${kind} `))
      .map((a) => a.slice(kind.length + 1))
    if (names.length > 0) ui.line('created', `${kind}s ${names.join(', ')}`)
  }
}

/**
 * Layout first, then the documents: one way (spec 0017 §4). What it did is
 * said as `sync` says things, and the summary drops the parts that are zero.
 */
async function syncBoard(
  c: Context,
  board: Board,
  ui: Ui,
  sayLayout: SayLayout
): Promise<void> {
  const tabs = await statusTabs(c.rnessDir)
  const want = desiredOf(tabs, c.org)
  sayLayout(
    ui,
    await fromGithub(c.provider.ensureLayout(board, layoutOf(tabs)))
  )
  const steps = planSync(want, await fromGithub(c.provider.items(board)))
  for (const step of steps) await fromGithub(c.provider.apply(board, step))
  const count = (kind: string): number =>
    steps.filter((s) => s.kind === kind).length
  const parts = (
    [
      ['created', 'create'],
      ['updated', 'update'],
      ['unchanged', 'unchanged'],
      ['archived', 'archive'],
    ] as const
  )
    .map(([word, kind]) => [word, count(kind)] as const)
    .filter(([, n]) => n > 0)
    .map(([word, n]) => `${n} ${word}`)
  ui.line(
    'synced',
    `${plural(want.length)}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`
  )
}

/** `rness pulse create`: the project, declared at once; then its layout and a first sync. */
export async function pulseCreateCommand(
  opts: PulseOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  try {
    const terminal = deps.terminal ?? defaultTerminal
    const ui = deps.ui ?? (await makeUi(terminal))
    let c = await context(opts)
    if (c.manifest.pulse !== null)
      throw new Error(
        `already declared: ${boardUrl(c.org, c.manifest.pulse.project)} — rness pulse sync`
      )
    if (!(await hasProjectScope(c.provider))) {
      if (opts.yes === true || !terminal.isTty()) throw new Error(NEEDS_SCOPE)
      const p = await terminal.prompts()
      const ok = await p.confirm({
        message:
          'The pulse needs the project scope of your GitHub login. Log in again to grant it?',
      })
      if (p.isCancel(ok) || ok !== true) throw new Error(NEEDS_SCOPE)
      const code = await loginCommand(
        {
          project: true,
          ...(opts.githubApi === undefined
            ? {}
            : { githubApi: opts.githubApi }),
        },
        { terminal, ui, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) }
      )
      if (code !== 0) return code
      c = { ...c, provider: await openProvider(c.manifest, apiOf(opts)) }
      if (!(await hasProjectScope(c.provider))) throw new Error(NEEDS_SCOPE)
    }
    const login = (await c.provider.identity())?.login ?? 'unknown'
    ui.line(
      'checked',
      `${providerOf(c.manifest)}, logged in as ${login}, scope ${PROJECT_SCOPE}`
    )

    const board = await fromGithub(c.provider.createBoard(c.org))
    // Declared as soon as the project exists, before its layout: whatever
    // fails after this leaves a declared project that `rness pulse sync`
    // completes, not one nobody knows about (spec 0017 §3).
    await writeManifest(c.rnessDir, {
      ...c.manifest,
      provider: providerOf(c.manifest),
      pulse: { project: board.number },
    })
    ui.line('created', `Agent Pulse — ${board.url}`)
    try {
      await syncBoard(c, board, ui, createdByKind)
    } finally {
      ui.line(
        'declared',
        'pulse in .rness/rness.json — commit it: git -C .rness commit -am "chore: rness pulse"'
      )
    }
    return 0
  } catch (e) {
    return reportError(e)
  }
}

/** `rness pulse sync`: the board follows the documents. */
export async function pulseSyncCommand(
  opts: PulseOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  try {
    const ui = deps.ui ?? (await makeUi(deps.terminal ?? defaultTerminal))
    const c = await context(opts)
    await syncBoard(c, await declaredBoard(c), ui, eachAdded)
    return 0
  } catch (e) {
    return reportError(e)
  }
}

interface MarkOptions {
  cwd?: string
  githubApi?: string
  session: string
  paths: string[]
  end?: boolean
}

/**
 * Hidden, for the hooks: marks the items of `paths` as worked on by `session`,
 * or — with `end` — clears that session's marks and syncs. It never prompts
 * and no one reads its output: a failure is recorded, for the next session
 * start to say (spec 0017 §5), and the exit is 0.
 */
export async function pulseMarkCommand(opts: MarkOptions): Promise<number> {
  try {
    return await mark(opts)
  } catch (e) {
    await recordFailure(e instanceof Error ? e.message : String(e))
    return 0
  }
}

async function mark(opts: MarkOptions): Promise<number> {
  const c = await context(opts)
  const board = await declaredBoard(c)
  const items = await fromGithub(c.provider.items(board))
  if (opts.end === true) {
    // A subagent's marks read `claude · <type> · <id>`: the session's end
    // clears every mark ending in its id, whatever agent type precedes it.
    const id = opts.session.split(' · ').pop() ?? opts.session
    const ids = items
      .filter(
        (i) => i.session === opts.session || i.session?.endsWith(` · ${id}`)
      )
      .map((i) => i.id)
    await fromGithub(c.provider.mark(board, ids, null))
    await syncBoard(c, board, plainUi, eachAdded)
    return 0
  }
  const wanted = new Set(opts.paths)
  const ids = items
    .filter((i) => i.path !== null && wanted.has(i.path))
    .map((i) => i.id)
  await fromGithub(c.provider.mark(board, ids, opts.session))
  return 0
}
