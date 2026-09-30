import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import type { Recorded, Reply } from './fake-github.ts'
import { fakeGithub } from './fake-github.ts'
import { asked, data, gql } from './github-graphql.ts'

export const TOKEN = {
  token: 'ghu_secret',
  source: 'login',
  login: 'octo',
} as const

export interface FField {
  id: string
  databaseId: number
  name: string
  options: { id: string; name: string; color?: string }[] | null
  /** GitHub's type; absent: SINGLE_SELECT with options, else TEXT. */
  dataType?: string
}
export interface FView {
  id?: string
  name: string
  layout?: 'BOARD_LAYOUT' | 'TABLE_LAYOUT' | 'ROADMAP_LAYOUT'
  /** The field a board's columns follow, by name. */
  column?: string | null
}
/** An issue of a repository: `acme/.rness` unless said otherwise. */
export interface FIssue {
  id: string
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  stateReason?: 'COMPLETED' | 'NOT_PLANNED'
  labels: string[]
  /** `owner/name`. */
  repository: string
}
export interface FItem {
  id: string
  /** A draft's id; null for any other content. */
  draftId: string | null
  /** The issue the item is; absent or null: a draft, or other content (a pull request). */
  issue?: FIssue | null
  /** A draft's title; an issue's is its own. */
  title: string
  archived: boolean
  values: Record<string, string>
}
/** `acme/.rness` as GitHub shows it: there, Issues on, the label `rness` made, the board linked. */
export interface FMemory {
  exists: boolean
  issues: boolean
  label: boolean
  linked: boolean
}

/** A status update of a project (spec 0025 §4). */
export interface FStatusUpdate {
  id: string
  body: string
  status: string | null
  startDate: string | null
  targetDate: string | null
}

/** One project of acme: the seed's is P_1, number 7; others follow. */
export interface FProject {
  id: string
  number: number
  title: string
  fields: FField[]
  viewList: Required<FView>[]
  items: FItem[]
  linked: boolean
  readme: string
  shortDescription: string
  statusUpdates: FStatusUpdate[]
  restViews: unknown[]
}

/** A project to seed next to the first: numbered 8, 9, … unless said. */
export interface FProjectSeed {
  number?: number
  title?: string
  fields?: FField[]
  views?: (string | FView)[]
  items?: FItem[]
  linked?: boolean
  readme?: string
  shortDescription?: string
  statusUpdates?: FStatusUpdate[]
}

const defaultFields = (at: number): FField[] => [
  {
    id: `F_status_${at}`,
    databaseId: at * 1000 + 1,
    name: 'Status',
    options: [{ id: `o_todo_${at}`, name: 'Todo' }],
  },
  {
    id: `F_title_${at}`,
    databaseId: at * 1000 + 2,
    name: 'Title',
    options: null,
  },
]

/** An issue of acme/.rness: open, labelled, no body yet. */
export const anIssue = (
  number: number,
  over: Partial<FIssue> = {}
): FIssue => ({
  id: `ISSUE_${number}`,
  number,
  title: `#${number}`,
  body: '',
  state: 'OPEN',
  labels: ['rness'],
  repository: 'acme/.rness',
  ...over,
})

/** A GitHub project, and acme/.rness's issues, that remember what they were told. */
export async function board(
  t: TestContext,
  seed: {
    fields?: FField[]
    /**
     * A name is a view that is right: a table for `Working`, else a board
     * columned by the collection's own field (`Status` when it has none).
     */
    views?: (string | FView)[]
    /** The view GitHub gives a new project; null: none. */
    defaultView?: { id: string; name: string } | null
    items?: FItem[]
    /** Issues of acme/.rness on no board. */
    issues?: FIssue[]
    /**
     * Items the board's listing leaves out, as GitHub's Projects API may for
     * a few seconds after one is added (spec 0020 §7).
     */
    lagging?: string[]
    /** acme/.rness; by default there, Issues on, labelled, linked. */
    memory?: Partial<FMemory>
    /** Answers what is not the project's (`GET /user`, …); undefined falls through. */
    other?: (r: Recorded) => Reply | undefined
    /** The first project's README, short description and status updates. */
    readme?: string
    shortDescription?: string
    statusUpdates?: FStatusUpdate[]
    /** More projects of acme, already there (spec 0025). */
    projects?: FProjectSeed[]
    /** Labels of acme/.rness besides `rness`, by name. */
    labels?: string[]
    /** The seed's project exists already: the first project made is a new one. */
    existing?: boolean
  } = {}
) {
  let next = 100
  const fields: FField[] = seed.fields ?? [
    {
      id: 'F_status',
      databaseId: 1,
      name: 'Status',
      options: [{ id: 'o_todo', name: 'Todo' }],
    },
    { id: 'F_title', databaseId: 2, name: 'Title', options: null },
  ]
  const isView = (v: string | FView): FView =>
    typeof v === 'string' ? { name: v } : v
  const viewList: Required<FView>[] = []
  const addView = (
    v: FView,
    list: Required<FView>[] = viewList,
    of: FField[] = fields
  ) => {
    const table = v.layout === 'TABLE_LAYOUT' || v.name === 'Working'
    const own = of.find((f) => f.name === `${v.name} status`)
    list.push({
      id: v.id ?? `V_${next++}`,
      name: v.name,
      layout: v.layout ?? (table ? 'TABLE_LAYOUT' : 'BOARD_LAYOUT'),
      column:
        v.column === undefined
          ? table
            ? null
            : (own?.name ?? 'Status')
          : v.column,
    })
  }
  if (seed.views !== undefined)
    seed.views.map(isView).forEach((v) => addView(v))
  else if (seed.defaultView !== null)
    viewList.push({
      id: seed.defaultView?.id ?? 'V_1',
      name: seed.defaultView?.name ?? 'View 1',
      layout: 'TABLE_LAYOUT',
      column: null,
    })
  const items: FItem[] = seed.items ?? []
  const memory: FMemory = {
    exists: true,
    issues: true,
    label: true,
    linked: true,
    ...seed.memory,
  }
  const issues: FIssue[] = [
    ...items.flatMap((i) => (i.issue == null ? [] : [i.issue])),
    ...(seed.issues ?? []),
  ]
  const lagging = new Set(seed.lagging ?? [])
  const restViews: unknown[] = []
  // The first project is the seed's; `memory.linked` is its link to .rness.
  const primary: FProject = {
    id: 'P_1',
    number: 7,
    title: 'Agent Pulse',
    fields,
    viewList,
    items,
    get linked() {
      return memory.linked
    },
    set linked(v: boolean) {
      memory.linked = v
    },
    readme: seed.readme ?? '',
    shortDescription: seed.shortDescription ?? '',
    statusUpdates: seed.statusUpdates ?? [],
    restViews,
  }
  const projects: FProject[] = [primary]
  const addProject = (p: FProjectSeed & { id?: string }): FProject => {
    const at = projects.length + 1
    const list: Required<FView>[] = []
    const of = p.fields ?? defaultFields(at)
    if (p.views !== undefined)
      p.views.map(isView).forEach((v) => addView(v, list, of))
    else
      list.push({
        id: `V_default_${at}`,
        name: 'View 1',
        layout: 'TABLE_LAYOUT',
        column: null,
      })
    const project: FProject = {
      id: p.id ?? `P_${at}`,
      number: p.number ?? 6 + at,
      title: p.title ?? `Project ${at}`,
      fields: of,
      viewList: list,
      items: p.items ?? [],
      linked: p.linked ?? false,
      readme: p.readme ?? '',
      shortDescription: p.shortDescription ?? '',
      statusUpdates: p.statusUpdates ?? [],
      restViews: [],
    }
    projects.push(project)
    for (const i of project.items) if (i.issue != null) issues.push(i.issue)
    return project
  }
  for (const p of seed.projects ?? []) addProject(p)
  /** The project a request names by `projectId`; the first when it names none. */
  const projectOf = (v: Record<string, unknown>): FProject =>
    projects.find((p) => p.id === v['projectId']) ?? primary
  const fieldAnywhere = (id: unknown): FField | undefined =>
    projects.flatMap((p) => p.fields).find((f) => f.id === id)
  const viewAnywhere = (id: unknown) => {
    for (const p of projects) {
      const at = p.viewList.findIndex((x) => x.id === id)
      if (at >= 0) return { list: p.viewList, at }
    }
    return undefined
  }
  let claimed = seed.existing === true
  let nextStatus = 1
  // acme/.rness's labels besides `rness`, whose id follows `memory.label`.
  const labels = new Map<string, string>(
    (seed.labels ?? []).map((name) => [name, `L_${name}`])
  )
  const labelName = (id: string): string | undefined =>
    id === 'L_1'
      ? 'rness'
      : [...labels].find(([, labelId]) => labelId === id)?.[0]
  let nextNumber = 1 + Math.max(0, ...issues.map((i) => i.number))
  const issueOf = (id: unknown) => issues.find((i) => i.id === id)
  const restLabels: unknown[] = []
  const mutations: {
    op: string
    variables: Record<string, unknown>
    query?: string
  }[] = []

  const optionsOf = (list: { name: string; id?: string; color?: string }[]) =>
    list.map((o) => ({
      id: o.id ?? `o_${next++}`,
      name: o.name,
      ...(o.color === undefined ? {} : { color: o.color }),
    }))
  const itemField = (v: Record<string, unknown>) =>
    [
      projectOf(v).items.find((i) => i.id === v['itemId']),
      projectOf(v).fields.find((f) => f.id === v['fieldId']),
    ] as const
  const answers: [string, (v: Record<string, unknown>, q: string) => Reply][] =
    [
      [
        // The repository itself: its Issues switch and label, not its issues.
        'hasIssuesEnabled',
        () =>
          memory.exists
            ? data({
                repository: {
                  id: 'R_1',
                  hasIssuesEnabled: memory.issues,
                  label: memory.label ? { id: 'L_1' } : null,
                },
              })
            : {
                json: {
                  data: { repository: null },
                  errors: [
                    {
                      type: 'NOT_FOUND',
                      message: 'Could not resolve to a Repository',
                    },
                  ],
                },
              },
      ],
      [
        'createIssue(',
        (v) => {
          mutations.push({ op: 'createIssue', variables: v })
          const made = anIssue(nextNumber++, {
            id: `ISSUE_${next++}`,
            title: String(v['title']),
            body: String(v['body'] ?? ''),
            labels: (v['labelIds'] as string[] | undefined)?.includes('L_1')
              ? ['rness']
              : [],
          })
          issues.push(made)
          return data({
            createIssue: { issue: { id: made.id, number: made.number } },
          })
        },
      ],
      [
        'addProjectV2ItemById(',
        (v) => {
          mutations.push({ op: 'addItem', variables: v })
          const project = projectOf(v)
          // GitHub adds an issue already on the board as the item it is.
          const there = project.items.find(
            (i) => !i.archived && i.issue?.id === v['contentId']
          )
          if (there !== undefined)
            return data({ addProjectV2ItemById: { item: { id: there.id } } })
          const id = `I_${next++}`
          project.items.push({
            id,
            draftId: null,
            issue: issueOf(v['contentId']) ?? null,
            title: '',
            archived: false,
            values: {},
          })
          return data({ addProjectV2ItemById: { item: { id } } })
        },
      ],
      [
        'convertProjectV2DraftIssueItemToIssue(',
        (v) => {
          mutations.push({ op: 'convert', variables: v })
          const item = projects
            .flatMap((p) => p.items)
            .find((i) => i.id === v['itemId'])!
          const made = anIssue(nextNumber++, {
            id: `ISSUE_${next++}`,
            title: item.title,
            labels: [],
          })
          issues.push(made)
          item.draftId = null
          item.issue = made
          return data({
            convertProjectV2DraftIssueItemToIssue: {
              item: {
                id: item.id,
                content: { id: made.id, number: made.number },
              },
            },
          })
        },
      ],
      [
        'updateIssue(',
        (v) => {
          mutations.push({ op: 'updateIssue', variables: v })
          const issue = issueOf(v['id'])
          if (issue !== undefined && typeof v['title'] === 'string')
            issue.title = v['title']
          if (issue !== undefined && typeof v['body'] === 'string')
            issue.body = v['body']
          return data({ updateIssue: { issue: { id: v['id'] } } })
        },
      ],
      [
        'closeIssue(',
        (v, q) => {
          mutations.push({ op: 'closeIssue', variables: v, query: q })
          const issue = issueOf(v['id'])
          if (issue !== undefined) {
            issue.state = 'CLOSED'
            issue.stateReason = /NOT_PLANNED/.test(q)
              ? 'NOT_PLANNED'
              : 'COMPLETED'
          }
          return data({ closeIssue: { issue: { id: v['id'] } } })
        },
      ],
      [
        'reopenIssue(',
        (v) => {
          mutations.push({ op: 'reopenIssue', variables: v })
          const issue = issueOf(v['id'])
          if (issue !== undefined) issue.state = 'OPEN'
          return data({ reopenIssue: { issue: { id: v['id'] } } })
        },
      ],
      [
        'addLabelsToLabelable(',
        (v) => {
          mutations.push({ op: 'addLabels', variables: v })
          const issue = issueOf(v['id'])
          for (const id of v['labelIds'] as string[]) {
            const name = labelName(id)
            if (
              issue !== undefined &&
              name !== undefined &&
              !issue.labels.includes(name)
            )
              issue.labels.push(name)
          }
          return data({ addLabelsToLabelable: { clientMutationId: null } })
        },
      ],
      [
        'removeLabelsFromLabelable(',
        (v) => {
          mutations.push({ op: 'removeLabels', variables: v })
          const issue = issueOf(v['id'])
          const off = (v['labelIds'] as string[]).map(labelName)
          if (issue !== undefined)
            issue.labels = issue.labels.filter((l) => !off.includes(l))
          return data({
            removeLabelsFromLabelable: { clientMutationId: null },
          })
        },
      ],
      [
        'labelList:',
        () =>
          data({
            repository: {
              labelList: {
                nodes: [
                  ...(memory.label ? [{ id: 'L_1', name: 'rness' }] : []),
                  ...[...labels].map(([name, id]) => ({ id, name })),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
      ],
      [
        'linkProjectV2ToRepository(',
        (v) => {
          mutations.push({ op: 'link', variables: v })
          projectOf(v).linked = true
          return data({
            linkProjectV2ToRepository: { repository: { id: 'R_1' } },
          })
        },
      ],
      [
        'repositories(first',
        (v) =>
          data({
            node: {
              repositories: {
                nodes: projectOf(v).linked
                  ? [{ nameWithOwner: 'acme/.rness' }]
                  : [],
              },
            },
          }),
      ],
      [
        'createProjectV2Field',
        (v, q) => {
          mutations.push({ op: 'createField', variables: v })
          const single = v['dataType'] === 'SINGLE_SELECT'
          const f: FField = {
            id: `F_${String(v['name'])}`,
            databaseId: next++,
            name: String(v['name']),
            options: single
              ? optionsOf(v['options'] as { name: string; color?: string }[])
              : null,
            dataType: String(v['dataType']),
          }
          projectOf(v).fields.push(f)
          return data({
            createProjectV2Field: { projectV2Field: asked(q, { ...f }) },
          })
        },
      ],
      [
        'updateProjectV2Field',
        (v, q) => {
          const f = fieldAnywhere(v['fieldId'])!
          if (typeof v['name'] === 'string') {
            // A rename (spec 0022 §2): the id stays, items keep their values.
            mutations.push({ op: 'renameField', variables: v })
            const was = f.name
            f.name = v['name']
            const owner = projects.find((p) => p.fields.includes(f))!
            for (const i of owner.items)
              if (was in i.values) {
                i.values[f.name] = i.values[was]!
                delete i.values[was]
              }
            return data({
              updateProjectV2Field: { projectV2Field: asked(q, { ...f }) },
            })
          }
          mutations.push({ op: 'setOptions', variables: v })
          f.options = optionsOf(
            v['options'] as { id?: string; name: string; color?: string }[]
          )
          return data({
            updateProjectV2Field: { projectV2Field: asked(q, { ...f }) },
          })
        },
      ],
      [
        'createProjectV2(',
        (v) => {
          mutations.push({ op: 'createProject', variables: v })
          // The seed's project is the first one made; the next are new.
          const made = claimed ? addProject({}) : primary
          claimed = true
          made.title = String(v['title'])
          return data({
            createProjectV2: {
              projectV2: {
                id: made.id,
                number: made.number,
                url: `https://github.com/orgs/acme/projects/${made.number}`,
              },
            },
          })
        },
      ],
      [
        'clearProjectV2ItemFieldValue',
        (v) => {
          mutations.push({ op: 'clear', variables: v })
          const [i, f] = itemField(v)
          if (i !== undefined && f !== undefined) delete i.values[f.name]
          return data({
            clearProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } },
          })
        },
      ],
      [
        'updateProjectV2ItemFieldValue',
        (v) => {
          mutations.push({ op: 'set', variables: v })
          const [i, f] = itemField(v)
          const value = v['value'] as {
            text?: string
            singleSelectOptionId?: string
            date?: string
            number?: number
          }
          const name =
            value.text ??
            value.date ??
            (value.number === undefined ? undefined : String(value.number)) ??
            f?.options?.find((o) => o.id === value.singleSelectOptionId)?.name
          if (i !== undefined && f !== undefined && name !== undefined)
            i.values[f.name] = name
          return data({
            updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } },
          })
        },
      ],
      [
        'archiveProjectV2Item',
        (v) => {
          mutations.push({ op: 'archive', variables: v })
          const archived = projectOf(v).items.find((i) => i.id === v['itemId'])
          if (archived !== undefined) archived.archived = true
          return data({ archiveProjectV2Item: { item: { id: 'x' } } })
        },
      ],
      [
        'deleteProjectV2Item(',
        (v) => {
          mutations.push({ op: 'deleteItem', variables: v })
          const list = projectOf(v).items
          const at = list.findIndex((i) => i.id === v['itemId'])
          if (at >= 0) list.splice(at, 1)
          return data({ deleteProjectV2Item: { deletedItemId: v['itemId'] } })
        },
      ],
      [
        'updateProjectV2(',
        (v) => {
          mutations.push({ op: 'updateProject', variables: v })
          const project = projectOf(v)
          if (typeof v['readme'] === 'string') project.readme = v['readme']
          if (typeof v['shortDescription'] === 'string')
            project.shortDescription = v['shortDescription']
          return data({ updateProjectV2: { projectV2: { id: project.id } } })
        },
      ],
      [
        'projectReadme:',
        (v) =>
          data({
            node: {
              projectReadme: projectOf(v).readme,
              projectDescription: projectOf(v).shortDescription,
            },
          }),
      ],
      [
        'statusUpdates(first',
        (v) =>
          data({
            node: {
              statusUpdates: { nodes: projectOf(v).statusUpdates },
            },
          }),
      ],
      [
        'createProjectV2StatusUpdate(',
        (v) => {
          mutations.push({ op: 'createStatusUpdate', variables: v })
          projectOf(v).statusUpdates.push({
            id: `SU_${nextStatus++}`,
            body: String(v['body']),
            status: (v['status'] as string | undefined) ?? null,
            startDate: (v['startDate'] as string | null | undefined) ?? null,
            targetDate: (v['targetDate'] as string | null | undefined) ?? null,
          })
          return data({
            createProjectV2StatusUpdate: { statusUpdate: { id: 'x' } },
          })
        },
      ],
      [
        'updateProjectV2StatusUpdate(',
        (v) => {
          mutations.push({ op: 'updateStatusUpdate', variables: v })
          const u = projects
            .flatMap((p) => p.statusUpdates)
            .find((x) => x.id === v['statusUpdateId'])
          if (u !== undefined) {
            u.body = String(v['body'])
            u.status = (v['status'] as string | undefined) ?? null
            u.startDate = (v['startDate'] as string | null | undefined) ?? null
            u.targetDate =
              (v['targetDate'] as string | null | undefined) ?? null
          }
          return data({
            updateProjectV2StatusUpdate: { statusUpdate: { id: 'x' } },
          })
        },
      ],
      [
        'organization(login: $login) { id }',
        () => data({ organization: { id: 'O_1' } }),
      ],
      [
        'projectV2(number: $number) { id url }',
        (v) => {
          const project =
            projects.find((p) => p.number === v['number']) ?? primary
          return data({
            organization: {
              projectV2: {
                id: project.id,
                url: `https://github.com/orgs/acme/projects/${project.number}`,
              },
            },
          })
        },
      ],
      [
        'updateProjectV2View(',
        (v, q) => {
          mutations.push({ op: 'updateView', variables: v, query: q })
          const found = viewAnywhere(v['viewId'])
          const renamed = found?.list[found.at]
          if (renamed !== undefined) renamed.name = String(v['name'])
          return data({
            updateProjectV2View: { projectV2View: { id: v['viewId'] } },
          })
        },
      ],
      [
        'deleteProjectV2View(',
        (v, q) => {
          mutations.push({ op: 'deleteView', variables: v, query: q })
          const found = viewAnywhere(v['viewId'])
          if (found !== undefined) found.list.splice(found.at, 1)
          return data({ deleteProjectV2View: { clientMutationId: null } })
        },
      ],
      [
        'views(first',
        (v) =>
          data({
            node: {
              views: {
                nodes: projectOf(v).viewList.map((x) => ({
                  id: x.id,
                  name: x.name,
                  layout: x.layout,
                  verticalGroupByFields: {
                    nodes: x.column === null ? [] : [{ name: x.column }],
                  },
                })),
              },
            },
          }),
      ],
      [
        'fields(first',
        (v, q) =>
          data({
            node: {
              fields: {
                nodes: projectOf(v).fields.map((f) => asked(q, { ...f })),
              },
            },
          }),
      ],
      [
        'issues(first',
        (v) =>
          data({
            repository: {
              issues: {
                nodes: issues
                  .filter(
                    (i) =>
                      i.repository === 'acme/.rness' &&
                      i.state === 'OPEN' &&
                      i.labels.includes(String(v['label']))
                  )
                  .map(({ id, number, title, body }) => ({
                    id,
                    number,
                    title,
                    body,
                  })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
      ],
      [
        'items(first',
        (v, q) =>
          data({
            node: {
              items: {
                nodes: projectOf(v)
                  .items.filter((i) => !lagging.has(i.id))
                  .map((i) => ({
                    id: i.id,
                    isArchived: i.archived,
                    // The query selects DraftIssue and Issue: other content is {}.
                    content:
                      i.issue != null
                        ? {
                            id: i.issue.id,
                            number: i.issue.number,
                            title: i.issue.title,
                            state: i.issue.state,
                            // As GitHub answers: only when the query selects it.
                            ...(/\bbody\b/.test(q)
                              ? { body: i.issue.body }
                              : {}),
                            repository: { nameWithOwner: i.issue.repository },
                            labels: {
                              nodes: i.issue.labels.map((name) => ({ name })),
                            },
                          }
                        : i.draftId === null
                          ? {}
                          : { id: i.draftId, title: i.title },
                    fieldValues: {
                      nodes: Object.entries(i.values).map(([name, value]) => {
                        const f = projectOf(v).fields.find(
                          (x) => x.name === name
                        )
                        return {
                          ...(f?.options
                            ? { name: value }
                            : f?.dataType === 'DATE'
                              ? { date: value }
                              : f?.dataType === 'NUMBER'
                                ? { number: Number(value) }
                                : { text: value }),
                          field: { name },
                        }
                      }),
                    },
                  })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
      ],
    ]
  const gh = await fakeGithub(t, (r: Recorded) => {
    const other = seed.other?.(r)
    if (other !== undefined) return other
    if (r.path !== '/graphql') {
      assert.equal(r.method, 'POST')
      if (r.path === '/repos/acme/.rness/labels') {
        restLabels.push(r.body)
        const name = (r.body as { name: string }).name
        if (name === 'rness') memory.label = true
        else labels.set(name, `L_${name}`)
        return {
          status: 201,
          json: { node_id: name === 'rness' ? 'L_1' : `L_${name}`, name },
        }
      }
      const number = Number(
        /^\/orgs\/acme\/projectsV2\/(\d+)\/views$/.exec(r.path)?.[1]
      )
      const project = projects.find((p) => p.number === number)
      assert.ok(project !== undefined, `no project for ${r.path}`)
      project.restViews.push(r.body)
      const body = r.body as {
        name: string
        layout: string
        vertical_group_by?: number[]
      }
      addView(
        {
          name: body.name,
          layout:
            body.layout === 'table'
              ? 'TABLE_LAYOUT'
              : body.layout === 'roadmap'
                ? 'ROADMAP_LAYOUT'
                : 'BOARD_LAYOUT',
          column:
            project.fields.find(
              (f) => f.databaseId === body.vertical_group_by?.[0]
            )?.name ?? null,
        },
        project.viewList,
        project.fields
      )
      return { json: {} }
    }
    const { query, variables } = gql(r)
    const found = answers.find(([needle]) => query.includes(needle))
    return found === undefined
      ? { status: 500, json: { message: `unexpected ${query}` } }
      : found[1](variables, query)
  })
  const provider = new GitHubOAuthProvider({ token: TOKEN, apiBase: gh.base })
  return {
    base: gh.base,
    provider,
    fields,
    get views() {
      return viewList.map((v) => v.name)
    },
    viewList,
    items,
    issues,
    memory,
    projects,
    /** A project by its number. */
    project: (number: number): FProject => {
      const found = projects.find((p) => p.number === number)
      assert.ok(found !== undefined, `no project ${number}`)
      return found
    },
    restViews,
    restLabels,
    mutations,
    requests: gh.requests,
  }
}
