import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { collectMarkdown } from './collect.ts'
import { documentDate, documentNumber, documentTitle } from './documents.ts'
import type { MarkdownItem } from './types.ts'

/** One document of a tab (spec 0016 §2.1). */
export interface StatusRow {
  /** `NNNN`, else `YYYY-MM-DD`, else the file name. */
  id: string
  title: string
  /** As written; null when missing or when the front matter does not parse. */
  status: string | null
  /** Relative to `.rness/`. */
  path: string
  /**
   * The Claude Code sessions that wrote or changed it, oldest first, each
   * once (spec 0020 §3.1, 0022 §3); absent when it records none.
   */
  sessions?: SessionEntry[]
}

/** A session in `sessions:`: its id, and the agent it ran as when recorded. */
export interface SessionEntry {
  id: string
  agent?: string
}

export interface StatusTab {
  /** The directory. */
  name: string
  label: string
  rows: StatusRow[]
}

/** The contract's collections that carry a status: always shown. */
const FIXED: readonly (readonly [string, string])[] = [
  ['adr', 'ADR'],
  ['specs', 'Specs'],
  ['plans', 'Plans'],
]
/** Never a discovered tab: the fixed ones, the contract's other collections, dependencies. */
const NOT_DISCOVERED: ReadonlySet<string> = new Set([
  ...FIXED.map(([name]) => name),
  'standards',
  'skills',
  'node_modules',
])
const TEMPLATE = 'adr/0000-template.md'

function statusOf(item: MarkdownItem): string | null {
  const status = item.fields?.['status']
  return typeof status === 'string' && status !== '' ? status : null
}

/**
 * `sessions:` as its entries: `{ id, agent }`, or a bare id as 0.15 wrote
 * it. Anything else is left out, and an id listed twice keeps its first
 * entry (spec 0022 §3).
 */
function sessionsOf(item: MarkdownItem): SessionEntry[] {
  const listed = item.fields?.['sessions']
  if (!Array.isArray(listed)) return []
  const entries = new Map<string, SessionEntry>()
  for (const entry of listed) {
    const fields =
      typeof entry === 'string'
        ? { id: entry }
        : entry !== null && typeof entry === 'object'
          ? (entry as Record<string, unknown>)
          : {}
    const { id, agent } = fields
    if (typeof id !== 'string' || id === '' || entries.has(id)) continue
    entries.set(
      id,
      typeof agent === 'string' && agent !== '' ? { id, agent } : { id }
    )
  }
  return [...entries.values()]
}

function rowOf(dir: string, item: MarkdownItem): StatusRow {
  const base = posix.basename(item.rel, '.md')
  const date = documentDate(item.rel)
  const number = documentNumber(item.rel)
  const sessions = sessionsOf(item)
  return {
    id: date ?? number ?? base,
    title: documentTitle(item.title ?? base, number),
    status: statusOf(item),
    path: `${dir}/${item.rel}`,
    ...(sessions.length > 0 ? { sessions } : {}),
  }
}

/** Newest first: file names descending, then paths. */
function newestFirst(a: StatusRow, b: StatusRow): number {
  const [x, y] = [posix.basename(a.path), posix.basename(b.path)]
  if (x !== y) return x < y ? 1 : -1
  return a.path < b.path ? 1 : a.path > b.path ? -1 : 0
}

/**
 * The tabs of `rness status` (spec 0016 §2.1): ADR, Specs and Plans, then
 * every other top-level directory of `.rness/` holding a Markdown file
 * whose front matter has a status — alphabetically, with those files only.
 */
export async function statusTabs(rnessDir: string): Promise<StatusTab[]> {
  const tabs: StatusTab[] = []
  for (const [name, label] of FIXED) {
    const rows = (await collectMarkdown(join(rnessDir, name)))
      .map((item) => rowOf(name, item))
      .filter((row) => row.path !== TEMPLATE)
    tabs.push({ name, label, rows: rows.sort(newestFirst) })
  }
  const entries = await readdir(rnessDir, { withFileTypes: true }).catch(
    () => []
  )
  const discovered = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        !NOT_DISCOVERED.has(e.name)
    )
    .map((e) => e.name)
    .sort()
  for (const name of discovered) {
    const rows = (await collectMarkdown(join(rnessDir, name)))
      .filter((item) => statusOf(item) !== null)
      .map((item) => rowOf(name, item))
    if (rows.length > 0)
      tabs.push({
        name,
        label: `${name.charAt(0).toUpperCase()}${name.slice(1)}`,
        rows: rows.sort(newestFirst),
      })
  }
  return tabs
}

/** A tab by its name or label, whatever the case. */
export function findTab(
  tabs: readonly StatusTab[],
  wanted: string
): StatusTab | undefined {
  const w = wanted.toLowerCase()
  return tabs.find(
    (tab) => tab.name.toLowerCase() === w || tab.label.toLowerCase() === w
  )
}

export type StatusTone = 'done' | 'dropped' | 'missing' | 'active'

const DONE: ReadonlySet<string> = new Set([
  'accepted',
  'implemented',
  'completed',
  'published',
])
const DROPPED: ReadonlySet<string> = new Set([
  'rejected',
  'superseded',
  'abandoned',
])

/** What a status says at a glance (spec 0016 §2.1), whatever its case. */
export function statusTone(status: string | null): StatusTone {
  if (status === null) return 'missing'
  const s = status.toLowerCase()
  if (DONE.has(s)) return 'done'
  if (DROPPED.has(s)) return 'dropped'
  return 'active'
}

const cell = (text: string): string => text.replaceAll('|', '\\|')

/** The tabs as Markdown, off a terminal (spec 0016 §2.3). */
export function statusMarkdown(
  workspace: string,
  tabs: readonly StatusTab[]
): string {
  const out = [`${workspace} · status`, '']
  for (const tab of tabs) {
    out.push(`## ${tab.label} (${tab.rows.length})`, '')
    if (tab.rows.length === 0) {
      out.push('_Nothing yet._', '')
      continue
    }
    out.push('| Id | Title | Status |', '| --- | --- | --- |')
    for (const row of tab.rows)
      out.push(
        `| ${cell(row.id)} | ${cell(row.title)} | ${cell(row.status ?? '?')} |`
      )
    out.push('')
  }
  return out.join('\n')
}
