import type { TargetContext, TargetFile } from './agents.ts'
import { PINNED_BIN } from './delegate.ts'
import { type PackageManager, localRunner } from './pm.ts'

/** The Claude Code plugin rness writes, whole (spec 0016 §3, 0019 §2). */
const PLUGIN = '.claude/skills/rness'

const PLUGIN_JSON = `${JSON.stringify(
  {
    name: 'rness',
    description:
      'The rness workspace in Claude Code: /rness:status, /rness:adr, /rness:spec, /rness:plan, /rness:done.',
  },
  null,
  2
)}\n`

/**
 * The `status` skill, `rness` being the path of `.rness` from the project
 * directory. One fixed command — the arguments never reach a shell — named
 * exactly in `allowed-tools`, so it runs without a prompt. Nothing in it
 * depends on the version; only its last line depends on the workspace's
 * package manager (spec 0019 §5), so an upgrade rewrites it only when that
 * text changes.
 */
function statusSkill(rness: string, pm: PackageManager): string {
  const command = `node "\${CLAUDE_PROJECT_DIR}/${rness}/${PINNED_BIN}" status --cwd "\${CLAUDE_PROJECT_DIR}"`
  return `---
name: status
description: The status of every decision, specification, plan and other tracked document of the rness workspace, one table per directory. Read-only.
argument-hint: '[tab]'
disable-model-invocation: true
allowed-tools: Bash(${command})
---

!\`${command}\`

Show the output above to the user as it is: the heading and the tables,
nothing added, nothing summarised, no other tool. Arguments: \`$ARGUMENTS\`.
When they name a tab, show only that tab's section. If the output says the
module cannot be found, say instead that ${rness} is not installed next to
this repository.

End with this line: _For the view with tabs and scrolling: here, Ctrl+Z,
then \`npx @rness/cli status\` (q to close), then \`fg\`; or in another
terminal, from the workspace's \`.rness/\`: \`${localRunner(pm)} rness status\`._
`
}

/**
 * A skill that walks the workspace's lifecycle (spec 0019 §3): a procedure
 * the developer or the model starts, the rules left in `CONVENTIONS.md`.
 */
interface Lifecycle {
  name: string
  description: string
  hint: string
  /** The `status` tab it injects: the ids, the next number, what to link. */
  tab: 'adr' | 'specs' | 'plans'
  /** Its instructions, `.rness` reached at `rness`. */
  body: (rness: string) => string
}

const LIFECYCLE: readonly Lifecycle[] = [
  {
    name: 'adr',
    description:
      'Record a decision of the rness workspace as an ADR in .rness/adr/ — a choice expensive to reverse or that creates a lasting constraint. Use when the developer asks for an ADR, or when the conversation reaches such a decision.',
    hint: '[subject | NNNN]',
    tab: 'adr',
    body: (
      rness
    ) => `You record a decision of this workspace as an ADR in \`${rness}/adr/\`. The table
above lists the existing ADRs, newest first. Arguments: \`$ARGUMENTS\`.

Before writing:

1. If the developer did not ask for an ADR in so many words, propose one in
   a single line — its title, and why the choice is hard to reverse — and
   wait for a yes.
2. Read \`${rness}/CONVENTIONS.md\` and \`${rness}/adr/0000-template.md\`: they hold the
   rules and the sections; this skill is only the procedure.
3. Arguments naming an ADR (\`NNNN\`): reopen that file. An \`Accepted\` ADR is
   never edited: offer a new ADR that supersedes it.
4. Otherwise the subject is the arguments, else the decision just
   discussed. Context, alternatives or consequences missing from the
   conversation: ask for them, one question at a time. Never invent them.

Writing:

- \`${rness}/adr/NNNN-<slug>.md\`, NNNN the highest number above plus one.
- The template's front matter and sections, filled in, its guidance lines
  removed: \`date\` today, \`status: Proposed\`, \`repo\` the repositories under
  \`org/\` it affects.
- An ADR it replaces is named in Context. That one becomes \`Superseded\`,
  with \`superseded_by:\`, only once the new ADR is \`Accepted\`.
- Add \`\${CLAUDE_SESSION_ID}\` at the end of \`sessions:\` in the front matter,
  unless it is already there.
- The rness hook checks every edit under \`${rness}/\`: fix what it reports.

After writing: give the path and the Decision section, and say the ADR
stays \`Proposed\` until the developer accepts it. Change a status only when
the developer says so. Do not commit.
`,
  },
  {
    name: 'spec',
    description:
      'Write a specification of the rness workspace in .rness/specs/ — the outcome wanted and its scope, before any plan. Use when the developer asks for a spec, or when agreed work is too large to start without one.',
    hint: '[subject | NNNN]',
    tab: 'specs',
    body: (
      rness
    ) => `You write a specification of this workspace in \`${rness}/specs/\`. The table above
lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

Before writing:

1. If the developer did not ask for a specification in so many words,
   propose one in a single line and wait for a yes.
2. Read \`${rness}/CONVENTIONS.md\`, then the most recent specification above: match
   its front matter, sections and tone.
3. Arguments naming a specification (\`NNNN\`): reopen it. One that is
   \`Implemented\`, \`Superseded\` or \`Rejected\` is not edited: offer a new one.
4. Otherwise the subject is the arguments, else the work just discussed.
   The problem, what is in and out of scope, the ADRs it rests on: ask what
   the conversation does not say, one question at a time.

Writing:

- \`${rness}/specs/NNNN-<slug>.md\`, NNNN the highest number above plus one.
- \`date\` and \`updated\` today, \`status: Draft\`, \`repo\`, and \`adr:\` linking
  the decisions it rests on — or the rationale in the body when none does.
- No specification yet to follow: Summary, Scope, Out of scope,
  Alternatives considered, To verify, Tests.
- What was checked in this session (a document read, a command run) is
  written as verified, with the date; everything else as a proposal or an
  open question.
- Add \`\${CLAUDE_SESSION_ID}\` at the end of \`sessions:\` in the front matter,
  unless it is already there.
- The rness hook checks every edit under \`${rness}/\`: fix what it reports.

After writing: give the path and the summary. It stays \`Draft\` until the
developer moves it (\`Proposed\` for review, \`Approved\` to plan it). No plan
here: \`/rness:plan NNNN\` once approved. Do not commit.
`,
  },
  {
    name: 'plan',
    description:
      'Turn an approved specification of the rness workspace into a plan in .rness/plans/ — ordered tasks, each with the command that proves it done. Use when the developer asks for a plan, or when a specification has just been approved.',
    hint: '<spec NNNN>',
    tab: 'plans',
    body: (
      rness
    ) => `You turn a specification into a plan in \`${rness}/plans/\`. The table above lists
the existing plans, newest first. Arguments, the specification:
\`$ARGUMENTS\`.

Before writing:

1. If the developer did not ask for a plan in so many words, propose one in
   a single line and wait for a yes.
2. No specification named: ask which. Read it, \`${rness}/CONVENTIONS.md\`, and the
   most recent plan above: match its front matter and sections.
3. A specification that is not \`Approved\`: say so, and plan it only if the
   developer confirms. A plan of it that is neither \`Completed\` nor
   \`Abandoned\`: reopen it rather than write a second.
4. Read the code and the repositories the specification touches: every
   task names real files and real commands.

Writing:

- \`${rness}/plans/NNNN-<slug>.md\`, NNNN the highest plan number above plus one —
  not the specification's.
- \`date\` and \`updated\` today, \`status: Draft\`, \`repo\`, \`spec:\` linking the
  specification.
- Tasks in order, as checkboxes. Each gives the files, what changes, and
  the command that proves it (a test, a build, a run). The last tasks:
  the documentation the work makes inaccurate, then the release when the
  repository has one.
- Where the plan decides something the specification leaves open, a
  section says so.
- Add \`\${CLAUDE_SESSION_ID}\` at the end of \`sessions:\` in the front matter,
  unless it is already there.
- The rness hook checks every edit under \`${rness}/\`: fix what it reports.

After writing: give the path and the list of tasks. It becomes \`Ready\` when
the developer agrees. Do not commit.
`,
  },
  {
    name: 'done',
    description:
      'Close a piece of work of the rness workspace — check each task of its plan on evidence, then move the plan and its specification to their final status and correct the documents the work made inaccurate. Use when the developer says the work is done, or when the last task of a plan passes.',
    hint: '[plan NNNN]',
    tab: 'plans',
    body: (
      rness
    ) => `You close a piece of work: its plan in \`${rness}/plans/\`, its specification, and
what they made inaccurate. The table above lists the plans, newest first.
Arguments: \`$ARGUMENTS\`.

1. The plan: the one named, else the one \`In progress\`. Several or none:
   ask.
2. If the developer did not ask to close it in so many words, propose it in
   a single line and wait for a yes.
3. Read the plan, its specification and \`${rness}/CONVENTIONS.md\`.
4. Evidence first. For each task, what shows it done: a test, a build, a
   command's output in this session. A task without evidence: run its
   check now, or report it. Never mark a task done on belief.
5. All tasks proven:
   - the plan: \`status: Completed\`, \`updated\` today, the checkboxes of the
     proven tasks ticked, and a section \`Verification (YYYY-MM-DD)\` — what
     ran, what it showed, what could not run and why;
   - the specification: \`Implemented\` once every plan of it is
     \`Completed\`; \`updated\` today;
   - the plan and the specification: add \`\${CLAUDE_SESSION_ID}\` at the end
     of \`sessions:\` in their front matter, unless it is already there;
   - the smallest set of documents the work makes inaccurate: \`${rness}/docs/\`,
     the READMEs of the repositories it changed.
6. A task not proven: the plan stays \`In progress\` — or \`Blocked\`, the
   blocker written in it. Say what remains.
7. The rness hook checks every edit under \`${rness}/\`: fix what it reports.

After: list the files changed and the statuses moved. Do not commit.
`,
  },
]

/**
 * One lifecycle skill. Its one command is read-only and fixed — the
 * arguments never reach a shell — and named exactly in `allowed-tools`, so it
 * runs without a prompt whoever invokes the skill. No
 * `disable-model-invocation`: the model may propose it, and writes nothing
 * without a yes (spec 0019 §3.1).
 */
function lifecycleSkill(rness: string, s: Lifecycle): string {
  const command = `node "\${CLAUDE_PROJECT_DIR}/${rness}/${PINNED_BIN}" status ${s.tab} --cwd "\${CLAUDE_PROJECT_DIR}"`
  return `---
name: ${s.name}
description: ${s.description}
argument-hint: '${s.hint}'
allowed-tools: Bash(${command})
---

!\`${command}\`

${s.body(rness)}`
}

/** The plugin's files, for a project directory reaching `.rness` at `rness`. */
export function pluginFiles(
  rness: string,
  at: TargetFile['at'],
  ctx: TargetContext
): TargetFile[] {
  return [
    { file: `${PLUGIN}/.claude-plugin/plugin.json`, at, content: PLUGIN_JSON },
    {
      file: `${PLUGIN}/skills/status/SKILL.md`,
      at,
      content: statusSkill(rness, ctx.packageManager),
    },
    ...LIFECYCLE.map((s) => ({
      file: `${PLUGIN}/skills/${s.name}/SKILL.md`,
      at,
      content: lifecycleSkill(rness, s),
    })),
  ]
}
