import type {
  BoardDeclaration,
  FieldDeclaration,
  OptionColor,
  ViewLayout,
} from '../core/board-declaration.ts'
import { contractOf } from '../core/board-declaration.ts'
import { labelOf } from '../core/presets.ts'
import { type StatusTab, statusTone } from '../core/status.ts'
import type { Fields } from '../core/types.ts'
import { headerOf } from './body.ts'
import { type DeclaredField, valuesOf } from './collection.ts'

export type { OptionColor } from '../core/board-declaration.ts'

/**
 * A board's shape for the adapter, built from its declaration (spec 0031)
 * and the documents of `.rness/`: the options of `Status`, the fields to
 * make, the views and the labels. The adapter adds the engine's own: `Path`
 * and the label `rness` (spec 0031 §1).
 */
export interface Layout {
  /** The options of `Status`, in order. */
  statuses: string[]
  /** The fields besides `Status` and `Path`, in the order they are made. */
  fields: LayoutField[]
  views: LayoutView[]
  /** The labels the board's documents carry besides `rness`. */
  labels: string[]
  /** Declared colours by option name; an option not named takes its kind's. */
  colors: Readonly<Record<string, OptionColor>>
}

/**
 * A field to make. A select's `kind` says how its options are coloured: a
 * status as its tone, a collection pink, a declared option keeps its own.
 */
export type LayoutField =
  | {
      name: string
      type: 'select'
      kind: 'status' | 'collection' | 'declared'
      options: string[]
      /** Its options kept in this order, those GitHub has besides after. */
      reorder: boolean
    }
  | { name: string; type: 'text' | 'date' | 'number' }

export interface LayoutView {
  name: string
  layout: ViewLayout
  /** The view's filter as GitHub keeps it; null: none. */
  filter: string | null
  /** A board's columns; `Status` unless a collection's or a declared select. */
  columns: string | null
  /** A table's fields, in order; null: GitHub's default. */
  fields: string[] | null
}

/** One collection of a board, for this workspace's documents. */
export interface BoardCollection {
  /** The directory. */
  name: string
  label: string
  /** Its steps, in order: the options its field and the board's `Status` take. */
  statuses: string[]
  field: string | null
  tab: StatusTab
}

/** What one document should look like as an item of the board. */
export interface Desired {
  path: string
  title: string
  /** What a new issue carries until pass 2 writes its body: the first line. */
  body: string
  status: string | null
  /** The collection's own status field, which carries `status` too; null: it has none. */
  statusField: string | null
  /**
   * Every declared field the sync writes, by name: all but those from
   * `$agent` and `$session`, which a session's marks write (spec 0017 §5).
   */
  values: Record<string, string | null>
  /** The labels its issue carries besides `rness`. */
  labels: string[]
  /** Labels the board makes that its issue must not carry. */
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

const TONE_COLORS = {
  done: 'green',
  dropped: 'gray',
  active: 'yellow',
} as const

/**
 * The colour of a select's option: as declared, else by its kind — a status
 * by its tone (a status nobody declared still reads done, dropped or under
 * way), a collection pink. Null: a declared option keeps the colour it has.
 */
export function optionColor(
  colors: Readonly<Record<string, OptionColor>>,
  kind: 'status' | 'collection' | 'declared',
  name: string
): OptionColor | null {
  const declared = colors[name]
  if (declared !== undefined) return declared
  if (kind === 'collection') return 'pink'
  if (kind === 'declared') return null
  const tone = statusTone(name)
  return tone === 'missing' ? 'gray' : TONE_COLORS[tone]
}

/** The name of a collection's status field under `"collections": "all"`: `ADR status`. */
export const statusFieldName = (label: string): string => `${label} status`

/** The lifecycle's statuses of `found` first, in its order, then the others as found. */
const inLifecycleOrder = (found: Iterable<string>): string[] => {
  const all = new Set(found)
  return [
    ...LIFECYCLE.filter((s) => all.has(s)),
    ...[...all].filter((s) => !LIFECYCLE.includes(s)),
  ]
}

/** Each value once, in the order first met. */
const once = (values: Iterable<string>): string[] => [...new Set(values)]

const foundIn = (tab: StatusTab): string[] =>
  tab.rows
    .map((row) => statusOf(row.status))
    .filter((s): s is string => s !== null)

/** The tab of a directory, empty when it has no document yet. */
const tabOf = (tabs: readonly StatusTab[], name: string): StatusTab =>
  tabs.find((t) => t.name === name) ?? { name, label: labelOf(name), rows: [] }

/**
 * A board's collections in this workspace (spec 0031 §2.3), in order.
 * `"all"`: `adr`, `specs` and `plans` with the contract's statuses, then
 * every other directory `rness status` finds with those found — but a
 * collection another board holds (`owned`). Each has its status field.
 */
export function collectionsOf(
  board: BoardDeclaration,
  tabs: readonly StatusTab[],
  owned: (collection: string) => boolean = () => false
): BoardCollection[] {
  if (board.collections === 'all')
    return tabs
      .filter((t) => !owned(t.name))
      .map((tab) => {
        const statuses = inLifecycleOrder([
          ...(contractOf(tab.name) ?? []),
          ...foundIn(tab),
        ])
        // A directory whose documents carry no status yet: columns by Status.
        return {
          name: tab.name,
          label: tab.label,
          statuses,
          field: statuses.length > 0 ? statusFieldName(tab.label) : null,
          tab,
        }
      })
  return Object.entries(board.collections).map(([name, c]) => {
    const tab = tabOf(tabs, name)
    const found = foundIn(tab)
    return {
      name,
      label: c.label,
      statuses:
        c.statuses === 'contract'
          ? inLifecycleOrder([...(contractOf(name) ?? []), ...found])
          : c.statuses === 'found'
            ? inLifecycleOrder(found)
            : once([...c.statuses, ...found]),
      field: c.field,
      tab: { ...tab, label: c.label },
    }
  })
}

/** The field a board's `$collection` select is: what a collection's view filters by. */
const collectionField = (board: BoardDeclaration): string | null =>
  Object.entries(board.fields).find(
    ([, f]) => f.type === 'select' && f.from.includes('$collection')
  )?.[0] ?? null

/** A view of one collection's cards: `collection:"ADR"`, the field's name in lowercase. */
export const collectionFilter = (field: string, label: string): string =>
  `${field.toLowerCase()}:"${label}"`

/**
 * The declared views, and under `"collections": "all"` one board view for
 * each collection no view names, after the last view of a collection (spec
 * 0031 §3).
 */
function viewsOf(
  board: BoardDeclaration,
  collections: readonly BoardCollection[]
): LayoutView[] {
  const field = collectionField(board)
  const labelOfCollection = (name: string): string =>
    collections.find((c) => c.name === name)?.label ?? labelOf(name)
  const views: LayoutView[] = board.views.map((v) => ({
    name: v.name,
    layout: v.layout,
    filter:
      [
        v.collection === null || field === null
          ? null
          : collectionFilter(field, labelOfCollection(v.collection)),
        v.filter,
      ]
        .filter((f): f is string => f !== null)
        .join(' ') || null,
    columns: v.layout === 'board' ? (v.columns ?? 'Status') : null,
    fields: v.fields,
  }))
  if (board.collections !== 'all' || field === null) return views
  const named = new Set(
    board.views.flatMap((v) => (v.collection === null ? [] : [v.collection]))
  )
  const extra = collections
    .filter((c) => !named.has(c.name))
    .map((c) => ({
      name: c.label,
      layout: 'board' as const,
      filter: collectionFilter(field, c.label),
      columns: c.field ?? 'Status',
      fields: null,
    }))
  const last = board.views.findLastIndex((v) => v.collection !== null)
  views.splice(last + 1, 0, ...extra)
  return views
}

const isSource = (from: string): boolean => from.startsWith('$')

/** The declared fields from front matter alone, as the reader of values takes them. */
const asDeclared = (name: string, f: FieldDeclaration): DeclaredField => ({
  name,
  type: f.type,
  from: f.from,
  options: f.options,
})

/** The board's shape (spec 0031 §2); `want` gives a declared select the options its documents carry. */
export function layoutOf(
  board: BoardDeclaration,
  collections: readonly BoardCollection[],
  want: readonly Desired[]
): Layout {
  const statuses =
    collections.length === 1
      ? (collections[0]?.statuses ?? [])
      : inLifecycleOrder(collections.flatMap((c) => c.statuses))
  const fields: LayoutField[] = []
  const declared = Object.entries(board.fields)
  // Where a card is first: its collection, then its steps, then the rest.
  for (const [name, f] of declared)
    if (f.type === 'select' && f.from[0] === '$collection')
      fields.push({
        name,
        type: 'select',
        kind: 'collection',
        options: collections.map((c) => c.label),
        reorder: false,
      })
  for (const c of collections)
    if (c.field !== null && c.statuses.length > 0)
      fields.push({
        name: c.field,
        type: 'select',
        kind: 'status',
        options: c.statuses,
        reorder: true,
      })
  for (const [name, f] of declared) {
    if (f.type === 'select' && f.from[0] === '$collection') continue
    if (f.type !== 'select') {
      fields.push({ name, type: f.type })
      continue
    }
    const status = f.from[0] === '$status'
    fields.push({
      name,
      type: 'select',
      kind: status ? 'status' : 'declared',
      options: status
        ? statuses
        : once([
            ...f.options,
            ...want
              .map((w) => w.values[name])
              .filter((v): v is string => typeof v === 'string'),
          ]),
      reorder: !f.from.every(isSource),
    })
  }
  return {
    statuses,
    fields,
    views: viewsOf(board, collections),
    // Made only when a document carries it: a directory with no card is no
    // label, though one carrying it once is taken off (`unlabels`).
    labels: once(want.flatMap((w) => w.labels)),
    colors: board.colors,
  }
}

const sessionsOf = (row: StatusTab['rows'][number]): string | null =>
  row.sessions
    ?.map((e) => (e.agent === undefined ? e.id : `${e.agent} · ${e.id}`))
    .join(', ') ?? null

/** Whether a board's fields or labels read the documents' front matter. */
export const readsFrontMatter = (board: BoardDeclaration): boolean =>
  board.labels !== null ||
  Object.values(board.fields).some((f) => f.from.some((k) => !isSource(k)))

/**
 * Each document of the board's collections as an item: its title, status,
 * declared values (`fronts`: its front matter by path) and labels.
 * `directories`: a collection's subdirectories, whose labels a document
 * that left them loses.
 */
export function desiredOf(
  board: BoardDeclaration,
  collections: readonly BoardCollection[],
  org: string,
  fronts: ReadonlyMap<string, Fields> = new Map(),
  directories: ReadonlyMap<string, readonly string[]> = new Map()
): Desired[] {
  const written = Object.entries(board.fields).filter(
    ([, f]) => !f.from.includes('$agent') && !f.from.includes('$session')
  )
  const shape = {
    readme: null,
    description: null,
    statuses: null,
    fields: written
      .filter(([, f]) => !f.from.every(isSource))
      .map(([name, f]) => asDeclared(name, f)),
    labels: board.labels,
  }
  const wanted = collections.flatMap((c) =>
    c.tab.rows.map((row) => {
      const front = fronts.get(row.path) ?? {}
      const read = valuesOf(shape, front, row.path.slice(c.name.length + 1))
      const status = statusOf(row.status)
      const sources: Record<string, string | null> = {
        $collection: c.label,
        $status: status,
        $sessions: sessionsOf(row),
        $id: row.id,
      }
      const values: Record<string, string | null> = {}
      for (const [name, f] of written) {
        let value: string | null = null
        for (const from of f.from) {
          value = isSource(from)
            ? (sources[from] ?? null)
            : (valuesOf(
                {
                  ...shape,
                  fields: [asDeclared(name, { ...f, from: [from] })],
                },
                front,
                ''
              ).values[name] ?? null)
          if (value !== null) break
        }
        values[name] = value
      }
      return {
        path: row.path,
        title: `${row.id} — ${row.title}`,
        body: headerOf(row.path, org),
        status,
        statusField: c.field,
        values,
        labels: read.labels,
        unlabels: [] as string[],
      }
    })
  )
  if (board.labels === null) return wanted
  // What the board labels: its documents' labels, then its collections'
  // subdirectories', so a label nobody carries any more is still taken off.
  const made = once([
    ...wanted.flatMap((w) => w.labels),
    ...(board.labels.kind === 'directory'
      ? collections.flatMap((c) => directories.get(c.name) ?? [])
      : []),
  ])
  return wanted.map((w) => ({
    ...w,
    unlabels: made.filter((l) => !w.labels.includes(l)),
  }))
}
