import assert from 'node:assert/strict'
import { test } from 'node:test'

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
const ROOT_START =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-start; else echo \'{"systemMessage":"rness: .rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness."}\'; fi'
const ROOT_EDIT =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook post-tool-use; fi'

const CLONE_END =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-end; fi'
const ROOT_END =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-end; fi'

const hooks = (start: string, edit: string, end: string) => [
  {
    path: ['hooks', 'SessionStart'],
    contains: { hooks: [{ type: 'command', command: start, timeout: 10 }] },
    label: 'the rness session-start hook',
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
  "name": "rness",
  "description": "The rness workspace in Claude Code: /rness:status, /rness:adr, /rness:spec, /rness:plan, /rness:done."
}
`
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
// The lifecycle skills, as spec 0019 §3 writes them.
const LIFECYCLE = {
  adr: (rness: string) => `---
name: adr
description: Record a decision of the rness workspace as an ADR in .rness/adr/ — a choice expensive to reverse or that creates a lasting constraint. Use when the developer asks for an ADR, or when the conversation reaches such a decision.
argument-hint: '[subject | NNNN]'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status adr --cwd "\${CLAUDE_PROJECT_DIR}")
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status adr --cwd "\${CLAUDE_PROJECT_DIR}"\`

You record a decision of this workspace as an ADR in \`${rness}/adr/\`. The table
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
  spec: (rness: string) => `---
name: spec
description: Write a specification of the rness workspace in .rness/specs/ — the outcome wanted and its scope, before any plan. Use when the developer asks for a spec, or when agreed work is too large to start without one.
argument-hint: '[subject | NNNN]'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status specs --cwd "\${CLAUDE_PROJECT_DIR}")
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status specs --cwd "\${CLAUDE_PROJECT_DIR}"\`

You write a specification of this workspace in \`${rness}/specs/\`. The table above
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
  plan: (rness: string) => `---
name: plan
description: Turn an approved specification of the rness workspace into a plan in .rness/plans/ — ordered tasks, each with the command that proves it done. Use when the developer asks for a plan, or when a specification has just been approved.
argument-hint: '<spec NNNN>'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "\${CLAUDE_PROJECT_DIR}")
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "\${CLAUDE_PROJECT_DIR}"\`

You turn a specification into a plan in \`${rness}/plans/\`. The table above lists
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
  done: (rness: string) => `---
name: done
description: Close a piece of work of the rness workspace — check each task of its plan on evidence, then move the plan and its specification to their final status and correct the documents the work made inaccurate. Use when the developer says the work is done, or when the last task of a plan passes.
argument-hint: '[plan NNNN]'
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "\${CLAUDE_PROJECT_DIR}")
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "\${CLAUDE_PROJECT_DIR}"\`

You close a piece of work: its plan in \`${rness}/plans/\`, its specification, and
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
  ...(['adr', 'spec', 'plan', 'done'] as const).map((name) => ({
    file: `.claude/skills/rness/skills/${name}/SKILL.md`,
    at,
    content: LIFECYCLE[name](rness),
  })),
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
        ...hooks(CLONE_START, CLONE_EDIT, CLONE_END),
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
      guarantees: hooks(ROOT_START, ROOT_EDIT, ROOT_END),
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

test('each ! line is the command its allowed-tools names; the lifecycle skills may be invoked by the model', () => {
  const tabs: Record<string, string> = {
    adr: 'adr',
    spec: 'specs',
    plan: 'plans',
    done: 'plans',
  }
  const files = TARGETS['claude']?.files({ packageManager: 'npm' }) ?? []
  const skills = files.filter((f) => f.file.endsWith('/SKILL.md'))
  assert.equal(skills.length, 10)
  for (const f of skills) {
    assert.ok('content' in f)
    const allowed = /^allowed-tools: Bash\((.*)\)$/m.exec(f.content)?.[1]
    const bang = /^!`(.*)`$/m.exec(f.content)?.[1]
    assert.ok(allowed !== undefined, f.file)
    assert.equal(bang, allowed, f.file)
    const name = /^name: (\w+)$/m.exec(f.content)?.[1] ?? ''
    if (name === 'status') continue
    assert.doesNotMatch(f.content, /disable-model-invocation/, f.file)
    // Spec 0020 §3.1: the session that writes a document is recorded in it.
    assert.ok(f.content.includes('`${CLAUDE_SESSION_ID}`'), f.file)
    assert.ok(f.content.includes('`sessions:`'), f.file)
    assert.ok(
      allowed.endsWith(` status ${tabs[name]} --cwd "\${CLAUDE_PROJECT_DIR}"`),
      f.file
    )
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
