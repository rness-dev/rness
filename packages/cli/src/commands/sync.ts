import { join } from 'node:path'
import { VERSION } from '../version.ts'
import { reportError } from '../report.ts'
import { findWorkspace } from '../core/workspace.ts'
import { loadManifest, resolveOrg } from '../core/manifest.ts'
import { assembleContext } from '../core/context.ts'
import { BLOCK_SIZE_WARNING, renderBlock } from '../core/block.ts'
import { ensureClaudeMd, mergeBlock } from '../core/merge.ts'
import { exists, isSymlink, readOrNull, writeFileAtomic } from '../core/fs.ts'
import { clone, isClean, pullFastForward } from '../core/git.ts'
import type { Manifest } from '../core/types.ts'

export interface SyncOptions {
  /** Only this scope's block (the root block is skipped). */
  scope?: string
  /** Render and compare; write nothing; exit 1 when any block differs. */
  check?: boolean
  /** `git pull --ff-only` in every clean clone. */
  pull?: boolean
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

function targetsOf(manifest: Manifest, root: string, only: string | undefined): Target[] {
  const targets: Target[] = []
  if (only === undefined) targets.push({ scope: null, dir: root, depth: 0, label: 'AGENTS.md' })
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    if (only !== undefined && name !== only) continue
    const segments = entry.path.split('/')
    targets.push({ scope: name, dir: join(root, ...segments), depth: segments.length, label: `${entry.path}/AGENTS.md` })
  }
  return targets
}

async function confirmOrExit(org: string): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('rness sync writes files; pass --yes to run without a prompt\n')
    return 2
  }
  const { confirm, isCancel } = await import('@clack/prompts')
  const answer = await confirm({ message: `Sync workspace \`${org}\`: clone missing repositories and rewrite the rness blocks?` })
  if (isCancel(answer) || answer !== true) {
    process.stderr.write('cancelled\n')
    return 1
  }
  return null
}

/** `rness sync`: clone missing repositories, write every block (spec 0003 §4). Returns the exit code. */
export async function syncCommand(opts: SyncOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const check = opts.check === true
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const { org, warning } = resolveOrg(manifest, ws.root)
    if (warning !== null) process.stderr.write(`warning: ${warning}\n`)
    if (opts.scope !== undefined && !Object.hasOwn(manifest.scopes, opts.scope)) {
      process.stderr.write(`unknown scope: ${opts.scope}\n`)
      return 1
    }
    if (!check && opts.yes !== true) {
      const refused = await confirmOrExit(org)
      if (refused !== null) return refused
    }

    const lines: string[] = []
    const problems: string[] = []

    try {
      // 1. Repositories: clone what is missing; pull only on request, only clean trees.
      for (const [name, repo] of Object.entries(manifest.repos)) {
        const dir = join(ws.root, 'org', name)
        const label = `org/${name}`
        if (!(await exists(dir))) {
          if (check) {
            lines.push(`missing  ${label} (would clone ${repo.url})`)
            continue
          }
          try {
            await clone(repo.url, dir)
            lines.push(`cloned   ${label}`)
          } catch (e) {
            problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
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
            problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      // 2. Blocks — only where repositories live; a standalone context checkout has no org/.
      if (!(await exists(join(ws.root, 'org')))) {
        lines.push('skipped  blocks (no org/ directory here)')
      } else {
        let differences = 0
        for (const t of targetsOf(manifest, ws.root, opts.scope)) {
          if (!(await exists(t.dir))) {
            lines.push(`skipped  ${t.label} (directory not present)`)
            continue
          }
          // One of the pair symlinked to the other (the common `CLAUDE.md →
          // AGENTS.md`) is left untouched: reading follows the link, and the
          // atomic rename would replace the link with a duplicate of its target.
          const linked = await Promise.all(MANAGED_FILES.map((f) => isSymlink(join(t.dir, f))))
          if (linked.includes(true)) {
            lines.push(`skipped  ${t.label} (symlink)`)
            continue
          }
          const context = await assembleContext({ rnessDir: ws.rnessDir, manifest, scope: t.scope })
          const block = renderBlock({ scope: t.scope, org, depth: t.depth, context, version: VERSION })
          if (block.bytes > BLOCK_SIZE_WARNING) {
            process.stderr.write(`warning: ${t.label}: block is ${Math.round(block.bytes / 1024)} KB (over 32 KB)\n`)
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
        if (check && differences > 0) problems.push(`${differences} block(s) out of date — run rness sync`)
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
