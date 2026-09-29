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
  options: { id: string; name: string }[] | null
}
export interface FItem {
  id: string
  draftId: string
  title: string
  archived: boolean
  values: Record<string, string>
}

/** A GitHub project that remembers what it was told. */
export async function board(
  t: TestContext,
  seed: {
    fields?: FField[]
    views?: string[]
    items?: FItem[]
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
  ]
  const views: string[] = seed.views ?? []
  const items: FItem[] = seed.items ?? []
  const restViews: unknown[] = []
  const mutations: { op: string; variables: Record<string, unknown> }[] = []

  const optionsOf = (list: { name: string; id?: string }[]) =>
    list.map((o) => ({ id: o.id ?? `o_${next++}`, name: o.name }))
  const answers: [string, (v: Record<string, unknown>, q: string) => Reply][] =
    [
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
              ? optionsOf(v['options'] as { name: string }[])
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
          f.options = optionsOf(v['options'] as { id?: string; name: string }[])
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
        'addProjectV2DraftIssue',
        (v) => {
          mutations.push({ op: 'addDraft', variables: v })
          const id = `I_${next++}`
          items.push({
            id,
            draftId: `D_${id}`,
            title: String(v['title']),
            archived: false,
            values: {},
          })
          return data({ addProjectV2DraftIssue: { projectItem: { id } } })
        },
      ],
      [
        'updateProjectV2DraftIssue',
        (v) => {
          mutations.push({ op: 'editDraft', variables: v })
          return data({
            updateProjectV2DraftIssue: { draftIssue: { id: 'x' } },
          })
        },
      ],
      [
        'clearProjectV2ItemFieldValue',
        (v) => {
          mutations.push({ op: 'clear', variables: v })
          return data({
            clearProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } },
          })
        },
      ],
      [
        'updateProjectV2ItemFieldValue',
        (v) => {
          mutations.push({ op: 'set', variables: v })
          return data({
            updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } },
          })
        },
      ],
      [
        'archiveProjectV2Item',
        (v) => {
          mutations.push({ op: 'archive', variables: v })
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
        'views(first',
        () =>
          data({
            organization: {
              projectV2: { views: { nodes: views.map((name) => ({ name })) } },
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
        () =>
          data({
            node: {
              items: {
                nodes: items.map((i) => ({
                  id: i.id,
                  isArchived: i.archived,
                  content: { id: i.draftId, title: i.title },
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
      assert.equal(r.path, '/orgs/acme/projectsV2/7/views')
      restViews.push(r.body)
      const name = (r.body as { name: string }).name
      views.push(name)
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
    views,
    items,
    restViews,
    mutations,
    requests: gh.requests,
  }
}
