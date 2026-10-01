---
name: adr
description: Record a decision of the rness workspace as an ADR in .rness/adr/ — a choice expensive to reverse or that creates a lasting constraint. Use when the developer asks for an ADR, or when the conversation reaches such a decision.
argument-hint: '[subject | NNNN]'
allowed-tools: Bash(node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status adr --cwd "${CLAUDE_PROJECT_DIR}")
---

!`node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status adr --cwd "${CLAUDE_PROJECT_DIR}"`

You record a decision of this workspace as an ADR in `../../.rness/adr/`. The table
above lists the existing ADRs, newest first. Arguments: `$ARGUMENTS`.

Before writing:

1. If the developer did not ask for an ADR in so many words, propose one in
   a single line — its title, and why the choice is hard to reverse — and
   wait for a yes.
2. Read `../../.rness/CONVENTIONS.md` and `../../.rness/adr/0000-template.md`: they hold the
   rules and the sections; this skill is only the procedure.
3. Arguments naming an ADR (`NNNN`): reopen that file. An `Accepted` ADR is
   never edited: offer a new ADR that supersedes it.
4. Otherwise the subject is the arguments, else the decision just
   discussed. Context, alternatives or consequences missing from the
   conversation: ask for them, one question at a time. Never invent them.

Writing:

- `../../.rness/adr/NNNN-<slug>.md`, NNNN the highest number above plus one.
- The template's front matter and sections, filled in, its guidance lines
  removed: `date` today, `status: Proposed`, `repo` the repositories under
  `org/` it affects.
- An ADR it replaces is named in Context. That one becomes `Superseded`,
  with `superseded_by:`, only once the new ADR is `Accepted`.
- Add `{ id: ${CLAUDE_SESSION_ID}, agent: <model> }` at the end of
  `sessions:` in the front matter, unless that id is already there.
  `<model>` is the model you run as, as Claude Code names it, after
  `Claude`: for example `Claude Opus 5.5`.
- The rness hook checks every edit under `../../.rness/`: fix what it reports.

After writing: give the path and the Decision section. The ADR stays
`Proposed` until it is accepted.

Move a status yourself when the work calls for it, and whenever the
developer says so: a plan `In progress` as you start its tasks,
`Completed` once they pass; a specification `Implemented` with its last
plan; a document `Superseded` by the one that replaces it. Accepting a
decision — an ADR `Accepted`, a specification `Approved` — is the
developer's, unless they asked you to go ahead with the work.

Commit each file you changed, in its own repository, and only the files
you alone changed: add them by name, never `git add -A` nor `commit -a`.
A file that had uncommitted changes before your first edit (`git status`
tells you), or that someone else changed since, stays uncommitted: say
which. Never push.
