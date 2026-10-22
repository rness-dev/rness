import {
  type AdfDocument,
  type AdfNode,
  footerAdf,
  readFooter,
  toAdf,
} from '../board/adf.ts'
import { digestOf, headerOf } from '../board/body.ts'
import type { Desired, Layout, LayoutView } from '../board/layout.ts'
import type { BoardItem, Placed, Step } from '../board/plan.ts'
import * as ji from './jira-issues.ts'
import * as jw from './jira-workflow.ts'
import type { JiraApiOptions } from './jira.ts'
import type { Board, MarkFields } from './provider.ts'
import type { JiraTarget } from './types.ts'

/**
 * The boards on Jira (spec 0039 §7): a team-managed space has one board,
 * which every declared `board` view shares; a card is an issue of the space
 * labelled `rness`; its status is a real Jira status, moved by a `GLOBAL`
 * transition; a select is a label `<field>-<option>`; a text, date or number
 * field a paragraph of the description's footer; the digest an issue
 * property. Statuses are known by id: a site in another language shows
 * them translated (plan 0053 task 1).
 */

export const LABEL = 'rness'
const STATUS = 'Status'
/** A gone document's status: hidden from the board by the team, once (spec 0039 §7.2). */
export const GONE = 'Gone'
const WORKING = 'working'
const WORKING_SESSION = 'Working session'
const FOOTER_ORDER = [WORKING_SESSION, 'Session history']
/** The issue property that keeps the digest of the body last written. */
const DIGEST = 'rness'

const slug = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, '-')

/** A select's option as a label: `collection-specs`, `agent-working` (spec 0039 §7.1). */
export const optionLabel = (field: string, option: string): string =>
  `${slug(field)}-${slug(option)}`

/** A status's category from its name (spec 0039 §7.2). */
export function categoryOf(name: string): jw.StatusCategory {
  if (['Draft', 'Proposed', 'Ready'].includes(name)) return 'TODO'
  if (['In progress', 'Blocked', 'Approved'].includes(name))
    return 'IN_PROGRESS'
  return 'DONE'
}

/** A space as the template makes it: these four statuses, by untranslated name. */
const TEMPLATE = ['done', 'in progress', 'in review', 'to do']
/** The template's three that become rness's, in a space just made (spec 0039 §7.2). */
const RENAMES: readonly [string, string][] = [
  ['To Do', 'Draft'],
  ['In Progress', 'In progress'],
  ['Done', 'Completed'],
]

/** The space's board on the site. */
export const jiraBoardUrl = (jira: JiraTarget, id: number): string =>
  `https://${jira.site}/jira/software/projects/${jira.space}/boards/${id}`

/** Every status the layout declares, in order, once each whatever its case, `Gone` last. */
export function declaredStatuses(layout: Layout): string[] {
  const names = [
    ...layout.statuses,
    ...layout.fields.flatMap((f) =>
      f.type === 'select' && f.kind === 'status' ? f.options : []
    ),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of [...names, GONE])
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase())
      out.push(n)
    }
  return out
}

/** What a setup would do to the space's statuses. */
interface SetupPlan {
  renames: jw.SpaceStatus[]
  create: string[]
  /** Every declared status by id, once renamed or made (made: the name). */
  adopted: Map<string, string>
  /** The space is as the template made it. */
  fresh: boolean
}

type Run = <T>(work: (o: JiraApiOptions) => Promise<T>) => Promise<T>

/** The adapter's board methods for Jira, for one process. */
export class JiraBoards {
  readonly #jira: JiraTarget
  readonly #run: Run
  #project: { id: string; key: string } | undefined
  #typeId: string | undefined
  #statuses: jw.SpaceStatus[] | undefined
  #layout: Layout | undefined
  /** Target status id → the GLOBAL transition's id: the same for every issue. */
  readonly #transitions = new Map<string, string>()
  readonly #known = new Map<string, ji.JiraIssue>()

  constructor(jira: JiraTarget, run: Run) {
    this.#jira = jira
    this.#run = run
  }

  async #projectOf(o: JiraApiOptions): Promise<{ id: string; key: string }> {
    if (this.#project !== undefined) return this.#project
    const found = await ji.space(this.#jira.space, o)
    if (found === null)
      throw new Error(
        `space ${this.#jira.space} not found on ${this.#jira.site} (or not visible to you)`
      )
    this.#project = found
    return found
  }

  async #statusesOf(
    o: JiraApiOptions,
    fresh = false
  ): Promise<jw.SpaceStatus[]> {
    if (this.#statuses !== undefined && !fresh) return this.#statuses
    this.#statuses = await jw.spaceStatuses((await this.#projectOf(o)).id, o)
    return this.#statuses
  }

  /** The space's one board; null when the space has none. */
  async board(org: string): Promise<Board | null> {
    return this.#run(async (o) => {
      const found = await jw.spaceBoard(this.#jira.space, o)
      return found === null
        ? null
        : {
            org,
            number: found.id,
            url: jiraBoardUrl(this.#jira, found.id),
            title: this.#jira.space,
          }
    })
  }

  async #setupPlan(layout: Layout, o: JiraApiOptions): Promise<SetupPlan> {
    const statuses = await this.#statusesOf(o, true)
    const fresh =
      statuses
        .map((s) => s.name.toLowerCase())
        .sort()
        .join(',') === TEMPLATE.join(',')
    const declared = declaredStatuses(layout)
    const byName = (name: string): jw.SpaceStatus | undefined =>
      statuses.find((s) => s.name.toLowerCase() === name.toLowerCase())
    const renames: jw.SpaceStatus[] = []
    if (fresh)
      for (const [from, to] of RENAMES) {
        const s = byName(from)
        // A rename onto another status's name would fail: Jira's names are
        // unique whatever the case. `In Progress` to `In progress` is its own.
        const other = byName(to)
        if (
          s !== undefined &&
          declared.includes(to) &&
          (other === undefined || other.id === s.id)
        )
          renames.push({ id: s.id, name: to, category: categoryOf(to) })
      }
    const adopted = new Map<string, string>()
    const create: string[] = []
    for (const name of declared) {
      const renamed = renames.find((r) => r.name === name)
      const there =
        renamed ??
        statuses.find(
          (s) =>
            s.name.toLowerCase() === name.toLowerCase() &&
            !renames.some((r) => r.id === s.id)
        )
      if (there === undefined) create.push(name)
      else adopted.set(there.id, name)
    }
    return { renames, create, adopted, fresh }
  }

  /**
   * What the setup would do to the space, as the question says it, or null
   * when every declared status is there with a GLOBAL transition. Asked
   * before `ensureLayout`, which does it (spec 0039 §7.2).
   */
  async pendingSetup(layout: Layout): Promise<string | null> {
    return this.#run(async (o) => {
      const plan = await this.#setupPlan(layout, o)
      const changes = plan.renames.length + plan.create.length
      const ids = [...plan.adopted.keys()]
      const transitions = changes > 0 || (await this.#lacksTransitions(ids, o))
      if (!transitions) return null
      return changes > 0
        ? `${changes} ${changes === 1 ? 'status' : 'statuses'}, any-to-any transitions`
        : 'any-to-any transitions'
    })
  }

  /** Whether one of `ids` has no GLOBAL transition yet: read off the workflow. */
  async #lacksTransitions(
    ids: readonly string[],
    o: JiraApiOptions
  ): Promise<boolean> {
    const issue = this.#typeId ?? (await ji.taskType(this.#jira.space, o))
    this.#typeId = issue
    const read = await jw.workflowStatuses(
      (await this.#projectOf(o)).id,
      issue,
      o
    )
    return ids.some((id) => !read.global.has(id))
  }

  async ensureLayout(board: Board, layout: Layout): Promise<string[]> {
    return this.#run(async (o) => {
      this.#layout = layout
      const space = this.#jira.space
      const lines: string[] = []
      const project = await this.#projectOf(o)
      this.#typeId ??= await ji.taskType(space, o)
      const plan = await this.#setupPlan(layout, o)
      if (plan.renames.length > 0) {
        await jw.renameStatuses(plan.renames, o)
        const from = plan.renames.map(
          (r) => RENAMES.find(([, to]) => to === r.name)?.[0] ?? r.name
        )
        lines.push(
          `renamed the template's ${from.join(', ')}: ${plan.renames.map((r) => r.name).join(', ')}`
        )
      }
      if (plan.create.length > 0) {
        const made = await jw.createStatuses(
          project.id,
          plan.create.map((name) => ({ name, category: categoryOf(name) })),
          o
        )
        for (const s of made) plan.adopted.set(s.id, s.name)
        lines.push(
          `created ${made.length} ${made.length === 1 ? 'status' : 'statuses'} in ${space}: ${made.map((s) => s.name).join(', ')}`
        )
      }
      await jw.addGlobalTransitions(
        project.id,
        this.#typeId,
        [...plan.adopted.keys()],
        o
      )
      await this.#statusesOf(o, true)
      // A space as the template made it gets its Backlog off; another is told.
      if (await jw.backlogOn(board.number, o)) {
        if (plan.fresh) {
          await jw.setBacklog(board.number, false, o)
          lines.push(`updated board ${space}: its Backlog off`)
        } else
          lines.push(
            `note board ${space}: its Backlog is on, so the cards rness makes land there, not on the board`
          )
      }
      lines.push(...viewNotes(this.#jira, layout))
      lines.push(...(await this.#columnsCheck(board, layout, plan.adopted, o)))
      return lines
    })
  }

  /**
   * Every declared status in a column, `Gone` hidden (spec 0039 §7.2): a
   * fresh board gives each status a column, an advanced one none.
   */
  async #columnsCheck(
    board: Board,
    layout: Layout,
    adopted: ReadonlyMap<string, string>,
    o: JiraApiOptions
  ): Promise<string[]> {
    const shown = new Set(
      (await jw.columns(board.number, o)).flatMap((c) => c.statuses)
    )
    const idOf = (name: string): string | undefined =>
      [...adopted].find(([, n]) => n === name)?.[0]
    const gone = idOf(GONE)
    const unmapped = declaredStatuses(layout).filter((n) => {
      if (n === GONE) return false
      const id = idOf(n)
      return id !== undefined && !shown.has(id)
    })
    const lines: string[] = []
    if (gone !== undefined && shown.has(gone))
      lines.push(
        `visible Gone has a column, so gone documents show on the board: hide it once, among the hidden statuses of the board's column settings, ${board.url}`
      )
    if (unmapped.length > 0)
      lines.push(
        unmapped.length === 1
          ? `unmapped a status has no column, its cards hidden: ${unmapped.join(', ')}; map it once in the board's column settings, ${board.url}`
          : `unmapped ${unmapped.length} statuses have no column, their cards hidden: ${unmapped.join(', ')}; map each once in the board's column settings, ${board.url}`
      )
    if (lines.length === 0)
      lines.push(
        `checked board ${this.#jira.space}: every status in a column, Gone hidden`
      )
    return lines
  }

  /** A status id's declared name; a status no declaration names, its own. */
  #nameOf(id: string | null): string | null {
    if (id === null) return null
    const status = this.#statuses?.find((s) => s.id === id)
    if (status === undefined) return null
    const declared =
      this.#layout === undefined ? [] : declaredStatuses(this.#layout)
    return (
      declared.find((n) => n.toLowerCase() === status.name.toLowerCase()) ??
      status.name
    )
  }

  #idOf(name: string): string | undefined {
    return this.#statuses?.find(
      (s) => s.name.toLowerCase() === name.toLowerCase()
    )?.id
  }

  async items(
    board: Board,
    options: { bodies?: boolean } = {}
  ): Promise<BoardItem[]> {
    return this.#run(async (o) => {
      await this.#statusesOf(o)
      const issues = await ji.search(
        `project = "${this.#jira.space}" AND labels = "${LABEL}"`,
        ji.ISSUE_FIELDS,
        o,
        [DIGEST]
      )
      this.#known.clear()
      for (const i of issues) this.#known.set(i.key, i)
      return issues.map((i) => this.#itemOf(board, i, options.bodies !== false))
    })
  }

  #itemOf(board: Board, issue: ji.JiraIssue, bodies: boolean): BoardItem {
    const { values: footer } =
      issue.description === null
        ? { values: {} }
        : readFooter(issue.description)
    const path = pathOf(issue.description)
    const values: Record<string, string> = { ...footer }
    const layout = this.#layout
    for (const [name, option] of decodeLabels(issue.labels, layout))
      values[name] = option
    const status = this.#nameOf(issue.statusId)
    if (status !== null) values[STATUS] = status
    const collection = values['Collection'] ?? null
    if (collection !== null && status !== null)
      values[`${collection} status`] = status
    if (path !== null) values['Path'] = path
    const digest = issue.properties[DIGEST]
    return {
      id: issue.key,
      path,
      issue: {
        number: issue.number,
        open: status !== GONE,
        labelled: issue.labels.some((l) => l.toLowerCase() === LABEL),
        body:
          bodies && path !== null
            ? headerOf(path, board.org, 'atlassian')
            : null,
        labels: carriedLabels(issue.labels, layout),
        digest:
          digest !== null &&
          typeof digest === 'object' &&
          typeof (digest as { digest?: unknown }).digest === 'string'
            ? (digest as { digest: string }).digest
            : null,
      },
      title: issue.summary,
      status,
      collectionStatus:
        collection === null ? null : (values[`${collection} status`] ?? null),
      type: collection,
      agent: values['Agent'] ?? null,
      session: values[WORKING_SESSION] ?? null,
      sessions: values['Session history'] ?? null,
      values,
    }
  }

  async #issue(key: string, o: JiraApiOptions): Promise<ji.JiraIssue> {
    const hit = this.#known.get(key)
    if (hit !== undefined) return hit
    const found = await ji.issue(key, o)
    if (found === null) throw new Error(`the board has no item ${key}`)
    this.#known.set(key, found)
    return found
  }

  /** The issue moved to the status `name` by its GLOBAL transition; nothing when it is there. */
  async #move(
    issue: ji.JiraIssue,
    name: string,
    o: JiraApiOptions
  ): Promise<void> {
    const target = this.#idOf(name)
    if (target === undefined)
      throw new Error(
        `${this.#jira.space} has no status ${name}: rness board push sets it up`
      )
    if (issue.statusId === target) return
    if (!this.#transitions.has(target))
      for (const t of await ji.transitions(issue.key, o))
        this.#transitions.set(t.to, t.id)
    const id = this.#transitions.get(target)
    // A GLOBAL transition is listed from every status, its own included
    // (task 1): none means the setup is not done.
    if (id === undefined)
      throw new Error(
        `${this.#jira.space} has no transition to ${name}: rness board push sets it up`
      )
    await ji.transition(issue.key, id, o)
    issue.statusId = target
  }

  async apply(board: Board, step: Step): Promise<Placed | null> {
    if (step.kind === 'unchanged') return null
    if (
      step.kind === 'convert' ||
      step.kind === 'archive' ||
      step.kind === 'remove'
    )
      // No drafts, one board per space (spec 0039 §6).
      throw new Error(`a ${step.kind} step has no meaning on Jira`)
    return this.#run(async (o) => {
      await this.#statusesOf(o)
      const layout = this.#layout ?? null
      if (step.kind === 'create') {
        this.#typeId ??= await ji.taskType(this.#jira.space, o)
        const body = await toAdf(step.want.body)
        const made = await ji.createIssue(
          this.#jira.space,
          this.#typeId,
          {
            summary: step.want.title,
            description: withFooter(body.content, footerOf(step.want, layout)),
            labels: [LABEL, ...labelsOf(step.want, layout)],
          },
          o
        )
        const issue = await ji.issue(made.key, o)
        if (issue !== null) {
          this.#known.set(made.key, issue)
          if (step.want.status !== null)
            await this.#move(issue, step.want.status, o)
        }
        return { id: made.key, number: made.number }
      }
      const issue = await this.#issue(step.id, o)
      if (step.kind === 'close') {
        await this.#move(issue, GONE, o)
        return null
      }
      const { body: kept, values } =
        issue.description === null
          ? { body: [] as AdfNode[], values: {} as Record<string, string> }
          : readFooter(issue.description)
      if (step.kind === 'body') {
        const body = await toAdf(step.body)
        const description = withFooter(body.content, values)
        await ji.updateIssue(issue.key, { description }, o)
        issue.description = description
        await ji.setProperty(
          issue.key,
          DIGEST,
          { digest: digestOf(step.body) },
          o
        )
        return null
      }
      // update: the title, the labels and their siblings, the footer, the status.
      const want = step.want
      const wanted = [LABEL, ...labelsOf(want, layout)]
      const carried = issue.labels
      const add = wanted.filter(
        (w) => !carried.some((c) => c.toLowerCase() === w.toLowerCase())
      )
      const prefixes = selectPrefixes(want, layout)
      const remove = carried.filter(
        (c) =>
          (prefixes.some((p) => c.toLowerCase().startsWith(p)) &&
            !wanted.some((w) => w.toLowerCase() === c.toLowerCase())) ||
          want.unlabels.some((u) => slug(u) === c.toLowerCase())
      )
      const description = withFooter(kept, {
        ...values,
        ...footerOf(want, layout),
      })
      const same =
        JSON.stringify(description) === JSON.stringify(issue.description)
      const change = {
        ...(issue.summary === want.title ? {} : { summary: want.title }),
        ...(same ? {} : { description }),
        ...(add.length === 0 ? {} : { add }),
        ...(remove.length === 0 ? {} : { remove }),
      }
      if (Object.keys(change).length > 0) {
        await ji.updateIssue(issue.key, change, o)
        issue.summary = want.title
        issue.description = description
        issue.labels = [...carried.filter((c) => !remove.includes(c)), ...add]
      }
      if (want.status !== null) await this.#move(issue, want.status, o)
      return null
    })
  }

  async mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null,
    fields: MarkFields = { agent: 'Agent', session: WORKING_SESSION }
  ): Promise<void> {
    return this.#run(async (o) => {
      for (const id of itemIds) {
        const issue = await this.#issue(id, o)
        const prefix = `${slug(fields.agent)}-`
        const agentLabels = issue.labels.filter((l) =>
          l.toLowerCase().startsWith(prefix)
        )
        const working = optionLabel(fields.agent, WORKING)
        const add =
          session === null || agentLabels.includes(working) ? [] : [working]
        const remove =
          session === null
            ? agentLabels
            : agentLabels.filter((l) => l !== working)
        const { body, values } =
          issue.description === null
            ? { body: [] as AdfNode[], values: {} as Record<string, string> }
            : readFooter(issue.description)
        const footer =
          fields.session === null
            ? values
            : { ...values, [fields.session]: session ?? '' }
        const description = withFooter(body, footer)
        const same =
          JSON.stringify(description) === JSON.stringify(issue.description)
        if (add.length === 0 && remove.length === 0 && same) continue
        await ji.updateIssue(
          issue.key,
          {
            ...(same ? {} : { description }),
            ...(add.length === 0 ? {} : { add }),
            ...(remove.length === 0 ? {} : { remove }),
          },
          o
        )
        issue.description = description
        issue.labels = [
          ...issue.labels.filter((l) => !remove.includes(l)),
          ...add,
        ]
      }
    })
  }
}

/** A description: the body's nodes, then the footer of `values`. */
function withFooter(
  body: readonly AdfNode[],
  values: Readonly<Record<string, string | null>>
): AdfDocument {
  return {
    version: 1,
    type: 'doc',
    content: [...body, ...footerAdf(values, FOOTER_ORDER)],
  }
}

/** The path a description's first paragraph names: its code-marked text. */
function pathOf(description: AdfDocument | null): string | null {
  const first = description?.content[0]
  const code = first?.content?.find(
    (n) => n.type === 'text' && n.marks?.some((m) => m.type === 'code')
  )
  return code?.text ?? null
}

/** The select fields whose labels a card carries: `Status` and the collections' status fields are Jira's status. */
function labelledSelects(
  layout: Layout | null
): { name: string; options: string[] }[] {
  return (layout?.fields ?? []).flatMap((f) =>
    f.type === 'select' && f.kind !== 'status'
      ? [{ name: f.name, options: f.options }]
      : []
  )
}

const isLabelled = (layout: Layout | null, name: string): boolean =>
  labelledSelects(layout).some((s) => s.name === name)

const isSelect = (layout: Layout | null, name: string): boolean =>
  name === STATUS ||
  (layout?.fields.some((f) => f.name === name && f.type === 'select') ?? false)

/** The labels a document's card carries besides `rness`: its selects' options, its own labels; spaces as `-`. */
function labelsOf(want: Desired, layout: Layout | null): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(want.values))
    if (value !== null && isLabelled(layout, name))
      out.push(optionLabel(name, value))
  out.push(...want.labels.map(slug))
  return [...new Set(out)]
}

/** The prefixes of the selects the document writes: a sibling option of one comes off. */
function selectPrefixes(want: Desired, layout: Layout | null): string[] {
  return Object.keys(want.values)
    .filter((name) => isLabelled(layout, name))
    .map((name) => `${slug(name)}-`)
}

/** The values a card's footer carries: its text, date and number fields. */
function footerOf(
  want: Desired,
  layout: Layout | null
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(want.values))
    if (!isSelect(layout, name)) out[name] = value
  return out
}

/** A card's selects read back off its labels: `collection-specs` is `Collection: Specs`. */
function decodeLabels(
  labels: readonly string[],
  layout: Layout | undefined
): [string, string][] {
  const out: [string, string][] = []
  for (const s of labelledSelects(layout ?? null))
    for (const option of s.options)
      if (labels.some((l) => l.toLowerCase() === optionLabel(s.name, option)))
        out.push([s.name, option])
  if (
    layout === undefined ||
    !labelledSelects(layout).some((s) => s.name === 'Agent')
  )
    if (labels.some((l) => l.toLowerCase() === optionLabel('Agent', WORKING)))
      out.push(['Agent', WORKING])
  return out
}

/** The labels as the engine compares them: a declared label carried as its slug reads as declared. */
function carriedLabels(
  labels: readonly string[],
  layout: Layout | undefined
): string[] {
  const declared = layout?.labels ?? []
  return labels.map(
    (l) => declared.find((d) => slug(d) === l.toLowerCase()) ?? l
  )
}

/**
 * What a view becomes on Jira, said once per clone (spec 0039 §7.1): the
 * board views share the space's board, filtered by their collection's
 * label; a table is an issue search; a roadmap is nothing.
 */
function viewNotes(jira: JiraTarget, layout: Layout): string[] {
  const lines: string[] = []
  const boards = layout.views.filter((v) => v.layout === 'board')
  if (boards.length > 1) {
    const collections = labelledSelects(layout).find(
      (s) => s.name === 'Collection'
    )
    const filters = boards.flatMap((v) => {
      const option = collections?.options.find((o) => o === v.name)
      return option === undefined ? [] : [optionLabel('Collection', option)]
    })
    lines.push(
      `note views ${boards.map((v) => v.name).join(', ')} share the board of ${jira.space}${filters.length > 0 ? `: filter on ${filters.join(', ')}` : ''}`
    )
  }
  // Several board views: their filters are the line above's labels. One
  // alone with a filter: dropped, said.
  if (boards.length === 1)
    for (const v of boards)
      if (v.filter !== null)
        lines.push(`note view ${v.name}: a board's filter is dropped on Jira`)
  for (const v of layout.views) {
    if (v.layout === 'table')
      lines.push(`note view ${v.name}: ${searchUrl(jira, v, layout)}`)
    if (v.layout === 'roadmap')
      lines.push(`note view ${v.name}: Jira has no roadmap for issues`)
  }
  return lines
}

/** A table view as Jira's issue search: the space, `rness`, and the labels its filter names. */
function searchUrl(jira: JiraTarget, view: LayoutView, layout: Layout): string {
  const labels = [LABEL]
  for (const m of (view.filter ?? '').matchAll(/(\w[\w ]*?):"?([^"\s]+)"?/g)) {
    const field = labelledSelects(layout).find(
      (s) => s.name.toLowerCase() === (m[1] ?? '').toLowerCase()
    )
    if (field !== undefined && m[2] !== undefined)
      labels.push(optionLabel(field.name, m[2]))
  }
  const jql = [
    `project = ${jira.space}`,
    ...labels.map((l) => `labels = ${l}`),
  ].join(' AND ')
  return `https://${jira.site}/issues/?jql=${encodeURIComponent(jql)}`
}
