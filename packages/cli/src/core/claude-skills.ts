import type { TargetContext, TargetFile } from './agents.ts'
import { PINNED_BIN } from './delegate.ts'
import { type PackageManager, localRunner } from './pm.ts'

/** The Claude Code plugin rness writes, whole (spec 0016 §3, 0019 §2). */
const PLUGIN = '.claude/skills/rness'

/**
 * The manifest also carries the agent-plugins.org `$schema` and the fields
 * it recommends (spec 0027 §5), so a scanner that looks for an Agent Plugins
 * manifest finds one; Claude Code 2.1.286 validates it without a remark.
 * No version: it would make every release rewrite the file.
 */
const PLUGIN_JSON = `${JSON.stringify(
  {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'rness',
    description:
      'The rness workspace in Claude Code: /rness:status, /rness:adr, /rness:spec, /rness:plan.',
    author: { name: 'rness-dev', url: 'https://rness.dev' },
    homepage: 'https://rness.dev',
    repository: 'https://github.com/rness-dev/rness',
    license: 'MIT',
    keywords: [
      'rness',
      'agents',
      'claude-code',
      'adr',
      'specification',
      'plan',
    ],
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
 * A skill that walks the workspace's lifecycle (spec 0019 §3, the grammar of
 * spec 0028 §7): a procedure the developer or the model starts, the rules
 * left in `CONVENTIONS.md`.
 */
interface Lifecycle {
  name: string
  description: string
  hint: string
  /** The `status` tab it injects, and the collection `doc new` allocates in. */
  tab: 'adr' | 'specs' | 'plans'
  /** Its instructions, `.rness` reached at `rness`, `allocate` the fixed `doc new` line. */
  body: (rness: string, allocate: string) => string
}

/**
 * Who moves a status, and what gets committed: the same words in every
 * lifecycle skill. A status follows the work, whoever does it; accepting a
 * decision stays the developer's, and `/rness:plan from` is their word for
 * a specification (spec 0028 §8). A commit holds only what the agent alone
 * changed, so a teammate's work in progress is never swept in.
 */
const STATUS_RULE = `Move a status yourself when the work calls for it, and whenever the
developer says so: a plan \`In progress\` as you start its tasks,
\`Completed\` once its proofs pass under \`check\`; a specification
\`Implemented\` with its last plan; a document \`Superseded\` by the one that
replaces it. Accepting an ADR is the developer's; a specification is
\`Approved\` by \`/rness:plan from NNNN\`, which is their word for it.`

const COMMIT_RULE = `Commit each file you changed, in its own repository, and only the files
you alone changed: add them by name, never \`git add -A\` nor \`commit -a\`.
A file that had uncommitted changes before your first edit (\`git status\`
tells you), or that someone else changed since, stays uncommitted: say
which. Never push.`

/** The session that writes a document, and its agent, recorded in it (spec 0020 §3.1, 0022 §3). */
const SESSION_LINE = `\`{ id: \${CLAUDE_SESSION_ID}, agent: <model> }\` at the end of
  \`sessions:\` in the front matter, unless that id is already there;
  \`<model>\` is the model you run as, as Claude Code names it, after
  \`Claude\`: for example \`Claude Opus 5.5\``

/**
 * How a new document gets its file (spec 0028 §9): the CLI allocates the
 * number, the skill names and fills the file. The command is fixed and
 * pre-approved; no argument of the developer's reaches a shell.
 */
const allocateStep = (allocate: string, collection: string): string =>
  `Allocate the file: run \`${allocate}\` (pre-approved above). It writes
   \`${collection}/NNNN-untitled.md\` with the next number, the front matter
   and the opening sections, and prints the path. Rename it to
   \`NNNN-<slug>.md\`, the slug a few lowercase words of the title joined by
   hyphens, and write the title as \`# NNNN — <title>\`. Never choose the
   number yourself.`

const HOOK_LINE = (rness: string): string =>
  `The rness hook checks every edit under \`${rness}/\`: fix what it reports.`

const LIFECYCLE: readonly Lifecycle[] = [
  {
    name: 'adr',
    description:
      'Record a decision of the rness workspace as an ADR in .rness/adr/ — a choice expensive to reverse or that creates a lasting constraint — or reopen one. Use when the developer asks for an ADR, or when the conversation reaches such a decision.',
    hint: '[create <subject> | open NNNN]',
    tab: 'adr',
    body: (
      rness,
      allocate
    ) => `You keep the decisions of this workspace: the ADRs in \`${rness}/adr/\`. The table
above lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

The first word is the verb. A bare number (\`0010\`, or a path) is \`open\`;
anything else is the subject of a \`create\`:

- \`create [subject]\`, or nothing: a new ADR, numbered by rness.
- \`open NNNN\`: reopen ADR NNNN. An \`Accepted\` ADR is never edited: offer a
  new one that supersedes it. \`Rejected\` and \`Superseded\` are history too.

Creating:

1. If the developer did not ask for an ADR in so many words, propose one in
   a single line — its title, and why the choice is hard to reverse — and
   wait for a yes.
2. Read \`${rness}/CONVENTIONS.md\` and \`${rness}/adr/0000-template.md\`: they hold the
   rules and the sections; this skill is only the procedure.
3. The subject is the arguments, else the decision just discussed. Context,
   alternatives or consequences missing from the conversation: ask for
   them, one question at a time. Never invent them.
4. ${allocateStep(allocate, 'adr')}
5. Fill it: \`repo\` the repositories under \`org/\` it affects; the template's
   sections, their guidance lines removed; an ADR it replaces named in
   Context — that one becomes \`Superseded\`, with \`superseded_by:\`, only once
   the new ADR is \`Accepted\`. Add ${SESSION_LINE}.
6. ${HOOK_LINE(rness)}

Opening: read the ADR and amend what the developer asks, in place while it
is \`Proposed\`; add the session line above. Nothing of the file's history is
rewritten: a decision that changed is a new ADR.

After writing: give the path and the Decision section. A new ADR stays
\`Proposed\` until the developer accepts it.

${STATUS_RULE}

${COMMIT_RULE}
`,
  },
  {
    name: 'spec',
    description:
      'Write a specification of the rness workspace in .rness/specs/ — the outcome wanted and its scope, before any plan — or reopen one. Use when the developer asks for a spec, or when agreed work is too large to start without one.',
    hint: '[create <subject> | open NNNN]',
    tab: 'specs',
    body: (
      rness,
      allocate
    ) => `You keep the specifications of this workspace, in \`${rness}/specs/\`. The table
above lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

The first word is the verb. A bare number (\`0028\`, or a path) is \`open\`;
anything else is the subject of a \`create\`:

- \`create [subject]\`, or nothing: a new specification, numbered by rness.
- \`open NNNN\`: reopen specification NNNN. One that is \`Implemented\`,
  \`Superseded\` or \`Rejected\` is not edited: offer a new one.

Creating:

1. If the developer did not ask for a specification in so many words,
   propose one in a single line and wait for a yes.
2. Read \`${rness}/CONVENTIONS.md\`, then the most recent specification above: match
   its front matter, sections and tone.
3. The subject is the arguments, else the work just discussed. The problem,
   what is in and out of scope, the ADRs it rests on: ask what the
   conversation does not say, one question at a time.
4. ${allocateStep(allocate, 'specs')}
5. Fill it: \`repo\`, and \`adr:\` linking the decisions it rests on — or the
   rationale in the body when none does; the sections it opened with
   (Summary, Scope, Out of scope, Alternatives considered, To verify,
   Tests), or the most recent specification's when the team's differ. What
   was checked in this session (a document read, a command run) is written
   as verified, with the date; everything else as a proposal or an open
   question. Add ${SESSION_LINE}.
6. ${HOOK_LINE(rness)}

Opening: read the specification and amend what the developer asks — a
section, a scope, an open question answered — \`updated\` today, the session
line added. A status moves only as the developer says, or by
\`/rness:plan from\`.

After writing: give the path and the summary. A new specification starts
\`Draft\`: \`Proposed\` for review; \`/rness:plan from NNNN\` approves it and
plans it.

${STATUS_RULE}

${COMMIT_RULE}
`,
  },
  {
    name: 'plan',
    description:
      'The plans of the rness workspace in .rness/plans/: one from an approved specification (from), one from the conversation (create), one reopened (open), one closed on evidence (check). Use when the developer asks for a plan, when a specification is ready to plan, or when the work of a plan is done.',
    hint: '[create <subject> | from <spec> | open NNNN | check NNNN]',
    tab: 'plans',
    body: (
      rness,
      allocate
    ) => `You keep the plans of this workspace, in \`${rness}/plans/\`. The table above
lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

The first word is the verb. A bare number (\`0037\`, or a path) is \`open\`;
anything else is the subject of a \`create\`:

- \`from NNNN\`: a plan from specification NNNN, which this approves.
- \`create [subject]\`, or nothing: a plan from the conversation, for work
  too small for a specification; \`spec:\` is left empty.
- \`open NNNN\`: reopen plan NNNN.
- \`check NNNN\`: run the proofs of plan NNNN; close it when they all pass.

\`from\`:

1. Read the specification, \`${rness}/CONVENTIONS.md\`, and the most recent plan
   above: match its front matter and sections. A specification that is
   \`Implemented\`, \`Superseded\` or \`Rejected\` is refused: say its status,
   write nothing. A plan of it that is neither \`Completed\` nor \`Abandoned\`:
   reopen it rather than write a second.
2. Typing this command is the developer's approval: the specification moves
   from \`Draft\` or \`Proposed\` to \`Approved\`, \`updated\` today, in the same
   commit as the plan. No confirmation question.
3. Read the code and the repositories the specification touches: every
   task names real files and real commands.
4. ${allocateStep(allocate, 'plans')}
5. Fill it: \`spec:\` linking the specification; tasks in order, as
   checkboxes, each with the files, what changes, and the command that
   proves it (a test, a build, a run) — the last tasks the documentation
   the work makes inaccurate, then the release when the repository has
   one; where the plan decides something the specification leaves open, the
   section it opened with says so. Add ${SESSION_LINE}.
6. ${HOOK_LINE(rness)}

\`create\`: as \`from\`, without a specification. If the developer did not ask
for a plan in so many words, propose one in a single line and wait for a
yes. The body says what the work is and why it needs no specification.

\`open\`: read the plan and its specification; amend what the developer
asks — a task added, split or reworded, a blocker recorded — \`updated\`
today, the session line added; move \`Draft\` to \`Ready\` or \`Blocked\` as they
say. A \`Completed\` or \`Abandoned\` plan is not reopened: offer a new plan of
the same specification.

\`check\`:

1. The plan: the one named, else the one \`In progress\`. Several or none:
   ask.
2. Read the plan, its specification and \`${rness}/CONVENTIONS.md\`.
3. Evidence first. For each task, what proves it: its command run now, or
   its result read in this session. Never mark a task done on belief. A
   check has no cache: run twice, it proves twice.
4. Every task proven:
   - the plan: \`status: Completed\`, \`updated\` today, the checkboxes of the
     proven tasks ticked, and a section \`Verification (YYYY-MM-DD)\` — what
     ran, what it showed, what could not run and why;
   - the specification: \`Implemented\` once every plan of it is
     \`Completed\`; \`updated\` today;
   - the plan and the specification: add ${SESSION_LINE};
   - the smallest set of documents the work makes inaccurate: \`${rness}/docs/\`,
     the READMEs of the repositories it changed.
5. A task not proven: nothing moves — the plan stays \`In progress\`, or
   \`Blocked\` with the blocker written in it. Say, task by task, what passed
   and what remains.
6. ${HOOK_LINE(rness)}

After writing: give the path and the list of tasks, or the statuses moved.
A new plan starts \`Draft\`, and becomes \`Ready\` once the developer agrees
with it or asks you to carry it out.

${STATUS_RULE}

${COMMIT_RULE}
`,
  },
]

/** The skill rness wrote up to 0.17 and `/rness:plan check` replaced (spec 0028 §8). */
const RETIRED_SKILLS = ['done'] as const

/**
 * One lifecycle skill. Its two commands are fixed — the arguments never
 * reach a shell — and named exactly in `allowed-tools`, so they run without
 * a prompt whoever invokes the skill: the status table it opens with, and
 * the allocation of a new document. No
 * `disable-model-invocation`: the model may propose it, and writes nothing
 * without a yes (spec 0019 §3.1).
 */
function lifecycleSkill(rness: string, s: Lifecycle): string {
  const bin = `node "\${CLAUDE_PROJECT_DIR}/${rness}/${PINNED_BIN}"`
  const command = `${bin} status ${s.tab} --cwd "\${CLAUDE_PROJECT_DIR}"`
  // The second fixed line: the allocation of spec 0028 §9, no argument in it.
  const allocate = `${bin} doc new ${s.tab} --cwd "\${CLAUDE_PROJECT_DIR}"`
  return `---
name: ${s.name}
description: ${s.description}
argument-hint: '${s.hint}'
allowed-tools: Bash(${command}), Bash(${allocate})
---

!\`${command}\`

${s.body(rness, allocate)}`
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
    ...RETIRED_SKILLS.map((name) => ({
      file: `${PLUGIN}/skills/${name}/SKILL.md`,
      at,
      retired: true as const,
    })),
  ]
}
