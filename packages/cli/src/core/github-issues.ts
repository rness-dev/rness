import { graphql, graphqlFound } from './github-projects.ts'
import { type ApiOptions, postJson } from './github.ts'

/**
 * A repository's issues over GitHub's API: what the pulse's items are made
 * of (spec 0018 §2). No pulse logic; errors carry GitHub's own message.
 */

export interface Repository {
  /** The node id. */
  id: string
  /** `hasIssuesEnabled`. */
  issues: boolean
  /** The node id of the label asked for; null: the repository has none. */
  labelId: string | null
}

/** `owner/name`: its id, its Issues switch and one label; null when GitHub shows no such repository. */
export async function repository(
  owner: string,
  name: string,
  label: string,
  o: ApiOptions
): Promise<Repository | null> {
  const d = await graphqlFound<{
    repository: {
      id: string
      hasIssuesEnabled: boolean
      label: { id: string } | null
    } | null
  }>(
    `query($owner: String!, $name: String!, $label: String!) {
      repository(owner: $owner, name: $name) { id hasIssuesEnabled label(name: $label) { id } }
    }`,
    { owner, name, label },
    o
  )
  const r = d?.repository ?? null
  return r === null
    ? null
    : { id: r.id, issues: r.hasIssuesEnabled, labelId: r.label?.id ?? null }
}

/** An open issue of a repository, with what adopting it needs. */
export interface OpenIssue {
  id: string
  number: number
  title: string
  body: string
}

/**
 * The open issues of `owner/name` that carry `label`, 100 a page. The
 * repository's issues, unlike a project's items, show an issue as soon as it
 * is created: the pulse looks here before creating one (spec 0020 §7).
 */
export async function openIssues(
  owner: string,
  name: string,
  label: string,
  o: ApiOptions
): Promise<OpenIssue[]> {
  const found: OpenIssue[] = []
  let after: string | null = null
  for (;;) {
    const d: {
      repository: {
        issues: {
          nodes: OpenIssue[]
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } | null
    } = await graphql(
      `
        query (
          $owner: String!
          $name: String!
          $label: String!
          $after: String
        ) {
          repository(owner: $owner, name: $name) {
            issues(first: 100, after: $after, states: OPEN, labels: [$label]) {
              nodes {
                id
                number
                title
                body
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { owner, name, label, after },
      o
    )
    const page = d.repository?.issues
    if (page === undefined) return found
    found.push(...page.nodes)
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null)
      return found
    after = page.pageInfo.endCursor
  }
}

/** Creates a label (REST `POST /repos/{owner}/{repo}/labels`, docs read 2026-09-30); returns its node id. */
export async function createLabel(
  owner: string,
  name: string,
  label: { name: string; color: string; description: string },
  o: ApiOptions
): Promise<string> {
  const body = await postJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`,
    label,
    o,
    true
  )
  const id =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)['node_id']
      : undefined
  if (typeof id !== 'string')
    throw new Error(`GitHub created the label ${label.name} without a node id`)
  return id
}

export async function createIssue(
  repositoryId: string,
  issue: { title: string; body: string; labelIds: string[] },
  o: ApiOptions
): Promise<{ id: string; number: number }> {
  const d = await graphql<{
    createIssue: { issue: { id: string; number: number } }
  }>(
    `
      mutation (
        $repositoryId: ID!
        $title: String!
        $body: String
        $labelIds: [ID!]
      ) {
        createIssue(
          input: {
            repositoryId: $repositoryId
            title: $title
            body: $body
            labelIds: $labelIds
          }
        ) {
          issue {
            id
            number
          }
        }
      }
    `,
    { repositoryId, ...issue },
    o
  )
  return d.createIssue.issue
}

/** A title, a body, or both: a variable left out leaves its field as it is. */
export async function updateIssue(
  id: string,
  change: { title?: string; body?: string },
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($id: ID!, $title: String, $body: String) {
        updateIssue(input: { id: $id, title: $title, body: $body }) {
          issue {
            id
          }
        }
      }
    `,
    { id, ...change },
    o
  )
}

/** Closes an issue as not planned: its document is gone (spec 0018 §2). */
export async function closeIssue(id: string, o: ApiOptions): Promise<void> {
  await graphql(
    `
      mutation ($id: ID!) {
        closeIssue(input: { issueId: $id, stateReason: NOT_PLANNED }) {
          issue {
            id
          }
        }
      }
    `,
    { id },
    o
  )
}

export async function reopenIssue(id: string, o: ApiOptions): Promise<void> {
  await graphql(
    `
      mutation ($id: ID!) {
        reopenIssue(input: { issueId: $id }) {
          issue {
            id
          }
        }
      }
    `,
    { id },
    o
  )
}

export async function addLabels(
  id: string,
  labelIds: string[],
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($id: ID!, $labelIds: [ID!]!) {
        addLabelsToLabelable(input: { labelableId: $id, labelIds: $labelIds }) {
          clientMutationId
        }
      }
    `,
    { id, labelIds },
    o
  )
}
