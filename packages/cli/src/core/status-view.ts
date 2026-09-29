import { type StatusTab, type StatusTone, statusTone } from './status.ts'

/**
 * The view of `rness status` in a terminal (spec 0016 §2.2), as pure
 * functions: a key moves the view, a view at a size is a list of lines. The
 * terminal — alternate screen, raw mode, keypresses — is the command's.
 */

export interface View {
  /** The active tab. */
  tab: number
  /** The first row shown. */
  top: number
}

export type Key =
  | 'left'
  | 'right'
  | 'tab'
  | 'backtab'
  | 'up'
  | 'down'
  | 'pageup'
  | 'pagedown'
  | 'home'
  | 'end'

/** How text is styled: ANSI in a terminal, the identity in tests. */
export interface Look {
  bold(text: string): string
  dim(text: string): string
  inverse(text: string): string
  tone(tone: StatusTone, text: string): string
}

/** Lines around the rows: the name, the tabs, a rule — a rule, the footer. */
const FRAME = 5

/** The rows a terminal of `height` lines shows: one at least. */
export function pageSize(height: number): number {
  return Math.max(1, height - FRAME)
}

function lastTop(tab: StatusTab | undefined, page: number): number {
  return Math.max(0, (tab?.rows.length ?? 0) - page)
}

/** `view` moved by `key`: tabs wrap and start at the top; scrolling stops at the ends. */
export function press(
  view: View,
  key: Key,
  tabs: readonly StatusTab[],
  page: number
): View {
  const n = tabs.length
  if (key === 'right' || key === 'tab')
    return { tab: (view.tab + 1) % n, top: 0 }
  if (key === 'left' || key === 'backtab')
    return { tab: (view.tab - 1 + n) % n, top: 0 }
  const moved: Record<string, number> = {
    up: view.top - 1,
    down: view.top + 1,
    pageup: view.top - page,
    pagedown: view.top + page,
    home: 0,
    end: Number.MAX_SAFE_INTEGER,
  }
  const top = moved[key] ?? view.top
  return {
    tab: view.tab,
    top: Math.min(Math.max(0, top), lastTop(tabs[view.tab], page)),
  }
}

/** The view kept in range after a resize changed the page. */
export function clampView(
  view: View,
  tabs: readonly StatusTab[],
  page: number
): View {
  return {
    tab: view.tab,
    top: Math.min(view.top, lastTop(tabs[view.tab], page)),
  }
}

// --- rendering ---------------------------------------------------------------

/** A piece of a line and how to style it once cut. */
type Segment = readonly [text: string, style?: (text: string) => string]

const width = (text: string): number => [...text].length

/** `text` in `n` columns: cut with `…` when longer, padded when shorter. */
function fit(text: string, n: number): string {
  if (n <= 0) return ''
  const chars = [...text]
  if (chars.length <= n) return text + ' '.repeat(n - chars.length)
  return `${chars
    .slice(0, n - 1)
    .join('')
    .trimEnd()}…`.padEnd(n)
}

/** The segments cut to `columns`, then styled: a style never spans a cut. */
function line(segments: readonly Segment[], columns: number): string {
  let left = columns
  let out = ''
  for (const [text, style] of segments) {
    if (left <= 0) break
    const chars = [...text]
    const kept = chars.length <= left ? text : chars.slice(0, left).join('')
    left -= width(kept)
    out += style === undefined ? kept : style(kept)
  }
  return out
}

function tabBar(
  tabs: readonly StatusTab[],
  active: number,
  look: Look
): Segment[] {
  const segments: Segment[] = [[' ']]
  tabs.forEach((tab, i) => {
    if (i > 0) segments.push([' '])
    const label = ` ${tab.label} (${tab.rows.length}) `
    segments.push(i === active ? [label, look.inverse] : [label])
  })
  return segments
}

function rowLines(
  tab: StatusTab | undefined,
  top: number,
  page: number,
  columns: number,
  look: Look
): Segment[][] {
  if (tab === undefined || tab.rows.length === 0)
    return [[['  Nothing here yet.', look.dim]]]
  const idWidth = Math.max(...tab.rows.map((r) => width(r.id)))
  const statusWidth = Math.max(...tab.rows.map((r) => width(r.status ?? '?')))
  // Two spaces before each column, one free at the right edge.
  const titleWidth = Math.max(
    1,
    columns - 1 - (2 + idWidth + 2 + 2 + statusWidth)
  )
  return tab.rows
    .slice(top, top + page)
    .map((row) => [
      ['  '],
      [row.id.padEnd(idWidth)],
      ['  '],
      [fit(row.title, titleWidth)],
      ['  '],
      [
        (row.status ?? '?').padEnd(statusWidth),
        (text) => look.tone(statusTone(row.status), text),
      ],
    ])
}

/** The footer: what is out of sight, then the keys. */
function footer(above: number, below: number): string {
  const parts = [
    ...(above > 0 ? [`↑ ${above} above`] : []),
    ...(below > 0 ? [`↓ ${below} more`] : []),
    '←/→ tab · ↑/↓ scroll · q close',
  ]
  return `  ${parts.join(' · ')}`
}

/** The whole screen for `view`, `columns` wide and at most `height` lines. */
export function renderView(
  view: View,
  tabs: readonly StatusTab[],
  workspace: string,
  columns: number,
  height: number,
  look: Look
): string[] {
  const page = pageSize(height)
  const tab = tabs[view.tab]
  const rule: Segment[] = [[` ${'─'.repeat(Math.max(0, columns - 2))}`]]
  const rows = rowLines(tab, view.top, page, columns, look)
  const shown = Math.min(page, rows.length)
  const total = tab?.rows.length ?? 0
  const lines: Segment[][] = [
    [[` rness · ${workspace}`, look.bold]],
    tabBar(tabs, view.tab, look),
    rule,
    ...rows,
    ...Array.from({ length: page - shown }, (): Segment[] => [['']]),
    rule,
    [[footer(view.top, Math.max(0, total - view.top - page)), look.dim]],
  ]
  return lines.slice(0, Math.max(0, height)).map((l) => line(l, columns))
}
