import * as gi from './github-issues.ts'
import { graphql, graphqlFound } from './github-projects.ts'
import type { ApiOptions } from './github.ts'

/**
 * The agent journal on GitHub (spec 0030 §3, §8): a plan's implementation
 * issue in the repository where the commits are, labelled `rness:plan`,
 * found again by the last line of its body; a sub-issue of the plan's issue
 * in `.rness`; the notes as comments; the pull request of a branch.
 */

export const JOURNAL_LABEL = 'rness:plan'
const JOURNAL_LABEL_COLOR = '0e8a16'
const JOURNAL_LABEL_DESCRIPTION = 'An implementation of a plan of .rness'

/** The last line of an implementation issue's body: how it is found again. */
export const journalMarker = (planPath: string): string =>
  `<!-- rness journal ${planPath} -->`

/** An issue a note can go to: its node id, its number and its repository, `owner/name`. */
export interface JournalIssue {
  id: string
  number: number
  repository: string
}

/** Why a repository takes no implementation issue: §3.4's fallback reads it. */
export class JournalRefused extends Error {
  readonly why: 'issues' | 'missing'
  constructor(why: 'issues' | 'missing', message: string) {
    super(message)
    this.why = why
  }
}

const lastLine = (body: string): string =>
  body
    .trimEnd()
    .split(/\r\n?|\n/)
    .at(-1)
    ?.trim() ?? ''

/** The open implementation issue of `planPath` in `owner/name`, or null. */
export async function journalIssue(
  owner: string,
  name: string,
  planPath: string,
  o: ApiOptions
): Promise<JournalIssue | null> {
  const marker = journalMarker(planPath)
  const found = (await gi.openIssues(owner, name, JOURNAL_LABEL, o)).find(
    (i) => lastLine(i.body) === marker
  )
  return found === undefined
    ? null
    : { id: found.id, number: found.number, repository: `${owner}/${name}` }
}

/**
 * A new implementation issue of `planPath` in `owner/name`, its label made
 * when the repository lacks it. A repository with its Issues off, or that
 * this login cannot see, is {@link JournalRefused}; a write GitHub refuses
 * throws as GitHub says.
 */
export async function createJournalIssue(
  owner: string,
  name: string,
  planPath: string,
  issue: { title: string; body: string },
  o: ApiOptions
): Promise<JournalIssue> {
  const repo = await gi.repository(owner, name, JOURNAL_LABEL, o)
  if (repo === null)
    throw new JournalRefused(
      'missing',
      `${owner}/${name} is not on GitHub, or this login cannot see it`
    )
  if (!repo.issues)
    throw new JournalRefused('issues', `${owner}/${name} takes no issues`)
  const labelId =
    repo.labelId ??
    (await gi.createLabel(
      owner,
      name,
      {
        name: JOURNAL_LABEL,
        color: JOURNAL_LABEL_COLOR,
        description: JOURNAL_LABEL_DESCRIPTION,
      },
      o
    ))
  const made = await gi.createIssue(
    repo.id,
    {
      title: issue.title,
      body: `${issue.body.trimEnd()}\n\n${journalMarker(planPath)}\n`,
      labelIds: [labelId],
    },
    o
  )
  return { ...made, repository: `${owner}/${name}` }
}

/** The issue `number` of `owner/name`: its node id and whether it is open; null when there is none. */
export async function issueOf(
  owner: string,
  name: string,
  number: number,
  o: ApiOptions
): Promise<{ id: string; number: number; open: boolean } | null> {
  const d = await graphqlFound<{
    repository: { issue: { id: string; number: number; state: string } | null }
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { id number state } }
    }`,
    { owner, name, number },
    o
  )
  const i = d?.repository.issue ?? null
  return i === null
    ? null
    : { id: i.id, number: i.number, open: i.state === 'OPEN' }
}

/** `child` made a sub-issue of `parent` (GraphQL `addSubIssue`, schema read 2026-10-06). */
export async function addSubIssue(
  parentId: string,
  childId: string,
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($issueId: ID!, $subIssueId: ID!) {
        addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
          issue {
            id
          }
        }
      }
    `,
    { issueId: parentId, subIssueId: childId },
    o
  )
}

/** A comment on an issue (GraphQL `addComment`). */
export async function comment(
  issueId: string,
  body: string,
  o: ApiOptions
): Promise<void> {
  await graphql(
    `
      mutation ($subjectId: ID!, $body: String!) {
        addComment(input: { subjectId: $subjectId, body: $body }) {
          commentEdge {
            node {
              id
            }
          }
        }
      }
    `,
    { subjectId: issueId, body },
    o
  )
}

/** The latest pull request whose head is `branch` in `owner/name`: its number and state; null when there is none. */
export async function pullRequestFor(
  owner: string,
  name: string,
  branch: string,
  o: ApiOptions
): Promise<{ number: number; state: string } | null> {
  const d = await graphqlFound<{
    repository: {
      pullRequests: { nodes: { number: number; state: string }[] }
    }
  }>(
    `query($owner: String!, $name: String!, $branch: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $branch, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { number state }
        }
      }
    }`,
    { owner, name, branch },
    o
  )
  const pr = d?.repository.pullRequests.nodes[0]
  return pr === undefined ? null : { number: pr.number, state: pr.state }
}
