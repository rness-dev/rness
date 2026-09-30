---
name: spec
description: Write a specification of the rness workspace in .rness/specs/ — the outcome wanted and its scope, before any plan. Use when the developer asks for a spec, or when agreed work is too large to start without one.
argument-hint: '[subject | NNNN]'
allowed-tools: Bash(node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status specs --cwd "${CLAUDE_PROJECT_DIR}")
---

!`node "${CLAUDE_PROJECT_DIR}/../../.rness/node_modules/@rness/cli/dist/bin/rness.js" status specs --cwd "${CLAUDE_PROJECT_DIR}"`

You write a specification of this workspace in `../../.rness/specs/`. The table above
lists the existing ones, newest first. Arguments: `$ARGUMENTS`.

Before writing:

1. If the developer did not ask for a specification in so many words,
   propose one in a single line and wait for a yes.
2. Read `../../.rness/CONVENTIONS.md`, then the most recent specification above: match
   its front matter, sections and tone.
3. Arguments naming a specification (`NNNN`): reopen it. One that is
   `Implemented`, `Superseded` or `Rejected` is not edited: offer a new one.
4. Otherwise the subject is the arguments, else the work just discussed.
   The problem, what is in and out of scope, the ADRs it rests on: ask what
   the conversation does not say, one question at a time.

Writing:

- `../../.rness/specs/NNNN-<slug>.md`, NNNN the highest number above plus one.
- `date` and `updated` today, `status: Draft`, `repo`, and `adr:` linking
  the decisions it rests on — or the rationale in the body when none does.
- No specification yet to follow: Summary, Scope, Out of scope,
  Alternatives considered, To verify, Tests.
- What was checked in this session (a document read, a command run) is
  written as verified, with the date; everything else as a proposal or an
  open question.
- Add `{ id: ${CLAUDE_SESSION_ID}, agent: <model> }` at the end of
  `sessions:` in the front matter, unless that id is already there.
  `<model>` is the model you run as, as Claude Code names it, after
  `Claude`: for example `Claude Opus 5.5`.
- The rness hook checks every edit under `../../.rness/`: fix what it reports.

After writing: give the path and the summary. It stays `Draft` until the
developer moves it (`Proposed` for review, `Approved` to plan it). No plan
here: `/rness:plan NNNN` once approved. Do not commit.
