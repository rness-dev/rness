# @rness/cli

The `rness` command: configuration-plane CLI for rness workspaces. It
resolves, validates and syncs an organisation's context for AI coding agents.
Not an agent — no LLM loop.

## Install

    npm i -g @rness/cli        # the command is `rness`
    npx @rness/cli --help

Inside a workspace, every `rness` delegates to the copy pinned in
`.rness/package.json`.

## Commands

    rness context [--scope <name>] [--json]           Resolve the context for a scope
    rness validate                                    Check .rness/ and every generated block
    rness sync [--scope <name>] [--check] [--pull] -y Clone repositories, write the blocks

Exit codes: 0 success, 1 handled error, 2 bad usage. `RNESS_DEBUG=1` adds
stack traces; `RNESS_NO_DELEGATE=1` skips the delegation. `sync` asks for
confirmation in a terminal; pass `-y`/`--yes` in scripts. `--check` writes
nothing and exits 1 when a block is out of date — use it in CI.

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
