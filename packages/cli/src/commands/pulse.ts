import type { CommandDeps } from '../core/deps.ts'
import { loadManifest, providerOf, writeManifest } from '../core/manifest.ts'
import type { Board, Provider } from '../core/provider.ts'
import { openProvider } from '../core/providers.ts'
import { statusTabs } from '../core/status.ts'
import { defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
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
const FIELDS = ['Status', 'Type', 'Agent', 'Session', 'Path']
const WORKING_VIEW = 'Working'

const boardUrl = (org: string, project: number): string =>
  `https://github.com/orgs/${org}/projects/${project}`

/** GitHub's own words, named as GitHub's unless they already say so. */
async function fromGithub<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (e) {
    if (e instanceof Error && !/github/i.test(e.message))
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

/**
 * Layout first, then the documents: one way (spec 0017 §4). What it did is
 * said as `sync` says things, and the summary drops the parts that are zero.
 */
async function syncBoard(
  c: Context,
  board: Board,
  ui: Ui,
  layoutVerb: string
): Promise<void> {
  const tabs = await statusTabs(c.rnessDir)
  const want = desiredOf(tabs, c.org)
  for (const added of await fromGithub(
    c.provider.ensureLayout(board, layoutOf(tabs))
  ))
    ui.line(layoutVerb, added)
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

/** `rness pulse create`: the board, its layout, a first sync, and the declaration. */
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

    const tabs = await statusTabs(c.rnessDir)
    const layout = layoutOf(tabs)
    const board = await fromGithub(c.provider.createBoard(c.org, layout))
    ui.line('created', `Agent Pulse — ${board.url}`)
    ui.line('created', `fields ${FIELDS.join(', ')}`)
    ui.line(
      'created',
      `views ${[...layout.views.map((v) => v.name), WORKING_VIEW].join(', ')}`
    )

    // Declared as soon as the board exists: a failed first sync leaves a
    // board `rness pulse sync` can fill, not one nobody knows about.
    await writeManifest(c.rnessDir, {
      ...c.manifest,
      provider: providerOf(c.manifest),
      pulse: { project: board.number },
    })
    const declared = (): void =>
      ui.line(
        'declared',
        'pulse in .rness/rness.json — commit it: git -C .rness commit -am "chore: rness pulse"'
      )
    try {
      await syncBoard(c, board, ui, 'added')
    } catch (e) {
      declared()
      throw e
    }
    declared()
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
    await syncBoard(c, await declaredBoard(c), ui, 'added')
    return 0
  } catch (e) {
    return reportError(e)
  }
}

/**
 * Hidden, for the hooks: marks the items of `paths` as worked on by `session`,
 * or — with `end` — clears that session's marks and syncs. It never prompts,
 * and it throws: the hook that starts it records why it failed.
 */
export async function pulseMarkCommand(opts: {
  cwd?: string
  githubApi?: string
  session: string
  paths: string[]
  end?: boolean
}): Promise<number> {
  const c = await context(opts)
  const board = await declaredBoard(c)
  const items = await fromGithub(c.provider.items(board))
  if (opts.end === true) {
    const ids = items.filter((i) => i.session === opts.session).map((i) => i.id)
    await fromGithub(c.provider.mark(board, ids, null))
    await syncBoard(c, board, plainUi, 'added')
    return 0
  }
  const wanted = new Set(opts.paths)
  const ids = items
    .filter((i) => i.path !== null && wanted.has(i.path))
    .map((i) => i.id)
  await fromGithub(c.provider.mark(board, ids, opts.session))
  return 0
}
