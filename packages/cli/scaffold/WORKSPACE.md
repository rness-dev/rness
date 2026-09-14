# Workspace layout

A rness workspace mirrors one GitHub organisation:

```
<org>/
├── AGENTS.md        generated global block, not committed
├── .rness/          this repository — the organisation's context
└── org/<repo>/      the repositories you work on, cloned; a monorepo is a
                     repository like any other, its parts are declared as scopes
```

The workspace root is never a git repository. `rness.json` is the
organisation's catalogue: `repos` (every repository rness knows about — each
teammate clones the ones they need under `org/`, `rness sync --all` clones
them all) and `scopes` (where context resolves: a repository, or a directory
inside one, with an optional `extends`).

A scope's context is the global files of each collection plus
`<collection>/<scope>/**` plus everything it `extends`. `rness context
--scope <name>` prints it; `rness sync` writes it into
`org/<repo>/AGENTS.md` as a marked block.
