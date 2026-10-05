# @rness/cli

The `rness` command: configuration-plane CLI for rness workspaces. It
resolves, validates and syncs an organisation's context for AI coding agents.
Not an agent — no LLM loop.

## Install

    npm create rness           # asks how to start: a GitHub organization, or a blank workspace
    npm create rness acme      # the organization github.com/acme, no first prompt
    pnpm create rness demo --blank   # ./demo with no GitHub step; npm: npm create rness demo -- --blank
    pnpm create rness          # the same with pnpm, yarn or bun: `.rness/` is
    yarn create rness          # installed with the manager that ran the command
    bun create rness
    npm i -g @rness/cli        # the command is `rness`
    npx @rness/cli --help

Inside a workspace, every `rness` delegates to the copy pinned in
`.rness/package.json`.

## Commands

    rness create [<org>] [--provider github] [--repos a,b] [--agent claude] [--pm npm|pnpm|yarn|bun] [--ssh|--https] [--skip-install] -y
    rness create <name> --blank [--agent claude] [--pm npm|pnpm|yarn|bun] [--skip-install] -y
    rness add <repo> [--scopes apps/web,packages/ui] [--ssh|--https] -y
    rness sync [--all] [--scope <name>] [--check] [--pull] [--agent <name>] -y
    rness upgrade [<version>] -y
    rness login [--setup-git|--no-setup-git]
    rness logout
    rness context [--scope <name>] [--json]
    rness status [<tab>] [--json]
    rness pulse create [<collection>] [-y]
    rness pulse sync
    rness validate
    rness mcp

`create` never runs inside a workspace. `add`, `sync` and `create` ask for
confirmation in a terminal; pass `-y`/`--yes` in scripts. `sync --check`
writes nothing and exits 1 when a block is out of date — use it in CI.

`create --blank` needs no GitHub organization, account or login: it writes
`<name>/.rness/` (a `rness.json` without `"org"`, committed), an empty
`<name>/org/` and the root `AGENTS.md` and `CLAUDE.md`. Only the install of
`.rness/` goes to the network. Bring repositories in with
`rness add <owner>/<repo>` or a git URL — a bare name needs an `"org"`.

### Status

    rness status            # every decision, specification and plan, a tab per directory
    rness status specs      # open on one tab (off a terminal: print only that one)
    rness status --json     # one JSON object: what the Claude Code plugin draws

A tab for `ADR`, `Specs` and `Plans`, always, then one for each other
directory of `.rness/` whose Markdown files carry a `status` in their front
matter (a `marketing/` of dated posts, say). A line per document, newest
first: its number (or date), its title, its status — green when done, grey
when dropped, red `?` when missing.

- In a terminal, a full-screen view: `←`/`→` or `Tab` change tab, `↑`/`↓`,
  `PgUp`/`PgDn`, `Home`/`End` scroll, `q` or `Esc` closes and gives the
  screen back. Read-only.
- Off a terminal — a pipe, CI, an agent's tool — Markdown: a table per tab.
- `--json`, terminal or not: the tabs and their rows — each row with the
  colour of its status on Agent Pulse (`color`, the board's name for it:
  `yellow` for `In progress`; `red` without a status) and its item there
  (`link`, the board filtered on its path; null without a pulse) — the
  board (`pulse`), and what a Claude Code session shows of the workspace,
  worded by the CLI — the session-start banner, the status line entry, the
  scope's plans `In progress` and the notes of the safety net (see
  "Hooks"). The plugin's mod reads it (see
  "The mod").
- From Claude Code, `/rness:status [tab]` opens a pane beside the
  conversation when the plugin's mod is loaded (see "The mod"), and shows
  those tables otherwise (see "Agent targets"). Nothing started from inside
  Claude Code gets the terminal, so
  the view cannot open from there (verified with Claude Code 2.1.284 on
  2026-09-29). Two ways to reach it, and the skill ends with both: in the
  same terminal, `Ctrl+Z` suspends Claude Code, run `npx @rness/cli status`
  (or `rness status` with a global install), `q`, then `fg` resumes it
  (Unix only); or in another terminal, from the workspace's `.rness/`, with
  the manager it installs with — `pnpm rness status`, `npx rness status`,
  `yarn rness status` or `bunx rness status` — which runs the pinned copy
  without the network (verified with each manager on 2026-09-30).

### Agent targets

The `AGENTS.md` block is what every agent reads. On top of it, rness writes
the files a given agent needs, for the agents the team declares in
`rness.json`:

    rness sync --agent claude     # declare claude, then write its files
    rness sync                    # in a terminal, with nothing declared, asks once

```json
{ "contract": 1, "org": "acme", "agents": ["claude"], "repos": { … }, "scopes": { … } }
```

- `agents` is the team's: the files it produces are committed in each
  repository. `[]` means none; without the key, `sync` asks in a terminal and
  never in scripts (`-y`, `--check`). A new workspace asks with `create`'s
  other questions, or takes `--agent`.
- **Claude Code** (`claude`): each clone gets `.claude/settings.json` with
  `../../.rness` in `permissions.additionalDirectories`, so a session in the
  repository reads the context repository without a prompt. Claude Code
  applies it once the repository has been trusted interactively. Verified
  with Claude Code 2.1.284 on 2026-09-29. Each clone also gets `.mcp.json`,
  which registers the MCP server; see "MCP server". The same settings file
  carries four hooks, and so does `.claude/settings.json` at the workspace
  root, which `sync` writes on every machine; see "Hooks". Both places also
  get a Claude Code plugin, `.claude/skills/rness/`, with four commands:
  `/rness:status [tab]`, the tables of `rness status`, and the lifecycle
  skills below; and a mod, its hooks module (see "The mod"). rness owns
  those files whole — an edit by hand is reported
  by `sync --check` and written back by `sync`. The plugin's manifest,
  `.claude-plugin/plugin.json`, also carries the agent-plugins.org
  `$schema`, the author, homepage, repository, licence and keywords, so a
  scanner that looks for an Agent Plugins manifest finds one; Claude Code
  reads the same file. The repository root also carries a `plugin.json` in
  that form, describing the repository, where a scanner looks first. Nothing in them depends on
  the version; the last line of the status skill names the workspace's
  package manager, so changing `packageManager` in `.rness/package.json`
  leaves it stale until the next `sync`. Claude Code loads the plugin once
  the folder is trusted, in a session started there.
- **The lifecycle skills**, one per collection, on one grammar: the first
  word is the verb, a bare number reopens, anything else is the subject of
  a `create`. `/rness:adr [create <subject> | open NNNN]` records a decision
  as an ADR or reopens one; `/rness:spec [create <subject> | open NNNN]`
  writes a specification or reopens one; `/rness:plan` takes four verbs:
  `from <spec NNNN>` writes a plan from a specification and approves it
  (typing the command is the approval), `create [subject]` writes a plan
  from the conversation for work too small for a specification, `open NNNN`
  reopens a plan, and `check NNNN` runs the proofs of a plan — each task's
  command, run now — and closes it when they all pass: the plan `Completed`,
  its specification `Implemented`, the documents the work made inaccurate
  corrected; one task without evidence and nothing moves. Each is a
  procedure loaded into the conversation, not a file generator: after a
  decision has been discussed, `/rness:adr` writes it from the
  conversation; otherwise it asks, one question at a time. The skill stays
  in the conversation for the next turns, and the file carries the work to
  the next session (`/rness:adr 0010` reopens it). The agent may start one
  itself — an ADR when a choice is expensive to reverse — but writes nothing
  without a yes, except `/rness:plan check` on a plan whose last task has
  just passed. The rules stay in `.rness/CONVENTIONS.md`; the skills only
  add the steps. A new document takes the collection's first status
  (`Proposed` for an ADR, `Draft` otherwise) and the next number, allocated
  by `rness doc new <collection>` — the second pre-approved line of each
  skill, so that every runtime and a bare terminal get the same number;
  `rness validate` refuses two documents with one number, the case a merge
  of two branches can still produce, and a document named without one
  (`NNNN-<slug>.md`, never a date). Each skill records its session: it adds
  `{ id: <session id>, agent: <model> }` to `sessions:` in the front matter
  of what it writes or closes. The agent is the model it runs as, as Claude
  Code names it (`Claude Opus 5.5`): no variable gives it to a skill. An
  edit made without a skill leaves none. The agent moves a status with the
  work (a plan `In progress`, then `Completed`; a specification
  `Implemented`) and whenever the developer says so; accepting an ADR or
  approving a specification stays the developer's unless they asked it to
  go ahead. Each skill ends in a commit of the files the agent alone
  changed, added by name; a file someone else changed too is left
  uncommitted and named. No skill pushes.
- rness owns values, not files: what is missing is added, nothing else is
  touched, and a file it cannot parse is reported, never rewritten.
  `sync --check` and `validate` report a missing value. Removing an agent
  from `agents` leaves its values in place; `sync` says where.
- Other agents (Codex, Cursor, GitHub Copilot) read the `AGENTS.md` block;
  `sync` refuses an agent it has no target for.

### The mod

Since 0.19.0 the plugin carries a hooks module — what Claude Code calls a
mod — in `hooks/hooks.json`, `hooks/register.tsx` and `types/index.d.ts`.
It draws the workspace in the session, from `rness status --json` run by
the pinned copy, and computes nothing itself:

- **A band above the prompt**, whenever a note needs action (a pin the
  installed copy does not match, problems `validate` would report): those
  notes. The banner is not repeated there; the session-start line says it
  once, in the transcript.
- **The status line**: `<scope> · <n> in progress`, with `⚠ <n>` when
  there are notes. Claude Code draws it after the plugin's name:
  `⚠ rness: web · 1 in progress` (2.1.289).
- **`/rness:status [tab]` as a pane** beside the conversation, a tab per
  collection, a row per document, its status in the colour Agent Pulse
  gives it (yellow in progress, green done, red blocked, gray draft or
  abandoned, blue proposed, purple approved — the board's purple is the
  terminal's magenta); no model turn. The pane takes the keyboard as it
  opens, on the newest row, with the keys of the full-screen view:
  **↑/↓ select a row**, `PgUp`/`PgDn` a page away, `Home`/`End`
  the ends, the window following the selection; **Tab and Shift+Tab
  change the tab**, wrapping, and so does a tab's digit (written before
  its name); **Enter, or a click, on a row shows the document**; Esc and
  `q` close the pane, and so does Esc at an empty prompt once the prompt
  has the keys back. The selected row is drawn between `‹` and `›`, which
  a click presses too. A pane has no ←/→ in Claude Code 2.1.289. The
  document is read from `.rness/` without its front matter, as the
  board's card shows it; `q` brings the list back, Esc still closes. An
  edit of the document shows at the next refresh. **Agent
  Pulse is a link** when the workspace declares a pulse: the board from the
  list, the document's item (the board filtered on its path) from the
  document. The terminal opens it as it opens any hyperlink (cmd+click on
  macOS, as a rule), a desktop surface on a click. In `claude -p`, or where
  no pane can be placed, the skill's tables answer instead.

It reads the snapshot again at session start, after an `Edit` or `Write`
of a file under `.rness/`, and at the end of each turn, off the turn's
path. The module runs the pinned copy at the one path `sync` writes into it
for its place (`.rness` at the root, `../../.rness` in a clone), as the
settings hooks do: never a copy a clone's own tree could hold. It loads
where the plugin loads — a trusted folder, `claude -p` included — on a
Claude Code that has mods: run by 2.1.280 and later, ignored without an
error by 2.1.240 and 2.1.199, where the skills work as before (verified on
2026-10-04). An older Claude Code is told so once per version and machine,
in the session-start line: `rness: Claude Code 2.1.240 shows no rness band,
status line or pane; 2.1.280 or later does — claude update`. The version
comes from `AI_AGENT`, which Claude Code sets (2.1.240 does); one that does
not set it, or not in that form, is told nothing. The versions told are kept
in `claude-code.json` beside the login (`~/.config/rness/` by default). Not in
`claude -p` or another SDK session, where nobody would read it; not after a
compaction. Versions between 2.1.240 and 2.1.280 were not tried: one of
them that loads mods is told to update for nothing. Mods are early access
in Claude Code: a release that changes their API may stop the band or the
pane until the next rness release; the skills and the settings hooks do not
depend on it.

To work on it, from `org/rness`: `pnpm check:mod` runs
`claude plugin validate` and `claude plugin test` on `packages/cli/mod`
(Claude Code needed, so not in CI); `tsc -p packages/cli/mod` type-checks it
once a `claude --plugin-dir packages/cli/mod` session has laid Claude
Code's types there.

### Hooks

With `claude` in `agents`, each clone's `.claude/settings.json` and the
workspace root's carry four Claude Code hooks, all run by the pinned copy:

- **At session start** (`SessionStart`, every source): a line for the
  developer — `rness 0.10.0 · acme · scope web — 3 standards, 2 decisions`
  — and, for the model, the scope's documents as `rness_context` lists
  them. When the context may be wrong, both say why: no `.rness` next to the
  repository or nothing installed there, a `rness.json` rness refuses, a pin
  the installed copy does not match, the problems `rness validate` reports.
  A Claude Code too old for the plugin's mod gets one more line, once (see
  "The mod"). After a compaction, the context only.
- **Before an edit** (`PreToolUse` on `Edit|Write`): refused, with the
  reason for the model, when it would change what `sync` generates — a
  line of the block of an `AGENTS.md` or `CLAUDE.md` (the reason names the
  standard that line comes from, to edit instead), or a file of
  `.claude/skills/rness/` — or add a problem to a document of `.rness/` or
  to `rness.json`. Only the problems the edit adds: a document already
  broken stays editable. The `old_string` is found as Claude Code's `Edit`
  finds it, straight quotes matching curly ones. Writes through Bash are
  not seen: the guard is best effort. About 0.07 s per edit, 0.11 s for a
  document of `.rness/` (measured 2026-10-04).
- **After an edit** (`PostToolUse` on `Edit|Write`): when the file is under
  `.rness/`, its front-matter problems — or those of `rness.json` — go back
  to the model, which fixes them in the same turn. Any other edit costs one
  path check. Stale blocks are left to `sync`. With a pulse declared, the
  edit is then marked on the board, broken or not; see "Pulse".
- **At session end** (`SessionEnd`): with a pulse declared, clears the marks
  this session set and syncs the board; see "Pulse". Without one, nothing.

Each hook is one fixed `sh` line: it runs
`<.rness>/node_modules/@rness/cli/dist/bin/rness.js hook <event>` when that
file exists, and otherwise says so at session start and nothing after an
edit. The line never changes between versions — what the hook does lives in
the CLI — because rness compares its entry as a whole: an entry edited by
hand counts as missing, and the next `sync` adds a second one. The team's
own hooks stay where they are.

Claude Code runs hooks from a committed settings file without asking each
developer, including in `claude -p`. These four read `.rness/`, write
nothing in the workspace and run no install. Only with a pulse declared do
they reach the network, through a detached `rness` process that uses your
login; when that process fails, it writes why to `pulse.json` in rness's
configuration directory (`~/.config/rness/` by default), which the next
session start reads, says once and deletes. See "Pulse". Review a change to
them like code. Verified with Claude Code 2.1.284 on 2026-09-29: in a clone
and at the root, the model received the context; after an edit that broke a
status, it received the problem. The `sh` line is not verified on Windows.

### Pulse

    rness pulse create            # once per organization: the board, then a first sync
    rness pulse create marketing  # a collection's own project (0.17.0)
    rness pulse sync              # every declared project, as often as wanted

A projection of rness's state on the organization's GitHub Projects: a
project named **Agent Pulse**, where the team sees — and reads — every
document of `.rness/`, and sees when an agent is at work on one. rness
writes the board; if it is not in rness, it does not belong there.

- **Items**: one per document of `rness status`, an issue of
  `<org>/.rness` added to the project. GitHub shows it only to people who
  can read `.rness`. Its title is the document's (`0016 — CLI: rness
status, …`) and its body the document (see **Body**). It carries the
  label `rness`, made if missing; `-label:rness` leaves these issues out of
  `.rness`'s Issues tab. An issue is open while its document exists. When
  the document is gone, the issue is closed as not planned and its item
  archived. Gone means gone for this clone's git: the path is in its
  history and no longer in its working tree. A path it has never seen is
  judged only on an issue this clone's sync opened — a document its agent
  wrote, then renamed or deleted before any commit. The clone records the
  issues it opens in its own git directory (`rness/opened`, per worktree,
  never pushed), and forgets one as soon as its git has seen the path. Any
  other — a teammate's new document, or yours from another clone, not
  pulled yet — is left alone. An issue closed while its document exists —
  by hand, or by a `fixes #12` in a `.rness` commit — is reopened at the
  next sync. The document's status is its field, not the issue's state.
  rness's items are those with a `Path`
  whose content is an issue of `.rness`. A draft with a `Path` is rness's
  from 0.12.0, and is converted into an issue of `.rness`. An issue of
  `.rness` on the board, labelled `rness`, without `Path`, whose body's
  first line is a document's first line, is one a stopped sync left: it
  gets its `Path` and is brought up to date, and no second issue is made.
  Anything else — an item without `Path`, an issue of another repository,
  any other issue of `.rness` without `Path` — is the team's: never
  edited, closed or archived. Two known limits. A clone behind the others
  writes what its working tree holds — an older title, status or body —
  until it pulls; the next up-to-date sync writes them back. A document
  that lives only on a branch of `.rness` has its issue closed by a sync
  from a branch without it, if git has seen the path or this clone opened
  the issue; back on its branch, it gets a new issue (`.rness` is worked
  on `main`, and branches of it are rare). The project is linked to
  `.rness`, so Agent Pulse shows in its Projects tab. Comments are the
  team's: a spec's discussion lives on its issue, and rness never writes
  or deletes one. `pulse create` and `pulse sync` need Issues on
  `.rness`. Without them they stop before
  writing anything: `the pulse needs Issues on <org>/.rness: turn them on
in its Settings`.
- **Body**: the document, the same bytes for the same document. It starts
  with a first line: the document's path and a link to the file. Then comes
  the document without its front matter (the status is a field) and
  without its first heading (the title). Links outside code are rewritten.
  A link to another document becomes the URL of its issue, which opens in
  the board's side panel. A link to any other file of `.rness` points to
  it on GitHub at `main` (an image, raw). An absolute link, a link out of
  `.rness`, or a link to no file stays as written. Outside code spans and
  fenced blocks, `@name` is written `\@name`, and a bare `#12` gets a
  zero-width space after `#`: a body notifies no one and points at no
  wrong issue. A body holds at most 65,536 characters. A longer document
  is cut at the last blank line that fits and ends with
  `The rest: <link>`. A last line, invisible on GitHub,
  `<!-- rness <digest> -->`, is how sync tells a body that changed.
- **Layout**: the fields `Status` (the union of the
  collection fields' options: every contract status plus the ones found in
  `.rness/`, in lifecycle order, at most 50), `Collection` (one option per tab of
  `rness status`; not `Type`, which is GitHub's own issue-type field and
  filter), `Agent` (`working`), `Working session` (`claude · 1a2b3c4d`,
  plus the agent type for a subagent: the session working on the document
  now, cleared when it ends), `Path`, and `Session history` — the
  document's `sessions:` (see "Agent targets"), each `Claude Opus 5.5 ·
<id>` (the id alone for an entry without its agent), joined by `, `,
  written by sync and never cleared: which sessions wrote a specification
  or implemented a plan, after they ended (`claude --resume <id>` reopens
  one on the machine it ran on). A board made before 0.15.0 gains
  `Session history` at its next sync; one from 0.15 has its `Session` and
  `Sessions` renamed in place, values and views kept (`renamed field
Session → Working session`). A board per directory, named as
  `rness status` names its tab, filtered on its `Collection`, its columns
  that collection's own steps: each collection has its own status field
  (`ADR status`, `Specs status`, …; a directory without statuses is columned
  by `Status`, which holds them all for the `All` table). `pulse sync`
  remakes a board built by an earlier version (its URL changes once); a `Working` table, filtered on `Agent: working`. A first view named `View 1` (GitHub's default) becomes `All` when no `All` exists, on create and on sync, showing Title, Collection, Status and Working session. Options are coloured (statuses by lifecycle: blue proposed, purple approved, yellow in progress, red blocked or rejected, yellow superseded, green done, gray abandoned; collections and `working` too); a sync recolours rness's options and leaves other options' colours alone. rness does
  not set the project's visibility: the project gets GitHub's default for a
  new organization project, which is private (`public: false`). Verified
  with Claude Code 2.1.284 on 2026-09-29.
- **Login**: the pulse needs the `project` scope. `rness login` asks for it
  when the workspace declares a pulse, or when `pulse create` needs it (in a
  terminal it offers to log in; with `-y` or off a terminal it stops with
  `the pulse needs a GitHub login: run rness login` or
  `the pulse needs the project scope: run rness login`). A developer who
  never uses the pulse grants nothing more than `repo read:org`. When GitHub
  cannot be asked, the pulse says so (`cannot reach GitHub: …`, or GitHub's
  own answer) instead of asking for a login. A classic `GITHUB_TOKEN` works
  if it carries the scope; a fine-grained or GitHub App token reports no
  scope, so the pulse refuses it whatever its permissions. An organization
  that restricts OAuth apps must approve "Rness", as for its private
  repositories.
- **`pulse create`** needs an `org` in `rness.json` (a blank workspace is
  refused) and no pulse yet. It creates the project and at once writes
  `"projects": { "pulse": <number> }` (and the `provider`) into `rness.json`,
  then adds the fields, options and views, and runs a first sync; its
  `created` lines say what it added. If a step after the project fails, it
  exits 1 with the pulse declared, and `rness pulse sync` completes the
  layout. Commit `rness.json` in `.rness`. The number is that of the
  project in the organization. A CLI older than 0.12.0 refuses the key, so
  the pin moves first (`rness upgrade`). A workspace without a `provider`
  whose repositories look like GitLab is refused before anything is
  created: write `"provider": "github"` if the organization is on GitHub.
- **`pulse sync`** works in two passes. First every document gets its
  issue — created, converted from a 0.12.0 draft, or reopened — with its
  title, label and fields. Then the bodies whose digest differs are
  written, since a body links to other documents' issues by number. It
  also adds the option or the board that a new status or directory needs.
  It says what it did to the issues, then to the items: `created 1 issue`,
  `reopened 1 issue`, `synced 52 items: 1 created, 2 updated, 49
unchanged`.
- **One way**: rness reads the board and the issues only to find its items
  and to tell a changed body. Anything changed by hand — a card moved, a
  field, a title, a body, an issue closed — is written back at the next
  sync, and never reaches `.rness/`. The board is not made read-only:
  whoever runs an agent writes it with their own login, so they need Write
  on the project. Read-only access for anyone else is set by hand, in the
  project's "Manage access". The project's workflows are left alone.
  GitHub turns on "Auto-add sub-issues to project" for a new project, so a
  sub-issue added under a document's issue joins the board without `Path`,
  as the team's item. A workflow someone turns on (`Item closed`, `Item
added to project`) may change a field of rness's items; the next sync
  writes it back.
- **A collection's own project** (0.17.0): `rness pulse create <collection>`
  gives a directory of `.rness/` whose documents carry a status — a tab of
  `rness status` — a project of its own, named after it, declared as
  `"projects": { "pulse": 4, "marketing": 5 }`. Agent Pulse keeps every
  other collection and the `Working` table; the collection's items leave
  it (`deleteProjectV2Item`, their issues untouched) once its project
  holds them. `pulse sync` syncs the collections' projects, then Agent
  Pulse. The project is written from the collection's files, one way:
  - `<collection>/README.md` is its README; its front matter may give
    `description:` (the short description), `statuses:` (the columns, in
    order, each there even when empty), `fields:` (each a name, a `type` —
    `text`, `date`, `select`, `number` — and `from`, the front-matter key
    of the documents that fills it, or a list of keys, the first present
    one winning; a `select` may give `options:`) and `labels:` (`directory`,
    the subdirectory a document sits in, or a front-matter key). A date
    field adds a `Calendar` roadmap; which date it draws is set once in the
    view's settings: GitHub's API does not set it.
  - `<collection>/updates/<date>.md` are its status updates: `health`
    (`on-track`, `at-risk`, `off-track`, `complete` or `inactive`),
    optionally `start_date` and `target_date`, the text below. Each is posted once, in
    the order of the names, and updated when its file changes; a deleted
    file leaves its update.

  rness adds no field or label of its own to a collection's project, and
  none of this reaches Agent Pulse: a workspace that declares no collection
  keeps its board as 0.16 made it.

- **Hooks**, with `claude` in `agents` and a pulse declared: session start
  marks the `In progress` plans of the session's scope `Agent: working`, with
  the session; an edit of a document of `.rness/` marks it — one the agent has just written, with no item yet, gets its issue first
  through a sync, and so does one whose status the edit changed, so its
  card moves within seconds rather than at the session's end; an edit that
  leaves the status alone, or of any other file of `.rness/`, costs no sync;
  the hooks' syncs run one at a time, an edit's skipped while another runs,
  the session end's waiting its turn; session end clears
  the marks of that session (its subagents' included) and syncs. Each one
  starts a detached `rness` process and answers at once, so a slow network
  never holds Claude Code; the session-end sync outlives Claude Code's exit.
  Verified with Claude Code 2.1.284 on 2026-09-29: the detached process wrote
  its file 3 s after `/exit`. It uses your login: with none, without the
  scope, or when GitHub cannot be reached, nothing is sent, and the next
  session start's banner says why, once:
  `rness: pulse not updated — <reason>`, such as
  `the pulse needs the project scope: run rness login` or
  `cannot reach GitHub: …`. Two sessions marking one plan both write; the
  last wins.
- **One issue per document**: before making an issue, `pulse sync` reads
  the open issues of `.rness` labelled `rness` (one request per 100, and
  only when it has one to make). One whose body starts with the document's
  first line was made by an earlier sync, whose item the board's listing
  did not show yet. It is added to the board instead of made again, and
  the output says `adopted 1 issue already made for its document`. Seen on
  2026-09-30: two syncs 18 s apart made two issues for one document.
- **Rate**: rness sends one request at a time. A new document costs an
  issue, its addition to the board, up to five fields, then its body. An
  unchanged document costs nothing but its share of the listing, which
  reads every item's body. On one of GitHub's rate limits rness waits as
  long as GitHub says (`waiting  60 s — GitHub's rate limit`), 10 minutes
  at most in all. Past that it stops, saying how many changes it did not
  make, and the next sync makes them. Measured on `rness-dev` (54
  documents, 2026-09-30): the migration from 0.12.0 took 169 s with no
  wait; a sync with nothing to change, 4 s; the listing, one page of
  852 KB in about 1 s.
- **Not yet**: GitLab and Atlassian. `create` lists them, disabled; a
  workspace whose `rness.json` names one is refused by `pulse`. `Waiting`
  and `Review` statuses, several agents on one board and hooks for agents
  other than Claude Code are not built.

### Provider

`rness.json` records where the organization lives:
`"provider": "github"`, between `contract` and `org`. Every command talks to
it through one adapter; `git` still does what git does (clone, pull, push,
credentials), and the provider's API the rest (organizations, creating a
repository, the board).

- `rness create` asks `Where does your organization live?` first: GitHub,
  GitLab and Atlassian (Bitbucket + Jira) shown disabled, coming later, and
  `No organization yet: a blank local workspace` (the `--blank` of
  "Blank workspace"). `--provider github` answers it off a terminal;
  `--org`, `--repos` and `--blank` settle it unasked. Joining an
  organization asks first as well, then takes the provider its `rness.json`
  names.
- A workspace without the key is read from its first repository URL: a
  GitLab host reads as `gitlab`, any other host — or no repository — as
  `github`. Nothing to change: `pulse create` writes it, and refuses a
  detected provider this version cannot talk to. The order of keys is
  `contract`, `provider`, `org`, `agents`, `projects`, `repos`, `scopes`.
  The former `"pulse": { "project": <number> }` still reads, as
  `"projects": { "pulse": <number> }`; both at once are refused.
- A provider _written_ in `rness.json` that this version cannot talk to
  (`gitlab`) is refused by `validate`, `create`, `login` and `pulse`:
  `provider "gitlab" is not supported by @rness/cli 0.17.1 (supported:
github)`. `add`, `sync` and the local commands never refuse. `null` is not a
  value: an absent key means none.

### MCP server

    rness mcp      # started by the agent over stdio, not by hand

A local, read-only MCP server over the workspace's `.rness/`, for an agent to
find what applies to the repository it works in and where a subject was
decided:

| Tool                                   | Returns                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rness_context({ scope? })`            | the scope of the working directory (or the one named) and what applies to it: standards, decisions, specifications, plans — id, status, title, path |
| `rness_list({ collection, status? })`  | every document of a collection, across scopes, optionally of one status                                                                             |
| `rness_read({ path })`                 | one file of `.rness/`, 256 KiB at most; nothing outside it                                                                                          |
| `rness_search({ query, collection? })` | the documents that match, most matching first, with the matching lines                                                                              |

- MCP over stdio, one message per line: the `2026-07-28` revision and the
  earlier ones that open with `initialize` (`2025-11-25` back to
  `2024-11-05`). No MCP SDK, no added dependency.
- `.rness/` is read again on each call, so an edit shows at once. Nothing is
  written.
- With `claude` in `agents`, `sync` registers it in each clone:
  `.mcp.json` gets `mcpServers.rness`, which runs the pinned copy
  (`node ../../.rness/node_modules/@rness/cli/dist/bin/rness.js mcp`). A
  team's own `rness` entry is left as it is.
- Each developer approves the server once, in Claude Code's own dialog.
  rness does not pre-approve it: `enabledMcpjsonServers` in a committed
  settings file would let any change to the `rness` entry of `.mcp.json` run
  unasked. Review such a change like code.
- Verified with Claude Code 2.1.284 on 2026-09-29: the server starts from the
  repository and its tools answer.
- Another agent can run the same command from a clone; rness writes no
  configuration for it.

### Log in

    rness login     # shows a code and https://github.com/login/device
    rness logout

`rness login` connects rness to your GitHub account (OAuth device flow: you
approve a code in a browser, on any machine). Logged in, `create` lists the
private repositories you can access, offers your organizations to choose
from, and says as whom it looks at one (`member   acme (as you)`). The
`create` wizard offers the login itself when it would otherwise list
anonymously.

- The login is one file, `~/.config/rness/auth.json` (`$XDG_CONFIG_HOME`,
  `%APPDATA%` on Windows), readable by you only. The access token lives 8
  hours and is renewed on its own. `GITHUB_TOKEN`, then `GH_TOKEN`, win over
  it — CI needs no login.
- rness asks for `repo` and `read:org`: GitHub has no read-only scope for
  private repositories. It only lists and clones. Where the workspace
  declares a pulse it asks for `project` too; see "Pulse".
- A new workspace has to reach GitHub before teammates can join it. Logged
  in, the `create` wizard offers to do it: it creates the private repository
  `<org>/.rness` and pushes the context with `git`. Declined, refused by
  GitHub, anonymous or with `--yes`, it prints the two manual steps instead
  — create the empty repository on github.com, then `git remote add origin …
&& git push`. No other tool is ever needed.
- Logged in, the wizard lists the organizations you belong to that have
  approved "Rness" — GitHub shows an OAuth app no other — your account
  last, then `an organization not listed here…` for a typed name: one that
  has not approved rness yet, an outside collaborator's, a public one.
  Right after the
  organization, before the SSH test, the probe of `<org>/.rness` and the
  listing, `create` checks your access: an organization that restricts
  OAuth apps and has not approved "Rness" hides its private repositories,
  so the wizard asks `Open github.com to approve rness for <org> now?`,
  opens the approval page in your browser (printed only over SSH) and waits
  — polling every 5 seconds, for 10 minutes at most — until an owner's
  click makes you a member in its eyes; then it goes on with the full
  listing. Declined, or timed out, it goes on with what is visible and
  names the page for later; with `--yes` or off a terminal it prints the
  warning and the page, and asks nothing. The order matters: a private
  `.rness` probed through a token the organization has not approved would
  read as absent, and `create` would start a second one.
- Over HTTPS, rness's own clones and pulls carry the login — through the
  environment of that one git command, never in a URL or `.git/config`. For
  your own `git pull` and `git push`, `login` offers to make rness git's
  credential helper for github.com (`--setup-git`, `--no-setup-git`);
  `logout` undoes it. It needs a global install (`npm i -g @rness/cli`): a
  copy run through `npx` lives in a cache. Over SSH none of this is needed.
  The helper names `node` by its absolute path: after a Node upgrade through
  a version manager (mise, nvm), run `rness login --setup-git` again.
- `rness logout` forgets the login; revoke the authorization itself in
  GitHub's settings (the command prints the link).

### SSH or HTTPS

`create` and `add` test your SSH access to github.com once
(`ssh -T git@github.com`) and write `git@github.com:` URLs when GitHub accepts
your key, `https://github.com/` ones otherwise; `--ssh` and `--https` decide
without the test. In a terminal `ssh` may ask for your key's passphrase;
without one (`--yes`, CI) it never prompts, so a key that needs a passphrase
counts as no access unless an agent holds it.

`rness.json` is authoritative: a URL written there is cloned as written, never
converted. In a workspace whose catalogue clones over SSH, `create` (joining)
and `sync` stop before the first clone when the SSH test fails and say how to
set up a key; `add` offers "Clone <name> over HTTPS instead?" (or `--https`),
which writes an HTTPS URL for that repository only.

Without an agent, a protected key is asked for again by every `git clone`.
Load it once per session: `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` on
macOS, `ssh-add ~/.ssh/id_ed25519` elsewhere.

### Colour

In a terminal `create`, `login`, `add`, `sync` and `upgrade` run as one
session: an intro, a line per finished step, spinners, a "Next" box, an
outro — in the same gutter as the questions. A spinner never animates while
git might ask for a passphrase: rness first tests SSH unattended, and clones
animate only when that passed. The help and the banner are coloured. Through a pipe, in CI, or with `NO_COLOR=1`, the output is plain text —
the same bytes as before 0.5.0; `FORCE_COLOR=1` paints it anyway. No
dependency does this: `util.styleText`, and a banner kept as a constant.

### Upgrade

    rness upgrade            # the latest release; `rness upgrade 0.5.0` for another
    npx @rness/cli@latest upgrade     # your global rness is below 0.8.0, or the pin is below 0.5.0
    pnpm rness upgrade       # inside .rness: the pinned copy merges its own scaffold

The version is written in one place, `.rness/package.json`. `upgrade` pins it
there (exact, the rest of the file untouched), installs with the workspace's
package manager, syncs through the new copy, then commits `.rness`
(`chore: rness <version>`); a failed install restores the file. Push
`.rness`. Teammates pull, and the next `rness` command in that
workspace installs the new pin itself — frozen, so the working tree stays
clean — and carries on: nothing to remember, nothing to run.
`RNESS_NO_INSTALL=1` turns that off and restores the warning, for CI, a
container image, or a machine that cannot install. A workspace still on 0.5.0
has no such catch-up: moving it to 0.5.1 is the last manual install.

The catch-up needs one of two things: a launcher — the `rness` you typed,
usually the global install — at 0.5.1 or later, or an installed copy at 0.5.3
or later, which checks for itself whatever launched it. With an older global
and a workspace below 0.5.3, a pin that moved is neither installed nor
announced: `npm i -g @rness/cli@latest` once.

A workspace ships `.github/dependabot.yml`, so each release opens a pull
request on the organization's `.rness`: the pin and the lockfile in the diff,
`validate` running on the new version, review, merge. The pull request
arrives 3 to 10 days after a release: the check is weekly, and Dependabot
holds any new version back for 3 days by default, a guard against a
compromised release. The file's header says how to lift that delay for
`@rness/cli`.

`upgrade` also merges the scaffold of the target version into `.rness`, with
git: the CI workflow, the hooks, the starter documents. After a Dependabot
pull request, run it once more to merge the scaffold of the version the pin
now names; `rness validate` warns while it is behind.

    rness upgrade
    merging  the @rness/cli 0.8.0 scaffold
    added    .github/workflows/validate.yml
    updated  .githooks/pre-commit
    merged   AGENTS.md

- The base is the last scaffold commit of `.rness`: the commit `create` made,
  or the previous `chore: rness scaffold <version>`. A file the team never
  touched takes the new version; an edited one keeps its edits where the
  scaffold did not change; overlapping lines conflict, and `upgrade` stops
  before installing — resolve with git (`git checkout --ours <file>` keeps
  yours, `--theirs` takes the scaffold's), commit, run `upgrade` again.
- `.rness` must be a clean git repository with no merge in progress.
  `upgrade` commits the merge itself, through the repository's hooks. When a
  hook refuses, everything stays staged, what it said is shown, and
  `upgrade` exits 1 with the commit to make.
- A workspace with no scaffold commit (made by hand, or older than
  `create`) is adopted: identical files merge silently, a differing one
  conflicts once.
- Merge an upgrade pull request with a merge commit, not a squash: a squash
  drops the scaffold commit, and the next upgrade falls back to an older base.

`upgrade` is never delegated to the pinned copy, which is what it replaces
— so it runs the copy you typed. From 0.8.0, a global `rness` older than the
pin merges the scaffold of the copy installed in `.rness`. A global below
0.8.0 knows no scaffold: it answers "already at" and merges nothing — use the
`npx` form, or the pinned copy from inside `.rness`. A workspace pinned below 0.5.0, whose copy has no such
command, starts with the `npx` form.

An upgrade commits `.rness` only. Its sync rewrites a block only when the
block's content changed — a block is current when its hash is, whatever
wrote it — and writes the agent files a release adds. The next steps list,
per repository, the files to commit there.

Exit codes: 0 success, 1 failure, 2 usage — or a refusal without a TTY.
`RNESS_DEBUG=1` adds stack traces; `RNESS_NO_DELEGATE=1` skips the delegation.

## 0.20.0 — the status pane opens a document; ↑/↓ select, Tab changes the tab; Agent Pulse's colours and links

- `/rness:status` in Claude Code: each row's status in Agent Pulse's colour;
  ↑/↓ select a row, Tab and Shift+Tab change the tab; Enter, or a click, on
  a row shows the document in the pane and `q` brings the list back; Agent
  Pulse is a link — the board from the list, the document's item from the
  document. `rness status --json` prints each row's `color` and `link`, and
  the board as `pulse`.

## 0.19.0 — the plugin's mod; edits of generated files refused before they land

- The Claude Code plugin gains a mod (see "The mod"): the notes to act on
  above the prompt, a status line entry, and `/rness:status` as a pane
  beside the conversation, with no model turn, driven by the keyboard. `sync` writes three more files into `.claude/skills/rness/`,
  at the root and in each clone; an upgrade lists the clone's for commit.
  Claude Code without mods ignores them; older than 2.1.280, it is told once
  per version, in the session-start line, to run `claude update` (when it
  sets `AI_AGENT`, as 2.1.240 does).
- A fourth hook, `PreToolUse` on `Edit|Write`: an edit of the block of an
  `AGENTS.md` or `CLAUDE.md`, or of the plugin's files, is refused before
  it is written, naming the file to edit instead; so is an edit that would
  add a problem to a document of `.rness/` or to `rness.json`. Until the
  upgrade has run on a machine, a session there runs the old pinned copy,
  which says `unknown hook event "pre-tool-use"` and lets the edit through.
- `rness status --json` prints the tabs and what the mod draws.

## 0.18.1 — a document without a number is caught; small fixes

- `rness validate` and the edit hook name a document of `adr/`, `specs/` or
  `plans/` whose file name has no number, with the next one:
  `plans/2026-10-02-x.md: not numbered; name it 0002-<slug>.md, the next
number of plans`. A plan another agent's skill wrote with a dated name
  is the usual case; rename it, or let the agent do it when the hook
  tells it. A workspace with such a file fails `validate` (and its CI)
  after the upgrade until it is renamed. The scaffold's `CONVENTIONS.md`
  states the rule, and `upgrade` merges it in.
- A dated file name is no longer read as a number: `rness doc new` after
  `2026-10-02-x.md` gave `2027`, and two dated plans of one year were
  reported as one number twice.
- `rness doc new` racing another one at the same number says `<file>
exists; nothing written` (exit 1) instead of a raw `EEXIST`.
- `1 repository`, not `1 repositories`, in `create` and `sync`.
- When the SSH test passes only by asking for the key's passphrase,
  `create`, `add` and `sync` say once how to load it into an agent
  (`ssh-add`), since every clone would ask again.
- Ctrl+C while `create` waits for an organization's approval is a cancel
  in the plain look too: `cancelled`, nothing written, exit 0 (it was 130).

## 0.18.0 — the wizard asks where first and waits for the approval; the skills on one grammar; Node 22.17

- The published CLI runs on **Node 22.17 or later** (ADR 0010); the guard
  compares major and minor. A workspace pinned to 0.17.x keeps refusing
  Node 22 until its pin moves: from inside it, `npx @rness/cli@latest
upgrade` works under Node 22, since `upgrade` is served by the copy
  invoked, never the pinned one.
- `rness create` asks **where the organization lives first** — the blank
  workspace is that question's last answer — then offers the login, which
  now lists **the organizations you belong to that have approved rness**
  (your account last, then `an organization not listed here…` for the
  rest). Right after the organization and
  before anything reads it, an organization that restricts OAuth apps and
  has not approved "Rness" gets its **approval page opened in your
  browser**; the wizard waits for the owner's click (10 minutes at most)
  and then lists the private repositories too. See "GitHub login".
- `/rness:adr`, `/rness:spec` and `/rness:plan` read their first word as
  the verb: `create`, `open` (a bare number), and for a plan `from <spec>`
  — which **approves the specification** it plans — and `check NNNN`, the
  proofs of a plan, in place of `/rness:done`. `/rness:done` is retired:
  `rness sync` removes its `SKILL.md` where an earlier release wrote it
  (`removed` in its output); commit the deletion in each repository, as
  `upgrade`'s next steps list. Note: `/rness:plan 0028` now opens plan
  0028; a plan is made with `from <spec>`. See "Agent targets".
- `rness doc new <collection> [--title <text>]` writes the next numbered
  document of `adr`, `specs` or `plans` and prints its path: the skills
  allocate with it instead of counting. `rness validate` and the edit hook
  refuse two documents with one number in a collection.
- The day of a release, `pnpm create rness` runs the previous version:
  pnpm ≥ 11 holds back a package younger than 24 hours
  (`minimumReleaseAge`). `rness upgrade` installs the latest all the same.

## 0.17.3 — the packages name the product; the plugin manifest for scanners

- `homepage` of `@rness/cli`, `create-rness` and `@rness/create` is
  `https://rness.dev`; `repository` and `bugs` stay on GitHub. That is
  how a scanner tells an official package from a fork;
  `pnpm check:versions` checks it with the versions.
- `.claude/skills/rness/.claude-plugin/plugin.json`, written by the Claude
  target, carries the agent-plugins.org `$schema`, the author, homepage,
  repository, licence and keywords. `rness sync` rewrites it once in each
  repository; commit it there.
- `skills/rness/SKILL.md` at the root of the repository: when to use Rness
  and how to install and run it, for `npx skills add rness-dev/rness`
  and skills.sh.

## 0.17.2 — the lifecycle skills move statuses and commit their files

- `/rness:adr`, `/rness:spec`, `/rness:plan` and `/rness:done` let the
  agent move a status as the work does — a plan `In progress` as its tasks
  start, `Completed` once they pass, a specification `Implemented` with its
  last plan — and whenever the developer says so. Accepting an ADR or
  approving a specification stays the developer's unless they asked the
  agent to go ahead. `/rness:done` closes a plan whose last task has just
  passed without asking first.
- Each of them ends in a commit of the files the agent alone changed, in
  their repository, added by name. A file that had uncommitted changes
  before the agent's first edit, or that someone else changed since, is
  left out and named. Nothing is pushed. Until now they committed nothing,
  which left their files for someone else to find.
- `rness upgrade` rewrites the four skills under `.claude/skills/rness/`;
  commit them in each repository, as its next steps list.

## 0.17.1 — pulse shows it is at work

- `pulse create` and `pulse sync` show a transient line while they write a
  project's items and bodies: each item is a few requests, one at a time,
  and 34 cards took minutes with nothing on screen.
- A collection's label is made only when a document carries it: a
  directory with no card (`assets/`) is no label.
- `pulse create <collection>` says `linked Marketing to <org>/.rness`, not
  `Agent Pulse`.

## 0.17.0 — a collection on its own GitHub Project

- `rness pulse create <collection>` gives a collection of `.rness/` a
  project of its own; `rness pulse sync` syncs every declared project. The
  collection's `README.md` gives the project its README, short
  description, columns, fields and labels, and `updates/` its status
  updates. See "Pulse".
- `rness.json` names the projects in `"projects": { "pulse": 4 }`; the
  former `"pulse": { "project": 4 }` still reads, and is written in the new
  form whenever rness writes the file. A CLI older than 0.17.0 refuses
  `projects`: move the pin first (`rness upgrade`).
- For the package's API: `Manifest.pulse` is now `Manifest.projects`.
- A workspace that declares no collection's project sees no change on
  Agent Pulse. Blocks are unchanged.

## 0.16.0 — Working session and Session history; the agent in the history

- Agent Pulse's session fields are renamed so that the names say what
  they hold: `Session` becomes `Working session` (the session working on
  a document now) and `Sessions` becomes `Session history` (every session
  that changed it). The first `pulse sync` with 0.16.0 renames them in
  place: values, ids and views stay. Until then, marks use whichever name
  the board has. See "Pulse".
- `Session history` names each session's agent: `Claude Opus 5.5 ·
1e9cb41b-…`. The lifecycle skills now record `{ id, agent }` in
  `sessions:`; a bare id, as 0.15 wrote it, still reads, and shows alone.
  `rness upgrade` rewrites the four skills: commit `.claude/skills/rness/`
  in each repository. See "Agent targets".
- Blocks are unchanged.

## 0.15.1 — upgrade names every file to commit

- `rness upgrade`'s next steps name every file the new version's sync
  wrote in a repository. They used to be listed from the running copy,
  which does not know the files a newer release adds: 0.13.0 named two of
  the plugin's six files after syncing with 0.14.0. The running copy now
  asks the copy it installed. This applies to upgrades run by 0.15.1 or
  later; from an older copy, commit `.claude/skills/rness/` whole, as the
  changelog of each release says.
- Agent Pulse no longer gives a document a second issue when two syncs
  follow each other within seconds. The second one's listing of the board
  may not show the item the first one added yet. Before making an issue,
  `pulse sync` now looks for an open issue of `.rness` already made for the
  document, and adds that one (`adopted 1 issue`). See "Pulse".
- Blocks are unchanged.

## 0.15.0 — Agent Pulse follows a status change; the sessions are kept

- An edit that changes a document's status syncs Agent Pulse at once: its
  card moves within seconds, not at the session's end. An edit that leaves
  the status alone still costs nothing. See "Pulse".
- `sessions:` in a document's front matter lists the Claude Code sessions
  that wrote or changed it. The lifecycle skills add theirs; the board
  shows them in a new field, `Sessions`, which a session's end never
  clears. A board gains the field at its first sync with 0.15.0. See
  "Pulse" and "Agent targets".
- `rness upgrade` rewrites the four lifecycle skills; commit
  `.claude/skills/rness/` in each repository.
- Blocks are unchanged.

## 0.14.0 — the lifecycle skills; `/rness:status` names a second terminal

- The `rness` plugin of Claude Code gains `/rness:adr`, `/rness:spec`,
  `/rness:plan` and `/rness:done`: the workspace's lifecycle as procedures
  the developer or the agent starts, which write nothing without a yes. See
  "Agent targets".
- `/rness:status` ends with two ways to the full-screen view: `Ctrl+Z` in
  the same terminal, or another terminal from `.rness/` —
  `pnpm rness status`, or the command of the workspace's package manager.
  See "Status".
- `rness upgrade` syncs, so it writes the four skills and rewrites
  `plugin.json` and the status skill; then commit `.claude/skills/rness/` in
  each repository, as its next steps list. Until then `sync --check` and
  `validate` report them.
- Blocks are unchanged.

## 0.13.0 — Agent Pulse: each document an issue of `.rness`, its content on the card

- Each item of Agent Pulse is an issue of `<org>/.rness`, labelled
  `rness`, whose body is the document. A link to another document opens
  its issue in the board's side panel. GitHub shows the items only to
  people who can read `.rness`. See "Pulse".
- **Needs Issues on `.rness`**: without them `pulse create` and
  `pulse sync` refuse, before writing anything.
- **Upgrading**: the first `pulse sync` with 0.13.0 — run by hand, or at
  the end of a Claude Code session — does the migration. It converts every
  draft that carries a `Path` into an issue of `.rness`: its id and fields
  stay, so the boards do not change. It labels each issue, writes its
  body, and links the project to `.rness`. GitHub notifies the people who
  watch `.rness` of each new issue, once. Nothing is asked. Until every
  developer's `.rness` is on 0.13.0, a session that ends on 0.12.0 syncs
  as 0.12.0 did: it sees the issues as the team's and adds a draft per
  document. The next 0.13.0 sync archives those drafts.
- The board is not made read-only, and its workflows are left alone. A
  change made on the board is written back at the next sync. See "Pulse".
- When it did, `pulse sync` says `created 1 issue`,
  `converted 52 drafts into issues of <org>/.rness` or `reopened 1 issue`.
  It waits on GitHub's rate limits, 10 minutes at most in all.
- An edit of a document that has no item yet — a spec or a plan the agent
  has just written — now gives it its issue, then marks it `working`.
  Before, it was marked only once a sync had added it.
- A clone that has not pulled a teammate's new document — or the same
  developer's, from another clone — leaves its item alone. 0.12.0 archived
  it, and the next up-to-date sync made a second one. A document renamed
  or deleted before any commit has its issue closed by the clone that
  opened it, which records it in its git directory (`rness/opened`).
- The package's `Provider` interface changes:
  - `checkIssues(org)` is new;
  - `apply` returns the item and issue number of a create or a convert:
    `Placed | null`;
  - `BoardItem` gains a required `issue`: the item's issue of `.rness`
    (number, state, label, body), or null;
  - `Step` gains the kinds `convert`, `close` and `body`, and `update`
    gains `reopen`;
  - `items(board, { bodies: false })` lists the items without their
    issues' bodies (`body: null`).

  An implementation outside this package must adapt to each.

- Blocks are unchanged.
- Status colours: `Rejected` is red and `Superseded` yellow, in every
  collection's field and in `Status`; a sync recolours them.

## 0.12.0 — `rness pulse`; the provider

- `rness pulse create` and `rness pulse sync`: the Agent Pulse board on the
  organization's GitHub Projects, a projection of `.rness/`. See "Pulse".
  `rness login` asks for the `project` scope where the workspace declares a
  pulse.
- `rness.json` gains two optional keys of contract 1: `provider` (`github`;
  `gitlab` and `atlassian` are listed as not available) and
  `pulse: { "project": <number> }`. A CLI older than 0.12.0 refuses them:
  move the pin (`rness upgrade`) before either is written. `create` asks
  `Where does your organization live?`, or takes `--provider github`. See
  "Provider".
- With `claude` in `agents`, `sync` adds a third hook, `SessionEnd`
  (`rness hook session-end`), to each clone's `.claude/settings.json` and to
  the workspace root's. `rness upgrade` syncs, so it adds it; then commit
  `.claude/settings.json` in each repository, as its next steps list. Until
  then `sync --check` and `validate` report the hook missing. The two
  existing hook lines do not change.
- With a pulse declared, the hooks mark and clear the plans an agent works
  on, through a detached process. See "Hooks".
- One status field per collection (`ADR status`, `Specs status`, `Plans status`, …); each board's columns are that collection's steps and only them. `rness pulse sync` remakes a board built by an earlier version (its URL changes once) and renames a first view named `View 1` to `All` when no `All` exists.
- Blocks are unchanged.

## 0.11.0 — `rness status`; `/rness:status` in Claude Code

- `rness status [tab]`: every decision, specification and plan — and any
  other directory of `.rness/` whose documents carry a status — a tab per
  directory, a line per document. A full-screen view in a terminal,
  Markdown off one. See "Status".
- With `claude` in `agents`, `sync` writes the `rness` plugin
  (`.claude/skills/rness/`) in each clone and at the workspace root:
  `/rness:status` in Claude Code. `rness upgrade` syncs, so it adds them;
  then commit `.claude/skills/rness/` in each repository, as its next steps
  list. Until then `sync --check` and `validate` report the files missing.
- Blocks are unchanged.

## 0.10.0 — hooks: the context at session start, validation after an edit

- With `claude` in `agents`, `sync` adds two hooks to each clone's
  `.claude/settings.json`, and writes `.claude/settings.json` at the
  workspace root with the same two. See "Hooks". `rness upgrade` syncs, so
  it adds them; then commit `.claude/settings.json` in each repository, as
  its next steps list. Until then `sync --check` and `validate` report the
  hooks missing.
- A settings file keeps the team's own hooks: rness appends its entries
  after them.
- Blocks are unchanged.

## 0.9.2 — the sync summary reads as a sentence

- `rness sync` counts agent files apart from blocks: "4 blocks: 4
  unchanged; 6 agent files: 6 unchanged". 0.9.1 counted them as blocks
  ("10 blocks: 10 unchanged").
- In a terminal the line reads as a sentence, verb first: "Synced 4 blocks:
  …" instead of "10 blocks: 10 unchanged synced".
- Blocks are unchanged: no `rness sync` is needed after upgrading.

## 0.9.1 — upgrade ends in its commit; the MCP server approved per developer

- `rness upgrade` commits `.rness` itself (`chore: rness <version>`), with
  the repository's hooks; a refusal leaves everything staged and exits 1.
  The next steps say what is left: push, and per repository the files the
  sync changed.
- `upgrade` syncs every time, the Dependabot case included (pin and install
  already at the target). In 0.9.0 it skipped the sync there, so the values
  0.9.0 added to the agent files were missing and the scaffold's
  pre-commit hook refused the commit.
- `upgrade` refuses a `.rness` with a merge in progress.
- `validate` counts a merge in progress: the commit recording a scaffold
  merge no longer warns that the scaffold is not merged.
- The Claude target no longer writes `enabledMcpjsonServers`: each developer
  approves the MCP server once. After syncing with 0.9.0, remove `rness`
  from `enabledMcpjsonServers` in each `.claude/settings.json` by hand —
  rness never removes a value.

## 0.9.0 — the context on demand: `rness mcp`

- `rness mcp`: a local, read-only MCP server with four tools —
  `rness_context`, `rness_list`, `rness_read`, `rness_search`. See "MCP
  server".
- The Claude target registers it: each clone gets `.mcp.json`
  (`mcpServers.rness`) and `rness` in `enabledMcpjsonServers` of
  `.claude/settings.json`. After upgrading, run `rness sync` once and commit
  both files in each repository; until then `sync --check` and `validate`
  report them missing.
- Blocks are unchanged.

## 0.8.1 — adoption without placeholders

- Adopting the scaffold no longer adds a `.gitkeep` to a directory that
  already holds files (`specs/`, `plans/` of a workspace older than
  `create`).
- In a terminal, `upgrade` says "Merging the @rness/cli 0.8.0 scaffold"
  instead of "the @rness/cli 0.8.0 scaffold merging".
- A test now pins what 0.8.0 already did: a global `rness` older than the pin
  merges the scaffold of the copy installed in `.rness`.

## 0.8.0 — upgrade merges the scaffold

- `rness upgrade` merges the target version's scaffold into `.rness` with
  git, three-way, from the last scaffold commit: files the team never
  touched are updated, edits are kept, overlaps conflict and stop the
  upgrade before the install. See "Upgrade". After a Dependabot pull request,
  run `rness upgrade` once to merge the scaffold; nothing is installed.
- `rness validate` warns while the merged scaffold is behind the pin.
- The commit `create` makes carries `Rness-Scaffold: <version>`.
- Breaking: `upgrade` refuses a `.rness` that is not a clean git repository.
  The two migrations it carried (an old `validate.yml` line, a missing
  `dependabot.yml`) are what the merge does now.
- Blocks are unchanged: no `rness sync` is needed after upgrading.

## 0.7.0 — agent targets: Claude Code

- `rness.json` may declare the team's agents: `"agents": ["claude"]`. It is
  an optional key of contract 1; no block changes. A CLI older than 0.7.0
  refuses the key: move the pin before declaring an agent.
- `rness sync --agent claude` declares it and writes each clone's
  `.claude/settings.json` (`../../.rness` in
  `permissions.additionalDirectories`). In a terminal with nothing declared,
  `sync` asks once which agents the team uses; `create` asks for a new
  workspace, or takes `--agent`.
- `sync --check` and `validate` cover the agent files, and `sync --pull`
  does not count them as local changes. See "Agent targets".

## 0.6.2 — no dialog for the root CLAUDE.md

- Opening Claude Code in a repository of the workspace no longer asks "Allow
  external CLAUDE.md file imports?". The workspace root `CLAUDE.md` carried
  `@AGENTS.md`; Claude Code loads that file from every repository below it,
  where the import points outside the working directory. `rness sync` now
  writes the global block into the root `CLAUDE.md` itself; a line that is
  exactly `@AGENTS.md` is dropped there, the rest of the file is kept. The
  `CLAUDE.md` of each repository keeps its `@AGENTS.md`.
- The root files are not in any repository: run `rness sync` once after the
  upgrade, on every machine. The blocks in the repositories are unchanged.
- `sync --check` and `validate` cover the root `CLAUDE.md`. At the root, a
  symlink between `CLAUDE.md` and `AGENTS.md` is left as it is and the other
  file is still written.
- The scaffold's `validate.yml` uses `actions/checkout@v7` and
  `actions/setup-node@v7`, as the rness repositories do. A workspace created
  before keeps its own file.

## 0.6.1 — hints you can type

- Every hint that names a command to run (`not cloned: …`, `run … sync`,
  `run … login`, `… upgrade <version>`) spells rness the way it was
  launched: `npx @rness/cli`, `pnpm dlx @rness/cli`, `yarn dlx @rness/cli`
  (npx on Yarn 1), `bunx @rness/cli`, or `rness` when it was typed directly.
  The next steps of `create` follow the same rule; `--pm`, which chooses what
  `.rness/` installs with, no longer decides them.
- Under `rness-dev` (`RNESS_NO_DELEGATE=1`), `create` writes its first blocks
  from the sources rather than through the copy it just installed.
- Blocks are unchanged: no `rness sync` is needed after upgrading.

## 0.6.0 — a workspace without GitHub

- `rness create <name> --blank` writes `<name>/.rness/` (a `rness.json`
  without `"org"`, committed), an empty `<name>/org/` and the root
  `AGENTS.md` and `CLAUDE.md`, with no login, SSH test or GitHub request.
  With `npm create`, flags go after `--`: `npm create rness demo -- --blank`.
- In a terminal, `create` with no organization and no `--repos` first asks
  how to start: from a GitHub organization, as before, or a blank local
  workspace.
- A `rness.json` without `"org"` is no longer a warning in `sync`, `add` and
  `validate`. In such a workspace `rness add <repo>` exits 2 and asks for
  `<owner>/<repo>` or a git URL: it used to take the directory name as the
  owner, a repository that almost never exists.
- The next steps `create` prints are written with the package manager that
  ran it: `npx @rness/cli`, `pnpm dlx @rness/cli`, `yarn dlx @rness/cli`
  (npx on Yarn 1), `bunx @rness/cli`, and `<pm> create rness <org>` for
  teammates. They said `rness …`, a command `npm create` never installs.
- Blocks are unchanged: no `rness sync` is needed after upgrading.

## 0.5.3 — catching up no longer depends on the global install

- After a pull that moved the pin, the next `rness` command installs it. That
  check ran in the launcher only, so a global `@rness/cli` below 0.5.1 — which
  delegates to the installed copy without looking — left the old version in
  place and said nothing: `sync --check` answered `unchanged` with 0.5.1
  blocks under a 0.5.2 pin. The installed copy now checks as well.
- Reach: the check lives in the installed copy, so it works from the first pin
  move after a workspace holds 0.5.3. The move to 0.5.3 itself still needs a
  launcher at 0.5.1 or later.
- The scaffold's `dependabot.yml` says why the pin's pull request arrives 3 to
  10 days after a release (a weekly check, plus Dependabot's default 3-day
  cooldown) and gives the three lines that lift it for `@rness/cli`. The
  default stays: for an adopting organization the CLI is a third-party
  package, and the cooldown guards against a compromised release.

## 0.5.2 — the block points at a file that exists

- The generated block told agents to read `.rness/STATUS.md`, a file neither
  the scaffold nor any command writes. It now sends them to
  `.rness/AGENTS.md`, which every workspace has and which sets the reading
  order.
- The intro is part of the hashed body: every block written by 0.5.1 or
  earlier is out of date under 0.5.2. Run `rness sync` once after upgrading,
  then commit the refreshed `AGENTS.md` in each repository; until then
  `rness sync --check` exits 1.

## 0.5.1 — the version of a workspace moves by pull request

- Joining an organization pinned to an older `@rness/cli` no longer mentions
  versions, and no longer invites a newcomer to move the whole team: the
  workspace is served by the version the organization agreed on.
- A workspace whose pin moved is reinstalled on the next command, with the
  package manager's frozen install so the working tree stays clean. Set
  `RNESS_NO_INSTALL=1` to keep the old warning instead — for CI, a container
  image, or a machine that cannot install.
- New workspaces ship `.github/dependabot.yml`, and `rness upgrade` writes it
  into workspaces created earlier: a pull request per release, reviewed, with
  `validate` running on the new version before the merge.
- A delegated child can no longer wait on an invisible SSH passphrase prompt:
  it fails with a readable line instead of hanging.
- A join that wrote its blocks succeeds even when a repository nobody picked
  failed to clone; those failures are hints.

## 0.5.0 — the organization is the workspace; rness.json is its catalogue

- `create <org>` names the organization, not a directory any more (`--org
<org>` and the prompt "What is your GitHub organization named?" do the
  same). The workspace directory is `./<org>`, with the organization's exact
  name; `--dir` is removed. With `npm create`, flags go after `--`:
  `npm create rness acme -- --yes`.
- SSH first: `create` and `add` write `git@github.com:` URLs when
  `ssh -T git@github.com` accepts your key, HTTPS ones otherwise (0.4.0
  wrote HTTPS unless `--ssh`). `--https` is new. A private `.rness` you reach
  over SSH is now found when joining. See "SSH or HTTPS" above.
- `create` does not offer repositories whose name starts with a dot
  (`.github`, …).
- Colour, a banner and progress lines in a terminal (see "Colour" above);
  nothing changes for scripts.
- `rness login` / `rness logout` are new: private repositories are listed,
  and cloned over HTTPS with the login (see "Log in" above). Without a login
  the note reads `rness login lists the private ones you can access`.
- `rness upgrade` is new (see "Upgrade" above). From 0.4.0:
  `npx @rness/cli@latest upgrade`.
- The header of a generated block no longer names the CLI version
  (`<!-- rness · scope: … -->`), and `sync` decides by the hash like
  `validate`: upgrading rewrites no `AGENTS.md`. Blocks written by 0.2–0.4
  stay as they are until their content changes. A 0.4.0 CLI calls the new
  header stale — upgrade every copy together.
- The scaffold's CI workflow reads the version from `package.json` instead of
  naming it; `upgrade` migrates the old line.
- `.rness/rness.json` is the organization's catalogue — every repository
  rness knows about, shared by the team. Your workspace is the part of it
  you cloned into `org/`; two teammates can clone different repositories,
  and nothing but `org/` records the choice. A choice never removes a
  repository from the catalogue.
- `create` lists the organization's repositories to search and pick from,
  with every catalogue repository pre-selected when joining (a catalogue
  repository the listing does not return is still offered, marked
  `in .rness`). A picked catalogue repository is cloned; a picked new one is
  added to the catalogue, as `rness add` does. Without a picker, `--repos`
  is the selection; a join without `--repos` clones the whole catalogue. A
  cancelled or declined prompt writes nothing and exits 0.
- The listing needs no credentials. Without a `GITHUB_TOKEN` (or `GH_TOKEN`)
  only public repositories are listed — and a personal account always lists
  only its public ones; add the others later with `rness add <repo>`.
- `rness sync` works on your clones: it writes the blocks of the repositories
  in `org/`, never of `rness.json` as a whole. In a terminal it asks "Do you
  want to sync as well?" with the catalogue repositories you have not cloned
  ("Select all", or pick some); what you pick is cloned first. With `--yes`,
  or `--check`, nothing is cloned and one `not cloned:` line names them
  (`--check` does not fail on it). `rness sync --all` clones them all without
  asking. A clone `rness.json` does not know gets no block and a
  `not in rness.json:` line pointing at `rness add`.
- A workspace pinned to 0.4.x clones every catalogue repository on sync —
  `create` runs the pinned copy's sync after joining.
- Joining a workspace whose `.rness` pins an older `@rness/cli` than the one
  you run says so, and that `rness upgrade` moves it.
- Repository and scope names take what GitHub allows, in lowercase: letters,
  digits, `.`, `_` and `-` (`my_lib`, `angular.js`). A name that differs only
  by case is declared in lowercase. A 0.4.0 CLI rejects a `rness.json` that
  holds a `.` or a `_` in a name — upgrade every copy together.
- Organization names follow GitHub's rule — letters, digits and single
  hyphens, not at either end, at most 39 characters — in `--org` and in
  `rness.json`'s `"org"`; the case is kept as typed.
- `"org"` in `rness.json` now accepts uppercase letters: a 0.4.0 CLI rejects
  a workspace whose `"org"` has any, so upgrade every copy together.

## 0.4.0 — create, add, the shims

- `npm create rness <org>` starts a new workspace for `github.com/<org>` or
  joins its existing `.rness`.
- `rness add <repo>` clones (or adopts) a repository under `org/`, declares
  it and any `--scopes` sub-directories, then syncs.
- `create-rness` and `@rness/create` are two-file shims pinned to the exact
  same version as `@rness/cli`, so the short `npm create` commands run this
  CLI.
- A new workspace's scaffold ships a `pnpm-workspace.yaml`
  (`minimumReleaseAgeExclude: ['@rness/cli']`) — pnpm 12 otherwise refuses a
  version published less than 24h earlier.

## 0.3.0 — what changed for a 0.2.0 workspace

- The directory decides a file's scope. `scopes: […]` and `scope: global`
  front-matter keys no longer route anything; `rness validate` reports them.
  Move the file instead (`standards/<scope>/…` or the collection root).
- `rness.json` may declare `"org": "<github-org>"`; without it the
  workspace directory name is used and `validate` warns.
- `validate` now checks every generated block: a stale block is an error,
  a missing one a warning — run `rness sync`.

## Develop

    pnpm install                      # from the repository root
    pnpm --filter @rness/cli test     # node:test on the TypeScript sources
    pnpm --filter @rness/cli typecheck
    pnpm --filter @rness/cli build    # tsup → dist/
    pnpm dev --help                   # the CLI, straight from these sources

`pnpm dev` runs `packages/cli/src/bin/rness.ts`: Node ≥ 24 strips the types,
so nothing is built between an edit and the next run. It turns delegation off,
because inside a workspace the launcher would otherwise hand the command to the
published `@rness/cli` pinned in `.rness/` rather than to the sources under
test; `RNESS_NO_DELEGATE=0 pnpm dev …` puts it back, to exercise delegation
itself.

To reach it from a workspace elsewhere on the machine, link it once:

    ln -s "$PWD/scripts/dev.mjs" ~/.local/bin/rness-dev   # from the repository root
    cd ~/somewhere/acme && rness-dev validate

`create` is never delegated, so it always runs these sources — the blocks it
writes at the end included, even once it has installed the pinned copy — and
it refuses to run inside a workspace, so call it from an empty directory.

`pnpm verdaccio` is the other loop: a local registry that serves this build as
a real package, for what only shows up through an install (`npm create rness`,
the pinned copy, a version bump). Each `pnpm verdaccio deploy` publishes a
version of its own — `0.6.1-dev.<time>` for sources at 0.6.0 — so a new
workspace pins exactly that build and no cache serves an older one under its
number. To try it in a workspace that exists, run `rness upgrade <version>`
inside it; the deploy prints the line.

Node ≥ 22.17. MIT.
