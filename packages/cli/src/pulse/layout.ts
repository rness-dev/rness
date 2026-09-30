import { STATUSES } from '../core/contract.ts'
import { type StatusTab, statusTone } from '../core/status.ts'
import type { Fields } from '../core/types.ts'
import { headerOf } from './body.ts'
import { type CollectionShape, type FieldType, valuesOf } from './collection.ts'

/** The board's shape, from the documents of `rness status` (spec 0017 §3, kept by spec 0018 §6). */
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
  /**
   * A collection's own fields (spec 0025 §4), in order, a `select` with its
   * options; none on Agent Pulse.
   */
  declared: { name: string; type: FieldType; options: string[] }[]
  /** The labels a collection's project makes, besides `rness`; none on Agent Pulse. */
  labels: string[]
}

/**
 * A collection's own project (spec 0025 §4): what its README declares, each
 * document's front matter by path, and its subdirectories, whose labels a
 * document that left them loses.
 */
export interface Own {
  shape: CollectionShape
  fronts: ReadonlyMap<string, Fields>
  directories?: readonly string[]
}

/** What one document should look like as an item of the board. */
export interface Desired {
  path: string
  title: string
  /** What a new issue carries until pass 2 writes its body: the first line. */
  body: string
  status: string | null
  type: string
  /** The collection's own status field, which carries `status` too; null: it has none. */
  statusField: string | null
  /** `Session history`: the document's `sessions:`, each `agent · id` or `id`, joined by `, `; null: none (spec 0022 §3). */
  sessions: string | null
  /** The collection's declared fields, by name (spec 0025 §4); empty on Agent Pulse. */
  values: Record<string, string | null>
  /** The labels its issue carries besides `rness`; empty on Agent Pulse. */
  labels: string[]
  /** Labels the collection makes that its issue must not carry. */
  unlabels: string[]
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
  Rejected: 'red',
  Superseded: 'yellow',
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
  return inLifecycleOrder([
    ...(Object.hasOwn(CONTRACT_STATUSES, tab.name)
      ? (CONTRACT_STATUSES[tab.name] ?? [])
      : []),
    ...found,
  ])
}

/** The collections that have a status field, by label: the one place that says which do. */
function fieldsOf(
  tabs: readonly StatusTab[]
): Map<string, { name: string; statuses: string[] }> {
  const fields = new Map<string, { name: string; statuses: string[] }>()
  for (const tab of tabs) {
    const statuses = collectionStatuses(tab)
    if (statuses.length > 0)
      fields.set(tab.label, { name: statusFieldName(tab.label), statuses })
  }
  return fields
}

/** Each value once, in the order first met. */
const once = (values: Iterable<string>): string[] => [...new Set(values)]

/**
 * The board's shape: Agent Pulse's from its tabs, as 0.16 made it; a
 * collection's own project (`own`) from its one tab and what its README
 * declares — `Status` alone for its columns, the declared statuses first.
 */
export function layoutOf(
  tabs: readonly StatusTab[],
  own?: { shape: CollectionShape; want: readonly Desired[] }
): Layout {
  if (own === undefined) {
    const fields = fieldsOf(tabs)
    return {
      statuses: inLifecycleOrder(
        [...fields.values()].flatMap((f) => f.statuses)
      ),
      fields: [...fields.values()],
      types: tabs.map((t) => t.label),
      views: tabs.map((t) => ({
        name: t.label,
        type: t.label,
        field: fields.get(t.label)?.name ?? null,
      })),
      declared: [],
      labels: [],
    }
  }
  const { shape, want } = own
  return {
    statuses: once([
      ...(shape.statuses ?? []),
      ...tabs.flatMap(collectionStatuses),
    ]),
    fields: [],
    types: tabs.map((t) => t.label),
    views: tabs.map((t) => ({ name: t.label, type: t.label, field: null })),
    declared: shape.fields.map((f) => ({
      name: f.name,
      type: f.type,
      options:
        f.type === 'select'
          ? once([
              ...f.options,
              ...want
                .map((w) => w.values[f.name])
                .filter((v): v is string => typeof v === 'string'),
            ])
          : [],
    })),
    labels: once(want.flatMap((w) => [...w.labels, ...w.unlabels])),
  }
}

const sessionsOf = (row: StatusTab['rows'][number]): string | null =>
  row.sessions
    ?.map((e) => (e.agent === undefined ? e.id : `${e.agent} · ${e.id}`))
    .join(', ') ?? null

export function desiredOf(
  tabs: readonly StatusTab[],
  org: string,
  own?: Own
): Desired[] {
  const fields = own === undefined ? fieldsOf(tabs) : new Map()
  const wanted = tabs.flatMap((tab) =>
    tab.rows.map((row) => {
      const { values, labels } =
        own === undefined
          ? { values: {}, labels: [] }
          : valuesOf(
              own.shape,
              own.fronts.get(row.path) ?? {},
              row.path.slice(tab.name.length + 1)
            )
      return {
        path: row.path,
        title: `${row.id} — ${row.title}`,
        body: headerOf(row.path, org),
        status: statusOf(row.status),
        type: tab.label,
        statusField: fields.get(tab.label)?.name ?? null,
        sessions: sessionsOf(row),
        values,
        labels,
        unlabels: [] as string[],
      }
    })
  )
  if (own === undefined) return wanted
  // What the collection labels: its documents' labels, then its
  // subdirectories', so a label nobody carries any more is still taken off.
  const made = once([
    ...wanted.flatMap((w) => w.labels),
    ...(own.shape.labels?.kind === 'directory' ? (own.directories ?? []) : []),
  ])
  return wanted.map((w) => ({
    ...w,
    unlabels: made.filter((l) => !w.labels.includes(l)),
  }))
}
