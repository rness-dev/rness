# Workspace layout

A rness workspace mirrors one GitHub organisation:

```
<org>/
├── AGENTS.md        generated global block, not committed
├── .rness/          this repository — the organisation's context
└── org/<repo>/      one clone per repository; a monorepo is a repository
                     like any other, its parts are declared as scopes
```

The workspace root is never a git repository. `rness.json` declares `repos`
(what `rness sync` clones under `org/`) and `scopes` (where context resolves:
a repository, or a directory inside one, with an optional `extends`).

A scope's context is the global files of each collection plus
`<collection>/<scope>/**` plus everything it `extends`. `rness context
--scope <name>` prints it; `rness sync` writes it into
`org/<repo>/AGENTS.md` as a marked block.
