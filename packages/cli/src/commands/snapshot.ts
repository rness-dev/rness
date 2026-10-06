import { type OptionColor, optionColor } from '../board/layout.ts'
import { boardUrl, itemUrl } from '../board/urls.ts'
import type { BoardDeclaration } from '../core/board-declaration.ts'
import { COLLECTIONS } from '../core/context.ts'
import { PULSE, workspaceName } from '../core/manifest.ts'
import { declaredBoard } from '../core/preset-board.ts'
import { currentPreset, presetTemplate } from '../core/presets.ts'
import { safetyNet } from '../core/safety-net.ts'
import {
  type StatusRow,
  type StatusTab,
  plansInProgress,
} from '../core/status.ts'
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

/** A board of `boards`, read whole: its name and its declaration. */
export interface SnapshotBoard {
  name: string
  declaration: BoardDeclaration
}

/** The declared boards, read whole; one whose README cannot be read is left out. */
async function boardsOf(
  manifest: Manifest,
  rnessDir: string
): Promise<SnapshotBoard[]> {
  const boards: SnapshotBoard[] = []
  for (const [name, entry] of Object.entries(manifest.boards ?? {}))
    try {
      boards.push({
        name,
        declaration: await declaredBoard(name, entry, rnessDir),
      })
    } catch {
      // `sync` and `validate` say why; the pane shows the rest.
    }
  return boards
}

/** The board that holds a collection: the one naming it, else one that takes all. */
const holderOf = (
  boards: readonly SnapshotBoard[],
  collection: string
): SnapshotBoard | undefined =>
  boards.find(
    (b) =>
      b.declaration.collections !== 'all' &&
      Object.hasOwn(b.declaration.collections, collection)
  ) ?? boards.find((b) => b.declaration.collections === 'all')

/** The colours of a status nobody declares: Agent Pulse's, as rness ships it. */
const SHIPPED_COLORS = presetTemplate(currentPreset('agent-pulse'), {
  collection: PULSE,
})['colors'] as Record<string, OptionColor>

/**
 * The board of the pane's link: the one that takes all, else the first,
 * among those the provider has; a board not created yet has no link.
 */
function pulseOf(
  org: string | null,
  boards: readonly SnapshotBoard[]
): string | null {
  const created = boards.filter((b) => b.declaration.number !== null)
  const main =
    created.find((b) => b.declaration.collections === 'all') ?? created[0]
  return org === null || main?.declaration.number == null
    ? null
    : boardUrl(org, main.declaration.number)
}

/**
 * The tabs with each row's colour and item, from the board that holds its
 * collection (spec 0031): its declared colour for the status, its item.
 */
export function snapshotTabs(
  tabs: readonly StatusTab[],
  org: string | null,
  boards: readonly SnapshotBoard[]
): SnapshotTab[] {
  return tabs.map((tab) => {
    const holder = holderOf(boards, tab.name)
    const colors = holder?.declaration.colors ?? SHIPPED_COLORS
    return {
      name: tab.name,
      label: tab.label,
      rows: tab.rows.map((row) => ({
        ...row,
        color:
          row.status === null
            ? 'red'
            : (optionColor(colors, 'status', row.status) ?? 'gray'),
        link:
          org === null || holder?.declaration.number == null
            ? null
            : itemUrl(org, holder.declaration.number, row.path),
      })),
    }
  })
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
  const boards = await boardsOf(manifest, ws.rnessDir)
  return {
    version: VERSION,
    workspace: workspaceName(manifest, ws.root),
    scope,
    banner,
    statusLine: statusLine(scope, inProgress, notes),
    inProgress,
    notes: noteLines(notes),
    pulse: pulseOf(manifest.org, boards),
    tabs: snapshotTabs(tabs, manifest.org, boards),
  }
}
