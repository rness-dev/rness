import { type ApiOptions, GitHubMessageError, postJson } from './github.ts'

/**
 * GitHub Projects (v2) over HTTP: GraphQL for projects, fields and items,
 * REST for views. No business logic; errors carry GitHub's own message.
 */

interface GraphqlAnswer<T> {
  data?: T
  errors?: { message?: string; type?: string }[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

async function graphqlRaw<T>(
  query: string,
  variables: Record<string, unknown>,
  options: ApiOptions
): Promise<GraphqlAnswer<T>> {
  const body = await postJson('/graphql', { query, variables }, options, true)
  return isRecord(body) ? (body as GraphqlAnswer<T>) : {}
}

function firstError(answer: GraphqlAnswer<unknown>): Error | null {
  const first = answer.errors?.[0]
  return first === undefined
    ? null
    : new GitHubMessageError(first.message ?? 'GitHub GraphQL error')
}

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: ApiOptions
): Promise<T> {
  const answer = await graphqlRaw<T>(query, variables, options)
  const error = firstError(answer)
  if (error !== null) throw error
  if (answer.data === undefined)
    throw new Error('GitHub GraphQL answered without data')
  return answer.data
}

export async function orgId(org: string, o: ApiOptions): Promise<string> {
  const d = await graphql<{ organization: { id: string } | null }>(
    'query($login: String!) { organization(login: $login) { id } }',
    { login: org },
    o
  )
  if (d.organization === null)
    throw new Error(`GitHub knows no organization ${org}`)
  return d.organization.id
}

export async function createProject(
  ownerId: string,
  title: string,
  o: ApiOptions
): Promise<{ id: string; number: number; url: string }> {
  const d = await graphql<{
    createProjectV2: { projectV2: { id: string; number: number; url: string } }
  }>(
    `
      mutation ($ownerId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId, title: $title }) {
          projectV2 {
            id
            number
            url
          }
        }
      }
    `,
    { ownerId, title },
    o
  )
  return d.createProjectV2.projectV2
}

export async function findProject(
  org: string,
  number: number,
  o: ApiOptions
): Promise<{ id: string; url: string } | null> {
  const answer = await graphqlRaw<{
    organization: { projectV2: { id: string; url: string } | null } | null
  }>(
    `query($login: String!, $number: Int!) {
      organization(login: $login) { projectV2(number: $number) { id url } }
    }`,
    { login: org, number },
    o
  )
  // An unknown project is a NOT_FOUND error, not an absent value.
  if (answer.errors?.every((e) => e.type === 'NOT_FOUND') === true) return null
  const error = firstError(answer)
  if (error !== null) throw error
  return answer.data?.organization?.projectV2 ?? null
}

export interface Field {
  id: string
  /** The numeric id REST project views refer to fields by. */
  databaseId: number
  name: string
  options: { id: string; name: string; color?: string }[] | null
}

interface RawField {
  id?: string
  databaseId?: number
  name?: string
  options?: { id: string; name: string; color?: string }[]
}

function toField(raw: RawField): Field {
  const databaseId = raw.databaseId
  // REST views address fields by this id: a missing one must not become 0.
  if (typeof databaseId !== 'number')
    throw new Error(
      `GitHub returned the field "${raw.name ?? raw.id ?? ''}" without a database id`
    )
  return {
    id: raw.id ?? '',
    databaseId,
    name: raw.name ?? '',
    options: raw.options ?? null,
  }
}

export async function fields(
  projectId: string,
  o: ApiOptions
): Promise<Field[]> {
  const d = await graphql<{ node: { fields: { nodes: RawField[] } } }>(
    `
      query ($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 100) {
              nodes {
                ${FIELD_SELECTION}
              }
            }
          }
        }
      }
    `,
    { projectId },
    o
  )
  // Fragments that match no field type leave an empty node.
  return d.node.fields.nodes
    .filter((n) => n.id !== undefined)
    .map((n) => toField(n))
}

/** An option to send: `color` is a ProjectV2SingleSelectFieldOptionColor (GRAY, BLUE, …). */
export interface OptionInput {
  name: string
  color: string
}

const optionInput = (o: OptionInput, id?: string) => ({
  ...(id === undefined ? {} : { id }),
  name: o.name,
  color: o.color,
  description: '',
})

const FIELD_SELECTION = `... on ProjectV2FieldCommon { id databaseId name }
  ... on ProjectV2SingleSelectField { options { id name color } }`

export async function createField(
  projectId: string,
  name: string,
  kind: 'TEXT' | { options: OptionInput[] },
  o: ApiOptions
): Promise<Field> {
  const single = kind !== 'TEXT'
  const d = await graphql<{
    createProjectV2Field: { projectV2Field: RawField }
  }>(
    `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!${
      single ? ', $options: [ProjectV2SingleSelectFieldOptionInput!]' : ''
    }) {
      createProjectV2Field(input: {
        projectId: $projectId, name: $name, dataType: $dataType${
          single ? ', singleSelectOptions: $options' : ''
        }
      }) { projectV2Field { ${FIELD_SELECTION} } }
    }`,
    {
      projectId,
      name,
      dataType: single ? 'SINGLE_SELECT' : 'TEXT',
      ...(single ? { options: kind.options.map((n) => optionInput(n)) } : {}),
    },
    o
  )
  return toField(d.createProjectV2Field.projectV2Field)
}

/** Sets a single-select field's options to `options`, resending existing ids so item values survive. */
export async function setOptions(
  field: Field,
  options: OptionInput[],
  o: ApiOptions
): Promise<Field> {
  const ids = new Map((field.options ?? []).map((opt) => [opt.name, opt.id]))
  const d = await graphql<{
    updateProjectV2Field: { projectV2Field: RawField }
  }>(
    `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
      updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
        projectV2Field { ${FIELD_SELECTION} }
      }
    }`,
    {
      fieldId: field.id,
      options: options.map((n) => optionInput(n, ids.get(n.name))),
    },
    o
  )
  return toField(d.updateProjectV2Field.projectV2Field)
}

export interface RawItem {
  id: string
  draftId: string | null
  title: string
  archived: boolean
  /** Field name → text or option name. */
  values: Record<string, string>
}

interface ItemNode {
  id: string
  isArchived?: boolean
  content?: { id?: string; title?: string } | null
  fieldValues?: {
    nodes: { text?: string; name?: string; field?: { name?: string } }[]
  }
}

export async function listItems(
  projectId: string,
  o: ApiOptions
): Promise<RawItem[]> {
  const items: RawItem[] = []
  let cursor: string | null = null
  for (;;) {
    const d: {
      node: {
        items: {
          nodes: ItemNode[]
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      }
    } = await graphql(
      `
        query ($projectId: ID!, $cursor: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                nodes {
                  id
                  isArchived
                  content {
                    ... on DraftIssue {
                      id
                      title
                    }
                  }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldTextValue {
                        text
                        field {
                          ... on ProjectV2FieldCommon {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2FieldCommon {
                            name
                          }
                        }
                      }
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { projectId, cursor },
      o
    )
    for (const n of d.node.items.nodes) {
      const values: Record<string, string> = {}
      for (const v of n.fieldValues?.nodes ?? []) {
        const field = v.field?.name
        const value = v.text ?? v.name
        if (field !== undefined && value !== undefined) values[field] = value
      }
      items.push({
        id: n.id,
        draftId: n.content?.id ?? null,
        title: n.content?.title ?? '',
        archived: n.isArchived === true,
        values,
      })
    }
    const { hasNextPage, endCursor } = d.node.items.pageInfo
    if (!hasNextPage || endCursor === null) return items
    cursor = endCursor
  }
}

export async function addDraft(
  projectId: string,
  title: string,
  body: string,
  o: ApiOptions
): Promise<string> {
  const d = await graphql<{
    addProjectV2DraftIssue: { projectItem: { id: string } }
  }>(
    `
      mutation ($projectId: ID!, $title: String!, $body: String) {
        addProjectV2DraftIssue(
          input: { projectId: $projectId, title: $title, body: $body }
        ) {
          projectItem {
            id
          }
        }
      }
    `,
    { projectId, title, body },
    o
  )
  return d.addProjectV2DraftIssue.projectItem.id
}

export async function editDraft(
  draftId: string,
  title: string,
  body: string,
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($draftIssueId: ID!, $title: String!, $body: String) {
        updateProjectV2DraftIssue(
          input: { draftIssueId: $draftIssueId, title: $title, body: $body }
        ) {
          draftIssue {
            id
          }
        }
      }
    `,
    { draftIssueId: draftId, title, body },
    o
  )
}

export async function setValue(
  projectId: string,
  itemId: string,
  fieldId: string,
  value: { text: string } | { optionId: string } | null,
  o: ApiOptions
): Promise<void> {
  if (value === null) {
    await graphql(
      `
        mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
          clearProjectV2ItemFieldValue(
            input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `,
      { projectId, itemId, fieldId },
      o
    )
    return
  }
  await graphql(
    `
      mutation (
        $projectId: ID!
        $itemId: ID!
        $fieldId: ID!
        $value: ProjectV2FieldValue!
      ) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: $value
          }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    {
      projectId,
      itemId,
      fieldId,
      value:
        'text' in value
          ? { text: value.text }
          : { singleSelectOptionId: value.optionId },
    },
    o
  )
}

export async function archive(
  projectId: string,
  itemId: string,
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($projectId: ID!, $itemId: ID!) {
        archiveProjectV2Item(
          input: { projectId: $projectId, itemId: $itemId }
        ) {
          item {
            id
          }
        }
      }
    `,
    { projectId, itemId },
    o
  )
}

/**
 * REST `POST /orgs/{org}/projectsV2/{number}/views` (docs.github.com/en/rest/projects/views,
 * read 2026-09-29). `groupBy` is a field's `databaseId`, sent as
 * `vertical_group_by` (board columns), which the API takes as a one-item array.
 */
export async function createView(
  org: string,
  number: number,
  view: {
    name: string
    layout: 'board' | 'table'
    filter: string
    groupBy?: number
    /** Fields' `databaseId`s, in column order; sent as `visible_fields`. */
    visibleFields?: number[]
  },
  o: ApiOptions
): Promise<void> {
  const body: Record<string, unknown> = {
    name: view.name,
    layout: view.layout,
    filter: view.filter,
  }
  if (view.groupBy !== undefined) {
    if (!Number.isInteger(view.groupBy))
      throw new Error(
        `a view groups by a field's database id, not ${view.groupBy}`
      )
    body['vertical_group_by'] = [view.groupBy]
  }
  if (view.visibleFields !== undefined) {
    if (!view.visibleFields.every(Number.isInteger))
      throw new Error('a view shows fields by their database ids')
    body['visible_fields'] = view.visibleFields
  }
  await postJson(
    `/orgs/${encodeURIComponent(org)}/projectsV2/${number}/views`,
    body,
    o,
    true
  )
}

/** View names, through GraphQL: the REST docs list no endpoint for them. */
export async function views(
  org: string,
  number: number,
  o: ApiOptions
): Promise<string[]> {
  const d = await graphql<{
    organization: {
      projectV2: { views: { nodes: { name: string }[] } } | null
    } | null
  }>(
    `
      query ($login: String!, $number: Int!) {
        organization(login: $login) {
          projectV2(number: $number) {
            views(first: 50) {
              nodes {
                name
              }
            }
          }
        }
      }
    `,
    { login: org, number },
    o
  )
  return (d.organization?.projectV2?.views.nodes ?? []).map((n) => n.name)
}

/**
 * The first view of a new project (GitHub's "View 1"): its id and name, or
 * null when it has none.
 */
export async function firstView(
  projectId: string,
  o: ApiOptions
): Promise<{ id: string; name: string } | null> {
  const d = await graphql<{
    node: { views: { nodes: { id: string; name: string }[] } } | null
  }>(
    `
      query ($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            views(first: 10) {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `,
    { projectId },
    o
  )
  return d.node?.views.nodes[0] ?? null
}

/**
 * `updateProjectV2View` (GraphQL schema, read 2026-09-29): a new name and the
 * fields the view shows, by node id, in column order.
 */
export async function renameView(
  viewId: string,
  name: string,
  visibleFieldIds: string[],
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($viewId: ID!, $name: String!, $visibleFieldIds: [ID!]) {
        updateProjectV2View(
          input: {
            viewId: $viewId
            name: $name
            configuration: { visibleFieldIds: $visibleFieldIds }
          }
        ) {
          projectV2View {
            id
          }
        }
      }
    `,
    { viewId, name, visibleFieldIds },
    o
  )
}
