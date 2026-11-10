import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { repositories } from './manifest.ts'
import { policiesFor } from './policy.ts'
import { type Refusal, readRefusals } from './refusals.ts'
import type { StatusTab } from './status.ts'
import type { Manifest, Workspace } from './types.ts'

/**
 * The `Policies` tab (spec 0040 §6): every policy of the workspace with its
 * scope and status, and under it the refusals of the last 7 days across the
 * clones, grouped by policy. It is a tab of `rness status`, not a board:
 * `policy` is never a card.
 */

/** How far back the tab looks. */
export const RECENT_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/** `2026-11-03 14:02 UTC`: the minute is enough for "when", and says its zone. */
const minute = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** The clones the refusals are read from: those of `org/` that exist, then `.rness`. */
async function clonesOf(ws: Workspace, manifest: Manifest): Promise<string[]> {
  const dirs = [
    ...repositories(manifest).map((r) => resolve(ws.root, ...r.dir.split('/'))),
    ws.rnessDir,
  ]
  const present: string[] = []
  for (const dir of dirs)
    if ((await stat(dir).catch(() => null))?.isDirectory() === true)
      present.push(dir)
  return present
}

/** The lines under the rows: one when there is no refusal, else a heading and a line per policy. */
export function refusalLines(refusals: readonly Refusal[]): string[] {
  if (refusals.length === 0)
    return [`No refusal in the last ${RECENT_DAYS} days.`]
  const byPolicy = new Map<string, { count: number; last: number }>()
  for (const r of refusals) {
    const at = Date.parse(r.time)
    const seen = byPolicy.get(r.policy)
    byPolicy.set(r.policy, {
      count: (seen?.count ?? 0) + 1,
      last: Math.max(seen?.last ?? at, at),
    })
  }
  return [
    `Refusals of the last ${RECENT_DAYS} days`,
    ...[...byPolicy]
      .sort(
        ([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0)
      )
      .map(
        ([policy, { count, last }]) =>
          `${policy}: ${count} refusal${count === 1 ? '' : 's'}, last ${minute(last)}`
      ),
  ]
}

export async function policiesTab(
  ws: Workspace,
  manifest: Manifest,
  now: number = Date.now()
): Promise<StatusTab> {
  const policies = await policiesFor(
    { rnessDir: ws.rnessDir, manifest },
    Object.keys(manifest.scopes),
    {
      withDisabled: true,
    }
  ).catch(() => [])
  const refusals: Refusal[] = []
  for (const clone of await clonesOf(ws, manifest))
    refusals.push(
      ...(await readRefusals(clone, { since: now - RECENT_DAYS * DAY }))
    )
  return {
    name: 'policy',
    label: 'Policies',
    titleHeading: 'Scope',
    rows: policies
      .map((p) => ({
        id: p.name,
        title: p.scope ?? 'global',
        status: p.status,
        path: p.rel,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    notes: refusalLines(refusals),
  }
}
