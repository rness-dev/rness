# @rness/cli

The `rness` command: configuration-plane CLI for rness workspaces. It
resolves, validates and syncs an organisation's context for AI coding agents.
Not an agent — no LLM loop.

## Install

    npm create rness           # prompts for the organization, then the repositories for your workspace
    npm create rness acme      # the organization github.com/acme, no first prompt
    npm i -g @rness/cli        # the command is `rness`
    npx @rness/cli --help

Inside a workspace, every `rness` delegates to the copy pinned in
`.rness/package.json`.

## Commands

    rness create [<org>] [--repos a,b] [--pm npm|pnpm|yarn|bun] [--ssh|--https] [--skip-install] -y
    rness add <repo> [--scopes apps/web,packages/ui] [--ssh|--https] -y
    rness sync [--all] [--scope <name>] [--check] [--pull] -y
    rness upgrade [<version>] -y
    rness context [--scope <name>] [--json]
    rness validate

`create` never runs inside a workspace. `add`, `sync` and `create` ask for
confirmation in a terminal; pass `-y`/`--yes` in scripts. `sync --check`
writes nothing and exits 1 when a block is out of date — use it in CI.

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

In a terminal the status column, the help and the banner are coloured, and a
slow step shows a transient line (`cloning  org/api`) that is erased when it
ends. Through a pipe, in CI, or with `NO_COLOR=1`, the output is plain text —
the same bytes as before 0.5.0; `FORCE_COLOR=1` paints it anyway. No
dependency does this: `util.styleText`, and a banner kept as a constant.

### Upgrade

    rness upgrade            # the latest release; `rness upgrade 0.5.0` for another
    npx @rness/cli@latest upgrade     # from a workspace pinned below 0.5.0

The version is written in one place, `.rness/package.json`. `upgrade` pins it
there (exact, the rest of the file untouched), installs with the workspace's
package manager, then syncs through the new copy; a failed install restores
the file. Commit `.rness`; teammates pull and install in `.rness`. Until they
do, every command warns that the workspace pins one version and holds
another. It is never delegated to the pinned copy, which is what it replaces
— so a workspace pinned below 0.5.0, whose copy has no such command, starts
with the `npx` form.

An upgrade touches `.rness` only: a generated block is current when its hash
is, whatever wrote it, so no `AGENTS.md` of the organization changes unless
its content does.

Exit codes: 0 success, 1 failure, 2 usage — or a refusal without a TTY.
`RNESS_DEBUG=1` adds stack traces; `RNESS_NO_DELEGATE=1` skips the delegation.

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
- Repository names that differ only by case are declared in lowercase;
  names with `_` or `.` cannot be declared yet and are shown disabled.
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
    RNESS_NO_DELEGATE=1 node packages/cli/src/bin/rness.ts --help

Inside a workspace whose `.rness/` pins a published `@rness/cli`, set
`RNESS_NO_DELEGATE=1` to run this source tree instead of delegating.

Node ≥ 24. MIT.
