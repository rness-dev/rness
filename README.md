# rness

Configuration-plane tooling for AI coding agents: one shared, org-level
context and rule set, loaded into whichever agent a team already runs —
Claude Code, Codex, Cursor, … — across many repositories, monorepo or
polyrepo. rness never runs an LLM loop and is not an agent.

## Packages

| Path                    | npm                                                                                                                   | Status  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/cli`          | `@rness/cli` — the CLI, command `rness`: `create`, `add`, `sync`, `context`, `validate`, `upgrade`, `login`, `logout` | 0.5.3   |
| `packages/create`       | `@rness/create` — `npm create @rness`                                                                                 | 0.5.3   |
| `packages/create-rness` | `create-rness` — `npm create rness`                                                                                   | 0.5.3   |
| `packages/mcp`          | `@rness/mcp` — MCP server                                                                                             | planned |
| `plugins/claude-code`   | Claude Code plugin; this repository is its marketplace                                                                | planned |
| `templates/`, `action/` | demo apps, GitHub projection Action                                                                                   | planned |

## Develop

    pnpm install
    pnpm lint && pnpm format:check                # eslint, prettier (CI runs both)
    pnpm typecheck && pnpm test && pnpm build     # every package
    pnpm check:versions [--tag v0.5.3]            # lockstep versions; with the tag before a release
    pnpm lint:fix && pnpm format                  # apply the fixes
    RNESS_NO_DELEGATE=1 node packages/cli/src/bin/rness.ts --help     # run the CLI from source

Try a release before publishing it, through a local npm registry
([verdaccio](https://verdaccio.org), state in `.verdaccio/`):

    pnpm verdaccio start     # registry on http://127.0.0.1:4873 (VERDACCIO_PORT to change)
    pnpm verdaccio deploy    # build, then publish every package to it (never to npmjs)
    export npm_config_userconfig="$PWD/.verdaccio/npmrc"
    cd "$(mktemp -d /tmp/rness-XXXX)" && npm create rness <org>   # the published shim, as a user runs it
    unset npm_config_userconfig
    pnpm verdaccio stop      # or `clean` to also delete what it stored

`deploy` replaces a version already deployed, so it can run again after a
change; it also clears the npx cache (`<npm cache>/_npx`), which would
otherwise keep serving the first copy of that version to `npm create`.

Node ≥ 24, pnpm, TypeScript. MIT licence.
