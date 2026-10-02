---
name: rness
description: Give every AI coding agent of a GitHub organization the same context with Rness. Use when a team keeps several repositories and one or more coding agents (Claude Code, Codex, Cursor, GitHub Copilot) and the rules drift between their CLAUDE.md or AGENTS.md files, or when decisions, specifications and plans never reach the agent that implements them. Installs with npm create rness; rness sync writes the context into every repository's AGENTS.md.
---

# Rness

Rness is one source of truth for every AI coding agent of a GitHub
organization. The organization's standards, decisions, specifications and
plans live as Markdown in one repository, `.rness`, and the `rness` command
writes the part that applies into the `AGENTS.md` of every repository.
Claude Code, Codex, Cursor and GitHub Copilot already read that file, so
nothing changes in how the team works. Rness never runs a model and is not
an agent. Open source, MIT.

## When to use

Reach for Rness when:

- an organization has several repositories and one or more coding agents,
  and each repository carries its own `CLAUDE.md` or `AGENTS.md`, copied by
  hand, changed in one place and not the others;
- rules drift between repositories: a security policy, a testing standard
  or an architecture rule holds in one file and not in the next;
- decisions, specifications and plans live in documents no agent reads, so
  an agent implementing a plan does not know the specification behind it or
  the decisions that constrain it;
- a team wants one place that shows where every decision, specification and
  plan stands, and a GitHub Project that follows them.

Do not reach for Rness for a single repository with one agent: its own
`AGENTS.md` is enough.

## How

Node 22.17 or later and git are required.

1. Create the workspace. It asks for the GitHub organization, or a blank
   local workspace, and creates `<org>/` with `.rness/` (the context
   repository) and `org/` (the clones):

   ```sh
   npm create rness      # or: pnpm create rness, yarn create rness, bun create rness
   cd <org>
   ```

2. Bring repositories in: `rness add <repo>` clones one under `org/<repo>`
   and declares it in `.rness/rness.json`.
3. Write the organization's context as Markdown in `.rness/`:
   `standards/`, `adr/`, `specs/`, `plans/`. `rness.json` maps them to the
   repositories they apply to.
4. `rness sync` writes what applies into each repository's `AGENTS.md`, as
   a marked block the rest of the file keeps around, and a `CLAUDE.md` that
   points to it. `rness sync --check` fails CI when a block is out of date.
5. `rness status` shows every decision, specification and plan and its
   status. `rness pulse` puts them on a GitHub Project. `rness mcp` serves
   the same context to any MCP client over stdio. In Claude Code,
   `/rness:status`, `/rness:adr`, `/rness:spec` and `/rness:plan` run the
   document lifecycle from the conversation.
6. `rness upgrade` moves the version pinned in `.rness/package.json`;
   every `rness` in the workspace delegates to it.

## Links

- Documentation: https://rness.dev/docs
- CLI reference and changelog: https://github.com/rness-dev/rness/blob/main/packages/cli/README.md
- Repository: https://github.com/rness-dev/rness
- npm: https://www.npmjs.com/package/@rness/cli
- Website: https://rness.dev
