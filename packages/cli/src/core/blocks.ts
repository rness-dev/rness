import { join } from 'node:path'

import { isCurrentBlock, renderBlock } from './block.ts'
import { assembleContext } from './context.ts'
import { exists, readOrNull } from './fs.ts'
import { findBlock } from './merge.ts'
import type { Manifest } from './types.ts'

export interface CheckBlocksInput {
  root: string
  rnessDir: string
  manifest: Manifest
  org: string
}

/**
 * What a target's `AGENTS.md` turned out to be. `stale` and `malformed` are
 * problems, `missing-dir` and `no-block` only warnings; `current` says
 * nothing and carries no message.
 */
export type BlockStatus =
  'current' | 'stale' | 'malformed' | 'missing-dir' | 'no-block'

export interface BlockCheck {
  label: string
  status: BlockStatus
  /** The line the plain look prints; null when the block is current. */
  message: string | null
}

export interface CheckBlocksResult {
  problems: string[]
  warnings: string[]
  /** One entry per target, in the order they were checked (spec 0007 §5c). */
  checks: BlockCheck[]
}

const PROBLEM: ReadonlySet<BlockStatus> = new Set(['stale', 'malformed'])

/**
 * Compare every present block with a fresh render (spec 0003 §4.6): a
 * different hash is a problem, a missing block only a warning, and nothing
 * is checked where no `org/` directory exists (a standalone context checkout).
 */
export async function checkBlocks({
  root,
  rnessDir,
  manifest,
  org,
}: CheckBlocksInput): Promise<CheckBlocksResult> {
  const checks: BlockCheck[] = []
  const note = (
    label: string,
    status: BlockStatus,
    message: string | null = null
  ): void => {
    checks.push({ label, status, message })
  }
  // The two flat arrays are a view over `checks`, so a line printed today
  // cannot drift from what the terminal renders.
  const derive = (): CheckBlocksResult => ({
    problems: checks
      .filter((c) => PROBLEM.has(c.status) && c.message !== null)
      .map((c) => c.message as string),
    warnings: checks
      .filter((c) => !PROBLEM.has(c.status) && c.message !== null)
      .map((c) => c.message as string),
    checks,
  })
  if (!(await exists(join(root, 'org')))) return derive()

  const targets: Array<{
    scope: string | null
    dir: string
    depth: number
    label: string
  }> = [{ scope: null, dir: root, depth: 0, label: 'AGENTS.md' }]
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    const segments = entry.path.split('/')
    targets.push({
      scope: name,
      dir: join(root, ...segments),
      depth: segments.length,
      label: `${entry.path}/AGENTS.md`,
    })
  }

  for (const t of targets) {
    if (!(await exists(t.dir))) {
      note(
        t.label,
        'missing-dir',
        `${t.label}: directory not present, block not checked`
      )
      continue
    }
    const text = await readOrNull(join(t.dir, 'AGENTS.md'))
    const lines = text === null ? [] : text.split(/\r?\n/)
    const found = findBlock(lines)
    if (found.kind === 'none') {
      note(
        t.label,
        'no-block',
        `${t.label}: no rness block yet (run rness sync)`
      )
      continue
    }
    if (found.kind === 'error') {
      note(t.label, 'malformed', `${t.label}: ${found.message}`)
      continue
    }
    const context = await assembleContext({
      rnessDir,
      manifest,
      scope: t.scope,
    })
    const fresh = renderBlock({
      scope: t.scope,
      org,
      depth: t.depth,
      context,
    })
    // Two ways to be stale: the header no longer matches a fresh render, or the
    // body no longer matches its own header — a hand edit inside the block.
    if (isCurrentBlock(lines.slice(found.begin, found.end + 1), fresh.hash))
      note(t.label, 'current')
    else
      note(t.label, 'stale', `${t.label}: stale rness block (run rness sync)`)
  }
  return derive()
}
