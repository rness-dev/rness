import { type AdfDocument, toAdf } from '../board/adf.ts'
import { type JournalIssue, JournalRefused } from './github-journal.ts'
import * as ji from './jira-issues.ts'
import type { JiraApiOptions } from './jira.ts'

/**
 * The agent journal in a Jira space (spec 0039 §6, spec 0030 §8):
 * Bitbucket has no issues, so the implementation issue of each repository
 * lives in the workspace's space, labelled `rness-plan` (Jira's rule for a
 * colon is undocumented), found again by the last paragraph of its
 * description; an issue link `Relates` where GitHub has a sub-issue; the
 * notes as comments, in ADF. An issue's id is its key, `RNESS-12`, which
 * is also how it is referred to.
 */

export const JIRA_JOURNAL_LABEL = 'rness-plan'

/**
 * The last paragraph of an implementation issue: ADF has no comment, so a
 * line of text, which names the repository since every repository's issue
 * is in the one space.
 */
export const jiraJournalMarker = (
  repository: string,
  planPath: string
): string => `rness journal ${repository} ${planPath}`

const asJournal = (space: string, key: string): JournalIssue => ({
  id: key,
  number: ji.issueNumber(key),
  repository: space,
  reference: key,
})

/** The text of a document's last block, trimmed. */
function lastText(doc: AdfDocument | null): string {
  const last = doc?.content.at(-1)
  const walk = (
    n: { text?: string; content?: unknown[] } | undefined
  ): string =>
    (n?.text ?? '') +
    ((n?.content ?? []) as { text?: string; content?: unknown[] }[])
      .map(walk)
      .join('')
  return walk(last).trim()
}

/** The open implementation issue of `planPath` for `repository` (`owner/name`), or null. */
export async function journalIssue(
  space: string,
  repository: string,
  planPath: string,
  o: JiraApiOptions
): Promise<JournalIssue | null> {
  const marker = jiraJournalMarker(repository, planPath)
  const found = (
    await ji.search(
      `project = "${space}" AND labels = "${JIRA_JOURNAL_LABEL}" AND statusCategory != Done`,
      ['description'],
      o
    )
  ).find((i) => lastText(i.description) === marker)
  return found === undefined ? null : asJournal(space, found.key)
}

/**
 * A new implementation issue: a Task of the space labelled `rness-plan`,
 * its body in ADF, the marker its last paragraph. `JournalRefused` when the
 * space is not there, or the login cannot create in it.
 */
export async function createJournalIssue(
  space: string,
  repository: string,
  planPath: string,
  issue: { title: string; body: string },
  o: JiraApiOptions
): Promise<JournalIssue> {
  if ((await ji.space(space, o)) === null)
    throw new JournalRefused(
      'missing',
      `space ${space} not found on ${o.site} (or not visible to you)`
    )
  const missing = await ji.missingPermissions(space, ['CREATE_ISSUES'], o)
  if (missing.length > 0)
    throw new JournalRefused(
      'issues',
      `${space} on ${o.site}: this login lacks ${missing.join(', ')}`
    )
  const body = await toAdf(issue.body)
  const description: AdfDocument = {
    ...body,
    content: [
      ...body.content,
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: jiraJournalMarker(repository, planPath) },
        ],
      },
    ],
  }
  const made = await ji.createIssue(
    space,
    await ji.taskType(space, o),
    { summary: issue.title, description, labels: [JIRA_JOURNAL_LABEL] },
    o
  )
  return asJournal(space, made.key)
}

/** The issue `<space>-<number>`: its key as its id, and whether it is open (not of the category Done). */
export async function issueOf(
  space: string,
  number: number,
  o: JiraApiOptions
): Promise<{ id: string; number: number; open: boolean } | null> {
  const found = await ji.issue(`${space}-${number}`, o)
  return found === null
    ? null
    : { id: found.key, number: found.number, open: !found.done }
}

/** `child` linked to `parent`, `Relates`: shown on both. */
export async function addSubIssue(
  parentKey: string,
  childKey: string,
  o: JiraApiOptions
): Promise<void> {
  await ji.relate(parentKey, childKey, o)
}

/** A comment, its Markdown in ADF. */
export async function comment(
  key: string,
  markdown: string,
  o: JiraApiOptions
): Promise<void> {
  await ji.comment(key, await toAdf(markdown), o)
}
