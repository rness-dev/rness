# rness

Configuration-plane tooling for AI coding agents: one shared, org-level
context and rule set, loaded into whichever agent a team already runs —
Claude Code, Codex, Cursor, … — across many repositories, monorepo or
polyrepo. rness never runs an LLM loop and is not an agent.

## Packages

| Path                    | npm                                                                                     | Status  |
| ----------------------- | --------------------------------------------------------------------------------------- | ------- |
| `packages/cli`          | `@rness/cli` — the CLI, command `rness`: `create`, `add`, `sync`, `context`, `validate` | 0.4.0   |
| `packages/create`       | `@rness/create` — `npm create @rness <org>`                                             | 0.4.0   |
| `packages/create-rness` | `create-rness` — `npm create rness <org>`                                               | 0.4.0   |
| `packages/mcp`          | `@rness/mcp` — MCP server                                                               | planned |
| `plugins/claude-code`   | Claude Code plugin; this repository is its marketplace                                  | planned |
| `templates/`, `action/` | demo apps, GitHub projection Action                                                     | planned |

## Develop

    pnpm install
    pnpm lint && pnpm format:check                # eslint, prettier (CI runs both)
    pnpm typecheck && pnpm test && pnpm build     # every package
    pnpm check:versions [--tag v0.4.0]            # lockstep versions; with the tag before a release
    pnpm lint:fix && pnpm format                  # apply the fixes
    RNESS_NO_DELEGATE=1 node packages/cli/src/bin/rness.ts --help     # run the CLI from source

Node ≥ 24, pnpm, TypeScript. MIT licence.
