import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { BLOCK_SIZE_WARNING, renderBlock } from '../core/block.ts'
import { assembleContext } from '../core/context.ts'
import { exists, isSymlink, readOrNull, writeFileAtomic } from '../core/fs.ts'
import { clone, isClean, pullFastForward } from '../core/git.ts'
import { loadManifest, resolveOrg } from '../core/manifest.ts'
import { ensureClaudeMd, mergeBlock } from '../core/merge.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'

export interface SyncOptions {
  /** Only this scope's block (the root block is skipped). */
  scope?: string
  /** Render and compare; write nothing; exit 1 when any block differs. */
  check?: boolean
  /** `git pull --ff-only` in every clean clone. */
  pull?: boolean
  /** Clone every catalogue repository missing from `org/`; by default none is cloned. */
  all?: boolean
  /** Skip the confirmation prompt. */
  yes?: boolean
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

interface Target {
  scope: string | null
  dir: string
  depth: number
  label: string
}

// Excluded from the cleanliness check whatever their status: sync writes them itself. A
// user's uncommitted edit to a tracked AGENTS.md is therefore not a veto — git pull
// --ff-only still refuses to overwrite it and that surfaces as a problem.
const MANAGED_FILES = ['AGENTS.md', 'CLAUDE.md']

function targetsOf(
  manifest: Manifest,
  root: string,
  only: string | undefined
): Target[] {
  const targets: Target[] = []
  if (only === undefined)
    targets.push({ scope: null, dir: root, depth: 0, label: 'AGENTS.md' })
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    if (only !== undefined && name !== only) continue
    const segments = entry.path.split('/')
    targets.push({
      scope: name,
      dir: join(root, ...segments),
      depth: segments.length,
      label: `${entry.path}/AGENTS.md`,
    })
  }
  return targets
}

/** The picker's "select all" entry; no repository name can take this value. */
const SELECT_ALL = '*'

/** The directories under `org/` — the user's workspace (ADR 0008). */
async function clonesIn(root: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(root, 'org'), { withFileTypes: true })
    return new Set(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    )
  } catch {
    return new Set()
  }
}

/**
 * In a terminal: offer the catalogue repositories that are not cloned, or
 * confirm when there are none. Returns the repositories to clone, or an exit
 * code when the run stops here.
 */
async function askWhatToSync(input: {
  org: string
  missing: readonly string[]
  offer: boolean
  terminal: Terminal
}): Promise<string[] | number> {
  if (!input.terminal.isTty()) {
    process.stderr.write(
      'rness sync writes files; pass --yes to run without a prompt\n'
    )
    return 2
  }
  const p = await input.terminal.prompts()
  const cancelled = (): number => {
    process.stderr.write('cancelled\n')
    return 1
  }
  if (input.offer && input.missing.length > 0) {
    const answer = await p.autocompleteMultiselect({
      message: 'Do you want to sync as well?',
      options: [
        {
          value: SELECT_ALL,
          label: 'Select all',
          hint: `${input.missing.length} repositories from rness.json`,
        },
        ...input.missing.map((name) => ({ value: name, label: name })),
      ],
      required: false,
      placeholder: 'Type to filter',
    })
    if (p.isCancel(answer) || !Array.isArray(answer)) return cancelled()
    return answer.includes(SELECT_ALL)
      ? [...input.missing]
      : answer.filter((name) => name !== SELECT_ALL)
  }
  const ok = await p.confirm({
    message: `Sync workspace \`${input.org}\`: rewrite the rness blocks of your clones?`,
  })
  if (p.isCancel(ok) || ok !== true) return cancelled()
  return []
}

/**
 * `rness sync`: write the blocks of the repositories cloned in `org/` (spec
 * 0003 §4). The clones are the workspace; `rness.json` is the organization's
 * catalogue, so a catalogue repository that is not cloned is offered (in a
 * terminal) or named, never cloned silently — `--all` clones them all.
 * Returns the exit code.
 */
export async function syncCommand(
  opts: SyncOptions,
  terminal: Terminal = defaultTerminal
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const check = opts.check === true
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const { org, warning } = resolveOrg(manifest, ws.root)
    if (warning !== null) process.stderr.write(`warning: ${warning}\n`)
    if (
      opts.scope !== undefined &&
      !Object.hasOwn(manifest.scopes, opts.scope)
    ) {
      process.stderr.write(`unknown scope: ${opts.scope}\n`)
      return 1
    }

    const clones = await clonesIn(ws.root)
    const missing = Object.keys(manifest.repos).filter((n) => !clones.has(n))
    let toClone = new Set<string>(opts.all === true && !check ? missing : [])
    if (!check && opts.yes !== true) {
      const answer = await askWhatToSync({
        org,
        missing,
        // `--all` already answers; `--scope` is about one block, not the workspace.
        offer: opts.all !== true && opts.scope === undefined,
        terminal,
      })
      if (typeof answer === 'number') return answer
      if (opts.all !== true) toClone = new Set(answer)
    }

    const lines: string[] = []
    const problems: string[] = []

    try {
      // 1. Repositories: clone only what was asked for; pull only on request,
      // only clean trees.
      const notCloned = new Set<string>()
      for (const [name, repo] of Object.entries(manifest.repos)) {
        const dir = join(ws.root, 'org', name)
        const label = `org/${name}`
        if (!(await exists(dir))) {
          if (!toClone.has(name)) {
            notCloned.add(name)
            continue
          }
          try {
            await clone(repo.url, dir)
            lines.push(`cloned   ${label}`)
          } catch (e) {
            problems.push(
              `${label}: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        } else if (opts.pull === true && !check) {
          try {
            if (!(await isClean(dir, MANAGED_FILES))) {
              lines.push(`skipped  ${label} (working tree not clean)`)
              continue
            }
            await pullFastForward(dir)
            lines.push(`pulled   ${label}`)
          } catch (e) {
            problems.push(
              `${label}: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
      }

      if (notCloned.size > 0)
        lines.push(
          `not cloned: ${[...notCloned].join(', ')} (rness add <name>, or rness sync --all)`
        )
      // A clone the catalogue does not know gets no block: no scope declares
      // its rules. Say how to bring it in rather than skipping it silently.
      const scoped = new Set(
        Object.values(manifest.scopes).map((s) => s.path.split('/')[1])
      )
      const undeclared = [...clones].filter(
        (n) => !Object.hasOwn(manifest.repos, n) && !scoped.has(n)
      )
      if (undeclared.length > 0)
        lines.push(
          `not in rness.json: ${undeclared.join(', ')} (rness add <name> declares it)`
        )

      // 2. Blocks — only where repositories live; a standalone context checkout has no org/.
      if (!(await exists(join(ws.root, 'org')))) {
        lines.push('skipped  blocks (no org/ directory here)')
      } else {
        let differences = 0
        for (const t of targetsOf(manifest, ws.root, opts.scope)) {
          if (!(await exists(t.dir))) {
            // A scope inside a repository that is not cloned is covered by
            // the `not cloned:` line; only a directory missing from a present
            // clone (or from no repository at all) is worth its own line.
            const repo = t.label.split('/')[1]
            if (
              !t.label.startsWith('org/') ||
              repo === undefined ||
              !notCloned.has(repo)
            )
              lines.push(`skipped  ${t.label} (directory not present)`)
            continue
          }
          // One of the pair symlinked to the other (the common `CLAUDE.md →
          // AGENTS.md`) is left untouched: reading follows the link, and the
          // atomic rename would replace the link with a duplicate of its target.
          const linked = await Promise.all(
            MANAGED_FILES.map((f) => isSymlink(join(t.dir, f)))
          )
          if (linked.includes(true)) {
            lines.push(`skipped  ${t.label} (symlink)`)
            continue
          }
          const context = await assembleContext({
            rnessDir: ws.rnessDir,
            manifest,
            scope: t.scope,
          })
          const block = renderBlock({
            scope: t.scope,
            org,
            depth: t.depth,
            context,
            version: VERSION,
          })
          if (block.bytes > BLOCK_SIZE_WARNING) {
            process.stderr.write(
              `warning: ${t.label}: block is ${Math.round(block.bytes / 1024)} KB (over 32 KB)\n`
            )
          }
          const file = join(t.dir, 'AGENTS.md')
          const merged = mergeBlock(await readOrNull(file), block.text)
          if (!merged.ok) {
            problems.push(`${t.label}: ${merged.error}`)
            continue
          }
          if (!merged.changed) {
            lines.push(`unchanged ${t.label}`)
            if (!check) await ensureClaudeMd(t.dir)
            continue
          }
          if (check) {
            lines.push(`stale    ${t.label}`)
            differences += 1
            continue
          }
          await writeFileAtomic(file, merged.text)
          await ensureClaudeMd(t.dir)
          lines.push(`updated  ${t.label}`)
        }
        if (check && differences > 0)
          problems.push(`${differences} block(s) out of date — run rness sync`)
      }

      return problems.length > 0 ? 1 : 0
    } finally {
      // Both flushes run even when something above throws, and stdout precedes
      // stderr so the report reads in order. The exit code above is computed
      // before this block, so it is unaffected.
      for (const l of lines) process.stdout.write(`${l}\n`)
      for (const p of problems) process.stderr.write(`${p}\n`)
    }
  } catch (e) {
    return reportError(e)
  }
}
