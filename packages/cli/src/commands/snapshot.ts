import { COLLECTIONS } from '../core/context.ts'
import { workspaceName } from '../core/manifest.ts'
import { safetyNet } from '../core/safety-net.ts'
import { type StatusTab, plansInProgress } from '../core/status.ts'
import { count } from '../core/style.ts'
import type { CollectionName, Manifest, Workspace } from '../core/types.ts'
import { scopeSummary } from '../mcp/tools.ts'
import { VERSION } from '../version.ts'

/**
 * What a Claude Code session shows of the workspace: the session-start
 * hook's banner (spec 0015 §3), and the snapshot `rness status --json`
 * hands the plugin's mod (spec 0029 §3.2). Shared by both commands so the
 * two say the same words.
 */

const NOUNS: Record<CollectionName, [string, string]> = {
  standards: ['standard', 'standards'],
  adr: ['decision', 'decisions'],
  specs: ['specification', 'specifications'],
  plans: ['plan', 'plans'],
  skills: ['skill', 'skills'],
}

/** The banner and the scope's summary for the model. */
export async function scopeBanner(
  ws: Workspace,
  manifest: Manifest,
  scope: string | null
): Promise<{ banner: string; lines: string[] }> {
  const summary = await scopeSummary(ws, manifest, scope)
  const counts = COLLECTIONS.flatMap((c) => {
    const n = summary.counts[c]
    return n === undefined ? [] : [count(n, NOUNS[c])]
  })
  const banner = `rness ${VERSION} · ${workspaceName(manifest, ws.root)} · ${scope === null ? 'global scope' : `scope ${scope}`} — ${counts.length === 0 ? 'nothing applies yet' : counts.join(', ')}`
  return { banner, lines: summary.lines }
}

/** The safety net's notes, each a line of its own, as the hooks print them. */
export const noteLines = (notes: readonly string[]): string[] =>
  notes.map((n) => `rness: ${n}`)

/**
 * The status line entry (spec 0029 §3.3): the scope, the plans in progress,
 * and the notes to act on, counted. A note's indented detail lines do not
 * count.
 */
export function statusLine(
  scope: string | null,
  inProgress: readonly string[],
  notes: readonly string[]
): string {
  const acting = notes.filter((n) => !n.startsWith(' ')).length
  return `rness · ${scope ?? 'global'} · ${inProgress.length} in progress${acting > 0 ? ` · ⚠ ${acting}` : ''}`
}

/** What `rness status --json` prints: everything the mod draws, worded here. */
export interface StatusSnapshot {
  version: string
  workspace: string
  scope: string | null
  banner: string
  statusLine: string
  /** The scope's plans In progress, `.rness/`-relative. */
  inProgress: string[]
  /** The safety net's lines, `rness: `-prefixed. */
  notes: string[]
  tabs: StatusTab[]
}

export async function statusSnapshot(
  ws: Workspace,
  manifest: Manifest,
  scope: string | null,
  tabs: StatusTab[]
): Promise<StatusSnapshot> {
  const { banner } = await scopeBanner(ws, manifest, scope)
  const inProgress = await plansInProgress(ws, manifest, scope)
  const notes = await safetyNet(ws, manifest)
  return {
    version: VERSION,
    workspace: workspaceName(manifest, ws.root),
    scope,
    banner,
    statusLine: statusLine(scope, inProgress, notes),
    inProgress,
    notes: noteLines(notes),
    tabs,
  }
}
