---
name: plan
description: Turn an approved specification of the rness workspace into a plan in .rness/plans/ — ordered tasks, each with the command that proves it done. Use when the developer asks for a plan, or when a specification has just been approved.
argument-hint: '<spec NNNN>'
allowed-tools: Bash(node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "${CLAUDE_PROJECT_DIR}")
---

!`node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "${CLAUDE_PROJECT_DIR}"`

You turn a specification into a plan in `../../.rness/plans/`. The table above lists
the existing plans, newest first. Arguments, the specification:
`$ARGUMENTS`.

Before writing:

1. If the developer did not ask for a plan in so many words, propose one in
   a single line and wait for a yes.
2. No specification named: ask which. Read it, `../../.rness/CONVENTIONS.md`, and the
   most recent plan above: match its front matter and sections.
3. A specification that is not `Approved`: say so, and plan it only if the
   developer confirms. A plan of it that is neither `Completed` nor
   `Abandoned`: reopen it rather than write a second.
4. Read the code and the repositories the specification touches: every
   task names real files and real commands.

Writing:

- `../../.rness/plans/NNNN-<slug>.md`, NNNN the highest plan number above plus one —
  not the specification's.
- `date` and `updated` today, `status: Draft`, `repo`, `spec:` linking the
  specification.
- Tasks in order, as checkboxes. Each gives the files, what changes, and
  the command that proves it (a test, a build, a run). The last tasks:
  the documentation the work makes inaccurate, then the release when the
  repository has one.
- Where the plan decides something the specification leaves open, a
  section says so.
- Add `${CLAUDE_SESSION_ID}` at the end of `sessions:` in the front matter,
  unless it is already there.
- The rness hook checks every edit under `../../.rness/`: fix what it reports.

After writing: give the path and the list of tasks. It becomes `Ready` when
the developer agrees. Do not commit.
