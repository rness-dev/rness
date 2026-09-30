import type { Desired } from '../pulse/layout.ts'
import {
  type Layout,
  type OptionColor,
  optionColor,
  statusFieldName,
} from '../pulse/layout.ts'
import type { BoardItem, Placed, Step } from '../pulse/plan.ts'
import * as gi from './github-issues.ts'
import * as gh from './github-projects.ts'
import type { ApiOptions } from './github.ts'
import type { Board, Provider } from './provider.ts'

/** The pulse's board on a GitHub project (spec 0017 §3–§4). */

export const PROJECT_TITLE = 'Agent Pulse'
const WORKING = 'working'
const WORKING_VIEW = 'Working'
/** The repository whose issues are the board's items (spec 0018 §2). */
const MEMORY = '.rness'
/** The label every one of them carries: `-label:rness` leaves them out of the Issues tab. */
export const LABEL = 'rness'
const LABEL_COLOR = '5319e7'
const LABEL_DESCRIPTION = 'A document of .rness, on Agent Pulse'
/** GitHub's label names ignore case: `Rness` is the label `rness`. */
const labelled = (labels: readonly string[]): boolean =>
  labels.some((l) => l.toLowerCase() === LABEL.toLowerCase())

/**
 * SPIKE-DEPENDENT CHOICES (not yet verified live): the names of the two
 * fields rness's board is grouped and filtered by, and `viewFilter` below.
 * Every use goes through these constants, so a fallback (`rness status`
 * instead of Status) is a change to `STATUS_FIELD`, `statusField` and
 * `viewFilter` only. The collection field is `Collection`, not `Type`:
 * `type:` is GitHub's own filter qualifier for issue types, and an
 * organization using issue types has a built-in `Type` field (spec 0017 §3).
 */
export const STATUS_FIELD = 'Status'
/** What rness calls the first view GitHub gives a new project. */
const ALL_VIEW = 'All'
const DEFAULT_VIEW = 'View 1'
export const COLLECTION_FIELD = 'Collection'

/** GitHub's built-in title field, which `fields()` returns like the others. */
function titleField(fields: readonly gh.Field[]): gh.Field {
  const field = fields.find((f) => f.name === 'Title')
  if (field === undefined)
    throw new Error('the GitHub project has no Title field')
  return field
}

/**
 * SPIKE-DEPENDENT CHOICE 1 of 2: the board's Status
 * is the built-in single-select field every project has. If the API refuses
 * to edit its options, the fallback is a created field `rness status` — change
 * this one function.
 */
export function statusField(fields: readonly gh.Field[]): gh.Field {
  const field = fields.find((f) => f.name === STATUS_FIELD)
  if (field === undefined || field.options === null)
    throw new Error(
      `the GitHub project has no single-select field ${STATUS_FIELD}`
    )
  return field
}

/**
 * SPIKE-DEPENDENT CHOICE 2 of 2 (not yet verified live): the filter string of
 * a board view of one collection, and of the Working table. If GitHub's
 * filter syntax differs from `field:"value"`, change these two lines.
 */
export const viewFilter = (collection: string): string =>
  `${COLLECTION_FIELD.toLowerCase()}:"${collection}"`
export const WORKING_FILTER = 'agent:working'

interface Cache {
  projectId: string
  fields?: gh.Field[]
  /** The items as last read: the values `apply` compares against. */
  known: Map<string, gh.RawItem>
  /**
   * Made by this process and not laid out yet: its Status still carries
   * GitHub's default options, which the first `ensureLayout` replaces.
   */
  fresh?: boolean
}

/** The single-select fields rness colours. */
type OptionKind = 'Status' | 'Collection' | 'Agent'

const namesOf = (field: gh.Field): string[] =>
  (field.options ?? []).map((o) => o.name)

/** `wanted` first, in its order, then the rest as they were. */
const orderedFirst = (
  wanted: readonly string[],
  all: readonly string[]
): string[] => {
  const first = wanted.filter((n) => all.includes(n))
  return [...first, ...all.filter((n) => !first.includes(n))]
}

/** The adapter's board methods, for one process: project ids and fields are cached per board. */
export class GitHubBoards implements Pick<
  Provider,
  | 'checkIssues'
  | 'createBoard'
  | 'board'
  | 'ensureLayout'
  | 'items'
  | 'apply'
  | 'mark'
> {
  readonly #o: ApiOptions
  readonly #cache = new Map<string, Cache>()
  /** Each organization's `.rness`, as first read: its id, its Issues, its label. */
  readonly #memories = new Map<string, gi.Repository>()

  constructor(options: ApiOptions) {
    this.#o = options
  }

  #key = (b: { org: string; number: number }): string => `${b.org}/${b.number}`

  async #cacheOf(board: Board): Promise<Cache> {
    const cached = this.#cache.get(this.#key(board))
    if (cached !== undefined) return cached
    const project = await gh.findProject(board.org, board.number, this.#o)
    if (project === null)
      throw new Error(`GitHub has no project ${board.number} in ${board.org}`)
    return this.#remember(board, project.id)
  }

  #remember(board: Board, projectId: string): Cache {
    const cache: Cache = { projectId, known: new Map() }
    this.#cache.set(this.#key(board), cache)
    return cache
  }

  async #fields(board: Board): Promise<gh.Field[]> {
    const cache = await this.#cacheOf(board)
    cache.fields ??= await gh.fields(cache.projectId, this.#o)
    return cache.fields
  }

  async #memory(org: string): Promise<gi.Repository> {
    const known = this.#memories.get(org)
    if (known !== undefined) return known
    const found = await gi.repository(org, MEMORY, LABEL, this.#o)
    if (found === null)
      throw new Error(
        `the pulse needs ${org}/${MEMORY} on GitHub: it is not there, or this login cannot see it`
      )
    this.#memories.set(org, found)
    return found
  }

  async checkIssues(org: string): Promise<void> {
    if (!(await this.#memory(org)).issues)
      throw new Error(
        `the pulse needs Issues on ${org}/${MEMORY}: turn them on in its Settings`
      )
  }

  /** The project only: the caller declares it before `ensureLayout` builds it. */
  async createBoard(org: string): Promise<Board> {
    const project = await gh.createProject(
      await gh.orgId(org, this.#o),
      PROJECT_TITLE,
      this.#o
    )
    const board = { org, number: project.number, url: project.url }
    this.#remember(board, project.id).fresh = true
    return board
  }

  async board(org: string, number: number): Promise<Board | null> {
    const project = await gh.findProject(org, number, this.#o)
    if (project === null) return null
    const board = { org, number, url: project.url }
    this.#remember(board, project.id)
    return board
  }

  async ensureLayout(board: Board, layout: Layout): Promise<string[]> {
    const cache = await this.#cacheOf(board)
    const fields = await gh.fields(cache.projectId, this.#o)
    const added: string[] = []

    const enumOf = (c: OptionColor): string => c.toUpperCase()
    const inputs = (
      existing: gh.Field['options'],
      kind: OptionKind,
      wanted: readonly string[],
      names: readonly string[]
    ): gh.OptionInput[] =>
      names.map((name) => ({
        name,
        // An option rness does not know keeps the colour it has.
        color: wanted.includes(name)
          ? enumOf(optionColor(kind, name))
          : (existing?.find((o) => o.name === name)?.color ?? 'GRAY'),
      }))
    const withOptions = async (
      field: gh.Field,
      kind: OptionKind,
      wanted: readonly string[],
      reorder = false
    ): Promise<gh.Field> => {
      const now = namesOf(field)
      const missing = wanted.filter((n) => !now.includes(n))
      // Existing options stay: a hand-made one is not rness's to remove.
      const grown = [...now, ...missing]
      const next = reorder ? orderedFirst(wanted, grown) : grown
      const ordered = !next.every((n, i) => n === now[i])
      const recoloured = (field.options ?? []).some(
        (o) =>
          wanted.includes(o.name) &&
          o.color !== undefined &&
          o.color !== enumOf(optionColor(kind, o.name))
      )
      if (!ordered && !recoloured) return field
      added.push(...missing.map((n) => `option ${n}`))
      if (missing.length === 0 && ordered) added.push('ordered options')
      if (recoloured && !added.includes('coloured options'))
        added.push('coloured options')
      // setOptions resends the ids of the kept options: items keep their value.
      return gh.setOptions(
        field,
        inputs(field.options, kind, wanted, next),
        this.#o
      )
    }
    const single = async (
      name: string,
      kind: OptionKind,
      wanted: readonly string[],
      reorder = false
    ): Promise<gh.Field> => {
      const field = fields.find((f) => f.name === name)
      if (field !== undefined) return withOptions(field, kind, wanted, reorder)
      added.push(`field ${name}`)
      return gh.createField(
        cache.projectId,
        name,
        { options: inputs(null, kind, wanted, wanted) },
        this.#o
      )
    }
    const text = async (name: string): Promise<gh.Field> => {
      const field = fields.find((f) => f.name === name)
      if (field !== undefined) return field
      added.push(`field ${name}`)
      return gh.createField(cache.projectId, name, 'TEXT', this.#o)
    }

    // A new project's Status carries GitHub's default options: replaced, not
    // extended, once. After that, options are only ever added.
    const fresh = cache.fresh === true && layout.statuses.length > 0
    cache.fresh = false
    if (fresh) added.push(...layout.statuses.map((n) => `option ${n}`))
    const status = fresh
      ? await gh.setOptions(
          statusField(fields),
          inputs(null, 'Status', layout.statuses, layout.statuses),
          this.#o
        )
      : await withOptions(statusField(fields), 'Status', layout.statuses, true)
    const collection = await single(
      COLLECTION_FIELD,
      'Collection',
      layout.types
    )
    // One status field per collection: its board shows its own steps only.
    const own = new Map<string, gh.Field>()
    for (const f of layout.fields)
      own.set(f.name, await single(f.name, 'Status', f.statuses, true))
    const agent = await single('Agent', 'Agent', [WORKING])
    const session = await text('Session')
    const path = await text('Path')

    const current = await gh.views(cache.projectId, this.#o)
    // GitHub's first view (`View 1`) becomes `All`; any other first view is
    // the team's, and so is an `All` that exists.
    const first = current[0]
    if (
      first !== undefined &&
      first.name === DEFAULT_VIEW &&
      !current.some((v) => v.name === ALL_VIEW)
    ) {
      added.push(`view ${ALL_VIEW}`)
      await gh.renameView(
        first.id,
        ALL_VIEW,
        [titleField(fields), collection, status, session].map((f) => f.id),
        this.#o
      )
    }

    for (const view of layout.views) {
      const column = view.field === null ? status : own.get(view.field)!
      const there = current.find((v) => v.name === view.name)
      if (there !== undefined) {
        if (
          there.layout === 'BOARD_LAYOUT' &&
          there.columnField === column.name
        )
          continue
        // GitHub cannot change what a board's columns follow: the board is made again.
        await gh.deleteView(there.id, this.#o)
        added.push(`view ${view.name} remade — columns ${column.name}`)
      } else added.push(`view ${view.name}`)
      await gh.createView(
        board.org,
        board.number,
        {
          name: view.name,
          layout: 'board',
          filter: viewFilter(view.type),
          groupBy: column.databaseId,
        },
        this.#o
      )
    }
    if (!current.some((v) => v.name === WORKING_VIEW)) {
      added.push(`view ${WORKING_VIEW}`)
      await gh.createView(
        board.org,
        board.number,
        {
          name: WORKING_VIEW,
          layout: 'table',
          filter: WORKING_FILTER,
          // Who works is the point of the table: title, then what and who.
          visibleFields: [
            titleField(fields).databaseId,
            collection.databaseId,
            status.databaseId,
            session.databaseId,
          ],
        },
        this.#o
      )
    }
    // The items' repository (spec 0018 §2): its label, and the board linked
    // to it — read first, so an unchanged board costs no write.
    const memory = await this.#memory(board.org)
    if (memory.labelId === null) {
      memory.labelId = await gi.createLabel(
        board.org,
        MEMORY,
        { name: LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
        this.#o
      )
      added.push(`label ${LABEL}`)
    }
    const repository = `${board.org}/${MEMORY}`
    const linked = await gh.linkedRepositories(cache.projectId, this.#o)
    if (!linked.some((r) => r.toLowerCase() === repository.toLowerCase())) {
      await gh.linkRepository(cache.projectId, memory.id, this.#o)
      added.push(`link ${repository}`)
    }
    cache.fields = [status, collection, ...own.values(), agent, session, path]
    return added
  }

  async items(
    board: Board,
    options: { bodies?: boolean } = {}
  ): Promise<BoardItem[]> {
    const cache = await this.#cacheOf(board)
    const raw = await gh.listItems(cache.projectId, this.#o, options)
    cache.known = new Map(raw.map((r) => [r.id, r]))
    const memory = `${board.org}/${MEMORY}`.toLowerCase()
    return raw
      .filter((r) => !r.archived)
      .map((r) => {
        const issue =
          r.issue !== null && r.issue.repository.toLowerCase() === memory
            ? r.issue
            : null
        // rness's: a draft of 0.12.0 or an issue of .rness, with Path. Any
        // other item is the team's (spec 0018 §2).
        const ours = r.draftId !== null || issue !== null
        return {
          id: r.id,
          path: ours ? (r.values['Path'] ?? null) : null,
          issue:
            issue === null
              ? null
              : {
                  number: issue.number,
                  open: issue.open,
                  labelled: labelled(issue.labels),
                  body: issue.body,
                },
          title: r.title,
          status: r.values[STATUS_FIELD] ?? null,
          collectionStatus:
            r.values[statusFieldName(r.values[COLLECTION_FIELD] ?? '')] ?? null,
          type: r.values[COLLECTION_FIELD] ?? null,
          agent: r.values['Agent'] ?? null,
          session: r.values['Session'] ?? null,
        }
      })
  }

  async #set(
    board: Board,
    itemId: string,
    name: string,
    value: string | null
  ): Promise<void> {
    const cache = await this.#cacheOf(board)
    const field = (await this.#fields(board)).find((f) => f.name === name)
    if (field === undefined) throw new Error(`the board has no field ${name}`)
    let sent: { text: string } | { optionId: string } | null = null
    if (value !== null && field.options === null) sent = { text: value }
    else if (value !== null) {
      const option = field.options?.find((opt) => opt.name === value)
      if (option === undefined)
        throw new Error(`the field ${name} has no option ${value}`)
      sent = { optionId: option.id }
    }
    await gh.setValue(cache.projectId, itemId, field.id, sent, this.#o)
    const known = cache.known.get(itemId)
    if (known === undefined) return
    if (value === null) delete known.values[name]
    else known.values[name] = value
  }

  async apply(board: Board, step: Step): Promise<Placed | null> {
    if (step.kind === 'unchanged') return null
    const cache = await this.#cacheOf(board)
    if (step.kind === 'create') return this.#create(board, cache, step.want)
    const known = await this.#known(board, step.id)
    if (step.kind === 'archive' || step.kind === 'close') {
      // A document gone: its issue closed as not planned (spec 0018 §2).
      if (step.kind === 'close' && known.issue?.open === true)
        await gi.closeIssue(known.issue.id, this.#o)
      await gh.archive(cache.projectId, step.id, this.#o)
      cache.known.delete(step.id)
      return null
    }
    if (step.kind === 'body') {
      const issue = this.#issueOf(known)
      await gi.updateIssue(issue.id, { body: step.body }, this.#o)
      issue.body = step.body
      return null
    }
    const labelId = await this.#labelId(board)
    if (step.kind === 'convert') {
      const made = await gh.convertDraft(
        step.id,
        (await this.#memory(board.org)).id,
        this.#o
      )
      known.draftId = null
      known.issue = {
        ...made,
        open: true,
        repository: `${board.org}/${MEMORY}`,
        body: '',
        labels: [],
      }
      await this.#issue(known, step.want, labelId)
      await this.#values(board, step.id, step.want)
      return { id: step.id, number: made.number }
    }
    const issue = this.#issueOf(known)
    if (step.reopen) {
      await gi.reopenIssue(issue.id, this.#o)
      issue.open = true
    }
    await this.#issue(known, step.want, labelId)
    await this.#values(board, step.id, step.want)
    return null
  }

  /** A new document's issue: labelled, the first line as body, added to the board, Path first. */
  async #create(board: Board, cache: Cache, want: Desired): Promise<Placed> {
    const memory = await this.#memory(board.org)
    const labelId = await this.#labelId(board)
    const made = await gi.createIssue(
      memory.id,
      { title: want.title, body: want.body, labelIds: [labelId] },
      this.#o
    )
    const id = await gh.addItem(cache.projectId, made.id, this.#o)
    cache.known.set(id, {
      id,
      draftId: null,
      issue: {
        ...made,
        open: true,
        repository: `${board.org}/${MEMORY}`,
        body: want.body,
        labels: [LABEL],
      },
      title: want.title,
      archived: false,
      values: {},
    })
    await this.#values(board, id, want)
    return { id, number: made.number }
  }

  /** The label and the title an issue of the board carries. */
  async #issue(
    known: gh.RawItem,
    want: Desired,
    labelId: string
  ): Promise<void> {
    const issue = this.#issueOf(known)
    if (!labelled(issue.labels)) {
      await gi.addLabels(issue.id, [labelId], this.#o)
      issue.labels.push(LABEL)
    }
    if (known.title !== want.title) {
      await gi.updateIssue(issue.id, { title: want.title }, this.#o)
      known.title = want.title
    }
  }

  /** Path first — an issue on the board without it is the team's — then the fields, each only when it differs. */
  async #values(board: Board, id: string, want: Desired): Promise<void> {
    const values = (await this.#known(board, id)).values
    const wanted: [string, string | null][] = [
      ['Path', want.path],
      [COLLECTION_FIELD, want.type],
      [STATUS_FIELD, want.status],
      ...(want.statusField === null
        ? []
        : ([[want.statusField, want.status]] as [string, string | null][])),
    ]
    for (const [name, value] of wanted)
      if ((values[name] ?? null) !== value)
        await this.#set(board, id, name, value)
  }

  async #known(board: Board, id: string): Promise<gh.RawItem> {
    const cache = await this.#cacheOf(board)
    if (!cache.known.has(id)) await this.items(board)
    const known = cache.known.get(id)
    if (known === undefined) throw new Error(`the board has no item ${id}`)
    return known
  }

  #issueOf(known: gh.RawItem): gh.RawIssue {
    if (known.issue === null)
      throw new Error(`the board's item ${known.id} is no issue`)
    return known.issue
  }

  async #labelId(board: Board): Promise<string> {
    const id = (await this.#memory(board.org)).labelId
    if (id === null)
      throw new Error(
        `${board.org}/${MEMORY} has no label ${LABEL}: run rness pulse sync`
      )
    return id
  }

  async mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null
  ): Promise<void> {
    for (const id of itemIds) {
      await this.#set(board, id, 'Agent', session === null ? null : WORKING)
      await this.#set(board, id, 'Session', session)
    }
  }
}
