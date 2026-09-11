# rness

Configuration-plane tooling for AI coding agents: one shared, org-level
context and rule set, loaded into whichever agent a team already runs —
Claude Code, Codex, Cursor, … — across many repositories, monorepo or
polyrepo. rness never runs an LLM loop and is not an agent.

## Packages

| Path | npm | Status |
| --- | --- | --- |
| `packages/cli` | `rness` — core CLI: `context`, `validate` | shipping |
| `packages/create` | `create-rness` — workspace bootstrap | planned |
| `packages/mcp` | `rness-mcp` — MCP server | planned |
| `plugins/claude-code` | Claude Code plugin; this repository is its marketplace | planned |
| `scaffold/`, `templates/`, `action/` | `.rness/` skeleton, demo apps, GitHub projection Action | planned |

## Develop

    pnpm install
    pnpm test                              # every package
    node packages/cli/src/cli.mjs --help

Node ≥ 24, pnpm. The core CLI carries zero runtime dependencies; every other
package has a single, named dependency budget.
