# Shared context

This directory is the durable, runtime-agnostic context of this organisation
for AI agents and maintainers. Claude Code, Codex, Cursor and every other
runtime read the same files.

## Start here

1. Read [README.md](README.md).
2. Read only the task-relevant decisions (`adr/`), specifications (`specs/`),
   plans (`plans/`), standards (`standards/`) and current-state notes (`docs/`).
3. Before editing a repository under `../org/`, read its `AGENTS.md`: the
   generated `<!-- BEGIN rness -->` block holds the rules that apply there.

## Rules of this directory

- Durable decisions live in `adr/`, proposed work in `specs/`, executable
  steps in `plans/`, current behaviour in `docs/`, reusable guidance in
  `standards/`, reusable agent skills in `skills/`.
- Never describe future work as current state.
- Generated blocks in `../org/*/AGENTS.md` are written by `rness sync`; edit
  the sources here, then run `rness sync`.
- Run `rness validate` before committing; the pre-commit hook does it for you
  once enabled (`git config core.hooksPath .githooks`).

See [CONVENTIONS.md](CONVENTIONS.md) for document lifecycle rules and
[WORKSPACE.md](WORKSPACE.md) for the workspace layout.
