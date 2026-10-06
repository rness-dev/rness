import { COLLECTIONS } from '../core/context.ts'
import { PULSE, workspaceName } from '../core/manifest.ts'
import { safetyNet } from '../core/safety-net.ts'
import {
  type StatusRow,
  type StatusTab,
  plansInProgress,
} from '../core/status.ts'
import { count } from '../core/style.ts'
import type { CollectionName, Manifest, Workspace } from '../core/types.ts'
import { scopeSummary } from '../mcp/tools.ts'
import { type OptionColor, optionColor } from '../pulse/layout.ts'
import { boardUrl, itemUrl } from '../pulse/urls.ts'
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
 * The workspace's label in the prompt footer (spec 0029 §3.3, plan 0044):
 * `rness`, the scope, the plans in progress, and the notes to act on,
 * counted. A note's indented detail lines do not count. The mod adds it to
 * the session modes (`focus`, `memory paused`), which carry no plugin name,
 * so the word `rness` is part of it.
 */
export function statusLine(
  scope: string | null,
  inProgress: readonly string[],
  notes: readonly string[]
): string {
  const acting = notes.filter((n) => !n.startsWith(' ')).length
  return `rness · ${scope ?? 'global'} · ${inProgress.length} in progress${acting > 0 ? ` · ⚠ ${acting}` : ''}`
}

/** A row of a tab as the mod draws it: the document, its colour, its item. */
export interface SnapshotRow extends StatusRow {
  /**
   * The colour of its status on Agent Pulse (spec 0017 §3: `yellow` for
   * `In progress`, `green` for `Completed`, …), by the board's neutral name;
   * `red` without a status, as the full-screen view marks `?`.
   */
  color: OptionColor
  /**
   * The document's item on Agent Pulse: the board filtered on its `Path`.
   * Null while the workspace declares no pulse.
   */
  link: string | null
}

export interface SnapshotTab {
  name: string
  label: string
  rows: SnapshotRow[]
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
  /** Agent Pulse, the board (spec 0017); null while none is declared. */
  pulse: string | null
  tabs: SnapshotTab[]
}

/** The pulse's board, when `rness.json` declares one and names the organization. */
function pulseOf(manifest: Manifest): { org: string; project: number } | null {
  const project = manifest.projects?.[PULSE]
  return manifest.org === null || project === undefined
    ? null
    : { org: manifest.org, project }
}

/** The tabs with each row's colour and item, as Agent Pulse has them. */
export function snapshotTabs(
  tabs: readonly StatusTab[],
  pulse: { org: string; project: number } | null
): SnapshotTab[] {
  return tabs.map((tab) => ({
    name: tab.name,
    label: tab.label,
    rows: tab.rows.map((row) => ({
      ...row,
      color: row.status === null ? 'red' : optionColor('Status', row.status),
      link: pulse === null ? null : itemUrl(pulse.org, pulse.project, row.path),
    })),
  }))
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
  const pulse = pulseOf(manifest)
  return {
    version: VERSION,
    workspace: workspaceName(manifest, ws.root),
    scope,
    banner,
    statusLine: statusLine(scope, inProgress, notes),
    inProgress,
    notes: noteLines(notes),
    pulse: pulse === null ? null : boardUrl(pulse.org, pulse.project),
    tabs: snapshotTabs(tabs, pulse),
  }
}
