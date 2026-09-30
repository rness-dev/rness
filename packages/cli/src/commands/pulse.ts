import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { CommandDeps } from '../core/deps.ts'
import { seenPaths } from '../core/git.ts'
import {
  GitHubMessageError,
  RateLimitError,
  type RateWait,
  rateWait,
} from '../core/github.ts'
import { loadManifest, providerOf, writeManifest } from '../core/manifest.ts'
import type { Board, Provider } from '../core/provider.ts'
import { PROVIDERS, openProvider } from '../core/providers.ts'
import { statusTabs } from '../core/status.ts'
import { defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { issueBody } from '../pulse/body.ts'
import { oneSyncAtATime, recordFailure } from '../pulse/detached.ts'
import { desiredOf, layoutOf } from '../pulse/layout.ts'
import {
  type BodyStep,
  type Placed,
  type Step,
  issuedAfter,
  planBodies,
  planSync,
  unwantedPaths,
} from '../pulse/plan.ts'
import { reportError } from '../report.ts'
import { loginCommand } from './login.ts'

export interface PulseOptions {
  yes?: boolean
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
  /** Internal (tests): GitHub API base. */
  githubApi?: string
  /** Internal (tests): how a rate-limit wait sleeps; default a timer. */
  sleep?: (ms: number) => Promise<void>
}

const PROJECT_SCOPE = 'project'
const NEEDS_LOGIN = 'the pulse needs a GitHub login: run rness login'
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

const apiOf = (opts: PulseOptions): { apiBase?: string } =>
  opts.githubApi === undefined ? {} : { apiBase: opts.githubApi }

const providerOptions = (
  opts: PulseOptions,
  wait?: RateWait
): { apiBase?: string; wait?: RateWait } => ({
  ...apiOf(opts),
  ...(wait === undefined ? {} : { wait }),
})

/** The refusals every pulse command shares, in order; each throws one line. */
async function context(opts: PulseOptions, wait?: RateWait): Promise<Context> {
  const ws = await findWorkspace(opts.cwd ?? process.cwd())
  const manifest = await loadManifest(ws.rnessDir)
  const provider = await openProvider(manifest, providerOptions(opts, wait))
  if (manifest.org === null)
    throw new Error('the pulse needs an organization: rness.json has no "org"')
  return { rnessDir: ws.rnessDir, manifest, org: manifest.org, provider }
}

/** Rate-limit waits said as they begin: a pause of minutes must not look like a hang (spec 0018 §4). */
const waitSaid = (opts: PulseOptions, ui: Ui): RateWait =>
  rateWait(async (ms) => {
    ui.line('waiting', `${Math.round(ms / 1000)} s — GitHub's rate limit`)
    await (opts.sleep ?? ((n: number) => delay(n)))(ms)
  })

/**
 * What the login lacks for the pulse — a login, or the project scope — or
 * null. Throws when GitHub cannot be asked: an offline machine or a rejected
 * token is never told that a scope is missing.
 */
async function missingAccess(provider: Provider): Promise<string | null> {
  if (!provider.authenticated) return NEEDS_LOGIN
  const scopes = await fromGithub(provider.scopes())
  return scopes?.includes(PROJECT_SCOPE) === true ? null : NEEDS_SCOPE
}

/** The declared board, opened; `sync` and `mark` need one. */
async function declaredBoard(c: Context): Promise<Board> {
  if (c.manifest.pulse === null)
    throw new Error('no pulse declared — rness pulse create')
  const missing = await missingAccess(c.provider)
  if (missing !== null) throw new Error(missing)
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
  for (const a of added) {
    if (a.startsWith('label ')) ui.line('created', a)
    else if (a.startsWith('link '))
      ui.line('linked', `Agent Pulse to ${a.slice('link '.length)}`)
  }
}

/** Every file of `.rness/` by its path there, with `/`; not `.git` nor `node_modules` (spec 0018 §3.3). */
async function filesOf(rnessDir: string): Promise<Set<string>> {
  const files = new Set<string>()
  const walk = async (rel: string): Promise<void> => {
    const dir = rel === '' ? rnessDir : join(rnessDir, ...rel.split('/'))
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') await walk(path)
      } else if (e.isFile()) files.add(path)
    }
  }
  await walk('')
  return files
}

const count = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What a sync did (spec 0018 §4): to `.rness`'s Issues first, then to every
 * item, as 0.12.0 said it; an item whose body alone was written is updated.
 * Each document has one step of create, convert, update or unchanged; an
 * item left alone for want of a document here is no document, not counted.
 */
function sayDone(
  ui: Ui,
  org: string,
  documents: number,
  steps: readonly Step[],
  writes: readonly BodyStep[]
): void {
  const n = (kind: Step['kind']): number =>
    steps.filter((s) => s.kind === kind).length
  const reopened = steps.filter((s) => s.kind === 'update' && s.reopen).length
  if (n('create') > 0) ui.line('created', count(n('create'), 'issue'))
  if (n('convert') > 0)
    ui.line(
      'converted',
      `${count(n('convert'), 'draft')} into issues of ${org}/.rness`
    )
  if (reopened > 0) ui.line('reopened', count(reopened, 'issue'))
  const written = new Set(writes.map((w) => w.id))
  const bodyOnly = steps.filter(
    (s) => s.kind === 'unchanged' && written.has(s.id)
  ).length
  const parts = (
    [
      ['created', n('create')],
      ['converted', n('convert')],
      ['updated', n('update') + bodyOnly],
      [
        'unchanged',
        documents - n('create') - n('convert') - n('update') - bodyOnly,
      ],
      ['archived', n('close') + n('archive')],
    ] as const
  )
    .filter(([, k]) => k > 0)
    .map(([word, k]) => `${k} ${word}`)
  ui.line(
    'synced',
    `${plural(documents)}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`
  )
}

/**
 * Issues first, then the layout, then the documents in two passes (spec
 * 0018 §4): each gets its issue, title, label and fields; then the bodies,
 * which link to one another's issues by number.
 */
async function syncBoard(
  c: Context,
  board: Board,
  ui: Ui,
  sayLayout: SayLayout
): Promise<void> {
  await fromGithub(c.provider.checkIssues(c.org))
  const tabs = await statusTabs(c.rnessDir)
  const want = desiredOf(tabs, c.org)
  sayLayout(
    ui,
    await fromGithub(c.provider.ensureLayout(board, layoutOf(tabs)))
  )
  const have = await fromGithub(c.provider.items(board))
  // Gone is gone for this clone's git (spec 0018 §2): a path it never saw is
  // closed only on an issue this login opened. The login is asked for only
  // then: a stored login knows it; an environment token asks GitHub once.
  // Unknown (the ask failed), git's word alone decides.
  const unwanted = unwantedPaths(want, have)
  const seen = await seenPaths(c.rnessDir, unwanted)
  const login = unwanted.every((p) => seen.has(p))
    ? null
    : ((await c.provider.identity())?.login ?? null)
  const steps = planSync(want, have, seen, login)
  const changes = steps.filter((s) => s.kind !== 'unchanged').length
  let writes: BodyStep[] = []
  let made = 0
  try {
    const placed = new Map<string, Placed>()
    for (const step of steps) {
      const p = await fromGithub(c.provider.apply(board, step))
      if (p !== null && (step.kind === 'create' || step.kind === 'convert'))
        placed.set(step.want.path, p)
      if (step.kind !== 'unchanged') made++
    }
    const issued = issuedAfter(steps, have, placed)
    const numbers = new Map([...issued].map(([path, i]) => [path, i.number]))
    const files = await filesOf(c.rnessDir)
    const bodies = new Map<string, string>()
    for (const w of want)
      bodies.set(
        w.path,
        issueBody({
          path: w.path,
          text: await readFile(join(c.rnessDir, ...w.path.split('/')), 'utf8'),
          org: c.org,
          numbers,
          files,
        })
      )
    writes = planBodies(bodies, issued)
    for (const step of writes) {
      await fromGithub(c.provider.apply(board, step))
      made++
    }
  } catch (e) {
    if (!(e instanceof RateLimitError)) throw e
    const total = changes + writes.length
    throw new Error(
      `${e.message}: ${total - made} of ${total} changes not made — the next rness pulse sync makes them`,
      { cause: e }
    )
  }
  sayDone(ui, c.org, want.length, steps, writes)
}

/** `rness pulse create`: the project, declared at once; then its layout and a first sync. */
export async function pulseCreateCommand(
  opts: PulseOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  try {
    const terminal = deps.terminal ?? defaultTerminal
    const ui = deps.ui ?? (await makeUi(terminal))
    const wait = waitSaid(opts, ui)
    let c = await context(opts, wait)
    if (c.manifest.pulse !== null)
      throw new Error(
        `already declared: ${boardUrl(c.org, c.manifest.pulse.project)} — rness pulse sync`
      )
    // A written provider was already refused by `context`; a detected one is
    // what create writes, so it is refused here, before GitHub is asked
    // anything (spec 0017 §2.2).
    const detected = providerOf(c.manifest)
    if (!PROVIDERS[detected].available)
      throw new Error(
        `the pulse needs a GitHub organization, and this workspace's repositories look like ${detected} (detected): write "provider": "github" in rness.json if the organization is on GitHub`
      )
    const missing = await missingAccess(c.provider)
    if (missing !== null) {
      if (opts.yes === true || !terminal.isTty()) throw new Error(missing)
      const p = await terminal.prompts()
      const ok = await p.confirm({
        message:
          missing === NEEDS_LOGIN
            ? 'The pulse needs a GitHub login with the project scope. Log in now?'
            : 'The pulse needs the project scope of your GitHub login. Log in again to grant it?',
      })
      if (p.isCancel(ok) || ok !== true) throw new Error(missing)
      const code = await loginCommand(
        {
          project: true,
          // The git question is `rness login`'s own, not the pulse's to ask.
          setupGit: false,
          ...(opts.githubApi === undefined
            ? {}
            : { githubApi: opts.githubApi }),
        },
        { terminal, ui, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) }
      )
      if (code !== 0) return code
      c = {
        ...c,
        provider: await openProvider(c.manifest, providerOptions(opts, wait)),
      }
      const still = await missingAccess(c.provider)
      if (still !== null) throw new Error(still)
    }
    // Before anything is written: the items are issues of .rness (spec 0018 §2).
    await fromGithub(c.provider.checkIssues(c.org))
    const login = (await c.provider.identity())?.login ?? 'unknown'
    ui.line(
      'checked',
      `${detected}, logged in as ${login}, scope ${PROJECT_SCOPE}`
    )

    const board = await fromGithub(c.provider.createBoard(c.org))
    // Declared as soon as the project exists, before its layout: whatever
    // fails after this leaves a declared project that `rness pulse sync`
    // completes, not one nobody knows about (spec 0017 §3).
    await writeManifest(c.rnessDir, {
      ...c.manifest,
      provider: detected,
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
    const c = await context(opts, waitSaid(opts, ui))
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
  /** Internal (tests): how the lock's poll sleeps. */
  sleep?: (ms: number) => Promise<void>
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
  const key = `${c.org}-${board.number}`
  const lock = opts.sleep === undefined ? {} : { sleep: opts.sleep }
  // Marks need ids, `Path` and `Session`: every body, on every edit, is not
  // theirs to download. A sync lists what it needs itself.
  const listed = () => fromGithub(c.provider.items(board, { bodies: false }))
  let items = await listed()
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
    // The session's last sync waits its turn behind an edit's.
    await oneSyncAtATime(key, () => syncBoard(c, board, plainUi, eachAdded), {
      ...lock,
      wait: true,
    })
    return 0
  }
  const wanted = new Set(opts.paths)
  // A document the agent has just written has no item until a sync gives it
  // one (plan 0027 Task 6, a fix to spec 0017 §5). Only a document of
  // `rness status` can get one: another file of `.rness/` costs no sync.
  const documents = new Set(
    (await statusTabs(c.rnessDir)).flatMap((t) => t.rows.map((r) => r.path))
  )
  const onBoard = new Set(
    items.flatMap((i) => (i.path === null ? [] : [i.path]))
  )
  if ([...wanted].some((p) => documents.has(p) && !onBoard.has(p))) {
    // Another hook's sync running gives it its item; the next edit marks it.
    const synced = await oneSyncAtATime(
      key,
      () => syncBoard(c, board, plainUi, eachAdded),
      lock
    )
    if (synced) items = await listed()
  }
  const ids = items
    .filter((i) => i.path !== null && wanted.has(i.path))
    .map((i) => i.id)
  await fromGithub(c.provider.mark(board, ids, opts.session))
  return 0
}
