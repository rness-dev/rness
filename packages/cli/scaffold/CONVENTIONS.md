# Working conventions

## Document roles

- **ADR** (`adr/`): a durable record of an important decision and its
  consequences. Never rewritten; superseded by a new ADR.
- **Specification** (`specs/`): what is proposed and why.
- **Plan** (`plans/`): ordered, verifiable implementation steps.
- **Documentation** (`docs/`): the current state, kept living.
- **Standard** (`standards/`): reusable guidance; global at the collection
  root, scoped under `standards/<scope>/`.
- **Skill** (`skills/`): reusable agent skills, resolved per scope the same
  way.

## Metadata and status

ADRs, specifications and plans start with YAML front matter before the first
`#` heading:

```yaml
---
date: YYYY-MM-DD
status: Proposed
repo: <repository or scope this applies to>
---
```

| Document | Allowed statuses |
| --- | --- |
| ADR | `Proposed`, `Accepted`, `Rejected`, `Superseded` |
| Specification | `Draft`, `Proposed`, `Approved`, `Implemented`, `Superseded`, `Rejected` |
| Plan | `Draft`, `Ready`, `In progress`, `Blocked`, `Completed`, `Abandoned` |

`date` is the creation date; add `updated: YYYY-MM-DD` on meaningful change
(never on an ADR). Link related documents with `spec:`, `plan:`, `adr:`, or
`superseded_by:`. A file's directory decides its scope: `<collection>/<file>.md`
applies everywhere, `<collection>/<scope>/**` applies to that scope and to the
scopes that extend it. Front matter never re-routes a file; `rness validate`
rejects a `scopes` or `scope` key.

`rness validate` enforces the front matter and the status sets above.

## Maintenance

- Change a status together with the work it describes.
- Update the smallest set of documents the completed work makes inaccurate.
- Run `rness sync` after any change here so every repository's generated
  block is current.
