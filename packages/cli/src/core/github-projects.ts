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

/** GitHub's GraphQL answers a spent budget with 200 and an error of this type. */
const rateLimited = (body: unknown): boolean =>
  isRecord(body) &&
  Array.isArray(body['errors']) &&
  body['errors'].some(
    (e: unknown) => isRecord(e) && e['type'] === 'RATE_LIMITED'
  )

async function graphqlRaw<T>(
  query: string,
  variables: Record<string, unknown>,
  options: ApiOptions
): Promise<GraphqlAnswer<T>> {
  const body = await postJson(
    '/graphql',
    { query, variables },
    options,
    true,
    rateLimited
  )
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

/** As `graphql`, but null when every error is NOT_FOUND: an unknown repository is no failure. */
export async function graphqlFound<T>(
  query: string,
  variables: Record<string, unknown>,
  options: ApiOptions
): Promise<T | null> {
  const answer = await graphqlRaw<T>(query, variables, options)
  const errors = answer.errors ?? []
  if (errors.length > 0 && errors.every((e) => e.type === 'NOT_FOUND'))
    return null
  const error = firstError(answer)
  if (error !== null) throw error
  return answer.data ?? null
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
  const errors = answer.errors ?? []
  if (errors.length > 0 && errors.every((e) => e.type === 'NOT_FOUND'))
    return null
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

/** Renames a field in place: its id, its values and the views showing it stay (spec 0022 §2). */
export async function renameField(
  fieldId: string,
  name: string,
  o: ApiOptions
): Promise<Field> {
  const d = await graphql<{
    updateProjectV2Field: { projectV2Field: RawField }
  }>(
    `mutation($fieldId: ID!, $name: String!) {
      updateProjectV2Field(input: { fieldId: $fieldId, name: $name }) {
        projectV2Field { ${FIELD_SELECTION} }
      }
    }`,
    { fieldId, name },
    o
  )
  return toField(d.updateProjectV2Field.projectV2Field)
}

/** The issue an item is (spec 0018 §2). */
export interface RawIssue {
  id: string
  number: number
  open: boolean
  /** `owner/name`. */
  repository: string
  /** Null: listed without bodies. */
  body: string | null
  labels: string[]
}

export interface RawItem {
  id: string
  /** A draft's id; null for any other content. */
  draftId: string | null
  /** The issue the item is; null for a draft or other content (a pull request). */
  issue: RawIssue | null
  /** The draft's or the issue's title. */
  title: string
  archived: boolean
  /** Field name → text or option name. */
  values: Record<string, string>
}

interface ItemNode {
  id: string
  isArchived?: boolean
  /** A draft has no `number`; content that is neither is `{}`. */
  content?: {
    id?: string
    title?: string
    number?: number
    state?: string
    body?: string
    repository?: { nameWithOwner?: string }
    labels?: { nodes: { name?: string }[] }
  } | null
  fieldValues?: {
    nodes: { text?: string; name?: string; field?: { name?: string } }[]
  }
}

/**
 * The project's items, archived ones included. `bodies: false` leaves the
 * issues' bodies out of the query — the heaviest part of a listing — and
 * each issue's `body` null.
 */
export async function listItems(
  projectId: string,
  o: ApiOptions,
  { bodies = true }: { bodies?: boolean } = {}
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
                    ... on Issue {
                      id
                      number
                      title
                      state
                      ${bodies ? 'body' : ''}
                      repository {
                        nameWithOwner
                      }
                      labels(first: 20) {
                        nodes {
                          name
                        }
                      }
                    }
                  }
                  fieldValues(first: 50) {
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
      const c = n.content
      const issue =
        c?.id !== undefined && c.number !== undefined
          ? {
              id: c.id,
              number: c.number,
              open: c.state === 'OPEN',
              repository: c.repository?.nameWithOwner ?? '',
              body: bodies ? (c.body ?? '') : null,
              labels: (c.labels?.nodes ?? [])
                .map((l) => l.name ?? '')
                .filter((l) => l !== ''),
            }
          : null
      items.push({
        id: n.id,
        draftId: issue === null ? (c?.id ?? null) : null,
        issue,
        title: c?.title ?? '',
        archived: n.isArchived === true,
        values,
      })
    }
    const { hasNextPage, endCursor } = d.node.items.pageInfo
    if (!hasNextPage || endCursor === null) return items
    cursor = endCursor
  }
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

/** Adds an issue to the project (`addProjectV2ItemById`); returns the item's id. */
export async function addItem(
  projectId: string,
  contentId: string,
  o: ApiOptions
): Promise<string> {
  const d = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `
      mutation ($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(
          input: { projectId: $projectId, contentId: $contentId }
        ) {
          item {
            id
          }
        }
      }
    `,
    { projectId, contentId },
    o
  )
  return d.addProjectV2ItemById.item.id
}

/** Makes a draft item an issue of the repository; the item keeps its id and fields (spec 0018 §1). */
export async function convertDraft(
  itemId: string,
  repositoryId: string,
  o: ApiOptions
): Promise<{ id: string; number: number }> {
  const d = await graphql<{
    convertProjectV2DraftIssueItemToIssue: {
      item: { content: { id?: string; number?: number } | null }
    }
  }>(
    `
      mutation ($itemId: ID!, $repositoryId: ID!) {
        convertProjectV2DraftIssueItemToIssue(
          input: { itemId: $itemId, repositoryId: $repositoryId }
        ) {
          item {
            id
            content {
              ... on Issue {
                id
                number
              }
            }
          }
        }
      }
    `,
    { itemId, repositoryId },
    o
  )
  const content = d.convertProjectV2DraftIssueItemToIssue.item.content
  const id = content?.id
  const number = content?.number
  if (id === undefined || number === undefined)
    throw new Error(`GitHub converted the item ${itemId} without an issue`)
  return { id, number }
}

/** The repositories the project is linked to, as `owner/name`. */
export async function linkedRepositories(
  projectId: string,
  o: ApiOptions
): Promise<string[]> {
  const d = await graphql<{
    node: { repositories: { nodes: { nameWithOwner: string }[] } } | null
  }>(
    `
      query ($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            repositories(first: 100) {
              nodes {
                nameWithOwner
              }
            }
          }
        }
      }
    `,
    { projectId },
    o
  )
  return (d.node?.repositories.nodes ?? []).map((r) => r.nameWithOwner)
}

/** Links the project to a repository: it shows in the repository's Projects tab (spec 0018 §2). */
export async function linkRepository(
  projectId: string,
  repositoryId: string,
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($projectId: ID!, $repositoryId: ID!) {
        linkProjectV2ToRepository(
          input: { projectId: $projectId, repositoryId: $repositoryId }
        ) {
          repository {
            id
          }
        }
      }
    `,
    { projectId, repositoryId },
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

export interface View {
  id: string
  name: string
  /** GitHub's `BOARD_LAYOUT`, `TABLE_LAYOUT` or `ROADMAP_LAYOUT`. */
  layout: string
  /** The name of the field a board's columns follow; null: none. */
  columnField: string | null
}

/** The views of a project, in order, through GraphQL: the REST docs list no endpoint for them. */
export async function views(projectId: string, o: ApiOptions): Promise<View[]> {
  const d = await graphql<{
    node: {
      views: {
        nodes: {
          id: string
          name: string
          layout: string
          verticalGroupByFields: { nodes: { name?: string }[] } | null
        }[]
      }
    } | null
  }>(
    `
      query ($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            views(first: 50) {
              nodes {
                id
                name
                layout
                verticalGroupByFields(first: 1) {
                  nodes {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { projectId },
    o
  )
  return (d.node?.views.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    layout: n.layout,
    columnField: n.verticalGroupByFields?.nodes[0]?.name ?? null,
  }))
}

/** Deletes a view (`deleteProjectV2View`): the way to change what a board's columns follow. */
export async function deleteView(viewId: string, o: ApiOptions): Promise<void> {
  await graphql(
    `
      mutation ($viewId: ID!) {
        deleteProjectV2View(input: { viewId: $viewId }) {
          clientMutationId
        }
      }
    `,
    { viewId },
    o
  )
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
