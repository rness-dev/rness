import type { TestContext } from 'node:test'

import type { AdfDocument } from '../../src/board/adf.ts'
import type { Recorded, Reply } from './fake-github.ts'
import { fakeJira } from './fake-jira.ts'

/**
 * A Jira site holding one team-managed Kanban space, with state: its
 * statuses, its workflow, its one board, its issues. Enough REST v3 and
 * Agile 1.0 for `rness board push`, the hooks and `rness note` on Atlassian
 * (spec 0039 §6, §7), answering as plan 0053 task 1 saw
 * rness-dev.atlassian.net answer: a status added to the workflow gets its
 * own column while the board is simple, none once a status is hidden;
 * names are unique whatever their case; a workflow update needs the
 * current version and each status already there with its id. Every request
 * is recorded.
 */
export interface FakeStatus {
  id: string
  name: string
  category: 'TODO' | 'IN_PROGRESS' | 'DONE'
}

export interface FakeJiraIssue {
  key: string
  summary: string
  labels: string[]
  statusId: string
  description: AdfDocument | null
  properties: Record<string, unknown>
  comments: AdfDocument[]
}

export interface JiraSite {
  base: string
  requests: Recorded[]
  statuses: FakeStatus[]
  /** The workflow's statuses and GLOBAL transitions, by status id. */
  workflow: { version: number; statuses: string[]; global: Map<string, string> }
  columns: { name: string; statuses: string[] }[]
  backlog: boolean
  issues: FakeJiraIssue[]
  links: { inward: string; outward: string }[]
  /** Hides a status, as the team does in the board's column settings: the board turns advanced. */
  hide(name: string): void
  /** Writes to issues: what a second push must not make. */
  issueWrites(): Recorded[]
}

const TEMPLATE: FakeStatus[] = [
  { id: '10008', name: 'To Do', category: 'TODO' },
  { id: '10009', name: 'In Progress', category: 'IN_PROGRESS' },
  { id: '10011', name: 'In Review', category: 'IN_PROGRESS' },
  { id: '10010', name: 'Done', category: 'DONE' },
]

const CATEGORY_KEY = { TODO: 'new', IN_PROGRESS: 'indeterminate', DONE: 'done' }

export async function jiraSite(
  t: TestContext,
  options: { space?: string; statuses?: FakeStatus[]; canEdit?: boolean } = {}
): Promise<JiraSite> {
  const space = options.space ?? 'RNESS'
  const projectId = '10002'
  let nextStatus = 10012
  let nextTransition = 100
  const state = {
    statuses: (options.statuses ?? TEMPLATE).map((s) => ({ ...s })),
    workflow: {
      version: 0,
      statuses: [] as string[],
      global: new Map<string, string>(),
    },
    columns: [] as { name: string; statuses: string[] }[],
    advanced: false,
    backlog: false,
    issues: [] as FakeJiraIssue[],
    links: [] as { inward: string; outward: string }[],
  }
  for (const s of state.statuses) {
    state.workflow.statuses.push(s.id)
    state.workflow.global.set(s.id, String(nextTransition++))
    state.columns.push({ name: s.name, statuses: [s.id] })
  }
  const status = (id: string): FakeStatus | undefined =>
    state.statuses.find((s) => s.id === id)
  const taken = (name: string, except?: string): boolean =>
    state.statuses.some(
      (s) => s.id !== except && s.name.toLowerCase() === name.toLowerCase()
    )
  const issueJson = (i: FakeJiraIssue, properties: string[]) => {
    const s = status(i.statusId)
    return {
      key: i.key,
      fields: {
        summary: i.summary,
        labels: i.labels,
        description: i.description,
        status: {
          id: i.statusId,
          name: s?.name,
          statusCategory: { key: CATEGORY_KEY[s?.category ?? 'TODO'] },
        },
      },
      properties: Object.fromEntries(
        properties.flatMap((p) =>
          Object.hasOwn(i.properties, p) ? [[p, i.properties[p]]] : []
        )
      ),
    }
  }
  /** The JQL rness writes: `project = "X"`, `labels = "x"`, `statusCategory != Done`, joined by AND. */
  const matches = (jql: string, i: FakeJiraIssue): boolean =>
    jql.split(/\s+AND\s+/).every((clause) => {
      const m = /^(\w+)\s*(!?=)\s*"?([^"]*)"?$/.exec(clause.trim())
      if (m === null) return false
      const [, key, op, value] = m
      const yes =
        key === 'project'
          ? value === space
          : key === 'labels'
            ? i.labels.includes(value ?? '')
            : key === 'statusCategory'
              ? status(i.statusId)?.category === 'DONE'
              : false
      return op === '=' ? yes : !yes
    })

  const route = (r: Recorded): Reply => {
    const url = new URL(r.path, 'http://x')
    const path = url.pathname
    const body = (r.body ?? {}) as Record<string, unknown>
    if (path === '/rest/api/3/myself')
      return { json: { displayName: 'Cédric Magne', accountId: 'acc-1' } }
    if (path === `/rest/api/3/project/${space}`)
      return { json: { id: projectId, key: space } }
    if (path === '/rest/api/3/mypermissions') {
      const have = options.canEdit !== false
      return {
        json: {
          permissions: {
            CREATE_ISSUES: { havePermission: true },
            EDIT_ISSUES: { havePermission: have },
            TRANSITION_ISSUES: { havePermission: true },
          },
        },
      }
    }
    if (path === `/rest/api/3/issue/createmeta/${space}/issuetypes`)
      return {
        json: {
          issueTypes: [
            { id: '10010', name: 'Epic', hierarchyLevel: 1 },
            { id: '10012', name: 'Tâche', hierarchyLevel: 0 },
            { id: '10013', name: 'Story', hierarchyLevel: 0 },
          ],
        },
      }
    if (path === '/rest/api/3/statuses/search')
      return {
        json: {
          values: state.statuses.map((s) => ({
            id: s.id,
            name: s.name,
            statusCategory: s.category,
          })),
          isLast: true,
        },
      }
    if (path === '/rest/api/3/statuses') {
      const listed = (body['statuses'] ?? []) as {
        id?: string
        name: string
        statusCategory: FakeStatus['category']
      }[]
      if (r.method === 'PUT') {
        for (const s of listed)
          if (taken(s.name, s.id))
            return {
              status: 400,
              json: {
                errorMessages: [
                  `Le nom d'état « ${s.name} » est déjà utilisé.`,
                ],
              },
            }
        for (const s of listed) {
          const there = status(s.id ?? '')
          if (there !== undefined) {
            there.name = s.name
            there.category = s.statusCategory
          }
        }
        return { status: 204, json: {} }
      }
      for (const s of listed)
        if (taken(s.name))
          return {
            status: 400,
            json: {
              errorMessages: [`Le nom d'état « ${s.name} » est déjà utilisé.`],
            },
          }
      const made = listed.map((s) => ({
        id: String(nextStatus++),
        name: s.name,
        category: s.statusCategory,
      }))
      state.statuses.push(...made)
      return { json: made.map((s) => ({ id: s.id, name: s.name })) }
    }
    if (path === '/rest/api/3/workflows')
      return {
        json: {
          statuses: state.statuses.map((s) => ({
            id: s.id,
            statusReference: s.id,
            name: s.name,
            statusCategory: s.category,
            description: '',
          })),
          workflows: [
            {
              id: 'wf-1',
              version: { versionNumber: state.workflow.version, id: 'v' },
              statuses: state.workflow.statuses.map((id) => ({
                statusReference: id,
                properties: {},
              })),
              transitions: [
                {
                  id: '1',
                  name: 'Create',
                  type: 'INITIAL',
                  toStatusReference: '10008',
                },
                ...[...state.workflow.global].map(([to, id]) => ({
                  id,
                  name: status(to)?.name ?? to,
                  type: 'GLOBAL',
                  toStatusReference: to,
                })),
              ],
            },
          ],
        },
      }
    if (path === '/rest/api/3/workflows/update') {
      const tops = (body['statuses'] ?? []) as {
        id?: string
        statusReference: string
      }[]
      if (
        tops.some(
          (s) => s.id === undefined && status(s.statusReference) !== undefined
        )
      )
        return {
          status: 400,
          json: {
            errorMessages: [
              `La référence ${tops[0]?.statusReference} n'est pas un UUID.`,
            ],
          },
        }
      const w =
        ((body['workflows'] ?? []) as Record<string, unknown>[])[0] ?? {}
      const version = (w['version'] as { versionNumber?: number } | undefined)
        ?.versionNumber
      if (version !== state.workflow.version)
        return {
          status: 409,
          json: { errorMessages: ['The workflow has changed.'] },
        }
      const statuses = (
        (w['statuses'] ?? []) as { statusReference: string }[]
      ).map((s) => s.statusReference)
      const transitions = (w['transitions'] ?? []) as {
        id: string
        type: string
        toStatusReference: string
      }[]
      for (const id of statuses)
        if (!state.workflow.statuses.includes(id)) {
          state.workflow.statuses.push(id)
          // A simple board gives a new status its own column; an advanced one none.
          if (!state.advanced)
            state.columns.push({ name: status(id)?.name ?? id, statuses: [id] })
        }
      for (const tr of transitions)
        if (tr.type === 'GLOBAL')
          state.workflow.global.set(tr.toStatusReference, tr.id)
      state.workflow.version++
      // A simple board's columns carry their statuses' names.
      if (!state.advanced)
        for (const c of state.columns)
          if (c.statuses.length === 1)
            c.name = status(c.statuses[0] ?? '')?.name ?? c.name
      return {
        json: {
          workflows: [{ version: { versionNumber: state.workflow.version } }],
        },
      }
    }
    if (path === '/rest/agile/1.0/board')
      return {
        json: {
          values:
            url.searchParams.get('projectKeyOrId') === space
              ? [{ id: 3, name: `${space} board`, type: 'simple' }]
              : [],
        },
      }
    if (path === '/rest/agile/1.0/board/3/configuration')
      return {
        json: {
          columnConfig: {
            columns: state.columns.map((c) => ({
              name: c.name,
              statuses: c.statuses.map((id) => ({ id })),
            })),
          },
        },
      }
    if (path === '/rest/agile/1.0/board/3/features') {
      if (r.method === 'PUT') state.backlog = body['enabling'] === true
      return {
        json: {
          features: [
            {
              feature: 'jsw.agility.backlog',
              state: state.backlog ? 'ENABLED' : 'DISABLED',
            },
          ],
        },
      }
    }
    if (path === '/rest/api/3/search/jql') {
      const jql = url.searchParams.get('jql') ?? ''
      const properties = (url.searchParams.get('properties') ?? '')
        .split(',')
        .filter((p) => p !== '')
      return {
        json: {
          issues: state.issues
            .filter((i) => matches(jql, i))
            .map((i) => issueJson(i, properties)),
          isLast: true,
        },
      }
    }
    if (path === '/rest/api/3/issue' && r.method === 'POST') {
      const fields = (body['fields'] ?? {}) as Record<string, unknown>
      const labels = (fields['labels'] ?? []) as string[]
      if (labels.some((l) => /\s/.test(l)))
        return {
          status: 400,
          json: { errors: { labels: 'a label holds no space' } },
        }
      const issue: FakeJiraIssue = {
        key: `${space}-${state.issues.length + 1}`,
        summary: String(fields['summary'] ?? ''),
        labels: [...labels],
        statusId: '10008',
        description: (fields['description'] as AdfDocument | undefined) ?? null,
        properties: {},
        comments: [],
      }
      state.issues.push(issue)
      return { status: 201, json: { id: '1', key: issue.key } }
    }
    if (path === '/rest/api/3/issueLink') {
      state.links.push({
        inward: String(
          (body['inwardIssue'] as { key?: string } | undefined)?.key
        ),
        outward: String(
          (body['outwardIssue'] as { key?: string } | undefined)?.key
        ),
      })
      return { status: 201, json: {} }
    }
    const at = new RegExp(
      `^/rest/api/3/issue/(${space}-\\d+)(?:/(\\w+)(?:/(\\w+))?)?$`
    ).exec(path)
    if (at !== null) {
      const issue = state.issues.find((i) => i.key === at[1])
      if (issue === undefined) return { status: 404, json: {} }
      const [, , sub, name] = at
      if (sub === undefined) {
        if (r.method === 'GET') return { json: issueJson(issue, []) }
        const fields = (body['fields'] ?? {}) as Record<string, unknown>
        if (typeof fields['summary'] === 'string')
          issue.summary = fields['summary']
        if (fields['description'] !== undefined)
          issue.description = fields['description'] as AdfDocument
        const labels = ((body['update'] as { labels?: unknown[] } | undefined)
          ?.labels ?? []) as { add?: string; remove?: string }[]
        for (const l of labels) {
          if (l.add !== undefined && !issue.labels.includes(l.add))
            issue.labels.push(l.add)
          if (l.remove !== undefined)
            issue.labels = issue.labels.filter((x) => x !== l.remove)
        }
        return { status: 204, json: {} }
      }
      if (sub === 'transitions') {
        if (r.method === 'GET')
          return {
            json: {
              transitions: [...state.workflow.global].map(([to, id]) => ({
                id,
                name: status(to)?.name,
                to: { id: to },
              })),
            },
          }
        const id = (body['transition'] as { id?: string } | undefined)?.id
        const to = [...state.workflow.global].find(([, t]) => t === id)?.[0]
        if (to === undefined)
          return {
            status: 400,
            json: { errorMessages: ['no such transition'] },
          }
        issue.statusId = to
        return { status: 204, json: {} }
      }
      if (sub === 'properties' && name !== undefined) {
        if (r.method === 'PUT') {
          issue.properties[name] = body
          return { status: 200, json: {} }
        }
        return Object.hasOwn(issue.properties, name)
          ? { json: { key: name, value: issue.properties[name] } }
          : { status: 404, json: {} }
      }
      if (sub === 'comment') {
        issue.comments.push(
          (body['body'] as AdfDocument | undefined) ?? {
            version: 1,
            type: 'doc',
            content: [],
          }
        )
        return { status: 201, json: {} }
      }
    }
    return {
      status: 404,
      json: { errorMessages: [`no fake route for ${r.method} ${path}`] },
    }
  }
  const host = await fakeJira(t, route)
  return {
    base: host.base,
    requests: host.requests,
    get statuses() {
      return state.statuses
    },
    get workflow() {
      return state.workflow
    },
    get columns() {
      return state.columns
    },
    get backlog() {
      return state.backlog
    },
    get issues() {
      return state.issues
    },
    get links() {
      return state.links
    },
    hide(name: string) {
      const s = state.statuses.find((x) => x.name === name)
      if (s === undefined) throw new Error(`no status ${name}`)
      state.columns = state.columns
        .map((c) => ({
          ...c,
          statuses: c.statuses.filter((id) => id !== s.id),
        }))
        .filter((c) => c.statuses.length > 0)
      state.advanced = true
    },
    issueWrites: () =>
      host.requests.filter(
        (r) =>
          (r.method === 'POST' || r.method === 'PUT') &&
          /^\/rest\/api\/3\/issue(\/|$)/.test(
            new URL(r.path, 'http://x').pathname
          )
      ),
  }
}
