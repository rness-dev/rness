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
}
export interface FView {
  id?: string
  name: string
  layout?: 'BOARD_LAYOUT' | 'TABLE_LAYOUT'
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
  /** Who opened it; null: a deleted account. */
  author: string | null
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

/** An issue of acme/.rness: open, labelled, no body yet, opened by octo — the tests' login. */
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
  author: 'octo',
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
    /** acme/.rness; by default there, Issues on, labelled, linked. */
    memory?: Partial<FMemory>
    /** Answers what is not the project's (`GET /user`, …); undefined falls through. */
    other?: (r: Recorded) => Reply | undefined
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
  const addView = (v: FView) => {
    const table = v.layout === 'TABLE_LAYOUT' || v.name === 'Working'
    const own = fields.find((f) => f.name === `${v.name} status`)
    viewList.push({
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
  if (seed.views !== undefined) seed.views.map(isView).forEach(addView)
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
  const issues: FIssue[] = items.flatMap((i) =>
    i.issue == null ? [] : [i.issue]
  )
  let nextNumber = 1 + Math.max(0, ...issues.map((i) => i.number))
  const issueOf = (id: unknown) => issues.find((i) => i.id === id)
  const restViews: unknown[] = []
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
      items.find((i) => i.id === v['itemId']),
      fields.find((f) => f.id === v['fieldId']),
    ] as const
  const answers: [string, (v: Record<string, unknown>, q: string) => Reply][] =
    [
      [
        'repository(owner: $owner',
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
          const id = `I_${next++}`
          items.push({
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
          const item = items.find((i) => i.id === v['itemId'])!
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
          if (issue !== undefined && !issue.labels.includes('rness'))
            issue.labels.push('rness')
          return data({ addLabelsToLabelable: { clientMutationId: null } })
        },
      ],
      [
        'linkProjectV2ToRepository(',
        (v) => {
          mutations.push({ op: 'link', variables: v })
          memory.linked = true
          return data({
            linkProjectV2ToRepository: { repository: { id: 'R_1' } },
          })
        },
      ],
      [
        'repositories(first',
        () =>
          data({
            node: {
              repositories: {
                nodes: memory.linked ? [{ nameWithOwner: 'acme/.rness' }] : [],
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
          }
          fields.push(f)
          return data({
            createProjectV2Field: { projectV2Field: asked(q, { ...f }) },
          })
        },
      ],
      [
        'updateProjectV2Field',
        (v, q) => {
          mutations.push({ op: 'setOptions', variables: v })
          const f = fields.find((x) => x.id === v['fieldId'])!
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
          return data({
            createProjectV2: {
              projectV2: {
                id: 'P_1',
                number: 7,
                url: 'https://github.com/orgs/acme/projects/7',
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
          }
          const name =
            value.text ??
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
          const archived = items.find((i) => i.id === v['itemId'])
          if (archived !== undefined) archived.archived = true
          return data({ archiveProjectV2Item: { item: { id: 'x' } } })
        },
      ],
      [
        'organization(login: $login) { id }',
        () => data({ organization: { id: 'O_1' } }),
      ],
      [
        'projectV2(number: $number) { id url }',
        () =>
          data({
            organization: {
              projectV2: {
                id: 'P_1',
                url: 'https://github.com/orgs/acme/projects/7',
              },
            },
          }),
      ],
      [
        'updateProjectV2View(',
        (v, q) => {
          mutations.push({ op: 'updateView', variables: v, query: q })
          const renamed = viewList.find((x) => x.id === v['viewId'])
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
          const at = viewList.findIndex((x) => x.id === v['viewId'])
          if (at >= 0) viewList.splice(at, 1)
          return data({ deleteProjectV2View: { clientMutationId: null } })
        },
      ],
      [
        'views(first',
        () =>
          data({
            node: {
              views: {
                nodes: viewList.map((x) => ({
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
        (_v, q) =>
          data({
            node: {
              fields: {
                nodes: fields.map((f) => asked(q, { ...f })),
              },
            },
          }),
      ],
      [
        'items(first',
        (_v, q) =>
          data({
            node: {
              items: {
                nodes: items.map((i) => ({
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
                          ...(/\bbody\b/.test(q) ? { body: i.issue.body } : {}),
                          ...(/\bauthor\b/.test(q)
                            ? {
                                author:
                                  i.issue.author === null
                                    ? null
                                    : { login: i.issue.author },
                              }
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
                    nodes: Object.entries(i.values).map(([name, value]) => ({
                      ...(fields.find((f) => f.name === name)?.options
                        ? { name: value }
                        : { text: value }),
                      field: { name },
                    })),
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
        memory.label = true
        return {
          status: 201,
          json: { node_id: 'L_1', name: (r.body as { name: string }).name },
        }
      }
      assert.equal(r.path, '/orgs/acme/projectsV2/7/views')
      restViews.push(r.body)
      const body = r.body as {
        name: string
        layout: string
        vertical_group_by?: number[]
      }
      addView({
        name: body.name,
        layout: body.layout === 'table' ? 'TABLE_LAYOUT' : 'BOARD_LAYOUT',
        column:
          fields.find((f) => f.databaseId === body.vertical_group_by?.[0])
            ?.name ?? null,
      })
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
    restViews,
    restLabels,
    mutations,
    requests: gh.requests,
  }
}
