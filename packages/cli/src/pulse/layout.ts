import { STATUSES } from '../core/contract.ts'
import { type StatusTab, statusTone } from '../core/status.ts'

/** The board's shape, from the documents of `rness status` (spec 0017 §3). */
export interface Layout {
  /** The options of `Status`, the All table's: every collection's, together. */
  statuses: string[]
  /** One status field per collection that has statuses (spec 0017 §3). */
  fields: { name: string; statuses: string[] }[]
  types: string[]
  /**
   * One board view per type, its columns the type's own status field, or
   * `Status` (`field: null`) when the type has none. The `Working` table is
   * the adapter's.
   */
  views: { name: string; type: string; field: string | null }[]
}

/** What one document should look like as an item of the board. */
export interface Desired {
  path: string
  title: string
  body: string
  status: string | null
  type: string
  /** The collection's own status field, which carries `status` too; null: it has none. */
  statusField: string | null
}

/** `?` is how `rness status` shows a document without a status. */
const statusOf = (status: string | null): string | null =>
  status === null || status === '?' ? null : status

/** The contract's statuses, in lifecycle order; the board's options follow it. */
const LIFECYCLE = [
  'Draft',
  'Proposed',
  'Ready',
  'Approved',
  'In progress',
  'Blocked',
  'Accepted',
  'Implemented',
  'Completed',
  'Rejected',
  'Superseded',
  'Abandoned',
]

export type OptionColor =
  'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple'

const STATUS_COLORS: Readonly<Record<string, OptionColor>> = {
  Draft: 'gray',
  Proposed: 'blue',
  Ready: 'blue',
  Approved: 'purple',
  'In progress': 'yellow',
  Blocked: 'red',
  Accepted: 'green',
  Implemented: 'green',
  Completed: 'green',
  Rejected: 'gray',
  Superseded: 'gray',
  Abandoned: 'gray',
}
const COLLECTION_COLORS: Readonly<Record<string, OptionColor>> = {
  ADR: 'purple',
  Specs: 'blue',
  Plans: 'orange',
}
const TONE_COLORS = {
  done: 'green',
  dropped: 'gray',
  active: 'yellow',
} as const

/** The colour of a single-select option of the board, by neutral name; the adapter maps it to its provider's. */
export function optionColor(
  field: 'Status' | 'Collection' | 'Agent',
  name: string
): OptionColor {
  if (field === 'Agent') return 'green'
  if (field === 'Collection') return COLLECTION_COLORS[name] ?? 'pink'
  const known = STATUS_COLORS[name]
  if (known !== undefined) return known
  const tone = statusTone(name)
  return tone === 'missing' ? 'gray' : TONE_COLORS[tone]
}

/** The name of a collection's status field: `ADR status`. */
export const statusFieldName = (label: string): string => `${label} status`

const CONTRACT_STATUSES: Readonly<
  Record<string, readonly string[] | undefined>
> = STATUSES

/** The lifecycle's statuses of `found` first, in its order, then the others as found. */
const inLifecycleOrder = (found: Iterable<string>): string[] => {
  const all = new Set(found)
  return [
    ...LIFECYCLE.filter((s) => all.has(s)),
    ...[...all].filter((s) => !LIFECYCLE.includes(s)),
  ]
}

/**
 * The steps of a collection: every status of the contract for one that has
 * a contract, whatever its documents carry (an invalid one is no reason to
 * fail), and the statuses found for a discovered directory.
 */
function collectionStatuses(tab: StatusTab): string[] {
  const found = tab.rows
    .map((row) => statusOf(row.status))
    .filter((s): s is string => s !== null)
  return inLifecycleOrder([...(CONTRACT_STATUSES[tab.name] ?? []), ...found])
}

export function layoutOf(tabs: readonly StatusTab[]): Layout {
  const fields = tabs
    .map((tab) => ({
      name: statusFieldName(tab.label),
      statuses: collectionStatuses(tab),
      label: tab.label,
    }))
    .filter((f) => f.statuses.length > 0)
  return {
    statuses: inLifecycleOrder(fields.flatMap((f) => f.statuses)),
    fields: fields.map(({ name, statuses }) => ({ name, statuses })),
    types: tabs.map((t) => t.label),
    views: tabs.map((t) => ({
      name: t.label,
      type: t.label,
      field: fields.some((f) => f.label === t.label)
        ? statusFieldName(t.label)
        : null,
    })),
  }
}

const hasField = (tab: StatusTab): boolean => collectionStatuses(tab).length > 0

export function desiredOf(tabs: readonly StatusTab[], org: string): Desired[] {
  return tabs.flatMap((tab) =>
    tab.rows.map((row) => ({
      path: row.path,
      title: `${row.id} — ${row.title}`,
      body: `${row.path}\n\nhttps://github.com/${org}/.rness/blob/main/${row.path}`,
      status: statusOf(row.status),
      type: tab.label,
      statusField: hasField(tab) ? statusFieldName(tab.label) : null,
    }))
  )
}
