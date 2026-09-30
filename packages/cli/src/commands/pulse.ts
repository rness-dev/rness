import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { collectMarkdown } from '../core/collect.ts'
import type { CommandDeps } from '../core/deps.ts'
import { seenPaths } from '../core/git.ts'
import {
  GitHubMessageError,
  RateLimitError,
  type RateWait,
  rateWait,
} from '../core/github.ts'
import {
  PULSE,
  loadManifest,
  providerOf,
  writeManifest,
} from '../core/manifest.ts'
import type { Board, Provider } from '../core/provider.ts'
import { PROVIDERS, openProvider } from '../core/providers.ts'
import { type StatusTab, statusTabs } from '../core/status.ts'
import { defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { issueBody } from '../pulse/body.ts'
import {
  type CollectionShape,
  type StatusUpdate,
  readShape,
  readUpdates,
} from '../pulse/collection.ts'
import { oneSyncAtATime, recordFailure } from '../pulse/detached.ts'
import {
  type Desired,
  type Layout,
  desiredOf,
  layoutOf,
} from '../pulse/layout.ts'
import { openedFile, readOpened, writeOpened } from '../pulse/opened.ts'
import {
  type BoardItem,
  type BodyStep,
  type Placed,
  type Step,
  issuedAfter,
  planBodies,
  planSync,
  stillOpened,
  unwantedPaths,
} from '../pulse/plan.ts'
import { reportError } from '../report.ts'
import { loginCommand } from './login.ts'

export interface PulseOptions {
  yes?: boolean
  /** `pulse create <collection>`: the collection's own project (spec 0025 §3). */
  collection?: string
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

/** A declared project, opened: `pulse` for Agent Pulse, else its collection's name. */
interface Declared {
  name: string
  board: Board
}

/**
 * Every declared project, opened: the collections' own first, in the order of
 * `projects`, Agent Pulse last — a document moving leaves it only once its
 * own project holds it (spec 0025 §3). `sync` and `mark` need one.
 */
async function declaredBoards(c: Context): Promise<Declared[]> {
  const projects = c.manifest.projects
  if (projects === null)
    throw new Error('no pulse declared — rness pulse create')
  const missing = await missingAccess(c.provider)
  if (missing !== null) throw new Error(missing)
  const names = Object.keys(projects).sort(
    (a, b) => Number(a === PULSE) - Number(b === PULSE)
  )
  const declared: Declared[] = []
  for (const name of names) {
    const number = projects[name]!
    const board = await fromGithub(c.provider.board(c.org, number))
    if (board === null)
      throw new Error(`GitHub has no project ${number} in ${c.org}`)
    declared.push({ name, board })
  }
  return declared
}

/** What one project holds and how it looks, from the files of `.rness/`. */
interface Scope {
  /** How a sync names the project: `Agent Pulse`, `Marketing`. */
  label: string
  want: Desired[]
  layout: Layout
  /** On Agent Pulse, a path whose collection has a project of its own. */
  elsewhere: (path: string) => boolean
  /** The paths whose opened issues this project's syncs record (spec 0018 §2). */
  mine: (path: string) => boolean
  /** A collection's own project: its README's declarations and its updates. */
  own: { shape: CollectionShape; updates: StatusUpdate[] } | null
}

/** A tab's label, as `rness status` makes it for a discovered directory. */
const labelOf = (name: string): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** The subdirectories of a collection, but `updates/`: the labels `labels: directory` makes. */
async function directoriesOf(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(
        (e) =>
          e.isDirectory() && !e.name.startsWith('.') && e.name !== 'updates'
      )
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function scopeOf(
  c: Context,
  name: string,
  tabs: readonly StatusTab[],
  owners: readonly string[]
): Promise<Scope> {
  const within = (collection: string) => (path: string) =>
    path.startsWith(`${collection}/`)
  if (name === PULSE) {
    const shown = tabs.filter((t) => !owners.includes(t.name))
    const elsewhere = (path: string) => owners.some((o) => within(o)(path))
    return {
      label: 'Agent Pulse',
      want: desiredOf(shown, c.org),
      layout: layoutOf(shown),
      elsewhere,
      mine: (path) => !elsewhere(path),
      own: null,
    }
  }
  // A collection with no document yet still has its project, empty.
  const tab = tabs.find((t) => t.name === name) ?? {
    name,
    label: labelOf(name),
    rows: [],
  }
  const dir = join(c.rnessDir, name)
  const shape = await readShape(c.rnessDir, name)
  const fronts = new Map(
    (await collectMarkdown(dir)).map((item) => [
      `${name}/${item.rel}`,
      item.fields ?? {},
    ])
  )
  const want = desiredOf([tab], c.org, {
    shape,
    fronts,
    directories: await directoriesOf(dir),
  })
  return {
    label: tab.label,
    want,
    layout: layoutOf([tab], { shape, want }),
    elsewhere: () => false,
    mine: within(name),
    own: { shape, updates: await readUpdates(c.rnessDir, name) },
  }
}

const plural = (n: number): string => `${n} item${n === 1 ? '' : 's'}`

/** What the layout gained, as `sync` says it: `added view Plans`, a line each. */
type SayLayout = (ui: Ui, added: readonly string[], project: string) => void
const eachAdded: SayLayout = (ui, added) => {
  for (const a of added)
    if (a.startsWith('renamed ')) ui.line('renamed', a.slice('renamed '.length))
    else ui.line('added', a)
}
/** As `create` says it: a line per kind, `created fields Collection, Agent`. */
const createdByKind: SayLayout = (ui, added, project) => {
  for (const kind of ['field', 'option', 'view']) {
    const names = added
      .filter((a) => a.startsWith(`${kind} `))
      .map((a) => a.slice(kind.length + 1))
    if (names.length > 0) ui.line('created', `${kind}s ${names.join(', ')}`)
  }
  for (const a of added) {
    if (a.startsWith('label ')) ui.line('created', a)
    else if (a.startsWith('link '))
      ui.line('linked', `${project} to ${a.slice('link '.length)}`)
  }
}

/** `work` under a transient line when there is any work to show; nothing when there is none. */
async function working(
  ui: Ui,
  doing: string,
  count: number,
  work: () => Promise<void>
): Promise<void> {
  if (count === 0) return work()
  await ui.step({ doing, quiet: true }, work, () => null)
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
  writes: readonly BodyStep[],
  adopted: number,
  on?: string
): void {
  // An adopted issue was planned as a create: it is counted apart.
  const n = (kind: Step['kind']): number =>
    steps.filter((s) => s.kind === kind).length -
    (kind === 'create' ? adopted : 0)
  const reopened = steps.filter((s) => s.kind === 'update' && s.reopen).length
  if (n('create') > 0) ui.line('created', count(n('create'), 'issue'))
  if (adopted > 0)
    ui.line(
      'adopted',
      `${count(adopted, 'issue')} already made for its document`
    )
  if (n('convert') > 0)
    ui.line(
      'converted',
      `${count(n('convert'), 'draft')} into issues of ${org}/.rness`
    )
  if (reopened > 0) ui.line('reopened', count(reopened, 'issue'))
  if (n('remove') > 0)
    ui.line('moved', `${plural(n('remove'))} to their collection's project`)
  const written = new Set(writes.map((w) => w.id))
  const bodyOnly = steps.filter(
    (s) => s.kind === 'unchanged' && written.has(s.id)
  ).length
  const parts = (
    [
      ['created', n('create')],
      ['adopted', adopted],
      ['converted', n('convert')],
      ['updated', n('update') + bodyOnly],
      [
        'unchanged',
        documents -
          n('create') -
          adopted -
          n('convert') -
          n('update') -
          bodyOnly,
      ],
      ['archived', n('close') + n('archive')],
    ] as const
  )
    .filter(([, k]) => k > 0)
    .map(([word, k]) => `${k} ${word}`)
  ui.line(
    'synced',
    `${plural(documents)}${on === undefined ? '' : ` on ${on}`}${
      parts.length > 0 ? `: ${parts.join(', ')}` : ''
    }`
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
  sayLayout: SayLayout,
  scope: Scope
): Promise<void> {
  await fromGithub(c.provider.checkIssues(c.org))
  const { want } = scope
  sayLayout(
    ui,
    await fromGithub(c.provider.ensureLayout(board, scope.layout)),
    scope.label
  )
  const have = await fromGithub(c.provider.items(board))
  // Gone is gone for this clone's git (spec 0018 §2): a path it never saw is
  // closed only on an issue this clone opened, as its record says. Git is
  // asked about every recorded path too: one it has seen is forgotten. The
  // record is the clone's: this project reads and rewrites its own paths only.
  const record = await openedFile(c.rnessDir)
  const all = await readOpened(record)
  const opened = new Map([...all].filter(([, path]) => scope.mine(path)))
  const others = [...all].filter(([, path]) => !scope.mine(path))
  const seen = await seenPaths(c.rnessDir, [
    ...unwantedPaths(want, have),
    ...opened.values(),
  ])
  const steps = planSync(want, have, seen, opened, scope.elsewhere)
  const changes = steps.filter((s) => s.kind !== 'unchanged').length
  let writes: BodyStep[] = []
  let made = 0
  let adopted = 0
  try {
    const placed = new Map<string, Placed>()
    // Recorded: the issues this sync opened — not a draft converted, synced
    // from a committed document — and forgotten: the ones it closed.
    const created = new Map<string, Placed>()
    const closed = new Set<string>()
    try {
      // Each change is a few requests, one at a time: a long pass shows it
      // is at work, and its line goes when it ends (spec 0007 §5).
      await working(
        ui,
        `writing  ${plural(changes)} on ${scope.label}`,
        changes,
        async () => {
          for (const step of steps) {
            const p = await fromGithub(c.provider.apply(board, step))
            if (
              p !== null &&
              (step.kind === 'create' || step.kind === 'convert')
            )
              placed.set(step.want.path, p)
            // An adopted issue was opened by whichever sync made it, not this one.
            if (p?.adopted === true) adopted++
            else if (p !== null && step.kind === 'create')
              created.set(step.want.path, p)
            if (step.kind === 'close' || step.kind === 'archive')
              closed.add(step.id)
            if (step.kind !== 'unchanged') made++
          }
        }
      )
    } finally {
      // What pass 1 did, recorded before anything else can stop the sync.
      await writeOpened(
        record,
        new Map([
          ...others,
          ...stillOpened(opened, have, seen, closed, created),
        ])
      )
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
    await working(
      ui,
      `writing  ${plural(writes.length)} bodies on ${scope.label}`,
      writes.length,
      async () => {
        for (const step of writes) {
          await fromGithub(c.provider.apply(board, step))
          made++
        }
      }
    )
  } catch (e) {
    if (!(e instanceof RateLimitError)) throw e
    const total = changes + writes.length
    throw new Error(
      `${e.message}: ${total - made} of ${total} changes not made — the next rness pulse sync makes them`,
      { cause: e }
    )
  }
  sayDone(
    ui,
    c.org,
    want.length,
    steps,
    writes,
    adopted,
    scope.own === null ? undefined : scope.label
  )
  if (scope.own !== null) {
    const { shape, updates } = scope.own
    for (const what of await fromGithub(
      c.provider.describe(board, {
        readme: shape.readme,
        description: shape.description,
      })
    ))
      ui.line('wrote', `${what} of ${scope.label}`)
    for (const line of await fromGithub(
      c.provider.postUpdates(board, updates)
    )) {
      const [verb, ...rest] = line.split(' ')
      ui.line(verb ?? 'posted', rest.join(' '))
    }
  }
}

/**
 * Every declared project, in turn (spec 0025 §3); `sayLayout` says what a
 * project's layout gained, by the project's name in `projects`.
 */
async function syncAll(
  c: Context,
  declared: readonly Declared[],
  ui: Ui,
  sayLayout: (name: string) => SayLayout
): Promise<void> {
  const tabs = await statusTabs(c.rnessDir)
  const owners = declared.map((d) => d.name).filter((n) => n !== PULSE)
  for (const { name, board } of declared)
    await syncBoard(
      c,
      board,
      ui,
      sayLayout(name),
      await scopeOf(c, name, tabs, owners)
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
    const wait = waitSaid(opts, ui)
    let c = await context(opts, wait)
    const name = opts.collection ?? PULSE
    const declared = c.manifest.projects?.[name]
    if (opts.collection === PULSE)
      throw new Error('"pulse" names Agent Pulse: rness pulse create')
    if (declared !== undefined)
      throw new Error(
        `already declared: ${boardUrl(c.org, declared)} — rness pulse sync`
      )
    // A collection is a tab of `rness status`: a directory of `.rness/` whose
    // documents carry a status (spec 0025 §3).
    const tab =
      opts.collection === undefined
        ? null
        : ((await statusTabs(c.rnessDir)).find(
            (t) => t.name === opts.collection
          ) ?? null)
    if (opts.collection !== undefined && tab === null)
      throw new Error(
        `${opts.collection} is no collection of .rness: none of its documents carries a status`
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

    const board = await fromGithub(c.provider.createBoard(c.org, tab?.label))
    // Declared as soon as the project exists, before its layout: whatever
    // fails after this leaves a declared project that `rness pulse sync`
    // completes, not one nobody knows about (spec 0017 §3).
    const manifest = {
      ...c.manifest,
      provider: detected,
      projects: { ...c.manifest.projects, [name]: board.number },
    }
    await writeManifest(c.rnessDir, manifest)
    c = { ...c, manifest }
    ui.line('created', `${tab?.label ?? 'Agent Pulse'} — ${board.url}`)
    try {
      await syncAll(c, await declaredBoards(c), ui, (n) =>
        n === name ? createdByKind : eachAdded
      )
    } finally {
      ui.line(
        'declared',
        `${name} in .rness/rness.json — commit it: git -C .rness commit -am "chore: rness pulse${
          opts.collection === undefined ? '' : ` ${opts.collection}`
        }"`
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
    await syncAll(c, await declaredBoards(c), ui, () => eachAdded)
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
  const declared = await declaredBoards(c)
  const key = `${c.org}-${declared.map((d) => d.board.number).join('-')}`
  const lock = opts.sleep === undefined ? {} : { sleep: opts.sleep }
  const syncEvery = () => syncAll(c, declared, plainUi, () => eachAdded)
  // Marks need ids, `Path` and `Session`: every body, on every edit, is not
  // theirs to download. A sync lists what it needs itself.
  const listed = (board: Board) =>
    fromGithub(c.provider.items(board, { bodies: false }))
  if (opts.end === true) {
    // A subagent's marks read `claude · <type> · <id>`: the session's end
    // clears every mark ending in its id, whatever agent type precedes it,
    // in every project (spec 0025 §3).
    const id = opts.session.split(' · ').pop() ?? opts.session
    for (const { board } of declared) {
      const ids = (await listed(board))
        .filter(
          (i) => i.session === opts.session || i.session?.endsWith(` · ${id}`)
        )
        .map((i) => i.id)
      await fromGithub(c.provider.mark(board, ids, null))
    }
    // The session's last sync waits its turn behind an edit's.
    await oneSyncAtATime(key, syncEvery, { ...lock, wait: true })
    return 0
  }
  // Only a path some declared project holds: Agent Pulse holds every other
  // collection's; without it, a document of an undeclared collection has no
  // board, and its edit costs no sync.
  const held = (path: string): boolean =>
    declared.some((d) => d.name === PULSE || path.startsWith(`${d.name}/`))
  const wanted = new Set(opts.paths.filter(held))
  // A document the agent has just written has no item until a sync gives it
  // one (plan 0027 Task 6, a fix to spec 0017 §5); one whose status the edit
  // changed shows the old one until a sync writes it (spec 0020 §2). Only a
  // document of `rness status` can need one: another file of `.rness/`, or
  // an edit that leaves the status alone, costs no sync.
  const documents = new Map(
    (await statusTabs(c.rnessDir)).flatMap((t) =>
      t.rows.map((r) => [r.path, r.status] as const)
    )
  )
  let items = new Map<string, BoardItem[]>()
  const listAll = async () => {
    items = new Map()
    for (const { name, board } of declared) items.set(name, await listed(board))
  }
  await listAll()
  const onBoard = new Map(
    [...items.values()]
      .flat()
      .flatMap((i) => (i.path === null ? [] : [[i.path, i.status] as const]))
  )
  const stale = (path: string): boolean =>
    documents.has(path) &&
    (!onBoard.has(path) || onBoard.get(path) !== documents.get(path))
  if ([...wanted].some(stale)) {
    // Another hook's sync running gives it its item; the next edit marks it.
    if (await oneSyncAtATime(key, syncEvery, lock)) await listAll()
  }
  for (const { name, board } of declared) {
    const ids = (items.get(name) ?? [])
      .filter((i) => i.path !== null && wanted.has(i.path))
      .map((i) => i.id)
    if (ids.length > 0)
      await fromGithub(c.provider.mark(board, ids, opts.session))
  }
  return 0
}
