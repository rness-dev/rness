import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { contractOf } from './board-declaration.ts'
import { readmeDeclarations } from './board-migration.ts'
import { containedPath } from './contained.ts'
import type { Manifest } from './types.ts'

/** Directories of `.rness/` that are never a collection: not documents with a status. */
const NEVER = new Set(['standards', 'skills', 'node_modules'])

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * What `validate` says of the boards against the files (spec 0031 §5, §6):
 * a board `rness.json` refused; a collection that is no directory of
 * `.rness/`, or one never a collection; a collection on two boards; a
 * `readme` or `updates` not there or out of `.rness`; a README that still
 * declares what `rness.json` declares now. One line each.
 */
export async function checkBoards(
  rnessDir: string,
  manifest: Manifest
): Promise<string[]> {
  const problems = (manifest.refused ?? []).map((r) => r.reason)
  const holders = new Map<string, string>()
  const all: string[] = []
  for (const [name, entry] of Object.entries(manifest.projects ?? {})) {
    if (typeof entry === 'number') continue
    const at = `projects.${name}`
    if (entry.collections === 'all') all.push(name)
    else
      for (const collection of Object.keys(entry.collections)) {
        const key = `"${at}.collections.${collection}"`
        if (NEVER.has(collection))
          problems.push(
            `${key} is no collection: ${[...NEVER].join(', ')} never are`
          )
        else if (
          contractOf(collection) === undefined &&
          !(await isDirectory(join(rnessDir, collection)))
        )
          problems.push(`${key} names no directory of .rness`)
        const other = holders.get(collection)
        if (other !== undefined)
          problems.push(
            `${key} is on ${other} too: a collection is on one board at most`
          )
        else holders.set(collection, name)
        for (const k of Object.keys(
          await readmeDeclarations(rnessDir, collection).catch(() => ({}))
        ))
          problems.push(
            `${collection}/README.md: "${k}" is declared in rness.json now — rness sync moves it`
          )
      }
    for (const key of ['readme', 'updates'] as const) {
      const path = entry[key]
      if (path === null) continue
      try {
        await containedPath(rnessDir, path)
      } catch (e) {
        problems.push(
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? `"${at}.${key}" names ${path}, which is not there`
            : `"${at}.${key}": ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }
  if (all.length > 1)
    problems.push(
      `${all.map((n) => `"projects.${n}"`).join(' and ')} each take every collection ("all"): a collection is on one board at most`
    )
  return problems
}
