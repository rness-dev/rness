import { relative, resolve, sep } from 'node:path'

import {
  notePosted,
  notesPosted,
  recordNotice,
} from '../board/journal-state.ts'
import { blobUrl, issueUrl } from '../board/urls.ts'
import type { BoardAction } from '../core/board-declaration.ts'
import { parseFrontMatter } from '../core/frontmatter.ts'
import { branchOf, headOf } from '../core/git.ts'
import { JournalRefused } from '../core/github-journal.ts'
import type { JournalIssue } from '../core/github-journal.ts'
import { cloneHolding } from '../core/repos.ts'
import { resolveScope } from '../core/scope.ts'
import { plansInProgress, statusTabs } from '../core/status.ts'
import {
  type Context,
  type Declared,
  context,
  declaredBoards,
  fromGithub,
} from './board.ts'

/**
 * `rness note` and `rness_note` (spec 0030 §4, §5): a short note of
 * the agent's on the plan it implements — on the plan's issue in `.rness`,
 * or on an implementation issue in the repository the session works in, a
 * sub-issue of the plan's (§3). Loaded through `import()` only.
 */

export const KINDS = ['approach', 'deviation', 'blocker', 'done'] as const
export type Kind = (typeof KINDS)[number]
const TITLE: Readonly<Record<Kind, string>> = {
  approach: 'Approach',
  deviation: 'Deviation',
  blocker: 'Blocker',
  done: 'Done',
}
const MAX = 4000
/** What a credential looks like; a note that matches is refused, never redacted. */
const SECRETS = [
  /ghp_/,
  /gho_/,
  /github_pat_/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /xox[abpr]-/,
  /sk-[A-Za-z0-9]{20,}/,
]

/** A refusal said to the agent in one line: the note is not posted. */
export class NoteRefused extends Error {}

export interface NoteInput {
  /** The session's directory. */
  cwd: string
  text: string
  kind?: string
  /** `.rness/`-relative: `plans/0021-x.md`; absent, the one plan in progress. */
  plan?: string
  /** `claude · 1a2b3c4d`, or a session id; absent, `CLAUDE_CODE_SESSION_ID`. */
  session?: string
  env?: NodeJS.ProcessEnv
  /** Internal (tests): GitHub API base. */
  githubApi?: string
}

/** Where a note went: `acme/api#87`, the reference a pull request uses. */
export interface Posted {
  reference: string
  to: 'plan' | 'repo'
}

/** The session as the hooks name it: `claude · 1a2b3c4d`; null without one. */
export function sessionFrom(
  given: string | undefined,
  env: NodeJS.ProcessEnv
): string | null {
  const raw = given ?? env['CLAUDE_CODE_SESSION_ID'] ?? ''
  if (raw.trim() === '') return null
  // Claude Code's Bash tool carries `CLAUDE_CODE_SESSION_ID` (read
  // 2026-10-06, 2.1.291); a session already named is kept as named.
  return raw.includes(' · ') ? raw : `claude · ${raw.slice(0, 8)}`
}

/** The text, its kind and the session, checked before anything is read. */
function checked(input: NoteInput): { kind: Kind; session: string } {
  const length = input.text.trim().length
  if (length < 1 || length > MAX)
    throw new NoteRefused(
      `a note holds 1 to ${MAX.toLocaleString('en')} characters (this one ${length})`
    )
  if (SECRETS.some((s) => s.test(input.text)))
    throw new NoteRefused('the note looks like it holds a credential')
  const kind = KINDS.find((k) => k === (input.kind ?? 'approach'))
  if (kind === undefined)
    throw new NoteRefused(
      `--kind is one of ${KINDS.slice(0, -1).join(', ')} or ${KINDS.at(-1)}`
    )
  const session = sessionFrom(input.session, input.env ?? process.env)
  if (session === null)
    throw new NoteRefused(
      'no session: write it from a Claude Code session, or pass --session'
    )
  return { kind, session }
}

export type Journal = Extract<BoardAction, { action: 'journal' }>

/** The board that keeps the journal: the first whose session start declares `journal`. */
export function journalOf(
  declared: readonly Declared[]
): { board: Declared; journal: Journal } | null {
  for (const d of declared)
    for (const a of d.declaration.hooks['session-start'] ?? [])
      if (a.action === 'journal') return { board: d, journal: a }
  return null
}

/** `git@github.com:acme/api.git` or `https://github.com/acme/api` → `acme`, `api`; null on another host. */
export function githubRepo(
  url: string
): { owner: string; name: string } | null {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  return m === null || m[1] === undefined || m[2] === undefined
    ? null
    : { owner: m[1], name: m[2] }
}

/** The plan the note is on (spec 0030 §2). */
async function planOf(
  c: Context,
  cwd: string,
  given?: string
): Promise<string> {
  const tabs = await statusTabs(c.rnessDir)
  const plans = tabs.find((t) => t.name === 'plans')?.rows ?? []
  if (given !== undefined) {
    const path = given.replace(/^\.rness\//, '')
    if (!plans.some((r) => r.path === path))
      throw new NoteRefused(`${given} is no plan of .rness`)
    return path
  }
  const scope = resolveScope(
    c.manifest,
    relative(c.root, resolve(cwd)).split(sep).join('/')
  )
  const candidates = await plansInProgress(
    { root: c.root, rnessDir: c.rnessDir },
    c.manifest,
    scope
  )
  if (candidates.length === 0)
    throw new NoteRefused(
      `no plan in progress in scope ${scope ?? 'global'}: set one In progress first`
    )
  if (candidates.length > 1)
    throw new NoteRefused(
      `several plans in progress: pass --plan, one of ${candidates.join(', ')}`
    )
  return candidates[0] ?? ''
}

/** A plan's issue in `.rness`, found by its card's `Path` on the journal's board. */
export async function planIssue(
  c: Context,
  board: Declared,
  plan: string
): Promise<JournalIssue> {
  const items = await fromGithub(
    c.provider.items(board.board, { bodies: false })
  )
  const number = items.find((i) => i.path === plan)?.issue?.number
  const found =
    number === undefined
      ? null
      : await fromGithub(c.provider.issueOf(c.org, '.rness', number))
  if (found === null)
    throw new NoteRefused(`${plan} has no issue yet: rness board push`)
  return {
    id: found.id,
    number: found.number,
    repository: `${c.org}/.rness`,
  }
}

/** A GitHub refusal to write (a token or organization policy, spec 0028). */
const refusedWrite = (e: unknown): boolean =>
  e instanceof Error &&
  /not accessible|forbidden|permission|must have push access/i.test(e.message)

/** The implementation issue's body (spec 0030 §3.2): the plan, its issue, its specification. */
async function implementationBody(
  c: Context,
  plan: string,
  planNumber: number
): Promise<string> {
  const lines = [
    `Plan [\`${plan}\`](${blobUrl(c.org, plan)}) · [plan issue](${issueUrl(c.org, planNumber)})`,
  ]
  try {
    const { readFile } = await import('node:fs/promises')
    const front =
      parseFrontMatter(
        await readFile(resolve(c.rnessDir, ...plan.split('/')), 'utf8')
      ) ?? {}
    const spec = /\(\.\.\/(specs\/[^)\s]+\.md)\)/.exec(
      String(front['spec'] ?? '')
    )
    if (spec?.[1] !== undefined)
      lines.push(`Specification [\`${spec[1]}\`](${blobUrl(c.org, spec[1])})`)
  } catch {
    // No specification named: the plan alone.
  }
  return `${lines.join('\n')}\n\nThe agent's notes on this implementation follow as comments. The pull request that completes it carries \`Closes\` with this issue's reference.`
}

/** Posts a note; throws {@link NoteRefused} or GitHub's error, in one line. */
export async function postNote(input: NoteInput): Promise<Posted> {
  const { kind, session } = checked(input)
  const c = await context({
    cwd: input.cwd,
    ...(input.githubApi === undefined ? {} : { githubApi: input.githubApi }),
  })
  const declared = await declaredBoards(c)
  const kept = journalOf(declared)
  if (kept === null)
    throw new NoteRefused(
      'no board keeps a journal: add { "action": "journal", "to": "plan" } to its session-start hooks'
    )
  const plan = await planOf(c, input.cwd, input.plan)
  if ((await notesPosted(c.rnessDir, session, plan)) >= kept.journal.limit)
    throw new NoteRefused(
      'journal full for this session: put the rest in the pull request'
    )
  const parent = await planIssue(c, kept.board, plan)
  const clone = cloneHolding(c.root, c.manifest.repos, input.cwd)

  let target: JournalIssue = parent
  let why: string | null = null
  if (kept.journal.to === 'repo' && clone !== null) {
    const repo = githubRepo(clone.url)
    if (repo === null || repo.owner.toLowerCase() !== c.org.toLowerCase())
      why = `${clone.name} is not on the workspace's provider`
    else
      try {
        const there = await fromGithub(
          c.provider.journalIssue(repo.owner, repo.name, plan)
        )
        if (there !== null) target = there
        else {
          const row = (await statusTabs(c.rnessDir))
            .find((t) => t.name === 'plans')
            ?.rows.find((r) => r.path === plan)
          target = await fromGithub(
            c.provider.createJournalIssue(repo.owner, repo.name, plan, {
              title: `Implement ${row === undefined ? plan : `${row.id} — ${row.title}`}`,
              body: await implementationBody(c, plan, parent.number),
            })
          )
          try {
            await fromGithub(c.provider.addSubIssue(parent.id, target.id))
          } catch {
            // A link GitHub refuses: the issue named on the plan's instead (§3.3).
            await fromGithub(
              c.provider.comment(
                parent.id,
                `Implementation: ${target.repository}#${target.number}`
              )
            )
          }
        }
      } catch (e) {
        if (e instanceof JournalRefused)
          why =
            e.why === 'issues'
              ? `${repo.owner}/${repo.name} takes no issues`
              : `${repo.owner}/${repo.name} is not on GitHub, or this login cannot see it`
        else if (refusedWrite(e))
          why = `${repo.owner}/${repo.name} refuses this login's write`
        else throw e
      }
  }
  if (why !== null)
    await recordNotice(`journal — ${why}, notes go to the plan's issue`)

  const where = clone?.dir ?? input.cwd
  const [branch, head] = await Promise.all([branchOf(where), headOf(where)])
  const id = session.split(' · ').pop() ?? session
  const header = [
    `**${TITLE[kind]}**`,
    session,
    ...(branch === null || head === null
      ? []
      : [`\`${branch}\` @ \`${head.slice(0, 7)}\``]),
  ].join(' · ')
  const body = [
    ...(why === null
      ? []
      : [`_${why}: this note goes to the plan's issue._`, '']),
    header,
    '',
    input.text.trim(),
    '',
    `<!-- rness note ${id} -->`,
  ].join('\n')
  await fromGithub(c.provider.comment(target.id, body))
  const reference = `${target.repository}#${target.number}`
  await notePosted(c.rnessDir, session, plan, { id: target.id, reference })
  return {
    reference,
    to: target === parent ? 'plan' : 'repo',
  }
}

/** `rness note`: the text from the argument, or stdin when it is absent or `-`. */
export async function noteCommand(opts: {
  text?: string
  kind?: string
  plan?: string
  session?: string
  cwd?: string
  githubApi?: string
  /** Internal (tests): what stdin holds. */
  stdin?: () => Promise<string>
}): Promise<number> {
  try {
    const text =
      opts.text === undefined || opts.text === '-'
        ? await (opts.stdin ?? readStdin)()
        : opts.text
    const posted = await postNote({
      cwd: opts.cwd ?? process.cwd(),
      text,
      ...(opts.kind === undefined ? {} : { kind: opts.kind }),
      ...(opts.plan === undefined ? {} : { plan: opts.plan }),
      ...(opts.session === undefined ? {} : { session: opts.session }),
      ...(opts.githubApi === undefined ? {} : { githubApi: opts.githubApi }),
    })
    process.stdout.write(`${posted.reference}\n`)
    return 0
  } catch (e) {
    process.stderr.write(
      `rness: ${e instanceof Error ? e.message : String(e)}\n`
    )
    return 1
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
