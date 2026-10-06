import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { issueBody } from '../board/body.ts'
import { type StatusUpdate, readUpdates } from '../board/collection.ts'
import { oneSyncAtATime, recordFailure } from '../board/detached.ts'
import {
  type BoardCollection,
  type Desired,
  type Layout,
  collectionsOf,
  desiredOf,
  layoutOf,
  readsFrontMatter,
} from '../board/layout.ts'
import { onceSaid } from '../board/noted.ts'
import { openedFile, readOpened, writeOpened } from '../board/opened.ts'
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
} from '../board/plan.ts'
import {
  type BoardAction,
  type BoardDeclaration,
  HOOK_EVENTS,
  parseBoard,
  presetFor,
} from '../core/board-declaration.ts'
import {
  readmeDeclarations,
  withoutDeclarations,
} from '../core/board-migration.ts'
import { collectMarkdown } from '../core/collect.ts'
import { containedPath } from '../core/contained.ts'
import type { CommandDeps } from '../core/deps.ts'
import { stripFrontMatter } from '../core/frontmatter.ts'
import { writeFileAtomic } from '../core/fs.ts'
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
import { declaredBoard, presetSource } from '../core/preset-board.ts'
import { labelOf } from '../core/presets.ts'
import type { Board, MarkFields, Provider } from '../core/provider.ts'
import { PROVIDERS, openProvider } from '../core/providers.ts'
import { type StatusTab, documentsIn, statusTabs } from '../core/status.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { loginCommand } from './login.ts'

export interface BoardOptions {
  /** Create the boards not created yet without asking (spec 0033 §4). */
  yes?: boolean
  /** Internal: the creation already answered — `rness pulse create` was typed. */
  confirmed?: boolean
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
  /** Internal (tests): GitHub API base. */
  githubApi?: string
  /** Internal (tests): how a rate-limit wait sleeps; default a timer. */
  sleep?: (ms: number) => Promise<void>
}

const PROJECT_SCOPE = 'project'
const NEEDS_LOGIN = 'boards need a GitHub login: run rness login'
const NEEDS_SCOPE = 'boards need the project scope: run rness login'

/**
 * GitHub's own words, named as GitHub's unless they already say so. rness's
 * own errors (`the board has no field Agent`) keep their words.
 */
export async function fromGithub<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (e) {
    if (e instanceof GitHubMessageError && !/github/i.test(e.message))
      throw new Error(`GitHub: ${e.message}`, { cause: e })
    throw e
  }
}

export interface Context {
  root: string
  rnessDir: string
  manifest: Manifest
  org: string
  provider: Provider
}

const apiOf = (opts: BoardOptions): { apiBase?: string } =>
  opts.githubApi === undefined ? {} : { apiBase: opts.githubApi }

const providerOptions = (
  opts: BoardOptions,
  wait?: RateWait
): { apiBase?: string; wait?: RateWait } => ({
  ...apiOf(opts),
  ...(wait === undefined ? {} : { wait }),
})

/** The refusals every board command shares, in order; each throws one line. */
export async function context(
  opts: BoardOptions,
  wait?: RateWait
): Promise<Context> {
  const ws = await findWorkspace(opts.cwd ?? process.cwd())
  const manifest = await loadManifest(ws.rnessDir)
  const provider = await openProvider(manifest, providerOptions(opts, wait))
  if (manifest.org === null)
    throw new Error('boards need an organization: rness.json has no "org"')
  return {
    root: ws.root,
    rnessDir: ws.rnessDir,
    manifest,
    org: manifest.org,
    provider,
  }
}

/** Rate-limit waits said as they begin: a pause of minutes must not look like a hang (spec 0018 §4). */
const waitSaid = (opts: BoardOptions, ui: Ui): RateWait =>
  rateWait(async (ms) => {
    ui.line('waiting', `${Math.round(ms / 1000)} s — GitHub's rate limit`)
    await (opts.sleep ?? ((n: number) => delay(n)))(ms)
  })

/**
 * What the login lacks for boards — a login, or the project scope — or
 * null. Throws when GitHub cannot be asked: an offline machine or a rejected
 * token is never told that a scope is missing.
 */
async function missingAccess(provider: Provider): Promise<string | null> {
  if (!provider.authenticated) return NEEDS_LOGIN
  const scopes = await fromGithub(provider.scopes())
  return scopes?.includes(PROJECT_SCOPE) === true ? null : NEEDS_SCOPE
}

/** A board the provider has: its declaration names its project. */
export type Created = BoardDeclaration & { number: number }

const isCreated = (d: BoardDeclaration): d is Created => d.number !== null

/** A declared project, opened: its name in `boards`, its declaration, its board. */
export interface Declared {
  name: string
  declaration: Created
  board: Board
}

/** A board that takes every collection no other board holds: `"collections": "all"`. */
const takesAll = (d: { declaration: BoardDeclaration }): boolean =>
  d.declaration.collections === 'all'

/** The collections a board holds by name; none for one that takes all. */
const namedCollections = (d: BoardDeclaration): string[] =>
  d.collections === 'all' ? [] : Object.keys(d.collections)

/** A board of `boards` the provider does not have yet: `board push` creates it (spec 0033 §4). */
interface NotCreated {
  name: string
  entry: string | BoardDeclaration
  declaration: BoardDeclaration
}

/**
 * Every declared board, read whole (a number or a preset's name is its
 * preset): those the provider has — those that name their collections
 * first, in the order of `boards`, one that takes all last, so a document
 * moving leaves it only once its own board holds it (spec 0025 §3) — and
 * those it does not have yet. A board `rness.json` refuses is said and
 * skipped.
 */
async function declarations(
  c: Context,
  ui?: Ui
): Promise<{
  created: { name: string; declaration: Created }[]
  notCreated: NotCreated[]
}> {
  const boards = c.manifest.boards ?? {}
  for (const r of c.manifest.refused ?? [])
    ui?.line('skipped', `${r.name}: ${r.reason}`)
  const all: { name: string; declaration: Created }[] = []
  const notCreated: NotCreated[] = []
  for (const [name, entry] of Object.entries(boards)) {
    const declaration = await declaredBoard(name, entry, c.rnessDir)
    // A README that still declares what rness.json declares now (spec 0031
    // §6): this board waits until `rness sync` moves it.
    const still: string[] = []
    if (typeof entry === 'object')
      for (const collection of namedCollections(declaration)) {
        const keys = Object.keys(
          await readmeDeclarations(c.rnessDir, collection)
        )
        if (keys.length > 0)
          still.push(`${collection}/README.md declares ${keys.join(', ')}`)
      }
    if (still.length > 0) {
      ui?.line(
        'skipped',
        `${name}: ${still.join(', ')}, which rness.json declares now — rness sync moves it`
      )
      continue
    }
    if (isCreated(declaration)) all.push({ name, declaration })
    else if (typeof entry !== 'number')
      notCreated.push({ name, entry, declaration })
  }
  return {
    created: all.sort((a, b) => Number(takesAll(a)) - Number(takesAll(b))),
    notCreated,
  }
}

/** What `boards` holds, said when there is nothing to push. */
function noBoard(c: Context): Error {
  return new Error(
    c.manifest.refused === undefined
      ? 'no board declared — declare one in .rness/rness.json, as "boards": { "pulse": "agent-pulse" }, then rness board push'
      : `no board rness.json declares is valid: ${c.manifest.refused.map((r) => r.reason).join('; ')}`
  )
}

/**
 * Every declared board the provider has, opened; `push` and `run` need
 * one. A board not created yet is left out: `push` creates it first.
 */
export async function declaredBoards(c: Context, ui?: Ui): Promise<Declared[]> {
  if (c.manifest.boards === null) throw noBoard(c)
  const { created } = await declarations(c, ui)
  if (created.length === 0) return []
  const missing = await missingAccess(c.provider)
  if (missing !== null) throw new Error(missing)
  const declared: Declared[] = []
  for (const { name, declaration } of created) {
    const board = await fromGithub(c.provider.board(c.org, declaration.number))
    if (board === null)
      throw new Error(`GitHub has no project ${declaration.number} in ${c.org}`)
    declared.push({ name, declaration, board })
  }
  return declared
}

/** What one project holds and how it looks, from the files of `.rness/`. */
interface Scope {
  /** How a sync names the project: `Agent Pulse`, `Marketing`. */
  label: string
  want: Desired[]
  layout: Layout
  /** A path on the board that another board holds, or none does: taken off, its issue kept. */
  elsewhere: (path: string) => boolean
  /** The paths whose opened issues this project's syncs record (spec 0018 §2). */
  mine: (path: string) => boolean
  /** Its README and short description, when declared. */
  text: { readme: string | null; description: string | null } | null
  updates: StatusUpdate[]
  /** Said after its sync's count: one board that takes all is said bare, as before. */
  on: string | undefined
}

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

/** A file of `.rness/`, its front matter removed; null when it is not there; one leading out of `.rness`, refused. */
async function textOf(rnessDir: string, rel: string): Promise<string | null> {
  try {
    return stripFrontMatter(
      await readFile(await containedPath(rnessDir, rel), 'utf8')
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** A collection's README as written; null when it has none. */
async function readmeText(
  rnessDir: string,
  collection: string
): Promise<string | null> {
  try {
    return await readFile(
      await containedPath(rnessDir, `${collection}/README.md`),
      'utf8'
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** The collection of a path of `.rness/`: its first directory. */
const collectionOfPath = (path: string): string => path.split('/')[0] ?? ''

async function scopeOf(
  c: Context,
  name: string,
  declaration: BoardDeclaration,
  tabs: readonly StatusTab[],
  owners: readonly string[]
): Promise<Scope> {
  const collections: BoardCollection[] = collectionsOf(
    declaration,
    tabs,
    (dir) => owners.includes(dir)
  )
  const held = (path: string): boolean =>
    collections.some((col) => col.name === collectionOfPath(path))
  // One that takes all holds what no other board holds; one that names its
  // collections, those alone: a card of any other leaves it, its issue kept.
  const elsewhere =
    declaration.collections === 'all'
      ? (path: string) => owners.includes(collectionOfPath(path))
      : (path: string) =>
          !namedCollections(declaration).includes(collectionOfPath(path))
  const fronts = new Map<string, Record<string, unknown>>()
  const directories = new Map<string, string[]>()
  if (readsFrontMatter(declaration))
    for (const col of collections) {
      const dir = join(c.rnessDir, col.name)
      for (const item of await collectMarkdown(dir))
        fronts.set(`${col.name}/${item.rel}`, item.fields ?? {})
      directories.set(col.name, await directoriesOf(dir))
    }
  const want = desiredOf(declaration, collections, c.org, fronts, directories)
  const text =
    declaration.readme === null && declaration.description === null
      ? null
      : {
          readme:
            declaration.readme === null
              ? null
              : await textOf(c.rnessDir, declaration.readme),
          description: declaration.description,
        }
  return {
    label: declaration.title ?? labelOf(name),
    want,
    layout: layoutOf(declaration, collections, want),
    elsewhere,
    mine: (path) => held(path) || !elsewhere(path),
    text,
    updates:
      declaration.updates === null
        ? []
        : await readUpdates(c.rnessDir, declaration.updates),
    on:
      declaration.collections === 'all'
        ? undefined
        : (declaration.title ?? labelOf(name)),
  }
}

const plural = (n: number): string => `${n} item${n === 1 ? '' : 's'}`

/** What the layout gained, as `sync` says it: `added view Plans`, a line each. */
type SayLayout = (ui: Ui, added: readonly string[], project: string) => void
/** What a layout line says, by its first word: `renamed …`, `updated …`, `deleted …`, `note …`, else added. */
const VERBS = ['renamed', 'updated', 'deleted', 'note'] as const
const eachAdded: SayLayout = (ui, added) => {
  for (const a of added) {
    const verb = VERBS.find((v) => a.startsWith(`${v} `))
    if (verb === undefined) ui.line('added', a)
    else ui.line(verb, a.slice(verb.length + 1))
  }
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
    else if (a.startsWith('note ')) ui.line('note', a.slice('note '.length))
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
  // A note — a field or view no longer declared — is said once per clone.
  sayLayout(
    ui,
    await onceSaid(
      c.rnessDir,
      board.number,
      await fromGithub(c.provider.ensureLayout(board, scope.layout))
    ),
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
      `${e.message}: ${total - made} of ${total} changes not made — the next rness board push makes them`,
      { cause: e }
    )
  }
  sayDone(ui, c.org, want.length, steps, writes, adopted, scope.on)
  if (scope.text !== null)
    for (const what of await fromGithub(c.provider.describe(board, scope.text)))
      ui.line('wrote', `${what} of ${scope.label}`)
  for (const line of await fromGithub(
    c.provider.postUpdates(board, scope.updates)
  )) {
    const [verb, ...rest] = line.split(' ')
    ui.line(verb ?? 'posted', rest.join(' '))
  }
}

/**
 * Every declared project, in turn (spec 0025 §3); `sayLayout` says what a
 * project's layout gained, by the board's name in `boards`.
 */
async function syncAll(
  c: Context,
  declared: readonly Declared[],
  ui: Ui,
  sayLayout: (name: string) => SayLayout
): Promise<void> {
  const tabs = await statusTabs(c.rnessDir)
  for (const d of declared) {
    // The collections the other boards name: none of this board's.
    const owners = declared
      .filter((o) => o !== d)
      .flatMap((o) => namedCollections(o.declaration))
    await syncBoard(
      c,
      d.board,
      ui,
      sayLayout(d.name),
      await scopeOf(c, d.name, d.declaration, tabs, owners)
    )
  }
}

/**
 * Whether a board may be created under that name: `pulse`, or a collection
 * of `.rness/` — a directory whose documents carry a status (spec 0025 §3,
 * 0033 §4). Throws naming it, before the provider is asked anything.
 */
export async function checkBoardName(
  rnessDir: string,
  name: string
): Promise<void> {
  if (name === PULSE) return
  const tabs = await statusTabs(rnessDir)
  if (!tabs.some((t) => t.name === name))
    throw new Error(
      `"boards.${name}": ${name} is no collection of .rness: none of its documents carries a status`
    )
}

/** The title a board not created yet gets on the provider: as declared, else its preset's. */
const titleOf = (b: NotCreated): string =>
  b.declaration.title ?? labelOf(b.name)

/**
 * The boards not created yet, created (spec 0033 §4): asked once, unless
 * `--yes` or `rness pulse create` answered; the login and `.rness`'s Issues
 * checked; each project made, its number written into `rness.json` before
 * anything else can fail; a collection's README declarations moved. Says
 * which were made and which were left: off a terminal, or declined.
 */
async function createBoards(
  c: Context,
  boards: readonly NotCreated[],
  opts: BoardOptions,
  terminal: Terminal,
  ui: Ui,
  wait: RateWait
): Promise<{ c: Context; made: string[]; left: string[] }> {
  for (const b of boards) await checkBoardName(c.rnessDir, b.name)
  // A written provider was already refused by `context`; a detected one is
  // what this writes, so it is refused here, before GitHub is asked
  // anything (spec 0017 §2.2).
  const detected = providerOf(c.manifest)
  if (!PROVIDERS[detected].available)
    throw new Error(
      `boards need a GitHub organization, and this workspace's repositories look like ${detected} (detected): write "provider": "github" in rness.json if the organization is on GitHub`
    )
  const names = boards.map((b) => b.name)
  if (opts.confirmed !== true && opts.yes !== true) {
    if (!terminal.isTty()) return { c, made: [], left: names }
    const p = await terminal.prompts()
    const ok = await p.confirm({
      message: `Create ${boards.map((b) => `${titleOf(b)} (${b.name})`).join(', ')} on GitHub, in ${c.org}?`,
    })
    if (p.isCancel(ok) || ok !== true) return { c, made: [], left: names }
  }
  const missing = await missingAccess(c.provider)
  if (missing !== null) {
    if (opts.yes === true || !terminal.isTty()) throw new Error(missing)
    const p = await terminal.prompts()
    const ok = await p.confirm({
      message:
        missing === NEEDS_LOGIN
          ? 'Boards need a GitHub login with the project scope. Log in now?'
          : 'Boards need the project scope of your GitHub login. Log in again to grant it?',
    })
    if (p.isCancel(ok) || ok !== true) throw new Error(missing)
    const code = await loginCommand(
      {
        project: true,
        // The git question is `rness login`'s own, not the board's to ask.
        setupGit: false,
        ...(opts.githubApi === undefined ? {} : { githubApi: opts.githubApi }),
      },
      { terminal, ui, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) }
    )
    if (code !== 0) throw new Error(missing)
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
  const made: string[] = []
  for (const b of boards) {
    // A preset's name is written whole from that preset (spec 0031 §3, plan
    // 0045), what a collection's README declared in it (spec 0031 §6); a
    // declaration, as the team wrote it.
    const source =
      typeof b.entry === 'string'
        ? await presetSource(b.name, c.rnessDir, null, b.entry)
        : b.declaration.source
    const readme =
      typeof b.entry === 'string' && b.name !== PULSE
        ? await readmeText(c.rnessDir, b.name)
        : null
    const title = titleOf(b)
    const board = await fromGithub(c.provider.createBoard(c.org, title))
    // Declared as soon as the project exists, before its layout: whatever
    // fails after this leaves a declared project that the next push
    // completes, not one nobody knows about (spec 0017 §3).
    const manifest: Manifest = {
      ...c.manifest,
      provider: detected,
      boards: {
        ...c.manifest.boards,
        [b.name]: parseBoard(b.name, { number: board.number, ...source }),
      },
    }
    await writeManifest(c.rnessDir, manifest)
    if (readme !== null) {
      const cleaned = withoutDeclarations(readme)
      if (cleaned !== readme)
        await writeFileAtomic(join(c.rnessDir, b.name, 'README.md'), cleaned)
    }
    c = { ...c, manifest }
    made.push(b.name)
    ui.line('created', `${title} — ${board.url}`)
  }
  return { c, made, left: [] }
}

/**
 * `rness board push`: every board follows the documents of `.rness/`; one
 * not created yet is created first (spec 0033 §4).
 */
export async function boardPushCommand(
  opts: BoardOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  try {
    const terminal = deps.terminal ?? defaultTerminal
    const ui = deps.ui ?? (await makeUi(terminal))
    const wait = waitSaid(opts, ui)
    let c = await context(opts, wait)
    if (c.manifest.boards === null) throw noBoard(c)
    const { notCreated } = await declarations(c, ui)
    let made: string[] = []
    let left: string[] = []
    if (notCreated.length > 0)
      ({ c, made, left } = await createBoards(
        c,
        notCreated,
        opts,
        terminal,
        ui,
        wait
      ))
    try {
      // The lines of `declarations` were said above: not twice.
      const declared = await declaredBoards(c)
      await syncAll(c, declared, ui, (n) =>
        made.includes(n) ? createdByKind : eachAdded
      )
    } finally {
      if (made.length > 0)
        ui.line(
          'declared',
          `${made.join(', ')} in .rness/rness.json — commit it: git -C .rness commit -am "chore: board ${made.join(', ')}"`
        )
    }
    if (left.length > 0)
      throw new Error(
        `not created: ${left.join(', ')} — rness board push in a terminal, or with --yes, creates ${left.length === 1 ? 'it' : 'them'}`
      )
    return 0
  } catch (e) {
    return reportError(e)
  }
}

/** The fields a board's marks write: its select from `$agent`, its text from `$session`. */
function markFields(d: BoardDeclaration): MarkFields | null {
  const fields = Object.entries(d.fields)
  const agent = fields.find(
    ([, f]) => f.type === 'select' && f.from.includes('$agent')
  )?.[0]
  if (agent === undefined) return null
  return {
    agent,
    session: fields.find(([, f]) => f.from.includes('$session'))?.[0] ?? null,
  }
}

/** Whether a board holds a path's collection: one that takes all holds any. */
export const holds = (d: Declared, path: string): boolean =>
  takesAll(d) ||
  namedCollections(d.declaration).includes(collectionOfPath(path))

/** The lock every write of these boards takes: one run at a time per workspace. */
const lockKey = (c: Context, declared: readonly Declared[]): string =>
  `${c.org}-${declared.map((d) => d.board.number).join('-')}`

/**
 * Marks, on each board, the items of the paths `wanted` gives it, for
 * `session`. A document with no item yet, or whose status the board does
 * not show yet, is synced first (plan 0027 Task 6, spec 0020 §2).
 * `failed(d, e)` hears a board's own failure; one of all of them throws.
 */
async function markOn(
  c: Context,
  declared: readonly Declared[],
  wanted: ReadonlyMap<Declared, ReadonlySet<string>>,
  session: string,
  lock: { sleep?: (ms: number) => Promise<void> },
  failed: (d: Declared, e: unknown) => void = (_d, e) => {
    throw e
  }
): Promise<void> {
  const key = lockKey(c, declared)
  const syncEvery = () => syncAll(c, declared, plainUi, () => eachAdded)
  // Marks need ids, `Path` and the session: every body, on every edit, is not
  // theirs to download. A sync lists what it needs itself.
  const listed = (board: Board) =>
    fromGithub(c.provider.items(board, { bodies: false }))
  const documents = new Map(
    (await statusTabs(c.rnessDir)).flatMap((t) =>
      t.rows.map((r) => [r.path, r.status] as const)
    )
  )
  let items = new Map<Declared, BoardItem[]>()
  const listAll = async () => {
    items = new Map()
    for (const d of declared) items.set(d, await listed(d.board))
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
  const all = new Set([...wanted.values()].flatMap((w) => [...w]))
  if ([...all].some(stale)) {
    // Another hook's sync running gives it its item; the next edit marks it.
    if (await oneSyncAtATime(key, syncEvery, lock)) await listAll()
  }
  for (const d of declared) {
    const paths = wanted.get(d)
    if (paths === undefined) continue
    try {
      const ids = (items.get(d) ?? [])
        .filter((i) => i.path !== null && paths.has(i.path))
        .map((i) => i.id)
      if (ids.length > 0)
        await fromGithub(
          c.provider.mark(
            d.board,
            ids,
            session,
            markFields(d.declaration) ?? undefined
          )
        )
    } catch (e) {
      failed(d, e)
    }
  }
}

/**
 * Clears `session`'s marks on a board — a subagent's too, whose session
 * reads `claude · <type> · <id>` (spec 0025 §3). A board without a field
 * from `$session` cannot tell sessions apart: every mark of it goes.
 */
async function clearOn(
  c: Context,
  d: Declared,
  session: string
): Promise<void> {
  const fields = markFields(d.declaration) ?? {
    agent: 'Agent',
    session: 'Working session',
  }
  const id = session.split(' · ').pop() ?? session
  const ids = (await fromGithub(c.provider.items(d.board, { bodies: false })))
    .filter((i) => {
      const of =
        fields.session === null
          ? null
          : (i.values[fields.session] ??
            (fields.session === 'Working session' ? i.session : null))
      return fields.session === null
        ? i.values[fields.agent] !== undefined
        : of === session || of?.endsWith(` · ${id}`) === true
    })
    .map((i) => i.id)
  await fromGithub(c.provider.mark(d.board, ids, null, fields))
}

export interface RunOptions {
  cwd?: string
  githubApi?: string
  /** `session-start`, `edit` or `session-end` (spec 0032 §2). */
  event: string
  session: string
  /** `edit`: the document edited. */
  paths: string[]
  /** `session-start`, `session-end`: the session's scope; absent, the workspace's root. */
  scope?: string
  /** `session-end`: the clone the session worked in, a name of `repos`. */
  clone?: string
  /** Internal (tests): how the lock's poll sleeps. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Hidden, for the hooks (spec 0032 §4): the actions each board declares at
 * `event`, in the order of `boards`, under one lock per workspace. It
 * never prompts; a failure is recorded, naming each board and action that
 * failed, for the next session start to say. The exit is 0.
 */
export async function boardRunCommand(opts: RunOptions): Promise<number> {
  const failures: string[] = []
  try {
    await run(opts, failures)
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e))
  }
  if (failures.length > 0) await recordFailure(failures.join('; '))
  return 0
}

async function run(opts: RunOptions, failures: string[]): Promise<void> {
  const event = HOOK_EVENTS.find((e) => e === opts.event)
  if (event === undefined) throw new Error(`no such event: ${opts.event}`)
  const c = await context(opts)
  const declared = await declaredBoards(c)
  const lock = opts.sleep === undefined ? {} : { sleep: opts.sleep }
  const label = (d: Declared): string => d.declaration.title ?? labelOf(d.name)
  const acting = (name: BoardAction['action']) =>
    declared.filter((d) =>
      (d.declaration.hooks[event] ?? []).some((a) => a.action === name)
    )
  if (event === 'session-end') {
    for (const d of acting('journal-summary'))
      try {
        const { postSummary } = await import('../board/summary.ts')
        await postSummary({
          c,
          board: d,
          session: opts.session,
          scope: opts.scope ?? null,
          ...(opts.clone === undefined ? {} : { clone: opts.clone }),
        })
      } catch (e) {
        failures.push(
          `journal-summary on ${label(d)} failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    const clearing = acting('clear-marks')
    for (const d of clearing)
      try {
        await clearOn(c, d, opts.session)
      } catch (e) {
        failures.push(
          `clear-marks on ${label(d)} failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    if (clearing.length === 0) return
    // The session's last sync waits its turn behind an edit's.
    await oneSyncAtATime(
      lockKey(c, declared),
      () => syncAll(c, declared, plainUi, () => eachAdded),
      { ...lock, wait: true }
    )
    return
  }
  const wanted = new Map<Declared, Set<string>>()
  const action = event === 'edit' ? 'mark' : 'mark-in-progress'
  for (const d of acting(action)) {
    let paths = opts.paths
    if (event === 'session-start') {
      const a = (d.declaration.hooks['session-start'] ?? []).find(
        (x) => x.action === 'mark-in-progress'
      )
      paths =
        a?.action === 'mark-in-progress'
          ? await documentsIn(
              { root: c.root, rnessDir: c.rnessDir },
              c.manifest,
              opts.scope ?? null,
              a.collections,
              a.statuses
            )
          : []
    }
    const held = paths.filter((p) => holds(d, p))
    if (held.length > 0) wanted.set(d, new Set(held))
  }
  if (wanted.size === 0) return
  await markOn(c, declared, wanted, opts.session, lock, (d, e) =>
    failures.push(
      `${action} on ${label(d)} failed: ${e instanceof Error ? e.message : String(e)}`
    )
  )
}

/**
 * `rness pulse create [collection]`, a former command (spec 0033 §2): the
 * board declared by its preset's name when `boards` does not name it yet,
 * then pushed, its creation answered by the command typed.
 */
export async function pulseCreateCommand(
  collection: string | undefined,
  opts: BoardOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  try {
    const name = collection ?? PULSE
    const ws = await findWorkspace(opts.cwd ?? process.cwd())
    const manifest = await loadManifest(ws.rnessDir)
    if (manifest.org === null)
      throw new Error('boards need an organization: rness.json has no "org"')
    const refused = manifest.refused?.find((r) => r.name === name)
    if (refused !== undefined)
      throw new Error(`already declared, and refused: ${refused.reason}`)
    let said = 'rness pulse create is now rness board push'
    if (manifest.boards?.[name] === undefined) {
      await checkBoardName(ws.rnessDir, name)
      const preset = presetFor(name)
      await writeManifest(ws.rnessDir, {
        ...manifest,
        boards: { ...manifest.boards, [name]: preset },
      })
      said = `boards are declared in rness.json now: added "${name}": "${preset}", then rness board push`
    }
    process.stderr.write(`${said}\n`)
    return await boardPushCommand({ ...opts, confirmed: true }, deps)
  } catch (e) {
    return reportError(e)
  }
}
