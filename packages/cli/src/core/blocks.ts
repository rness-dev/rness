import { join } from 'node:path'
import { VERSION } from '../version.ts'
import { assembleContext } from './context.ts'
import { parseHeader, renderBlock } from './block.ts'
import { findBlock } from './merge.ts'
import { exists, readOrNull } from './fs.ts'
import type { Manifest } from './types.ts'

export interface CheckBlocksInput {
  root: string
  rnessDir: string
  manifest: Manifest
  org: string
}

export interface CheckBlocksResult {
  problems: string[]
  warnings: string[]
}

/**
 * Compare every present block with a fresh render (spec 0003 §4.6): a
 * different hash is a problem, a missing block only a warning, and nothing
 * is checked where no `org/` directory exists (a standalone context checkout).
 */
export async function checkBlocks({ root, rnessDir, manifest, org }: CheckBlocksInput): Promise<CheckBlocksResult> {
  const problems: string[] = []
  const warnings: string[] = []
  if (!(await exists(join(root, 'org')))) return { problems, warnings }

  const targets: Array<{ scope: string | null; dir: string; depth: number; label: string }> = [
    { scope: null, dir: root, depth: 0, label: 'AGENTS.md' },
  ]
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    const segments = entry.path.split('/')
    targets.push({ scope: name, dir: join(root, ...segments), depth: segments.length, label: `${entry.path}/AGENTS.md` })
  }

  for (const t of targets) {
    if (!(await exists(t.dir))) continue
    const text = await readOrNull(join(t.dir, 'AGENTS.md'))
    const lines = text === null ? [] : text.split(/\r?\n/)
    const found = findBlock(lines)
    if (found.kind === 'none') {
      warnings.push(`${t.label}: no rness block yet (run rness sync)`)
      continue
    }
    if (found.kind === 'error') {
      problems.push(`${t.label}: ${found.message}`)
      continue
    }
    const header = parseHeader(lines[found.begin + 1] ?? '')
    const context = await assembleContext({ rnessDir, manifest, scope: t.scope })
    const fresh = renderBlock({ scope: t.scope, org, depth: t.depth, context, version: VERSION })
    if (header === null || header.hash !== fresh.hash) {
      problems.push(`${t.label}: stale rness block (run rness sync)`)
    }
  }
  return { problems, warnings }
}
