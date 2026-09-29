import type { Layout } from '../pulse/layout.ts'
import type { BoardItem, Step } from '../pulse/plan.ts'
import * as gh from './github-projects.ts'
import type { ApiOptions } from './github.ts'
import type { Board, Provider } from './provider.ts'

/** The pulse's board on a GitHub project (spec 0017 §3–§4). */

export const PROJECT_TITLE = 'Agent Pulse'
const WORKING = 'working'
const WORKING_VIEW = 'Working'

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
  'createBoard' | 'board' | 'ensureLayout' | 'items' | 'apply' | 'mark'
> {
  readonly #o: ApiOptions
  readonly #cache = new Map<string, Cache>()

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

    const withOptions = async (
      field: gh.Field,
      wanted: readonly string[],
      reorder = false
    ): Promise<gh.Field> => {
      const have = new Set(namesOf(field))
      const missing = wanted.filter((n) => !have.has(n))
      const now = namesOf(field)
      // Existing options stay: a hand-made one is not rness's to remove.
      const grown = [...now, ...missing]
      const next = reorder ? orderedFirst(wanted, grown) : grown
      if (next.every((n, i) => n === now[i])) return field
      added.push(...missing.map((n) => `option ${n}`))
      if (missing.length === 0) added.push('ordered options')
      // setOptions resends the ids of the kept options: items keep their value.
      return gh.setOptions(field, next, this.#o)
    }
    const single = async (
      name: string,
      wanted: readonly string[]
    ): Promise<gh.Field> => {
      const field = fields.find((f) => f.name === name)
      if (field !== undefined) return withOptions(field, wanted)
      added.push(`field ${name}`)
      return gh.createField(
        cache.projectId,
        name,
        { options: [...wanted] },
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
      ? await gh.setOptions(statusField(fields), layout.statuses, this.#o)
      : await withOptions(statusField(fields), layout.statuses, true)
    const collection = await single(COLLECTION_FIELD, layout.types)
    const agent = await single('Agent', [WORKING])
    const session = await text('Session')
    const path = await text('Path')

    const existing = new Set(await gh.views(board.org, board.number, this.#o))
    for (const view of layout.views)
      if (!existing.has(view.name)) {
        added.push(`view ${view.name}`)
        await gh.createView(
          board.org,
          board.number,
          {
            name: view.name,
            layout: 'board',
            filter: viewFilter(view.type),
            groupBy: status.databaseId,
          },
          this.#o
        )
      }
    if (!existing.has(WORKING_VIEW)) {
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
    cache.fields = [status, collection, agent, session, path]
    return added
  }

  async items(board: Board): Promise<BoardItem[]> {
    const cache = await this.#cacheOf(board)
    const raw = await gh.listItems(cache.projectId, this.#o)
    cache.known = new Map(raw.map((r) => [r.id, r]))
    return raw
      .filter((r) => !r.archived)
      .map((r) => ({
        id: r.id,
        // No longer a draft issue (converted by hand): the team's, like an
        // item without Path — the plan leaves it alone (spec 0017 §4).
        path: r.draftId === null ? null : (r.values['Path'] ?? null),
        title: r.title,
        status: r.values[STATUS_FIELD] ?? null,
        type: r.values[COLLECTION_FIELD] ?? null,
        agent: r.values['Agent'] ?? null,
        session: r.values['Session'] ?? null,
      }))
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
    if (value === null) {
      await gh.setValue(cache.projectId, itemId, field.id, null, this.#o)
      return
    }
    if (field.options === null) {
      await gh.setValue(
        cache.projectId,
        itemId,
        field.id,
        { text: value },
        this.#o
      )
      return
    }
    const option = field.options.find((opt) => opt.name === value)
    if (option === undefined)
      throw new Error(`the field ${name} has no option ${value}`)
    await gh.setValue(
      cache.projectId,
      itemId,
      field.id,
      { optionId: option.id },
      this.#o
    )
  }

  async apply(board: Board, step: Step): Promise<void> {
    if (step.kind === 'unchanged') return
    const cache = await this.#cacheOf(board)
    if (step.kind === 'archive') {
      await gh.archive(cache.projectId, step.id, this.#o)
      cache.known.delete(step.id)
      return
    }
    const { want } = step
    const values: [string, string | null][] = [
      ['Path', want.path],
      [COLLECTION_FIELD, want.type],
      [STATUS_FIELD, want.status],
    ]
    if (step.kind === 'create') {
      const id = await gh.addDraft(
        cache.projectId,
        want.title,
        want.body,
        this.#o
      )
      for (const [name, value] of values)
        if (value !== null) await this.#set(board, id, name, value)
      return
    }
    if (!cache.known.has(step.id)) await this.items(board)
    const known = cache.known.get(step.id)
    if (known?.draftId == null)
      throw new Error(`the board has no draft item ${step.id}`)
    await gh.editDraft(known.draftId, want.title, want.body, this.#o)
    for (const [name, value] of values)
      if ((known.values[name] ?? null) !== value)
        await this.#set(board, step.id, name, value)
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
