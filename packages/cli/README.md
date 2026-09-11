# @rness/cli

The `rness` command: configuration-plane CLI for rness workspaces. It
resolves, validates and (from 0.3.0) syncs an organisation's context for AI
coding agents. Not an agent — no LLM loop.

## Install

    npm i -g @rness/cli        # the command is `rness`
    npx @rness/cli --help

Inside a workspace, every `rness` delegates to the copy pinned in
`.rness/package.json`.

## Commands

    rness context [--scope <name>] [--json]   Resolve the context for a scope
    rness validate                            Check .rness/ against the contract

Exit codes: 0 success, 1 handled error, 2 bad usage. `RNESS_DEBUG=1` adds
stack traces; `RNESS_NO_DELEGATE=1` skips the delegation.

## Develop

    pnpm install                      # from the repository root
    pnpm --filter @rness/cli test     # node:test on the TypeScript sources
    pnpm --filter @rness/cli typecheck
    pnpm --filter @rness/cli build    # tsup → dist/
    RNESS_NO_DELEGATE=1 node packages/cli/src/bin/rness.ts --help

Inside a workspace whose `.rness/` pins a published `@rness/cli`, set
`RNESS_NO_DELEGATE=1` to run this source tree instead of delegating.

Node ≥ 24. MIT.
