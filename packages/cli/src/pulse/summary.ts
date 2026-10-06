import { resolve } from 'node:path'

import { type Context, type Declared, fromGithub } from '../commands/pulse.ts'
import { branchOf, commitsBetween } from '../core/git.ts'
import { plansInProgress } from '../core/status.ts'
import {
  type NotedIssue,
  forgetNotes,
  forgetStart,
  issuesNoted,
  startOf,
} from './journal-state.ts'
import { githubRepo, journalOf, planIssue } from './note.ts'

/**
 * The session-end summary (spec 0030 §6): the commits since the session's
 * start on the current branch, the branch's pull request, the duration; on
 * each issue the session's notes went to, else on the one plan in progress
 * of its scope when there is a commit. No note of the limit. Loaded
 * through `import()` only.
 */

export interface SummaryInput {
  c: Context
  /** The board that declares `journal-summary`, and so `journal`. */
  board: Declared
  session: string
  /** The session's scope; null, the root's. */
  scope: string | null
  /** The clone the session worked in: a name of `repos`. */
  clone?: string
}

/** The commits a summary names; the rest are counted. */
const SHOWN = 10

function commitsLine(commits: readonly string[]): string {
  if (commits.length === 0) return 'no commit'
  const named = commits
    .slice(0, SHOWN)
    .map((s) => `\`${s}\``)
    .join(', ')
  const more = commits.length > SHOWN ? ', …' : ''
  return `${commits.length} commit${commits.length === 1 ? '' : 's'} (${named}${more})`
}

/** The issue of the one plan in progress of the scope: its implementation issue in `repo` mode when there is one. */
async function onePlan(
  input: SummaryInput,
  repo: { owner: string; name: string } | null
): Promise<NotedIssue[]> {
  const { c } = input
  const plans = await plansInProgress(
    { root: c.root, rnessDir: c.rnessDir },
    c.manifest,
    input.scope
  )
  const plan = plans.length === 1 ? plans[0] : undefined
  if (plan === undefined) return []
  if (journalOf([input.board])?.journal.to === 'repo' && repo !== null) {
    const there = await fromGithub(
      c.provider.journalIssue(repo.owner, repo.name, plan)
    )
    if (there !== null)
      return [
        { id: there.id, reference: `${there.repository}#${there.number}` },
      ]
  }
  const issue = await planIssue(c, input.board, plan)
  return [{ id: issue.id, reference: `${issue.repository}#${issue.number}` }]
}

/** Posts the summary; the issues it went to, none when skipped. The session's records are forgotten either way. */
export async function postSummary(input: SummaryInput): Promise<string[]> {
  const { c, session } = input
  const url =
    input.clone === undefined ? undefined : c.manifest.repos[input.clone]?.url
  const dir =
    url === undefined || input.clone === undefined
      ? null
      : resolve(c.root, 'org', input.clone)
  try {
    const start = dir === null ? null : await startOf(dir, session)
    const commits =
      dir === null || start === null
        ? []
        : await commitsBetween(dir, start.head).catch(() => [])
    const found = url === undefined ? null : githubRepo(url)
    // A repository of another owner is not the workspace's (spec 0030 §3.4).
    const repo =
      found !== null && found.owner.toLowerCase() === c.org.toLowerCase()
        ? found
        : null
    const noted = await issuesNoted(c.rnessDir, session)
    const targets =
      noted.length > 0
        ? noted
        : commits.length > 0
          ? await onePlan(input, repo)
          : []
    if (targets.length === 0) return []

    const branch = dir === null ? null : await branchOf(dir)
    const pr =
      repo === null || branch === null
        ? null
        : await fromGithub(
            c.provider.pullRequestFor(repo.owner, repo.name, branch)
          )
    const id = session.split(' · ').at(-1) ?? session
    const minutes =
      start === null
        ? null
        : Math.max(1, Math.round((Date.now() - start.at) / 60_000))
    const details = [
      ...(branch === null || start === null
        ? []
        : [`Branch \`${branch}\` · ${commitsLine(commits)}`]),
      ...(pr === null || repo === null
        ? []
        : [
            `Pull request ${repo.owner}/${repo.name}#${pr.number} (${pr.state.toLowerCase()})`,
          ]),
    ]
    const body = [
      [
        '**Session summary**',
        session,
        ...(minutes === null ? [] : [`${minutes} min`]),
      ].join(' · '),
      '',
      ...(details.length === 0 ? [] : [...details, '']),
      `<!-- rness note ${id} summary -->`,
    ].join('\n')
    for (const t of targets) await fromGithub(c.provider.comment(t.id, body))
    return targets.map((t) => t.reference)
  } finally {
    if (dir !== null) await forgetStart(dir, session)
    await forgetNotes(c.rnessDir, session)
  }
}
