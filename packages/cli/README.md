# rness CLI

Configuration-plane CLI for rness. Resolves and validates workspace context.
Not an agent — no LLM loop.

## Commands

    rness context [--scope <name>] [--json]   Resolve the context for a scope
    rness validate                            Check .rness/ against the contract

Run inside an rness workspace (a directory tree containing `.rness/rness.json`).

## Develop

    cd cli && npm test
