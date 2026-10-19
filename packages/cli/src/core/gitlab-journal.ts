import {
  JOURNAL_LABEL,
  type JournalIssue,
  JournalRefused,
  journalMarker,
} from './github-journal.ts'
import * as gi from './gitlab-issues.ts'
import type { GitlabApiOptions } from './gitlab.ts'

/**
 * The agent journal on GitLab (spec 0037 §6, spec 0030 §8): the plan's
 * implementation issue in the project where the commits are, labelled
 * `rness:plan`, found again by the last line of its description; an issue
 * link where GitHub has a sub-issue (Free has no parent issue); the notes;
 * the merge request of a branch. An issue's id is `<project path>#<iid>`:
 * what the link and the note need.
 */

const LABEL_COLOR = '0e8a16'
const LABEL_DESCRIPTION = 'An implementation of a plan of .rness'

export const gitlabIssueId = (project: string, iid: number): string =>
  `${project}#${iid}`

/** `acme/api#4` as its project and iid. */
export function gitlabIssueRef(id: string): { project: string; iid: number } {
  const at = id.lastIndexOf('#')
  const iid = Number(id.slice(at + 1))
  if (at <= 0 || !Number.isInteger(iid))
    throw new Error(`not a GitLab issue: ${id}`)
  return { project: id.slice(0, at), iid }
}

const lastLine = (body: string): string =>
  body
    .trimEnd()
    .split(/\r\n?|\n/)
    .at(-1)
    ?.trim() ?? ''

export async function journalIssue(
  project: string,
  planPath: string,
  o: GitlabApiOptions
): Promise<JournalIssue | null> {
  const marker = journalMarker(planPath)
  const found = (
    await gi.listIssues(
      project,
      { labels: [JOURNAL_LABEL], state: 'opened' },
      o
    )
  ).find((i) => lastLine(i.description) === marker)
  return found === undefined
    ? null
    : {
        id: gitlabIssueId(project, found.iid),
        number: found.iid,
        repository: project,
      }
}

export async function createJournalIssue(
  project: string,
  planPath: string,
  issue: { title: string; body: string },
  o: GitlabApiOptions
): Promise<JournalIssue> {
  const known = await gi.projectOf(project, o)
  if (known === null)
    throw new JournalRefused(
      'missing',
      `${project} is not on GitLab, or this login cannot see it`
    )
  if (!known.issues)
    throw new JournalRefused('issues', `${project} takes no issues`)
  if (!(await gi.labels(project, o)).some((l) => l.name === JOURNAL_LABEL))
    await gi.createLabel(
      project,
      {
        name: JOURNAL_LABEL,
        color: LABEL_COLOR,
        description: LABEL_DESCRIPTION,
      },
      o
    )
  const made = await gi.createIssue(
    project,
    {
      title: issue.title,
      description: `${issue.body.trimEnd()}\n\n${journalMarker(planPath)}\n`,
      labels: [JOURNAL_LABEL],
    },
    o
  )
  return {
    id: gitlabIssueId(project, made.iid),
    number: made.iid,
    repository: project,
  }
}

export async function issueOf(
  project: string,
  iid: number,
  o: GitlabApiOptions
): Promise<{ id: string; number: number; open: boolean } | null> {
  const found = await gi.issue(project, iid, o)
  return found === null
    ? null
    : {
        id: gitlabIssueId(project, found.iid),
        number: found.iid,
        open: found.state === 'opened',
      }
}

/** `child` linked to `parent`, `relates_to`: shown under Linked items on both. */
export async function addSubIssue(
  parentId: string,
  childId: string,
  o: GitlabApiOptions
): Promise<void> {
  const parent = gitlabIssueRef(parentId)
  const child = gitlabIssueRef(childId)
  await gi.link(parent.project, parent.iid, child.project, child.iid, o)
}

export async function comment(
  issueId: string,
  body: string,
  o: GitlabApiOptions
): Promise<void> {
  const ref = gitlabIssueRef(issueId)
  await gi.note(ref.project, ref.iid, body, o)
}

/** The merge request of `branch`: `number` its iid, `state` as GitLab says it (`opened`, `merged`, `closed`). */
export async function pullRequestFor(
  project: string,
  branch: string,
  o: GitlabApiOptions
): Promise<{ number: number; state: string } | null> {
  const mr = await gi.mergeRequest(project, branch, o)
  return mr === null ? null : { number: mr.iid, state: mr.state }
}
