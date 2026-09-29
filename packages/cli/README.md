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
    rness status [<tab>]
    rness pulse create [-y]
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

A tab for `ADR`, `Specs` and `Plans`, always, then one for each other
directory of `.rness/` whose Markdown files carry a `status` in their front
matter (a `marketing/` of dated posts, say). A line per document, newest
first: its number (or date), its title, its status — green when done, grey
when dropped, red `?` when missing.

- In a terminal, a full-screen view: `←`/`→` or `Tab` change tab, `↑`/`↓`,
  `PgUp`/`PgDn`, `Home`/`End` scroll, `q` or `Esc` closes and gives the
  screen back. Read-only.
- Off a terminal — a pipe, CI, an agent's tool — Markdown: a table per tab.
- From Claude Code, `/rness:status [tab]` shows those tables (see "Agent
  targets"). For the view itself: `Ctrl+Z` suspends Claude Code, run
  `npx @rness/cli status` (or `rness status` with a global install), `q`,
  then `fg` resumes it — the skill ends with that line. Nothing started from inside
  Claude Code gets the terminal, so the view cannot open from there
  (verified with Claude Code 2.1.284 on 2026-09-29).

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
  carries three hooks, and so does `.claude/settings.json` at the workspace
  root, which `sync` writes on every machine; see "Hooks". Both places also
  get a Claude Code plugin, `.claude/skills/rness/`, with one command:
  `/rness:status [tab]`, the tables of `rness status`. rness owns those
  files whole — an edit by hand is reported by `sync --check` and written
  back by `sync` — and nothing in them depends on the version. Claude Code
  loads the plugin once the folder is trusted, in a session started there.
- rness owns values, not files: what is missing is added, nothing else is
  touched, and a file it cannot parse is reported, never rewritten.
  `sync --check` and `validate` report a missing value. Removing an agent
  from `agents` leaves its values in place; `sync` says where.
- Other agents (Codex, Cursor, GitHub Copilot) read the `AGENTS.md` block;
  `sync` refuses an agent it has no target for.

### Hooks

With `claude` in `agents`, each clone's `.claude/settings.json` and the
workspace root's carry three Claude Code hooks, all run by the pinned copy:

- **At session start** (`SessionStart`, every source): a line for the
  developer — `rness 0.10.0 · acme · scope web — 3 standards, 2 decisions`
  — and, for the model, the scope's documents as `rness_context` lists
  them. When the context may be wrong, both say why: no `.rness` next to the
  repository or nothing installed there, a `rness.json` rness refuses, a pin
  the installed copy does not match, the problems `rness validate` reports.
  After a compaction, the context only.
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
developer, including in `claude -p`. These three read `.rness/`, write
nothing in the workspace and run no install. Only with a pulse declared do
they reach the network, through a detached `rness` process that uses your
login; when that process fails, it writes why to `pulse.json` in rness's
configuration directory (`~/.config/rness/` by default), which the next
session start reads, says once and deletes. See "Pulse". Review a change to
them like code. Verified with Claude Code 2.1.284 on 2026-09-29: in a clone
and at the root, the model received the context; after an edit that broke a
status, it received the problem. The `sh` line is not verified on Windows.

### Pulse

    rness pulse create      # once per organization: the board, then a first sync
    rness pulse sync        # as often as wanted

A projection of rness's state on the organization's GitHub Projects: a
project named **Agent Pulse**, where the team sees every document of
`.rness/` and when an agent is at work on one. rness writes the board and
never reads it back; if it is not in rness, it does not belong there.

- **Layout**: one item per document (a draft issue: its title, its path and a
  link to it in `<org>/.rness`), and the fields `Status` (the statuses found
  in `.rness/`, at most 50), `Collection` (one option per tab of
  `rness status`; not `Type`, which is GitHub's own issue-type field and
  filter), `Agent` (`working`), `Session` (`claude · 1a2b3c4d`, plus the
  agent type for a subagent) and `Path`. A board per directory, named as
  `rness status` names its tab, filtered on its `Collection`, its columns
  the statuses; a `Working` table, filtered on `Agent: working`. rness does
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
  `"pulse": { "project": <number> }` (and the `provider`) into `rness.json`,
  then adds the fields, options and views, and runs a first sync; its
  `created` lines say what it added. If a step after the project fails, it
  exits 1 with the pulse declared, and `rness pulse sync` completes the
  layout. Commit `rness.json` in `.rness`. The number is that of the
  project in the organization. A CLI older than 0.12.0 refuses the key, so
  the pin moves first (`rness upgrade`). A workspace without a `provider`
  whose repositories look like GitLab is refused before anything is
  created: write `"provider": "github"` if the organization is on GitHub.
- **`pulse sync`**: creates the items that are missing, updates those whose
  title, status or collection changed, archives those whose document is
  gone, and adds the option or the board a new status or directory needs. It
  says `synced 49 items: 2 updated, 47 unchanged`. An item converted to an
  issue by hand is the team's: left alone, and its document gets a new
  draft.
- **One way**: the board is only read to find rness's items. What someone
  changes there by hand is overwritten at the next sync.
- **Hooks**, with `claude` in `agents` and a pulse declared: session start
  marks the `In progress` plans of the session's scope `Agent: working`, with
  the session; an edit of a document of `.rness/` marks it; session end clears
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
- **Rate**: rness sends its requests one after another, without pausing. A
  first sync makes a draft and sets up to three fields per document — about
  200 requests for fifty documents; whether that stays under GitHub's
  limits for creating content is to be confirmed on GitHub. Later syncs
  touch only what changed.
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

- `rness create` asks `Where does your organization live?`: GitHub, and
  GitLab and Atlassian (Bitbucket + Jira) shown disabled, coming later.
  `--provider github` answers it off a terminal. A blank workspace asks
  nothing. Joining an organization asks first as well, then takes the
  provider its `rness.json` names.
- A workspace without the key is read from its first repository URL: a
  GitLab host reads as `gitlab`, any other host — or no repository — as
  `github`. Nothing to change: `pulse create` writes it, and refuses a
  detected provider this version cannot talk to. The order of keys is
  `contract`, `provider`, `org`, `agents`, `pulse`, `repos`, `scopes`.
- A provider _written_ in `rness.json` that this version cannot talk to
  (`gitlab`) is refused by `validate`, `create`, `login` and `pulse`:
  `provider "gitlab" is not supported by @rness/cli 0.12.0 (supported:
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
- An organization that restricts OAuth apps hides its private repositories
  until an owner approves "Rness"; `create` says so, with the link.
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

Node ≥ 24. MIT.
