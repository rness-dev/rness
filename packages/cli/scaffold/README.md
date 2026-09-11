# Context repository

The `.rness/` directory of an rness workspace: the organisation's decisions,
specifications, plans, standards and skills, resolved per repository by the
`rness` CLI and delivered to every AI coding agent as a generated block.

- Entry point for agents: [AGENTS.md](AGENTS.md)
- Layout: [WORKSPACE.md](WORKSPACE.md)
- Document lifecycle: [CONVENTIONS.md](CONVENTIONS.md)
- Workspace map (repositories, scopes): [rness.json](rness.json)

## Commands

    npm run validate     # rness validate — check this tree against the contract
    npm run context      # rness context — print the resolved context for a scope
    npm run sync         # rness sync — clone repositories, regenerate blocks

The CLI is pinned in `package.json`; any `rness` you run inside the workspace
delegates to that copy.
