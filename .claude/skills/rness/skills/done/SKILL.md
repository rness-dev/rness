---
name: done
description: Close a piece of work of the rness workspace — check each task of its plan on evidence, then move the plan and its specification to their final status and correct the documents the work made inaccurate. Use when the developer says the work is done, or when the last task of a plan passes.
argument-hint: '[plan NNNN]'
allowed-tools: Bash(node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "${CLAUDE_PROJECT_DIR}")
---

!`node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status plans --cwd "${CLAUDE_PROJECT_DIR}"`

You close a piece of work: its plan in `../../.rness/plans/`, its specification, and
what they made inaccurate. The table above lists the plans, newest first.
Arguments: `$ARGUMENTS`.

1. The plan: the one named, else the one `In progress`. Several or none:
   ask.
2. The developer asked to close it, or its last task has just passed in
   this session: close it. Otherwise propose it in a single line and wait
   for a yes.
3. Read the plan, its specification and `../../.rness/CONVENTIONS.md`.
4. Evidence first. For each task, what shows it done: a test, a build, a
   command's output in this session. A task without evidence: run its
   check now, or report it. Never mark a task done on belief.
5. All tasks proven:
   - the plan: `status: Completed`, `updated` today, the checkboxes of the
     proven tasks ticked, and a section `Verification (YYYY-MM-DD)` — what
     ran, what it showed, what could not run and why;
   - the specification: `Implemented` once every plan of it is
     `Completed`; `updated` today;
   - the plan and the specification: add
     `{ id: ${CLAUDE_SESSION_ID}, agent: <model> }` at the end of
     `sessions:` in their front matter, unless that id is already there;
     `<model>` is the model you run as, as Claude Code names it, after
     `Claude`: for example `Claude Opus 5.5`;
   - the smallest set of documents the work makes inaccurate: `../../.rness/docs/`,
     the READMEs of the repositories it changed.
6. A task not proven: the plan stays `In progress` — or `Blocked`, the
   blocker written in it. Say what remains.
7. The rness hook checks every edit under `../../.rness/`: fix what it reports.

After: list the files changed and the statuses moved.

Commit each file you changed, in its own repository, and only the files
you alone changed: add them by name, never `git add -A` nor `commit -a`.
A file that had uncommitted changes before your first edit (`git status`
tells you), or that someone else changed since, stays uncommitted: say
which. Never push.
