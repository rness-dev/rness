import { resolve } from 'node:path'

import { type Context, type Declared, fromGithub } from '../commands/board.ts'
import { journalOf, planIssue, workspaceRepo } from '../commands/note.ts'
import { branchOf, commitsBetween } from '../core/git.ts'
import { journalReference } from '../core/github-journal.ts'
import { providerOf } from '../core/manifest.ts'
import { readRefusals } from '../core/refusals.ts'
import { plansInProgress } from '../core/status.ts'
import {
  type NotedIssue,
  forgetNotes,
  forgetStart,
  issuesNoted,
  startOf,
} from './journal-state.ts'

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

/**
 * The refusals of policies in the session's clone since its start (spec 0040
 * §6): `Policies: 3 refusals (no-em-dash 2, no-agent-trailers 1)`, the most
 * refused first. One record is one refusal. Null when there is none.
 */
export function policiesLine(
  refusals: readonly { policy: string }[]
): string | null {
  if (refusals.length === 0) return null
  const counts = new Map<string, number>()
  for (const { policy } of refusals)
    counts.set(policy, (counts.get(policy) ?? 0) + 1)
  const named = [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([policy, n]) => `${policy} ${n}`)
    .join(', ')
  const n = refusals.length
  return `Policies: ${n} refusal${n === 1 ? '' : 's'} (${named})`
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
      return [{ id: there.id, reference: journalReference(there) }]
  }
  const issue = await planIssue(c, input.board, plan)
  return [{ id: issue.id, reference: journalReference(issue) }]
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
    // A repository of another owner is not the workspace's (spec 0030 §3.4).
    const repo = url === undefined ? null : workspaceRepo(c, url)
    const refusals =
      dir === null || start === null
        ? []
        : await readRefusals(dir, { since: start.at })
    const noted = await issuesNoted(c.rnessDir, session)
    const targets =
      noted.length > 0
        ? noted
        : commits.length > 0 || refusals.length > 0
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
    const refused = policiesLine(refusals)
    const details = [
      ...(branch === null || start === null
        ? []
        : [`Branch \`${branch}\` · ${commitsLine(commits)}`]),
      ...(pr === null || repo === null
        ? []
        : [
            providerOf(c.manifest) === 'gitlab'
              ? `Merge request ${repo.owner}/${repo.name}!${pr.number} (${pr.state.toLowerCase()})`
              : `Pull request ${repo.owner}/${repo.name}#${pr.number} (${pr.state.toLowerCase()})`,
          ]),
      ...(refused === null ? [] : [refused]),
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
