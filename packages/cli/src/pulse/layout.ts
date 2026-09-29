import type { StatusTab } from '../core/status.ts'

/** The board's shape, from the documents of `rness status` (spec 0017 §3). */
export interface Layout {
  statuses: string[]
  types: string[]
  /** One board view per type; the `Working` table is the adapter's. */
  views: { name: string; type: string }[]
}

/** What one document should look like as an item of the board. */
export interface Desired {
  path: string
  title: string
  body: string
  status: string | null
  type: string
}

/** `?` is how `rness status` shows a document without a status. */
const statusOf = (status: string | null): string | null =>
  status === null || status === '?' ? null : status

export function layoutOf(tabs: readonly StatusTab[]): Layout {
  const statuses = new Set<string>()
  for (const tab of tabs)
    for (const row of tab.rows) {
      const status = statusOf(row.status)
      if (status !== null) statuses.add(status)
    }
  return {
    statuses: [...statuses],
    types: tabs.map((t) => t.label),
    views: tabs.map((t) => ({ name: t.label, type: t.label })),
  }
}

export function desiredOf(tabs: readonly StatusTab[], org: string): Desired[] {
  return tabs.flatMap((tab) =>
    tab.rows.map((row) => ({
      path: row.path,
      title: `${row.id} — ${row.title}`,
      body: `${row.path}\n\nhttps://github.com/${org}/.rness/blob/main/${row.path}`,
      status: statusOf(row.status),
      type: tab.label,
    }))
  )
}
