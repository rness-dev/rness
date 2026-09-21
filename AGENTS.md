# rness workspace member — scope: rness

<!-- BEGIN rness -->
<!-- rness · scope: rness · contract: 1 · hash: ee0dc45b82a1 · generated: run `rness sync`, never edit inside this block -->
This directory is scope `rness` of rness workspace `rness-dev`. Full context lives in
`../../.rness/` — start at its `AGENTS.md`, then task-relevant `adr/`, `specs/`, `plans/`;
live: `rness context --scope rness`. If `.rness/` is not reachable, this is a
standalone clone: the rules below are all you have.

## Rules
<!-- rness: standards/rness/dependencies.md -->
# Dependencies (scope `rness`)

The published packages of the `rness` repository take the dependencies that
earn their place ([ADR 0007](../../adr/0007-cli-stack-and-npm-naming.md)).
This standard is how to apply that day to day.

- Prefer a Node ≥ 24 built-in when it does the job as well: `fs.glob`,
  `util.styleText`, `node:test`, native type stripping for development.
- Adding a dependency is a reviewed change: pin it, and say in the PR what
  built-in or existing dependency does not cover the need.
- Keep `context` and `validate` lean: no prompt library and no network code
  on their path. Interactive or heavy modules load lazily (`import()`).
- Current runtime dependencies of `@rness/cli`: `commander`, `yaml`,
  `@clack/prompts`. Development: `typescript`, `tsup`, `@types/node`.
- The repository root owns the code-quality tooling for every package:
  `eslint` (`@eslint/js`, `typescript-eslint`, `eslint-config-prettier`) and
  `prettier` (with `@trivago/prettier-plugin-sort-imports`). `pnpm lint` and
  `pnpm format:check` run before typecheck, tests and build, locally and in CI.
  Generated `AGENTS.md`/`CLAUDE.md`, the scaffold and the test fixtures are
  never reformatted: their bytes are part of the contract.
- `.rness/scripts/` — this workspace's context tooling (`STATUS.md`, the HTML
  dashboard for GitHub Pages) — stays dependency-free: it runs in git hooks
  and must never need an install to work.

<!-- rness: standards/architecture.md -->
# Architecture and repository strategy

Choose the smallest structure that supports the product’s real ownership,
deployment, and reuse boundaries. Do not introduce a new repository, package,
service, or abstraction without a clear consumer and purpose.

## Boundaries

- Keep domains and external-system integrations explicit.
- Prefer feature-oriented modules as an application grows.
- Keep shared utilities narrow, generic, and well named.
- Avoid circular dependencies and hidden global state.
- Separate client-visible code from server-only code where that distinction
  exists.
- Document contracts between independently released components.

## Change decisions

Use an ADR for choices that would be expensive to reverse or that create a
lasting constraint. Include the context, decision, alternatives, and
consequences. A repository layout is not changed merely to satisfy a generic
pattern.

<!-- rness: standards/blockchain.md -->
# Blockchain and smart-contract standards

Apply this guidance only when a project actually interacts with blockchains,
wallets, or smart contracts. Select ecosystems and tooling to match the
project’s target network and existing implementation; this scaffold mandates
neither a chain nor a provider.

- Treat wallet, network, RPC, transaction, and user-entered values as untrusted
  input.
- Keep chain configuration, contract interfaces, read operations, write
  operations, and UI concerns separate.
- Validate network identity, addresses, units, and amounts before requesting a
  signature or submitting a transaction.
- Model unsupported network, rejected signature, pending transaction, and
  reverted transaction states explicitly.
- Use integer-safe unit handling; never use floating-point values for token
  amounts.
- Never embed private keys, seed phrases, RPC credentials, or deployment
  secrets in source code or client bundles.
- Reuse established, reviewed primitives where they meet the requirement.
- Test authorization, failure paths, events, accounting, and meaningful edge
  cases. Do not claim a contract is audited without independent evidence.

<!-- rness: standards/coding-style.md -->
# Coding style

Follow the formatter, linter, type system, and conventions already established
by the project. If none exists, choose a small, idiomatic baseline for the
language in use and document it before applying it broadly.

- Favor clear names, small focused modules, and explicit inputs and outputs.
- Prefer immutable updates and composition where they make behavior easier to
  follow.
- Keep public APIs intentional; do not export incidental implementation detail.
- Model expected empty, loading, error, and success states explicitly.
- Avoid broad suppression of lint, type, or test failures. Use a narrow,
  documented exception only when justified.
- Keep comments for non-obvious reasoning, constraints, or trade-offs—not for
  restating code.

<!-- rness: standards/deployment.md -->
# Deployment and operations

Select a deployment target based on the project’s runtime, security,
compliance, cost, and operational needs. Do not assume a hosting provider,
cloud account, branch policy, or environment naming convention.

Before handoff, run the project’s relevant validation commands and document
the deployment inputs: required environment variable names, build command,
runtime expectations, and rollback path.

- Store secrets in the deployment platform or approved secret manager, never in
  source code, logs, or client bundles.
- Fail clearly when required configuration is missing.
- Use preview or staging environments when they are part of the project’s
  delivery process.
- Keep production changes observable and reversible where practical.
- Add platform-specific configuration only when it solves a real requirement.

<!-- rness: standards/documentation.md -->
# Documentation standards

Choose documentation location by audience and lifecycle.

| Audience | Location |
| --- | --- |
| Agents and maintainers | `.rness/` |
| Repository users and contributors | Repository `README.md` and contributor documents |
| External users or operators | The project’s public documentation surface |
| Current implementation behavior | `.rness/docs/` or the owning repository, according to its policy |

Avoid duplicate sources of truth. Documentation must describe what exists or
clearly label a proposal, limitation, or pending item.

## Writing rules

- State consequences as well as mechanisms.
- Support security and correctness claims with evidence.
- Date facts that can become stale, such as version pins or compatibility.
- Do not claim reviews, audits, certifications, availability, or guarantees
  that have not occurred.
- Keep setup instructions executable and free of secret values.

<!-- rness: standards/engineering.md -->
# Engineering standards

Apply these principles to every project; choose technologies to fit the
existing codebase and the task rather than a scaffold preference.

## Priorities

1. Correctness and security
2. Simplicity and readability
3. Maintainability
4. Performance appropriate to the evidence
5. Developer experience

Prefer small, explicit changes over speculative abstractions. Reuse existing
patterns and dependencies when they fit. Add a dependency, service, or layer
only for a demonstrated need.

## Delivery expectations

- Keep the project runnable at meaningful checkpoints.
- Use stable, supported tool versions compatible with the repository.
- Keep configuration, credentials, and environment-specific values out of
  source control.
- Run the relevant formatter, static checks, tests, and build before handoff.
- State any verification that could not be run and why.

<!-- rness: standards/github.md -->
# Version-control and collaboration standards

Use the hosting and review workflow configured by the repository. This
scaffold does not require a particular forge, branch name, commit format, or
merge strategy.

- Keep commits focused and describe the change clearly.
- Run the relevant checks before requesting review or handing work off.
- Keep automation free of credentials and project-specific URLs.
- Use a branch or worktree when the repository policy requires isolation.
- Merge, push, publish, or delete branches only with the authorization and
  process appropriate to the repository.

Every maintained repository should explain its purpose, prerequisites, local
workflow, validation commands, configuration names, and contribution policy in
its own README or equivalent entry point.

<!-- rness: standards/nextjs.md -->
# Next.js conventions

Apply this guidance only to repositories that already use Next.js or where the
task explicitly selects it. It does not prescribe Next.js for other projects.

- Follow the installed version’s official conventions and keep TypeScript
  strictness and linting aligned with the project.
- Prefer server rendering by default; introduce client components only at the
  smallest boundary that needs browser APIs or interactivity.
- Keep data fetching, mutations, route handlers, and loading/error boundaries
  close to the feature that owns them.
- Validate required environment variables at startup or at the boundary where
  they are used.
- Never expose secrets through client-visible environment variables.
- Preserve the existing directory and routing conventions rather than imposing
  a new layout.

<!-- rness: standards/testing.md -->
# Testing standards

Use the test runner and commands already configured by the project. If a
project has no test setup, add one only when the requested change warrants it
and choose the language’s conventional, lightweight option.

## What to verify

1. Security and correctness guarantees
2. Expected failures and rejection paths
3. Boundary conditions
4. Main success paths
5. User-visible formatting and ergonomics

- Keep tests deterministic: control time, randomness, network access, and
  external services.
- Assert the specific behavior or error that matters.
- Test the project’s integration with a dependency, not the dependency’s own
  internals.
- Run fast automated checks before slower integration or end-to-end checks.
- Treat coverage as a diagnostic, not a target; map important claims to the
  test that proves them.

The context utilities in `.rness/scripts/` use the built-in Node test runner to
avoid adding a second test framework solely for this scaffold.

<!-- rness: standards/ui.md -->
# UI and styling standards

Follow the project’s established UI stack and design system. If the project has
none, select the lightest accessible approach that serves the task; this
scaffold does not mandate a CSS framework, component library, or theme tool.

- Reuse existing primitives and tokens before creating bespoke components.
- Preserve semantic HTML, keyboard navigation, visible focus, labels, and
  sufficient contrast.
- Make responsive behavior intentional and verify small and large layouts.
- Provide useful loading, empty, error, disabled, and success states where
  relevant.
- Keep components focused and composable; avoid premature design-system
  abstractions.
- Respect existing light, dark, and system-theme behavior when present.
<!-- END rness -->
