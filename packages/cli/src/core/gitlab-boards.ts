import { splitFooter, withFooter } from '../board/footer.ts'
import {
  type Desired,
  type Layout,
  type LayoutView,
  type OptionColor,
  optionColor,
} from '../board/layout.ts'
import type { BoardItem, Placed, Step } from '../board/plan.ts'
import { gitlabBoardUrl } from '../board/urls.ts'
import * as gi from './gitlab-issues.ts'
import {
  type GitlabApiOptions,
  failure,
  field,
  gitlabCall,
  pages,
  segment,
} from './gitlab.ts'
import type { Board, MarkFields } from './provider.ts'

/**
 * The boards on GitLab, on the Free tier (spec 0037 §7): the cards are the
 * issues of the context project `rness`; a select is a label `Key::value`,
 * kept exclusive by rness; a text, date or number field is a line of the
 * description's footer; one issue board per `board` view, its lists the
 * labels of its columns, Open and Closed hidden. A rness board is
 * identified by `ids`, view name to issue board id.
 */

const CONTEXT = 'rness'
export const LABEL = 'rness'
const LABEL_COLOR = '#5319e7'
const LABEL_DESCRIPTION = 'A document of .rness, on a board of rness'
const OWN_LABEL_COLOR = '#ededed'
const WORKING = 'working'
const STATUS = 'Status'
const WORKING_SESSION = 'Working session'
/** The fields of the footer, first: a session's, then the history. */
const FOOTER_ORDER = [WORKING_SESSION, 'Session history']

/** An option's colour as a label's hex (GitHub's palette: the same board, the same colours). */
const HEX: Readonly<Record<OptionColor, string>> = {
  gray: '#6e7781',
  blue: '#0969da',
  green: '#1a7f37',
  yellow: '#bf8700',
  orange: '#bc4c00',
  red: '#cf222e',
  pink: '#bf3989',
  purple: '#8250df',
}

const scoped = (key: string, value: string): string => `${key}::${value}`

/** `Key::value` as its key and value; null for a plain label. */
function split(label: string): { key: string; value: string } | null {
  const at = label.indexOf('::')
  return at <= 0
    ? null
    : { key: label.slice(0, at), value: label.slice(at + 2) }
}

/** The path a description's first line names: `` `specs/0002-b.md` · [on GitLab](…) ``. */
const PATH_LINE = /^`([^`\n]+)` · \[on GitLab\]\(/

interface IssueBoard {
  id: number
  name: string
  hideBacklog: boolean
  hideClosed: boolean
  lists: { id: number; position: number; label: string }[]
}

function toBoard(value: unknown): IssueBoard | null {
  const id = field(value, 'id')
  if (typeof id !== 'number') return null
  const name = field(value, 'name')
  const lists = field(value, 'lists')
  return {
    id,
    name: typeof name === 'string' ? name : '',
    hideBacklog: field(value, 'hide_backlog_list') === true,
    hideClosed: field(value, 'hide_closed_list') === true,
    lists: Array.isArray(lists)
      ? lists.flatMap((l: unknown) => {
          const listId = field(l, 'id')
          const position = field(l, 'position')
          const label = field(field(l, 'label'), 'name')
          return typeof listId === 'number' && typeof label === 'string'
            ? [
                {
                  id: listId,
                  position: typeof position === 'number' ? position : 0,
                  label,
                },
              ]
            : []
        })
      : [],
  }
}

interface Known {
  issue: gi.GitlabIssue
}

/** What a rness board on GitLab keeps for one process. */
interface Cache {
  layout?: Layout
  known: Map<string, Known>
}

/** The adapter's board methods for GitLab, for one process. */
export class GitLabBoards {
  readonly #o: GitlabApiOptions
  readonly #cache = new Map<string, Cache>()
  /** The context project's labels by name, with their ids, per organization. */
  readonly #labels = new Map<string, Map<string, number>>()

  constructor(options: GitlabApiOptions) {
    this.#o = options
  }

  #project = (org: string): string => `${org}/${CONTEXT}`
  #key = (b: Board): string => `${b.org}/${b.number}`

  #cacheOf(board: Board): Cache {
    let cache = this.#cache.get(this.#key(board))
    if (cache === undefined) {
      cache = { known: new Map() }
      this.#cache.set(this.#key(board), cache)
    }
    return cache
  }

  async #boards(org: string): Promise<IssueBoard[]> {
    const listed = await pages(
      `/projects/${segment(this.#project(org))}/boards`,
      {},
      this.#o
    )
    if (listed === null)
      throw new Error(
        `${this.#project(org)} is not on GitLab (or not visible to you)`
      )
    return listed.items.flatMap((b) => {
      const board = toBoard(b)
      return board === null ? [] : [board]
    })
  }

  async #createIssueBoard(org: string, name: string): Promise<number> {
    const at = `/projects/${segment(this.#project(org))}/boards`
    const answer = await gitlabCall('POST', at, this.#o, { name })
    const id = field(answer.body, 'id')
    if (answer.status !== 201 || typeof id !== 'number')
      throw failure(answer, at)
    await this.#hideLists(org, id)
    return id
  }

  /** Open and Closed hidden: a card with none of the lists' labels is on no list (plan 0049 task 1). */
  async #hideLists(org: string, id: number): Promise<void> {
    const at = `/projects/${segment(this.#project(org))}/boards/${id}`
    const answer = await gitlabCall('PUT', at, this.#o, {
      hide_backlog_list: true,
      hide_closed_list: true,
    })
    if (answer.status !== 200) throw failure(answer, at)
  }

  /** One issue board per view, `<title> · <view>`; the first one's id the board's number. */
  async createBoard(
    org: string,
    title: string,
    views: readonly string[]
  ): Promise<Board> {
    const ids: Record<string, number> = {}
    for (const view of views)
      ids[view] = await this.#createIssueBoard(org, `${title} · ${view}`)
    return boardOf(org, ids, title)
  }

  /** The board of `ids`, those GitLab still has; null when it has none of them. */
  async board(
    org: string,
    ids: Readonly<Record<string, number>>
  ): Promise<Board | null> {
    const there = await this.#boards(org)
    const kept: Record<string, number> = {}
    for (const [view, id] of Object.entries(ids))
      if (there.some((b) => b.id === id)) kept[view] = id
    if (Object.keys(ids).length > 0 && Object.keys(kept).length === 0)
      return null
    const first = there.find((b) => b.id === Object.values(kept)[0])
    const title = first?.name.split(' · ')[0] ?? 'rness'
    return boardOf(org, kept, title)
  }

  /** The context project's labels by name, read once per organization. */
  async #labelIds(org: string): Promise<Map<string, number>> {
    let ids = this.#labels.get(org)
    if (ids === undefined) {
      ids = new Map(
        (await gi.labels(this.#project(org), this.#o)).map((l) => [
          l.name,
          l.id,
        ])
      )
      this.#labels.set(org, ids)
    }
    return ids
  }

  async ensureLayout(board: Board, layout: Layout): Promise<string[]> {
    const cache = this.#cacheOf(board)
    cache.layout = layout
    const project = this.#project(board.org)
    const added: string[] = []

    // The labels: rness's own, then a scoped label per option of every
    // select, then the collections' plain ones.
    const ids = await this.#labelIds(board.org)
    const made: string[] = []
    const ensure = async (
      name: string,
      color: string,
      description?: string
    ): Promise<void> => {
      if (ids.has(name)) return
      ids.set(
        name,
        await gi.createLabel(
          project,
          {
            name,
            color,
            ...(description === undefined ? {} : { description }),
          },
          this.#o
        )
      )
      made.push(name)
    }
    await ensure(LABEL, LABEL_COLOR, LABEL_DESCRIPTION)
    const selects = selectsOf(layout)
    for (const s of selects)
      for (const option of s.options)
        await ensure(
          scoped(s.name, option),
          HEX[optionColor(layout.colors, s.kind, option) ?? 'gray']
        )
    for (const name of layout.labels) await ensure(name, OWN_LABEL_COLOR)
    if (made.length > 0) added.push(`label ${labelSummary(made)}`)

    // A board per `board` view; its lists the labels of its columns.
    const there = await this.#boards(board.org)
    const title = board.title ?? 'rness'
    const next: Record<string, number> = { ...(board.ids ?? {}) }
    for (const view of layout.views) {
      if (view.layout === 'table') {
        added.push(
          `note view ${view.name}: a table is not a board on GitLab - ${issuesUrl(board.org, view, layout)}`
        )
        continue
      }
      if (view.layout === 'roadmap') {
        added.push(`note view ${view.name}: GitLab has no roadmap for issues`)
        continue
      }
      let issueBoard = there.find((b) => b.id === next[view.name])
      if (issueBoard === undefined) {
        const id = await this.#createIssueBoard(
          board.org,
          `${title} · ${view.name}`
        )
        next[view.name] = id
        issueBoard = {
          id,
          name: `${title} · ${view.name}`,
          hideBacklog: true,
          hideClosed: true,
          lists: [],
        }
        added.push(`view ${view.name}`)
      } else if (!issueBoard.hideBacklog || !issueBoard.hideClosed)
        await this.#hideLists(board.org, issueBoard.id)
      const columns = view.columns ?? STATUS
      if (view.filter !== null && columns === STATUS)
        added.push(
          `note view ${view.name}: a board scoped by a filter is GitLab Premium: its filter is dropped`
        )
      if (columns === STATUS && collectionsOf(layout) > 1)
        added.push(
          `note view ${view.name}: its Status lists show the cards of every collection`
        )
      const wanted = (
        selects.find((s) => s.name === columns)?.options ?? []
      ).map((o) => scoped(columns, o))
      await this.#lists(board.org, issueBoard, wanted, ids)
    }
    if (JSON.stringify(next) !== JSON.stringify(board.ids ?? {})) {
      board.ids = next
      const first = Object.values(next)[0]
      if (first !== undefined) board.url = gitlabBoardUrl(board.org, first)
    }
    return added
  }

  /** A board's lists: one per wanted label, in order; a list of a label of the same key not wanted, deleted. */
  async #lists(
    org: string,
    board: IssueBoard,
    wanted: readonly string[],
    ids: ReadonlyMap<string, number>
  ): Promise<void> {
    const base = `/projects/${segment(this.#project(org))}/boards/${board.id}/lists`
    const key = wanted[0] === undefined ? null : split(wanted[0])?.key
    const lists = [...board.lists]
    for (const list of board.lists)
      if (
        key !== null &&
        key !== undefined &&
        split(list.label)?.key === key &&
        !wanted.includes(list.label)
      ) {
        const at = `${base}/${list.id}`
        const answer = await gitlabCall('DELETE', at, this.#o)
        if (answer.status !== 204 && answer.status !== 200)
          throw failure(answer, at)
        lists.splice(lists.indexOf(list), 1)
      }
    for (const name of wanted) {
      if (lists.some((l) => l.label === name)) continue
      const labelId = ids.get(name)
      if (labelId === undefined) continue
      const answer = await gitlabCall('POST', base, this.#o, {
        label_id: labelId,
      })
      const id = field(answer.body, 'id')
      if (answer.status !== 201 || typeof id !== 'number')
        throw failure(answer, base)
      lists.push({ id, position: lists.length, label: name })
    }
    // In the declared order.
    const order = wanted.filter((n) => lists.some((l) => l.label === n))
    const sorted = [...lists]
      .filter((l) => order.includes(l.label))
      .sort((a, b) => a.position - b.position)
    for (const [position, name] of order.entries()) {
      const list = sorted.find((l) => l.label === name)
      if (list === undefined || sorted.indexOf(list) === position) continue
      const at = `${base}/${list.id}`
      const answer = await gitlabCall('PUT', at, this.#o, { position })
      if (answer.status !== 200) throw failure(answer, at)
      sorted.splice(sorted.indexOf(list), 1)
      sorted.splice(position, 0, list)
    }
  }

  async items(
    board: Board,
    options: { bodies?: boolean } = {}
  ): Promise<BoardItem[]> {
    const cache = this.#cacheOf(board)
    const issues = await gi.listIssues(
      this.#project(board.org),
      { labels: [LABEL], state: 'all' },
      this.#o
    )
    // On a workspace of several boards, a card is this board's when it
    // carries one of its collections' status labels.
    const scopes =
      cache.layout === undefined ? null : memberScopes(cache.layout)
    const mine = issues.filter(
      (i) =>
        scopes === null ||
        i.labels.some((l) => {
          const s = split(l)
          return s !== null && scopes.has(s.key)
        })
    )
    cache.known = new Map(mine.map((i) => [String(i.iid), { issue: i }]))
    return mine.map((i) => itemOf(i, options.bodies !== false))
  }

  async #known(board: Board, id: string): Promise<gi.GitlabIssue> {
    const cache = this.#cacheOf(board)
    const hit = cache.known.get(id)
    if (hit !== undefined) return hit.issue
    const found = await gi.issue(this.#project(board.org), Number(id), this.#o)
    if (found === null) throw new Error(`the board has no item ${id}`)
    cache.known.set(id, { issue: found })
    return found
  }

  #remember(board: Board, issue: gi.GitlabIssue): void {
    this.#cacheOf(board).known.set(String(issue.iid), { issue })
  }

  async apply(board: Board, step: Step): Promise<Placed | null> {
    const project = this.#project(board.org)
    const layout = this.#cacheOf(board).layout ?? null
    if (step.kind === 'unchanged') return null
    if (step.kind === 'convert' || step.kind === 'archive')
      // GitLab never had 0.12.0's drafts (spec 0037 §6).
      throw new Error(`a ${step.kind} step has no meaning on GitLab`)
    if (step.kind === 'create') {
      const issue = await gi.createIssue(
        project,
        {
          title: step.want.title,
          description: withFooter(
            step.want.body,
            footerOf(step.want, layout),
            FOOTER_ORDER
          ),
          labels: [LABEL, ...labelsOf(step.want, layout)],
        },
        this.#o
      )
      this.#remember(board, issue)
      return { id: String(issue.iid), number: issue.iid }
    }
    const issue = await this.#known(board, step.id)
    if (step.kind === 'close') {
      // A document gone: its issue closed (GitLab has no "not planned").
      if (issue.state === 'opened')
        this.#remember(
          board,
          await gi.updateIssue(
            project,
            issue.iid,
            { stateEvent: 'close' },
            this.#o
          )
        )
      return null
    }
    if (step.kind === 'remove') {
      // Its collection's own board holds it: this board's labels off, the issue left.
      const scopes = layout === null ? new Set<string>() : memberScopes(layout)
      const off = issue.labels.filter((l) => {
        const s = split(l)
        return s !== null && scopes.has(s.key)
      })
      if (off.length > 0)
        this.#remember(
          board,
          await gi.updateIssue(
            project,
            issue.iid,
            { removeLabels: off },
            this.#o
          )
        )
      return null
    }
    const { body, values } = splitFooter(issue.description)
    if (step.kind === 'body') {
      // The footer stays below the new body (spec 0037 §7.3).
      this.#remember(
        board,
        await gi.updateIssue(
          project,
          issue.iid,
          { description: withFooter(step.body, values, FOOTER_ORDER) },
          this.#o
        )
      )
      return null
    }
    // update: the title, the labels and their siblings, the footer, the state.
    const want = step.want
    const wanted = [LABEL, ...labelsOf(want, layout)]
    const carried = issue.labels
    const add = wanted.filter(
      (w) => !carried.some((c) => c.toLowerCase() === w.toLowerCase())
    )
    const keys = new Set(
      [...wanted, ...nulledKeys(want, layout)].flatMap((w) => {
        const s = split(w)
        return s === null ? [] : [s.key]
      })
    )
    const remove = carried.filter((c) => {
      const s = split(c)
      if (s !== null && keys.has(s.key) && !wanted.includes(c)) return true
      return want.unlabels.some((u) => u.toLowerCase() === c.toLowerCase())
    })
    const footer = { ...values, ...footerOf(want, layout) }
    const description = withFooter(body, footer, FOOTER_ORDER)
    const change: gi.IssueChange = {
      ...(issue.title === want.title ? {} : { title: want.title }),
      ...(add.length === 0 ? {} : { addLabels: add }),
      ...(remove.length === 0 ? {} : { removeLabels: remove }),
      ...(description === issue.description.replace(/\r\n?/g, '\n').trimEnd()
        ? {}
        : { description }),
      ...(step.reopen ? { stateEvent: 'reopen' as const } : {}),
    }
    if (Object.keys(change).length > 0)
      this.#remember(
        board,
        await gi.updateIssue(project, issue.iid, change, this.#o)
      )
    return null
  }

  async mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null,
    fields: MarkFields = { agent: 'Agent', session: WORKING_SESSION }
  ): Promise<void> {
    const project = this.#project(board.org)
    for (const id of itemIds) {
      const issue = await this.#known(board, id)
      const agentLabels = issue.labels.filter(
        (l) => split(l)?.key === fields.agent
      )
      const working = scoped(fields.agent, WORKING)
      const add =
        session === null || agentLabels.includes(working) ? [] : [working]
      const remove =
        session === null
          ? agentLabels
          : agentLabels.filter((l) => l !== working)
      const { body, values } = splitFooter(issue.description)
      const footer =
        fields.session === null
          ? values
          : { ...values, [fields.session]: session ?? '' }
      const description = withFooter(body, footer, FOOTER_ORDER)
      const change: gi.IssueChange = {
        ...(add.length === 0 ? {} : { addLabels: add }),
        ...(remove.length === 0 ? {} : { removeLabels: remove }),
        ...(description === issue.description.replace(/\r\n?/g, '\n').trimEnd()
          ? {}
          : { description }),
      }
      if (Object.keys(change).length > 0)
        this.#remember(
          board,
          await gi.updateIssue(project, issue.iid, change, this.#o)
        )
    }
  }
}

/** A rness board on GitLab: the first view's issue board is its link (decided 2026-10-19). */
function boardOf(
  org: string,
  ids: Readonly<Record<string, number>>,
  title: string
): Board {
  const first = Object.values(ids)[0] ?? 0
  return {
    org,
    number: first,
    url:
      first === 0
        ? `https://gitlab.com/${org}/${CONTEXT}/-/issues`
        : gitlabBoardUrl(org, first),
    ids: { ...ids },
    title,
  }
}

interface Select {
  name: string
  kind: 'status' | 'collection' | 'declared'
  options: string[]
}

/** Every select of the layout, `Status` first: what scoped labels are made of. */
function selectsOf(layout: Layout): Select[] {
  return [
    { name: STATUS, kind: 'status', options: layout.statuses },
    ...layout.fields.flatMap((f) =>
      f.type === 'select'
        ? [{ name: f.name, kind: f.kind, options: f.options }]
        : []
    ),
  ]
}

const collectionsOf = (layout: Layout): number =>
  layout.fields.find((f) => f.type === 'select' && f.kind === 'collection')
    ?.type === 'select'
    ? (layout.fields.find(
        (f): f is Extract<typeof f, { type: 'select' }> =>
          f.type === 'select' && f.kind === 'collection'
      )?.options.length ?? 0)
    : 0

/**
 * The keys whose labels make a card this board's: its collections' status
 * fields (`ADR status`); a board without one, `Status`.
 */
function memberScopes(layout: Layout): Set<string> {
  const own = layout.fields.flatMap((f) =>
    f.type === 'select' && f.kind === 'status' ? [f.name] : []
  )
  return new Set(own.length > 0 ? own : [STATUS])
}

const isSelect = (layout: Layout | null, name: string): boolean =>
  name === STATUS ||
  (layout?.fields.some((f) => f.name === name && f.type === 'select') ?? false)

/** The labels a document's card carries besides `rness`: its status, its selects, its collection's own. */
function labelsOf(want: Desired, layout: Layout | null): string[] {
  const out: string[] = []
  if (want.status !== null) out.push(scoped(STATUS, want.status))
  if (want.statusField !== null && want.status !== null)
    out.push(scoped(want.statusField, want.status))
  for (const [name, value] of Object.entries(want.values))
    if (value !== null && isSelect(layout, name)) out.push(scoped(name, value))
  out.push(...want.labels)
  return [...new Set(out)]
}

/** The keys of the selects a document has no value for: their labels come off. */
function nulledKeys(want: Desired, layout: Layout | null): string[] {
  return Object.entries(want.values).flatMap(([name, value]) =>
    value === null && isSelect(layout, name) ? [scoped(name, '')] : []
  )
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

/** `labels rness, Status (12), ADR status (4)`: the labels made, by key. */
function labelSummary(made: readonly string[]): string {
  const plain: string[] = []
  const byKey = new Map<string, number>()
  for (const name of made) {
    const s = split(name)
    if (s === null) plain.push(name)
    else byKey.set(s.key, (byKey.get(s.key) ?? 0) + 1)
  }
  return [...plain, ...[...byKey].map(([k, n]) => `${k} (${n})`)].join(', ')
}

/**
 * A table view as GitLab's issue list: the cards, and the labels its filter
 * names (`agent:working` is `Agent::working`), printed once.
 */
function issuesUrl(org: string, view: LayoutView, layout: Layout): string {
  const labels = [LABEL]
  for (const m of (view.filter ?? '').matchAll(/(\w[\w ]*?):"?([^"\s]+)"?/g)) {
    const key = selectsOf(layout).find(
      (s) => s.name.toLowerCase() === (m[1] ?? '').toLowerCase()
    )?.name
    if (key !== undefined && m[2] !== undefined) labels.push(scoped(key, m[2]))
  }
  return `https://gitlab.com/${org}/${CONTEXT}/-/issues/?${labels.map((l) => `label_name[]=${encodeURIComponent(l)}`).join('&')}`
}

/** An issue as a card: its path from its first line, its values from its scoped labels and its footer. */
function itemOf(issue: gi.GitlabIssue, bodies: boolean): BoardItem {
  const { body, values: footer } = splitFooter(issue.description)
  const path = PATH_LINE.exec(body)?.[1] ?? null
  const values: Record<string, string> = { ...footer }
  for (const l of issue.labels) {
    const s = split(l)
    if (s !== null) values[s.key] = s.value
  }
  if (path !== null) values['Path'] = path
  const collection = values['Collection'] ?? null
  return {
    id: String(issue.iid),
    path,
    issue: {
      number: issue.iid,
      open: issue.state === 'opened',
      labelled: issue.labels.some((l) => l.toLowerCase() === LABEL),
      body: bodies ? body : null,
      labels: [...issue.labels],
    },
    title: issue.title,
    status: values[STATUS] ?? null,
    collectionStatus:
      collection === null ? null : (values[`${collection} status`] ?? null),
    type: collection,
    agent: values['Agent'] ?? null,
    session: values[WORKING_SESSION] ?? null,
    sessions: values['Session history'] ?? null,
    values,
  }
}
