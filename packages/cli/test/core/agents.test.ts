import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { parse as parseYaml } from 'yaml'

import {
  SUPPORTED_AGENTS,
  TARGETS,
  unsupportedAgents,
  unsupportedMessage,
} from '../../src/core/agents.ts'
import { VERSION } from '../../src/version.ts'

// The exact lines Claude Code runs. Never change them: a changed entry is
// appended next to the old one, and the hook runs twice (spec 0015 §2.3).
const CLONE_START =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-start; else echo \'{"systemMessage":"rness: ../../.rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness."}\'; fi'
const CLONE_EDIT =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook post-tool-use; fi'
const CLONE_GUARD =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook pre-tool-use; fi'
const ROOT_START =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-start; else echo \'{"systemMessage":"rness: .rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness."}\'; fi'
const ROOT_EDIT =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook post-tool-use; fi'

const ROOT_GUARD =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook pre-tool-use; fi'
const CLONE_END =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-end; fi'
const ROOT_END =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-end; fi'

const hooks = (start: string, guard: string, edit: string, end: string) => [
  {
    path: ['hooks', 'SessionStart'],
    contains: { hooks: [{ type: 'command', command: start, timeout: 10 }] },
    label: 'the rness session-start hook',
  },
  {
    path: ['hooks', 'PreToolUse'],
    contains: {
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: guard, timeout: 10 }],
    },
    label: 'the rness pre-tool-use hook',
  },
  {
    path: ['hooks', 'PostToolUse'],
    contains: {
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: edit, timeout: 10 }],
    },
    label: 'the rness post-tool-use hook',
  },
  {
    path: ['hooks', 'SessionEnd'],
    contains: { hooks: [{ type: 'command', command: end, timeout: 10 }] },
    label: 'the rness session-end hook',
  },
]

// The plugin rness owns whole (spec 0016 §3, 0019 §2). Nothing
// version-specific: an upgrade rewrites a file only when its text changes.
// The status skill's last line names the workspace's manager (spec 0019 §5).
const PLUGIN_JSON = `{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "rness",
  "description": "The rness workspace in Claude Code: /rness:status, /rness:adr, /rness:spec, /rness:plan.",
  "author": {
    "name": "rness-dev",
    "url": "https://rness.dev"
  },
  "homepage": "https://rness.dev",
  "repository": "https://github.com/rness-dev/rness",
  "license": "MIT",
  "keywords": [
    "rness",
    "agents",
    "claude-code",
    "adr",
    "specification",
    "plan"
  ],
  "types": "./types/index.d.ts"
}
`
/**
 * The mod's files (spec 0029 §3.1), as they are in the package's mod/; the
 * module with the path of `.rness` of its place written in.
 */
const MOD = (rel: string, rness: string) =>
  readFileSync(new URL(`../../mod/${rel}`, import.meta.url), 'utf8').replace(
    "const RNESS = '.rness'",
    `const RNESS = '${rness}'`
  )
const skill = (rness: string, run = 'npx') => `---
name: status
description: The status of every decision, specification, plan and other tracked document of the rness workspace, one table per directory. Read-only.
argument-hint: '[tab]'
disable-model-invocation: true
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status --cwd "\${CLAUDE_PROJECT_DIR}")
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status --cwd "\${CLAUDE_PROJECT_DIR}"\`

Show the output above to the user as it is: the heading and the tables,
nothing added, nothing summarised, no other tool. Arguments: \`$ARGUMENTS\`.
When they name a tab, show only that tab's section. If the output says the
module cannot be found, say instead that ${rness} is not installed next to
this repository.

End with this line: _For the view with tabs and scrolling: here, Ctrl+Z,
then \`npx @rness/cli status\` (q to close), then \`fg\`; or in another
terminal, from the workspace's \`.rness/\`: \`${run} rness status\`._
`
// The lifecycle skills, as spec 0019 §3 and spec 0028 §7 write them.
const LIFECYCLE = {
  adr: (rness: string) => `---
name: adr
description: Record a decision of the rness workspace as an ADR in .rness/adr/ — a choice expensive to reverse or that creates a lasting constraint — or reopen one. Use when the developer asks for an ADR, or when the conversation reaches such a decision.
argument-hint: '[create <subject> | open NNNN]'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status adr --cwd "\${CLAUDE_PROJECT_DIR}"), Bash(node "${rness}/node_modules/@rness/cli/dist/bin/rness.js" doc new adr)
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status adr --cwd "\${CLAUDE_PROJECT_DIR}"\`

You keep the decisions of this workspace: the ADRs in \`${rness}/adr/\`. The table
above lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

The first word is the verb, when a reference (\`0010\`, or a path) follows
it; a bare reference is \`open\`; any other words are the subject of a
\`create\` (\`open source licensing\` is a subject):

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
4. Allocate the file: run \`node "${rness}/node_modules/@rness/cli/dist/bin/rness.js" doc new adr\` from the project directory, where
   Claude Code was opened (pre-approved above as typed; \`CLAUDE_PROJECT_DIR\`
   is not set in your shell, so the path is relative). It writes
   \`adr/NNNN-untitled.md\` with the next number, the front matter
   and the opening sections, and prints the path. Rename it to
   \`NNNN-<slug>.md\`, the slug a few lowercase words of the title joined by
   hyphens, and write the title as \`# NNNN — <title>\`. Never choose the
   number yourself.
5. Fill it: \`repo\` the repositories under \`org/\` it affects; the template's
   sections, their guidance lines removed; an ADR it replaces named in
   Context — that one becomes \`Superseded\`, with \`superseded_by:\`, only once
   the new ADR is \`Accepted\`. Add \`{ id: \${CLAUDE_SESSION_ID}, agent: <model> }\` at the end of
  \`sessions:\` in the front matter, unless that id is already there;
  \`<model>\` is the model you run as, as Claude Code names it, after
  \`Claude\`: for example \`Claude Opus 5.5\`.
6. The rness hook checks every edit under \`${rness}/\`: fix what it reports.

Opening: read the ADR and amend what the developer asks, in place while it
is \`Proposed\`; add the session line above. Nothing of the file's history is
rewritten: a decision that changed is a new ADR.

After writing: give the path and the Decision section. A new ADR stays
\`Proposed\` until the developer accepts it.

Move a status yourself when the work calls for it, and whenever the
developer says so: a plan \`In progress\` as you start its tasks,
\`Completed\` once its proofs pass under \`check\`; a specification
\`Implemented\` with its last plan; a document \`Superseded\` by the one that
replaces it. Accepting an ADR is the developer's; a specification is
\`Approved\` by \`/rness:plan from NNNN\`, which is their word for it.

Commit each file you changed, in its own repository, and only the files
you alone changed: add them by name, never \`git add -A\` nor \`commit -a\`.
A file that had uncommitted changes before your first edit (\`git status\`
tells you), or that someone else changed since, stays uncommitted: say
which. Never push.
`,
  spec: (rness: string) => `---
name: spec
description: Write a specification of the rness workspace in .rness/specs/ — the outcome wanted and its scope, before any plan — or reopen one. Use when the developer asks for a spec, or when agreed work is too large to start without one.
argument-hint: '[create <subject> | open NNNN]'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status specs --cwd "\${CLAUDE_PROJECT_DIR}"), Bash(node "${rness}/node_modules/@rness/cli/dist/bin/rness.js" doc new specs)
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status specs --cwd "\${CLAUDE_PROJECT_DIR}"\`

You keep the specifications of this workspace, in \`${rness}/specs/\`. The table
above lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

The first word is the verb, when a reference (\`0028\`, or a path) follows
it; a bare reference is \`open\`; any other words are the subject of a
\`create\`:

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
4. Allocate the file: run \`node "${rness}/node_modules/@rness/cli/dist/bin/rness.js" doc new specs\` from the project directory, where
   Claude Code was opened (pre-approved above as typed; \`CLAUDE_PROJECT_DIR\`
   is not set in your shell, so the path is relative). It writes
   \`specs/NNNN-untitled.md\` with the next number, the front matter
   and the opening sections, and prints the path. Rename it to
   \`NNNN-<slug>.md\`, the slug a few lowercase words of the title joined by
   hyphens, and write the title as \`# NNNN — <title>\`. Never choose the
   number yourself.
5. Fill it: \`repo\`, and \`adr:\` linking the decisions it rests on — or the
   rationale in the body when none does; the sections it opened with
   (Summary, Scope, Out of scope, Alternatives considered, To verify,
   Tests), or the most recent specification's when the team's differ. What
   was checked in this session (a document read, a command run) is written
   as verified, with the date; everything else as a proposal or an open
   question. Add \`{ id: \${CLAUDE_SESSION_ID}, agent: <model> }\` at the end of
  \`sessions:\` in the front matter, unless that id is already there;
  \`<model>\` is the model you run as, as Claude Code names it, after
  \`Claude\`: for example \`Claude Opus 5.5\`.
6. The rness hook checks every edit under \`${rness}/\`: fix what it reports.

Opening: read the specification and amend what the developer asks — a
section, a scope, an open question answered — \`updated\` today, the session
line added. A status moves only as the developer says, or by
\`/rness:plan from\`.

After writing: give the path and the summary. A new specification starts
\`Draft\`: \`Proposed\` for review; \`/rness:plan from NNNN\` approves it and
plans it.

Move a status yourself when the work calls for it, and whenever the
developer says so: a plan \`In progress\` as you start its tasks,
\`Completed\` once its proofs pass under \`check\`; a specification
\`Implemented\` with its last plan; a document \`Superseded\` by the one that
replaces it. Accepting an ADR is the developer's; a specification is
\`Approved\` by \`/rness:plan from NNNN\`, which is their word for it.

Commit each file you changed, in its own repository, and only the files
you alone changed: add them by name, never \`git add -A\` nor \`commit -a\`.
A file that had uncommitted changes before your first edit (\`git status\`
tells you), or that someone else changed since, stays uncommitted: say
which. Never push.
`,
  plan: (rness: string) => `---
name: plan
description: The plans of the rness workspace in .rness/plans/ — a plan from a specification (from, which approves it), from the conversation (create), reopened (open), or closed on evidence (check). Use when the developer asks for a plan, to approve a specification, or to check the work of a plan.
argument-hint: '[create <subject> | from <spec> | open NNNN | check NNNN]'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "\${CLAUDE_PROJECT_DIR}"), Bash(node "${rness}/node_modules/@rness/cli/dist/bin/rness.js" doc new plans)
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "\${CLAUDE_PROJECT_DIR}"\`

You keep the plans of this workspace, in \`${rness}/plans/\`. The table above
lists the existing ones, newest first. Arguments: \`$ARGUMENTS\`.

The first word is the verb, when a reference (\`0037\`, or a path) follows
it — \`check\` alone means the plan \`In progress\`; a bare reference is
\`open\`; any other words are the subject of a \`create\`:

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
2. The developer typed this command: that is their approval, and the
   specification moves from \`Draft\` or \`Proposed\` to \`Approved\`, \`updated\`
   today, in the same commit as the plan — no confirmation question. If
   you are proposing it yourself, propose it in a single line and wait for
   a yes first: the approval is theirs, never yours.
3. Read the code and the repositories the specification touches: every
   task names real files and real commands.
4. Allocate the file: run \`node "${rness}/node_modules/@rness/cli/dist/bin/rness.js" doc new plans\` from the project directory, where
   Claude Code was opened (pre-approved above as typed; \`CLAUDE_PROJECT_DIR\`
   is not set in your shell, so the path is relative). It writes
   \`plans/NNNN-untitled.md\` with the next number, the front matter
   and the opening sections, and prints the path. Rename it to
   \`NNNN-<slug>.md\`, the slug a few lowercase words of the title joined by
   hyphens, and write the title as \`# NNNN — <title>\`. Never choose the
   number yourself.
5. Fill it: \`spec:\` linking the specification; tasks in order, as
   checkboxes, each with the files, what changes, and the command that
   proves it (a test, a build, a run) — the last tasks the documentation
   the work makes inaccurate, then the release when the repository has
   one; where the plan decides something the specification leaves open, the
   section it opened with says so. Add \`{ id: \${CLAUDE_SESSION_ID}, agent: <model> }\` at the end of
  \`sessions:\` in the front matter, unless that id is already there;
  \`<model>\` is the model you run as, as Claude Code names it, after
  \`Claude\`: for example \`Claude Opus 5.5\`.
6. The rness hook checks every edit under \`${rness}/\`: fix what it reports.

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
2. The developer asked for the check, or the plan's last task has just
   passed in this session: run it. Otherwise propose it in a single line
   and wait for a yes.
3. Read the plan, its specification and \`${rness}/CONVENTIONS.md\`.
4. Evidence first. For each task, what proves it: its command run now, or
   its result read in this session. Never mark a task done on belief. A
   check has no cache: run twice, it proves twice.
5. Every task proven:
   - the plan: \`status: Completed\`, \`updated\` today, the checkboxes of the
     proven tasks ticked, and a section \`Verification (YYYY-MM-DD)\` — what
     ran, what it showed, what could not run and why;
   - the specification: \`Implemented\` once every plan of it is
     \`Completed\`; \`updated\` today;
   - the plan and the specification: add \`{ id: \${CLAUDE_SESSION_ID}, agent: <model> }\` at the end of
  \`sessions:\` in the front matter, unless that id is already there;
  \`<model>\` is the model you run as, as Claude Code names it, after
  \`Claude\`: for example \`Claude Opus 5.5\`;
   - the smallest set of documents the work makes inaccurate: \`${rness}/docs/\`,
     the READMEs of the repositories it changed.
6. A task not proven: nothing moves, the plan stays \`In progress\`. Say,
   task by task, what passed and what remains. A blocker the developer
   names is a move of its own: \`Blocked\`, the blocker written in the plan.
7. The rness hook checks every edit under \`${rness}/\`: fix what it reports.

After writing: give the path and the list of tasks, or the statuses moved.
A new plan starts \`Draft\`, and becomes \`Ready\` once the developer agrees
with it or asks you to carry it out.

Move a status yourself when the work calls for it, and whenever the
developer says so: a plan \`In progress\` as you start its tasks,
\`Completed\` once its proofs pass under \`check\`; a specification
\`Implemented\` with its last plan; a document \`Superseded\` by the one that
replaces it. Accepting an ADR is the developer's; a specification is
\`Approved\` by \`/rness:plan from NNNN\`, which is their word for it.

Commit each file you changed, in its own repository, and only the files
you alone changed: add them by name, never \`git add -A\` nor \`commit -a\`.
A file that had uncommitted changes before your first edit (\`git status\`
tells you), or that someone else changed since, stays uncommitted: say
which. Never push.
`,
}
const plugin = (rness: string, at: 'clones' | 'root') => [
  {
    file: '.claude/skills/rness/.claude-plugin/plugin.json',
    at,
    content: PLUGIN_JSON,
  },
  {
    file: '.claude/skills/rness/skills/status/SKILL.md',
    at,
    content: skill(rness),
  },
  ...(['adr', 'spec', 'plan'] as const).map((name) => ({
    file: `.claude/skills/rness/skills/${name}/SKILL.md`,
    at,
    content: LIFECYCLE[name](rness),
  })),
  ...['hooks/hooks.json', 'hooks/register.tsx', 'types/index.d.ts'].map(
    (rel) => ({
      file: `.claude/skills/rness/${rel}`,
      at,
      content: MOD(rel, rness),
    })
  ),
  // Written up to 0.17, replaced by `/rness:plan check` (spec 0028 §8):
  // removed where it is still found.
  { file: '.claude/skills/rness/skills/done/SKILL.md', at, retired: true },
]

test('Claude Code is the one target: read access to .rness, the rness MCP server, the hooks, the plugin', () => {
  assert.deepEqual(SUPPORTED_AGENTS, ['claude'])
  const claude = TARGETS['claude']
  assert.equal(claude?.name, 'claude')
  assert.equal(claude.label, 'Claude Code')
  assert.deepEqual(claude.files({ packageManager: 'npm' }), [
    {
      file: '.claude/settings.json',
      at: 'clones',
      guarantees: [
        {
          path: ['permissions', 'additionalDirectories'],
          contains: '../../.rness',
        },
        ...hooks(CLONE_START, CLONE_GUARD, CLONE_EDIT, CLONE_END),
      ],
    },
    {
      file: '.mcp.json',
      at: 'clones',
      guarantees: [
        {
          path: ['mcpServers', 'rness'],
          value: {
            command: 'node',
            args: [
              '../../.rness/node_modules/@rness/cli/dist/bin/rness.js',
              'mcp',
            ],
          },
        },
      ],
    },
    ...plugin('../../.rness', 'clones'),
    {
      file: '.claude/settings.json',
      at: 'root',
      guarantees: hooks(ROOT_START, ROOT_GUARD, ROOT_EDIT, ROOT_END),
    },
    ...plugin('.rness', 'root'),
  ])
})

test('the closing line of /rness:status follows the manager: pnpm, npm, yarn, bun', () => {
  const STATUS = '.claude/skills/rness/skills/status/SKILL.md'
  for (const [packageManager, run] of [
    ['pnpm', 'pnpm'],
    ['npm', 'npx'],
    ['yarn', 'yarn'],
    ['bun', 'bunx'],
  ] as const) {
    const files = TARGETS['claude']?.files({ packageManager }) ?? []
    for (const [rness, at] of [
      ['../../.rness', 'clones'],
      ['.rness', 'root'],
    ] as const) {
      const status = files.find((f) => f.at === at && f.file === STATUS)
      assert.ok(status !== undefined && 'content' in status)
      assert.equal(status.content, skill(rness, run))
    }
  }
})

test('each ! line is the first command its allowed-tools names, the second allocates a document; the lifecycle skills may be invoked by the model', () => {
  const tabs: Record<string, string> = {
    adr: 'adr',
    spec: 'specs',
    plan: 'plans',
  }
  const files = TARGETS['claude']?.files({ packageManager: 'npm' }) ?? []
  const skills = files.filter((f) => f.file.endsWith('/SKILL.md'))
  // status, adr, spec, plan at the root and in the clones; the retired done twice.
  assert.equal(skills.length, 10)
  assert.equal(skills.filter((f) => 'retired' in f).length, 2)
  for (const f of skills) {
    if ('retired' in f) {
      assert.ok(f.file.endsWith('/done/SKILL.md'), f.file)
      continue
    }
    assert.ok('content' in f)
    const line = /^allowed-tools: (.*)$/m.exec(f.content)?.[1] ?? ''
    // `Bash(a), Bash(b)`: each command holds parentheses of its own.
    const allowed = line
      .replace(/^Bash\(/, '')
      .replace(/\)$/, '')
      .split(/\), Bash\(/)
    const bang = /^!`(.*)`$/m.exec(f.content)?.[1]
    assert.ok(allowed.length > 0, f.file)
    assert.equal(bang, allowed[0], f.file)
    const name = /^name: (\w+)$/m.exec(f.content)?.[1] ?? ''
    if (name === 'status') {
      assert.equal(allowed.length, 1, f.file)
      continue
    }
    assert.doesNotMatch(f.content, /disable-model-invocation/, f.file)
    // Spec 0020 §3.1, 0022 §3: the session that writes a document, and its
    // agent, are recorded in it.
    assert.ok(
      f.content.includes('`{ id: ${CLAUDE_SESSION_ID}, agent: <model> }`'),
      f.file
    )
    assert.ok(f.content.includes('`sessions:`'), f.file)
    assert.ok(
      allowed[0]?.endsWith(
        ` status ${tabs[name]} --cwd "\${CLAUDE_PROJECT_DIR}"`
      ),
      f.file
    )
    // Spec 0028 §9: the number comes from the CLI, by a fixed line the body names.
    assert.equal(allowed.length, 2, f.file)
    // Typed by the model in a shell where CLAUDE_PROJECT_DIR is not set
    // (verified 2026-10-02): relative to the project directory.
    assert.equal(
      allowed[1],
      `node "${f.at === 'root' ? '.rness' : '../../.rness'}/node_modules/@rness/cli/dist/bin/rness.js" doc new ${tabs[name]}`,
      f.file
    )
    assert.ok(f.content.includes(`run \`${allowed[1]}\``), f.file)
    assert.doesNotMatch(f.content, /highest .*number/, f.file)
  }
})

test('the front matter of every skill is YAML a strict parser reads: name, description, argument-hint, allowed-tools', () => {
  const files = TARGETS['claude']?.files({ packageManager: 'npm' }) ?? []
  for (const f of files) {
    if (!f.file.endsWith('/SKILL.md') || !('content' in f)) continue
    const block = /^---\n([\s\S]*?)\n---\n/.exec(f.content)?.[1]
    assert.ok(block !== undefined, f.file)
    // A description with ": " in it is a nested mapping to YAML, and Claude
    // Code reads it only through a fallback other readers do not have.
    const fields = parseYaml(block, { strict: true }) as Record<string, unknown>
    for (const key of ['name', 'description', 'allowed-tools'])
      assert.equal(typeof fields[key], 'string', `${f.file}: ${key}`)
    if (fields['name'] !== 'status')
      assert.equal(typeof fields['argument-hint'], 'string', f.file)
  }
})

test('the session-start line is valid sh, and its fallback is one JSON object', async () => {
  const { execFileSync } = await import('node:child_process')
  // No copy installed at a made-up project directory: the fallback speaks.
  const out = execFileSync('sh', ['-c', CLONE_START], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent/org/web' },
    encoding: 'utf8',
  })
  assert.deepEqual(JSON.parse(out), {
    systemMessage:
      'rness: ../../.rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness.',
  })
  // The edit and end hooks say nothing and succeed.
  for (const line of [CLONE_EDIT, CLONE_END])
    assert.equal(
      execFileSync('sh', ['-c', line], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent/org/web' },
        encoding: 'utf8',
      }),
      ''
    )
})

test('unsupportedAgents keeps the names this version has no target for', () => {
  assert.deepEqual(unsupportedAgents(['claude', 'codex', 'cursor']), [
    'codex',
    'cursor',
  ])
  assert.deepEqual(unsupportedAgents([]), [])
  // A name on the prototype chain is not a target.
  assert.deepEqual(unsupportedAgents(['constructor']), ['constructor'])
  assert.equal(
    unsupportedMessage('codex'),
    `rness.json: agent "codex" is not supported by @rness/cli ${VERSION} (supported: claude)`
  )
})
