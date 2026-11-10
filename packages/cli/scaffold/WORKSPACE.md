# Workspace layout

A rness workspace mirrors one GitHub organisation:

```
<org>/
├── AGENTS.md        generated global block, not committed
├── .rness/          this repository: the organisation's context
└── org/<repo>/      the repositories you work on, cloned; a monorepo is a
                     repository like any other, its parts are declared as scopes
```

The workspace root is never a git repository. `rness.json` is the
organisation's catalogue: `scopes` (where context resolves). A scope with a
`url` is a repository: each teammate clones the ones they need under `org/`,
`rness sync --all` clones them all. A scope with a `path` is a part of the
repository it is nested in, a directory inside it. Either has an optional
`extends`.

A scope's context is the global files of each collection plus
`<collection>/<scope>/**` plus everything it `extends`. `rness context
--scope <name>` prints it; `rness sync` writes it into
`org/<repo>/AGENTS.md` as a marked block.
