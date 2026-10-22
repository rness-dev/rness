import { type JiraApiOptions, jiraFailure, jiraRequest } from './jira.ts'

// A Jira space's statuses, its workflow and its board (spec 0039 §7.2),
// as plan 0053 task 1 saw a team-managed Kanban space answer. A status is
// picked by id; its name here is the untranslated one `statuses/search`
// gives, never what an issue shows on a site in another language.

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null

export type StatusCategory = 'TODO' | 'IN_PROGRESS' | 'DONE'

export interface SpaceStatus {
  id: string
  name: string
  category: StatusCategory
}

const category = (v: unknown): StatusCategory =>
  v === 'DONE' ? 'DONE' : v === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'TODO'

/** The statuses of a team-managed space, by id, untranslated name and category. */
export async function spaceStatuses(
  projectId: string,
  o: JiraApiOptions
): Promise<SpaceStatus[]> {
  const path = '/rest/api/3/statuses/search'
  const q = new URLSearchParams({ projectId, maxResults: '200' })
  const answer = await jiraRequest('GET', `${path}?${q}`, o)
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const values = field(answer.body, 'values')
  return (Array.isArray(values) ? values : []).flatMap((v) => {
    const id = str(field(v, 'id'))
    const name = str(field(v, 'name'))
    return id === null || name === null
      ? []
      : [{ id, name, category: category(field(v, 'statusCategory')) }]
  })
}

/** New statuses of the space (`PROJECT` scope): their ids. A name taken, whatever its case, fails the batch (task 1). */
export async function createStatuses(
  projectId: string,
  statuses: readonly { name: string; category: StatusCategory }[],
  o: JiraApiOptions
): Promise<SpaceStatus[]> {
  const path = '/rest/api/3/statuses'
  const answer = await jiraRequest('POST', path, o, {
    scope: { type: 'PROJECT', project: { id: projectId } },
    statuses: statuses.map((s) => ({
      name: s.name,
      statusCategory: s.category,
      description: '',
    })),
  })
  if (answer.status !== 200 && answer.status !== 201)
    throw jiraFailure(o, answer, path)
  const made = Array.isArray(answer.body) ? answer.body : []
  return statuses.map((s) => {
    const found = made.find(
      (m) => str(field(m, 'name'))?.toLowerCase() === s.name.toLowerCase()
    )
    const id = str(field(found, 'id'))
    if (id === null) throw new Error(`${o.site} made no status ${s.name}`)
    return { id, name: s.name, category: s.category }
  })
}

/** Statuses renamed: their ids, their columns and their issues kept (task 1, 2026-10-21). */
export async function renameStatuses(
  statuses: readonly SpaceStatus[],
  o: JiraApiOptions
): Promise<void> {
  const path = '/rest/api/3/statuses'
  const answer = await jiraRequest('PUT', path, o, {
    statuses: statuses.map((s) => ({
      id: s.id,
      name: s.name,
      statusCategory: s.category,
      description: '',
    })),
  })
  if (answer.status !== 204 && answer.status !== 200)
    throw jiraFailure(o, answer, path)
}

/** The statuses a GLOBAL transition of the workflow of the space's `issueTypeId` leads to. */
export async function workflowStatuses(
  projectId: string,
  issueTypeId: string,
  o: JiraApiOptions
): Promise<{ global: Set<string> }> {
  const path = '/rest/api/3/workflows'
  const read = await jiraRequest('POST', path, o, {
    projectAndIssueTypes: [{ projectId, issueTypeId }],
  })
  if (read.status !== 200) throw jiraFailure(o, read, path)
  const workflows = field(read.body, 'workflows')
  const w = Array.isArray(workflows) ? workflows[0] : undefined
  const transitions = (field(w, 'transitions') as unknown[] | undefined) ?? []
  return {
    global: new Set(
      transitions.flatMap((t) =>
        field(t, 'type') === 'GLOBAL'
          ? [str(field(t, 'toStatusReference')) ?? '']
          : []
      )
    ),
  }
}

/**
 * Each of `statusIds` in the workflow of the space's `issueTypeId`, with a
 * `GLOBAL` transition to it, so any status reaches any other in one call
 * (spec 0039 §6). The workflow is read right before it is updated (its
 * version must be current); each status already there is sent with its
 * `id`, else Jira takes it for a new one (task 1). Returns the statuses a
 * transition was added to; nothing missing, nothing sent.
 */
export async function addGlobalTransitions(
  projectId: string,
  issueTypeId: string,
  statusIds: readonly string[],
  o: JiraApiOptions
): Promise<string[]> {
  const readPath = '/rest/api/3/workflows'
  const read = await jiraRequest('POST', readPath, o, {
    projectAndIssueTypes: [{ projectId, issueTypeId }],
  })
  if (read.status !== 200) throw jiraFailure(o, read, readPath)
  const workflows = field(read.body, 'workflows')
  const w = Array.isArray(workflows) ? workflows[0] : undefined
  if (w === undefined)
    throw new Error(`${o.site} has no workflow for the space's Task`)
  const inWorkflow = new Set(
    ((field(w, 'statuses') as unknown[] | undefined) ?? []).flatMap((s) => {
      const ref = str(field(s, 'statusReference'))
      return ref === null ? [] : [ref]
    })
  )
  const transitions = (field(w, 'transitions') as unknown[] | undefined) ?? []
  const reached = new Set(
    transitions.flatMap((t) =>
      field(t, 'type') === 'GLOBAL'
        ? [str(field(t, 'toStatusReference')) ?? '']
        : []
    )
  )
  const missing = statusIds.filter((id) => !reached.has(id))
  if (missing.length === 0) return []
  const top = Math.max(
    0,
    ...transitions.map((t) => Number(str(field(t, 'id')) ?? 0) || 0)
  )
  const known = new Set(
    ((field(read.body, 'statuses') as unknown[] | undefined) ?? []).map((s) =>
      str(field(s, 'id'))
    )
  )
  const names = new Map<string, string>()
  const listed = (field(read.body, 'statuses') as unknown[] | undefined) ?? []
  for (const s of listed) {
    const id = str(field(s, 'id'))
    const name = str(field(s, 'name'))
    if (id !== null && name !== null) names.set(id, name)
  }
  const add = missing.filter((id) => !inWorkflow.has(id))
  const statuses = [
    ...listed,
    // A status the read does not list yet (made in this run): by reference alone.
    ...missing
      .filter((id) => !known.has(id))
      .map((id) => ({ id, statusReference: id })),
  ]
  const path = '/rest/api/3/workflows/update'
  const answer = await jiraRequest('POST', path, o, {
    statuses,
    workflows: [
      {
        id: field(w, 'id'),
        version: field(w, 'version'),
        statuses: [
          ...((field(w, 'statuses') as unknown[] | undefined) ?? []),
          ...add.map((id) => ({ statusReference: id, properties: {} })),
        ],
        transitions: [
          ...transitions,
          ...missing.map((id, i) => ({
            id: String(top + 10 * (i + 1)),
            name: names.get(id) ?? id,
            type: 'GLOBAL',
            toStatusReference: id,
            links: [],
            actions: [],
            validators: [],
            triggers: [],
            properties: {},
          })),
        ],
      },
    ],
  })
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  return missing
}

/** The space's one board (a team-managed space has exactly one): its id and name; null when it has none. */
export async function spaceBoard(
  key: string,
  o: JiraApiOptions
): Promise<{ id: number; name: string } | null> {
  const path = '/rest/agile/1.0/board'
  const q = new URLSearchParams({ projectKeyOrId: key })
  const answer = await jiraRequest('GET', `${path}?${q}`, o)
  if (answer.status === 404) return null
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const values = field(answer.body, 'values')
  const first = Array.isArray(values) ? values[0] : undefined
  const id = field(first, 'id')
  if (typeof id !== 'number') return null
  return { id, name: str(field(first, 'name')) ?? key }
}

/** The board's columns, each with the ids of its statuses; a status in none is hidden (task 1, 2026-10-23). */
export async function columns(
  boardId: number,
  o: JiraApiOptions
): Promise<{ name: string; statuses: string[] }[]> {
  const path = `/rest/agile/1.0/board/${boardId}/configuration`
  const answer = await jiraRequest('GET', path, o)
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const listed = field(field(answer.body, 'columnConfig'), 'columns')
  return (Array.isArray(listed) ? listed : []).map((c) => ({
    name: str(field(c, 'name')) ?? '',
    statuses: ((field(c, 'statuses') as unknown[] | undefined) ?? []).flatMap(
      (s) => {
        const id = str(field(s, 'id'))
        return id === null ? [] : [id]
      }
    ),
  }))
}

const BACKLOG = 'jsw.agility.backlog'

/** Whether the board's Backlog is on: issues created by API land there, not on the board (spec 0039 §1). */
export async function backlogOn(
  boardId: number,
  o: JiraApiOptions
): Promise<boolean> {
  const path = `/rest/agile/1.0/board/${boardId}/features`
  const answer = await jiraRequest('GET', path, o)
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const features = field(answer.body, 'features')
  return (Array.isArray(features) ? features : []).some(
    (f) => field(f, 'feature') === BACKLOG && field(f, 'state') === 'ENABLED'
  )
}

/** The board's Backlog switched on or off (task 1: `enabling`, 200). */
export async function setBacklog(
  boardId: number,
  on: boolean,
  o: JiraApiOptions
): Promise<void> {
  const path = `/rest/agile/1.0/board/${boardId}/features`
  const answer = await jiraRequest('PUT', path, o, {
    boardId,
    feature: BACKLOG,
    enabling: on,
  })
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
}
