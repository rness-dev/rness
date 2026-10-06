import type { StatusUpdate } from '../board/collection.ts'
import type { Desired, LayoutView } from '../board/layout.ts'
import {
  type Layout,
  type OptionColor,
  collectionFilter,
  optionColor,
} from '../board/layout.ts'
import {
  type BoardItem,
  type Placed,
  type Step,
  firstLine,
} from '../board/plan.ts'
import * as gi from './github-issues.ts'
import * as gh from './github-projects.ts'
import type { ApiOptions } from './github.ts'
import type { Board, MarkFields, Provider } from './provider.ts'

/** A board on a GitHub project: its layout (spec 0017 §3, kept by spec 0018 §6), its items issues of `.rness` (spec 0018 §2–§5). */

export const PROJECT_TITLE = 'Agent Pulse'
const WORKING = 'working'
const WORKING_VIEW = 'Working'
/** The engine's field: where an item belongs, `adr/0001-a.md` (spec 0031 §1). */
const PATH_FIELD = 'Path'
/** The repository whose issues are the board's items (spec 0018 §2). */
const MEMORY = '.rness'
/** The label every one of them carries: `-label:rness` leaves them out of the Issues tab. */
export const LABEL = 'rness'
/** The session working on a document now; cleared when it ends (spec 0017 §5). */
const WORKING_SESSION = 'Working session'
/** Every session that wrote or changed a document; never cleared (spec 0020 §3). */
const SESSION_HISTORY = 'Session history'
/** What 0.15 named them: renamed at the next sync, read and written under either name until then (spec 0022 §2). */
const FORMERLY: Readonly<Record<string, string>> = {
  [WORKING_SESSION]: 'Session',
  [SESSION_HISTORY]: 'Sessions',
}
/** A value of an item, under the field's name or, on a board not renamed yet, its former one. */
const valueOf = (values: Record<string, string>, name: string): string | null =>
  values[name] ?? values[FORMERLY[name] ?? ''] ?? null
const LABEL_COLOR = '5319e7'
const LABEL_DESCRIPTION = 'A document of .rness, on a board of rness'
/** A label a collection's README declares for its documents (spec 0025 §4). */
const OWN_LABEL_COLOR = 'ededed'
const OWN_LABEL_DESCRIPTION =
  'A label a collection of .rness gives its documents'
/** The roadmap a collection's project gets when it declares a date field. */
const CALENDAR_VIEW = 'Calendar'
/** How a status update names the file it came from; GitHub does not show it. */
const markerOf = (path: string): string => `<!-- rness: ${path} -->`
/** A declared field's type as GitHub names it. */
const DATA_TYPE = {
  text: 'TEXT',
  date: 'DATE',
  number: 'NUMBER',
  select: 'SINGLE_SELECT',
} as const
/** GitHub's type as `rness.json` names it, for a refusal. */
const READABLE_TYPE: Readonly<Record<string, string>> = {
  TEXT: 'text',
  DATE: 'date',
  NUMBER: 'number',
  SINGLE_SELECT: 'select',
}
/** GitHub's own fields, which a project lists with the others. */
const GITHUB_FIELDS = new Set(
  [
    'Title',
    'Assignees',
    'Labels',
    'Linked pull requests',
    'Milestone',
    'Repository',
    'Reviewers',
    'Type',
    'Parent issue',
    'Sub-issues progress',
    'Tracks',
    'Tracked by',
  ].map((n) => n.toLowerCase())
)
/**
 * A view rness made in a release before it was declared: a collection's
 * (its name in its filter), the `Working` table, `All`, a `Calendar`. Not
 * declared any more, it goes; any other view is the team's (spec 0031 §4).
 */
const rnessOwn = (v: gh.View): boolean =>
  (v.filter !== null &&
    v.filter === collectionFilter(COLLECTION_FIELD, v.name)) ||
  (v.name === WORKING_VIEW && v.filter === WORKING_FILTER) ||
  (v.name === ALL_VIEW && v.filter === null && v.layout === 'TABLE_LAYOUT') ||
  (v.name === CALENDAR_VIEW && v.layout === 'ROADMAP_LAYOUT')
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
  /** `.rness`'s open issues labelled `rness`, read at the first create. */
  open?: gi.OpenIssue[]
}

/** How a single-select's options are coloured (`optionColor`). */
type OptionKind = 'status' | 'collection' | 'declared'

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
  /** Each organization's `.rness` labels by name, read when a collection needs one. */
  readonly #labels = new Map<string, Map<string, string>>()

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
        `boards need ${org}/${MEMORY} on GitHub: it is not there, or this login cannot see it`
      )
    this.#memories.set(org, found)
    return found
  }

  async checkIssues(org: string): Promise<void> {
    if (!(await this.#memory(org)).issues)
      throw new Error(
        `boards need Issues on ${org}/${MEMORY}: turn them on in its Settings`
      )
  }

  /** The project only: the caller declares it before `ensureLayout` builds it. */
  async createBoard(org: string, title = PROJECT_TITLE): Promise<Board> {
    const project = await gh.createProject(
      await gh.orgId(org, this.#o),
      title,
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
    // A project this process just made keeps what it knows: its default
    // statuses are still to replace.
    if (!this.#cache.has(this.#key(board))) this.#remember(board, project.id)
    return board
  }

  async ensureLayout(board: Board, layout: Layout): Promise<string[]> {
    const cache = await this.#cacheOf(board)
    const fields = await gh.fields(cache.projectId, this.#o)
    const added: string[] = []

    const enumOf = (c: OptionColor): string => c.toUpperCase()
    const colorOf = (kind: OptionKind, name: string): string | null => {
      const c = optionColor(layout.colors, kind, name)
      return c === null ? null : enumOf(c)
    }
    const inputs = (
      existing: gh.Field['options'],
      kind: OptionKind,
      wanted: readonly string[],
      names: readonly string[]
    ): gh.OptionInput[] =>
      names.map((name) => {
        const had = existing?.find((o) => o.name === name)?.color
        // An option rness does not know keeps the colour it has.
        const color = wanted.includes(name) ? colorOf(kind, name) : null
        return { name, color: color ?? had ?? 'GRAY' }
      })
    const withOptions = async (
      field: gh.Field,
      kind: OptionKind,
      wanted: readonly string[],
      reorder: boolean
    ): Promise<gh.Field> => {
      const now = namesOf(field)
      const missing = wanted.filter((n) => !now.includes(n))
      // Existing options stay: a hand-made one is not rness's to remove.
      const grown = [...now, ...missing]
      const next = reorder ? orderedFirst(wanted, grown) : grown
      const ordered = !next.every((n, i) => n === now[i])
      const recoloured = (field.options ?? []).some((o) => {
        const color = wanted.includes(o.name) ? colorOf(kind, o.name) : null
        return color !== null && o.color !== undefined && o.color !== color
      })
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
    const typed = (name: string, type: string): gh.Field | undefined => {
      const field = fields.find((f) => f.name === name)
      if (field !== undefined && field.dataType !== type)
        throw new Error(
          `the project's field ${name} is not a ${READABLE_TYPE[type] ?? type} field: rename it on the project, or in rness.json`
        )
      return field
    }
    const single = async (
      name: string,
      kind: OptionKind,
      wanted: readonly string[],
      reorder: boolean
    ): Promise<gh.Field | null> => {
      const field = typed(name, 'SINGLE_SELECT')
      if (field !== undefined) return withOptions(field, kind, wanted, reorder)
      // GitHub takes no single-select field without options: none yet, none made.
      if (wanted.length === 0) return null
      added.push(`field ${name}`)
      return gh.createField(
        cache.projectId,
        name,
        { options: inputs(null, kind, wanted, wanted) },
        this.#o
      )
    }
    const plain = async (
      name: string,
      type: 'text' | 'date' | 'number'
    ): Promise<gh.Field> => {
      const field = typed(name, DATA_TYPE[type])
      if (field !== undefined) return field
      // A field 0.15 named otherwise is renamed, not made again: its values
      // and the views showing it stay.
      const was = fields.find((f) => f.name === FORMERLY[name])
      if (type === 'text' && was !== undefined) {
        added.push(`renamed field ${was.name} → ${name}`)
        return gh.renameField(was.id, name, this.#o)
      }
      added.push(`field ${name}`)
      return gh.createField(cache.projectId, name, DATA_TYPE[type], this.#o)
    }

    // A new project's Status carries GitHub's default options: replaced, not
    // extended, once. After that, options are only ever added.
    const fresh = cache.fresh === true && layout.statuses.length > 0
    cache.fresh = false
    if (fresh) added.push(...layout.statuses.map((n) => `option ${n}`))
    const status = fresh
      ? await gh.setOptions(
          statusField(fields),
          inputs(null, 'status', layout.statuses, layout.statuses),
          this.#o
        )
      : await withOptions(statusField(fields), 'status', layout.statuses, true)
    // The engine's: where each item belongs (spec 0031 §1).
    const path = await plain(PATH_FIELD, 'text')
    const made: gh.Field[] = []
    for (const f of layout.fields) {
      const field =
        f.type === 'select'
          ? await single(f.name, f.kind, f.options, f.reorder)
          : await plain(f.name, f.type)
      if (field !== null) made.push(field)
    }
    const all = [status, path, ...made]
    // A field no longer declared stays on the project, no longer written.
    const declared = new Set([
      ...layout.fields.map((f) => f.name),
      ...Object.values(FORMERLY),
    ])
    for (const f of fields)
      if (
        f.name !== STATUS_FIELD &&
        f.name !== PATH_FIELD &&
        !GITHUB_FIELDS.has(f.name.toLowerCase()) &&
        !declared.has(f.name)
      )
        added.push(
          `note field ${f.name} is no longer declared: delete it on GitHub if unwanted`
        )

    const byName = (name: string): gh.Field | undefined =>
      all.find((f) => f.name === name) ?? fields.find((f) => f.name === name)
    // A field not made yet (a select with no option) is shown once it is.
    const shown = (names: readonly string[] | null) =>
      names === null
        ? null
        : names.flatMap((n) => {
            const f = byName(n)
            return f === undefined ? [] : [f]
          })
    const current = await gh.views(cache.projectId, this.#o)
    // The views by name as GitHub orders them once this is done: a view made
    // goes last, as GitHub adds it.
    const after = current.map((v) => v.name)
    const gone = (name: string) => after.splice(after.indexOf(name), 1)
    // GitHub's first view (`View 1`) becomes the first declared one when it
    // is a table that is not there yet; any other first view is the team's.
    const first = current[0]
    const lead = layout.views[0]
    let renamed: string | null = null
    if (
      first !== undefined &&
      lead !== undefined &&
      first.name === DEFAULT_VIEW &&
      lead.layout === 'table' &&
      !current.some((v) => v.name === lead.name)
    ) {
      added.push(`view ${lead.name}`)
      const visible = shown(lead.fields)
      await gh.updateView(
        first.id,
        {
          name: lead.name,
          ...(lead.filter === null ? {} : { filter: lead.filter }),
          ...(visible === null
            ? {}
            : { visibleFieldIds: visible.map((f) => f.id) }),
        },
        this.#o
      )
      renamed = first.id
      after[0] = lead.name
    }
    const create = async (view: LayoutView): Promise<void> => {
      const column = view.columns === null ? null : byName(view.columns)
      if (view.columns !== null && column === undefined)
        throw new Error(`the project has no field ${view.columns} to column by`)
      await gh.createView(
        board.org,
        board.number,
        {
          name: view.name,
          layout: view.layout,
          filter: view.filter,
          ...(column === null || column === undefined
            ? {}
            : { groupBy: column.databaseId }),
          ...(view.fields === null
            ? {}
            : {
                visibleFields: (shown(view.fields) ?? []).map(
                  (f) => f.databaseId
                ),
              }),
        },
        this.#o
      )
    }
    for (const view of layout.views) {
      if (renamed !== null && view === lead) continue
      const there = current.find((v) => v.name === view.name)
      if (there === undefined) {
        added.push(`view ${view.name}`)
        await create(view)
        after.push(view.name)
        continue
      }
      // GitHub changes neither a board's columns nor a roadmap's date in
      // place: a view whose layout or columns differ is made again.
      if (
        there.layout !== gh.LAYOUTS[view.layout] ||
        (view.layout === 'board' && there.columnField !== view.columns)
      ) {
        await gh.deleteView(there.id, this.#o)
        added.push(
          `view ${view.name} remade${
            view.layout === 'board' ? ` — columns ${view.columns}` : ''
          }`
        )
        await create(view)
        gone(view.name)
        after.push(view.name)
        continue
      }
      // GitHub returns a filter as it was given, and the fields shown in
      // the project's order: compared as a set (read 2026-10-06).
      const filter = there.filter !== view.filter
      const visible = shown(view.fields)
      const fieldsDiffer =
        visible !== null &&
        (visible.length !== there.fields.length ||
          visible.some((f) => !there.fields.includes(f.name)))
      if (filter || fieldsDiffer) {
        added.push(`updated view ${view.name}`)
        await gh.updateView(
          there.id,
          {
            ...(filter ? { filter: view.filter ?? '' } : {}),
            ...(fieldsDiffer && visible !== null
              ? { visibleFieldIds: visible.map((f) => f.id) }
              : {}),
          },
          this.#o
        )
      }
    }
    // A view no longer declared: rness's own goes, the team's stays, named.
    const wanted = new Set(layout.views.map((v) => v.name))
    for (const v of current) {
      if (v.id === renamed || wanted.has(v.name)) continue
      if (rnessOwn(v)) {
        await gh.deleteView(v.id, this.#o)
        added.push(`deleted view ${v.name}`)
        gone(v.name)
      } else
        added.push(
          `note view ${v.name} is not declared: delete it on GitHub if unwanted`
        )
    }
    const order = after.filter((n) => wanted.has(n))
    const declaredOrder = layout.views
      .map((v) => v.name)
      .filter((n) => order.includes(n))
    if (order.some((n, i) => n !== declaredOrder[i]))
      added.push(
        'note views are not in the declared order: GitHub keeps them as they were made'
      )

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
    for (const name of layout.labels)
      if ((await this.#ownLabel(board.org, name)).made)
        added.push(`label ${name}`)
    const repository = `${board.org}/${MEMORY}`
    const linked = await gh.linkedRepositories(cache.projectId, this.#o)
    if (!linked.some((r) => r.toLowerCase() === repository.toLowerCase())) {
      await gh.linkRepository(cache.projectId, memory.id, this.#o)
      added.push(`link ${repository}`)
    }
    cache.fields = [
      ...all,
      ...fields.filter((f) => !all.some((a) => a.id === f.id)),
    ]
    return added
  }

  /** A collection's label on `.rness`, made when missing; its id, and whether this made it. */
  async #ownLabel(
    org: string,
    name: string
  ): Promise<{ id: string; made: boolean }> {
    let ids = this.#labels.get(org)
    if (ids === undefined) {
      ids = await gi.labelIds(org, MEMORY, this.#o)
      this.#labels.set(org, ids)
    }
    // GitHub's label names ignore case.
    const known = [...ids].find(([n]) => n.toLowerCase() === name.toLowerCase())
    if (known !== undefined) return { id: known[1], made: false }
    const id = await gi.createLabel(
      org,
      MEMORY,
      {
        name,
        color: OWN_LABEL_COLOR,
        description: OWN_LABEL_DESCRIPTION,
      },
      this.#o
    )
    ids.set(name, id)
    return { id, made: true }
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
                  labels: [...issue.labels],
                },
          title: r.title,
          status: r.values[STATUS_FIELD] ?? null,
          collectionStatus:
            r.values[`${r.values[COLLECTION_FIELD] ?? ''} status`] ?? null,
          type: r.values[COLLECTION_FIELD] ?? null,
          agent: r.values['Agent'] ?? null,
          session: valueOf(r.values, WORKING_SESSION),
          sessions: valueOf(r.values, SESSION_HISTORY),
          values: { ...r.values },
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
    const fields = await this.#fields(board)
    const field =
      fields.find((f) => f.name === name) ??
      fields.find((f) => f.name === FORMERLY[name])
    if (field === undefined) throw new Error(`the board has no field ${name}`)
    let sent:
      | { text: string }
      | { optionId: string }
      | { date: string }
      | { number: number }
      | null = null
    if (value !== null && field.dataType === 'DATE') sent = { date: value }
    else if (value !== null && field.dataType === 'NUMBER')
      sent = { number: Number(value) }
    else if (value !== null && field.options === null) sent = { text: value }
    else if (value !== null) {
      const option = field.options?.find((opt) => opt.name === value)
      if (option === undefined)
        throw new Error(`the field ${name} has no option ${value}`)
      sent = { optionId: option.id }
    }
    await gh.setValue(cache.projectId, itemId, field.id, sent, this.#o)
    const known = cache.known.get(itemId)
    if (known === undefined) return
    if (value === null) delete known.values[field.name]
    else known.values[field.name] = value
  }

  async apply(board: Board, step: Step): Promise<Placed | null> {
    if (step.kind === 'unchanged') return null
    const cache = await this.#cacheOf(board)
    if (step.kind === 'create') return this.#create(board, cache, step.want)
    if (step.kind === 'remove') {
      // Its collection's own project holds it (spec 0025 §3): off this board only.
      await gh.deleteItem(cache.projectId, step.id, this.#o)
      cache.known.delete(step.id)
      return null
    }
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
      await this.#ownLabels(board.org, known, step.want)
      await this.#values(board, step.id, step.want)
      return { id: step.id, number: made.number }
    }
    const issue = this.#issueOf(known)
    if (step.reopen) {
      await gi.reopenIssue(issue.id, this.#o)
      issue.open = true
    }
    await this.#issue(known, step.want, labelId)
    await this.#ownLabels(board.org, known, step.want)
    await this.#values(board, step.id, step.want)
    return null
  }

  /**
   * An open issue of `.rness`, labelled `rness`, whose body starts with the
   * document's first line — made by an earlier sync whose item the board's
   * listing did not show yet, 18 s later (spec 0020 §7) — or null. Read once
   * per process, at the first create; an issue taken is taken off the list.
   */
  async #adoptable(
    board: Board,
    cache: Cache,
    want: Desired
  ): Promise<gi.OpenIssue | null> {
    cache.open ??= await gi.openIssues(board.org, MEMORY, LABEL, this.#o)
    const at = cache.open.findIndex((i) => firstLine(i.body) === want.body)
    if (at === -1) return null
    return cache.open.splice(at, 1)[0] ?? null
  }

  /**
   * A new document's issue: labelled, the first line as body, added to the
   * board, Path first. One already made for it is added instead: GitHub adds
   * an issue already on the board as the item it is, so no second one.
   */
  async #create(board: Board, cache: Cache, want: Desired): Promise<Placed> {
    const memory = await this.#memory(board.org)
    const labelId = await this.#labelId(board)
    const found = await this.#adoptable(board, cache, want)
    if (found !== null) {
      const id = await gh.addItem(cache.projectId, found.id, this.#o)
      const known: gh.RawItem = cache.known.get(id) ?? {
        id,
        draftId: null,
        issue: {
          id: found.id,
          number: found.number,
          open: true,
          repository: `${board.org}/${MEMORY}`,
          body: found.body,
          labels: [LABEL],
        },
        title: found.title,
        archived: false,
        values: {},
      }
      cache.known.set(id, known)
      await this.#issue(known, want, labelId)
      await this.#ownLabels(board.org, known, want)
      await this.#values(board, id, want)
      return { id, number: found.number, adopted: true }
    }
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
    await this.#ownLabels(board.org, cache.known.get(id)!, want)
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

  /** The labels a collection gives the issue, and those it takes off (spec 0025 §4). */
  async #ownLabels(
    org: string,
    known: gh.RawItem,
    want: Desired
  ): Promise<void> {
    if (want.labels.length === 0 && want.unlabels.length === 0) return
    const issue = this.#issueOf(known)
    const carried = (name: string): string | undefined =>
      issue.labels.find((l) => l.toLowerCase() === name.toLowerCase())
    const add = want.labels.filter((l) => carried(l) === undefined)
    const off = want.unlabels.filter((l) => carried(l) !== undefined)
    if (add.length > 0) {
      const ids: string[] = []
      for (const name of add) ids.push((await this.#ownLabel(org, name)).id)
      await gi.addLabels(issue.id, ids, this.#o)
      issue.labels.push(...add)
    }
    if (off.length > 0) {
      const ids: string[] = []
      for (const name of off) ids.push((await this.#ownLabel(org, name)).id)
      await gi.removeLabels(issue.id, ids, this.#o)
      issue.labels = issue.labels.filter(
        (l) => !off.some((o) => o.toLowerCase() === l.toLowerCase())
      )
    }
  }

  /** Path first — an issue on the board without it is the team's — then the fields, each only when it differs. */
  async #values(board: Board, id: string, want: Desired): Promise<void> {
    const values = (await this.#known(board, id)).values
    const fields = await this.#fields(board)
    // A select with no option yet has no field yet: nothing to write.
    const declared = Object.entries(want.values).filter(([name]) =>
      fields.some((f) => f.name === name || FORMERLY[name] === f.name)
    )
    const [where, rest] = [
      declared.filter(([name]) => name === COLLECTION_FIELD),
      declared.filter(([name]) => name !== COLLECTION_FIELD),
    ]
    const wanted: [string, string | null][] = [
      [PATH_FIELD, want.path],
      ...where,
      [STATUS_FIELD, want.status],
      ...(want.statusField === null
        ? []
        : ([[want.statusField, want.status]] as [string, string | null][])),
      ...rest,
    ]
    for (const [name, value] of wanted)
      if (valueOf(values, name) !== value)
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
        `${board.org}/${MEMORY} has no label ${LABEL}: run rness board push`
      )
    return id
  }

  async mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null,
    fields: MarkFields = { agent: 'Agent', session: WORKING_SESSION }
  ): Promise<void> {
    for (const id of itemIds) {
      await this.#set(
        board,
        id,
        fields.agent,
        session === null ? null : WORKING
      )
      if (fields.session !== null)
        await this.#set(board, id, fields.session, session)
    }
  }

  async describe(
    board: Board,
    text: { readme: string | null; description: string | null }
  ): Promise<string[]> {
    const cache = await this.#cacheOf(board)
    const now = await gh.projectText(cache.projectId, this.#o)
    const next: { readme?: string; shortDescription?: string } = {}
    // GitHub keeps a README's text as sent, up to its trailing blanks.
    if (text.readme !== null && now.readme.trimEnd() !== text.readme.trimEnd())
      next.readme = text.readme.trimEnd()
    if (text.description !== null && now.shortDescription !== text.description)
      next.shortDescription = text.description
    if (next.readme === undefined && next.shortDescription === undefined)
      return []
    await gh.updateProjectText(cache.projectId, next, this.#o)
    return [
      ...(next.readme === undefined ? [] : ['readme']),
      ...(next.shortDescription === undefined ? [] : ['short description']),
    ]
  }

  async postUpdates(
    board: Board,
    updates: readonly StatusUpdate[]
  ): Promise<string[]> {
    if (updates.length === 0) return []
    const cache = await this.#cacheOf(board)
    const there = await gh.statusUpdates(cache.projectId, this.#o)
    const written: string[] = []
    for (const u of updates) {
      const marker = markerOf(u.path)
      const input = {
        body: `${u.body.trimEnd()}\n\n${marker}`,
        status: u.health.toUpperCase().replace('-', '_'),
        startDate: u.startDate,
        targetDate: u.targetDate,
      }
      const posted = there.find((p) => p.body.includes(marker))
      if (posted === undefined) {
        await gh.createStatusUpdate(cache.projectId, input, this.#o)
        written.push(`posted ${u.path}`)
      } else if (
        posted.body.trimEnd() !== input.body ||
        posted.status !== input.status ||
        (posted.startDate ?? null) !== input.startDate ||
        (posted.targetDate ?? null) !== input.targetDate
      ) {
        await gh.updateStatusUpdate(posted.id, input, this.#o)
        written.push(`updated ${u.path}`)
      }
    }
    return written
  }
}
