import { STATUSES } from './contract.ts'
import { isPresetRevision, labelOf } from './presets.ts'

/**
 * A board as `rness.json` declares it (spec 0031 §2.2): what a GitHub
 * Project shows of `.rness/`. rness keeps the engine (one issue per
 * document, `Path`, `Status`, the label `rness`); everything here is the
 * team's. A declaration is read whole or refused, naming its full key.
 */

export const OPTION_COLORS = [
  'gray',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
] as const
export type OptionColor = (typeof OPTION_COLORS)[number]

export const FIELD_TYPES = ['text', 'date', 'select', 'number'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** What rness knows of a document, for a field's `from` (spec 0031 §2.4). */
export const SOURCES = [
  '$collection',
  '$status',
  '$agent',
  '$session',
  '$sessions',
  '$id',
] as const
export type Source = (typeof SOURCES)[number]

/** The option a field from `$agent` carries while a session works on the card. */
export const WORKING = 'working'

export interface FieldDeclaration {
  type: FieldType
  /** Front-matter keys or `$` sources, the first present winning. */
  from: string[]
  /** A select's options, in order; values found elsewhere follow. */
  options: string[]
}

/** `contract`, `found`, or the statuses in order (spec 0031 §2.3). */
export type StatusesDeclaration = 'contract' | 'found' | string[]

export interface CollectionDeclaration {
  label: string
  statuses: StatusesDeclaration
  /** A single-select field of this collection's statuses alone; null: none. */
  field: string | null
}

export const VIEW_LAYOUTS = ['board', 'table', 'roadmap'] as const
export type ViewLayout = (typeof VIEW_LAYOUTS)[number]

export interface ViewDeclaration {
  name: string
  layout: ViewLayout
  /** Only this collection's cards; null: every card of the board. */
  collection: string | null
  /** A GitHub filter added to the view's own. */
  filter: string | null
  /** A board's columns: a single-select field; null: `Status`. */
  columns: string | null
  /** A table's columns, in order; null: GitHub's default. */
  fields: string[] | null
  /** A roadmap's date field. */
  date: string | null
}

export type LabelSource = { kind: 'directory' } | { kind: 'key'; key: string }

export interface BoardDeclaration {
  number: number
  /** The preset and revision it was made from, `agent-pulse/1`; null: none. */
  preset: string | null
  title: string | null
  description: string | null
  /** A file of `.rness/` whose text, front matter removed, is the README. */
  readme: string | null
  /** A directory of `.rness/` whose files are the status updates. */
  updates: string | null
  collections: 'all' | Record<string, CollectionDeclaration>
  colors: Record<string, OptionColor>
  fields: Record<string, FieldDeclaration>
  labels: LabelSource | null
  views: ViewDeclaration[]
  /** The entry as `rness.json` holds it: what is written back. */
  source: Record<string, unknown>
}

/** The fields every board has, and GitHub's own: a declared one of the same name is refused. */
export const TAKEN_FIELDS: readonly string[] = [
  'Path',
  'Status',
  'Title',
  'Assignees',
  'Labels',
  'Linked pull requests',
  'Milestone',
  'Repository',
  'Reviewers',
  'Type',
  'Parent issue',
  'Sub-issues progress',
]
/** What a table view may show besides the board's fields. */
const SHOWN_FIELDS: readonly string[] = [
  'Title',
  'Status',
  'Labels',
  'Assignees',
  'Path',
]

const BOARD_KEYS = [
  'number',
  'preset',
  'title',
  'description',
  'readme',
  'updates',
  'collections',
  'colors',
  'fields',
  'labels',
  'views',
]
const COLLECTION_KEYS = ['label', 'statuses', 'field']
const FIELD_KEYS = ['type', 'from', 'options']
const VIEW_KEYS = [
  'name',
  'layout',
  'collection',
  'filter',
  'columns',
  'fields',
  'date',
]
/** The key a view's layout alone takes. */
const LAYOUT_KEY: Readonly<Record<string, ViewLayout>> = {
  columns: 'board',
  fields: 'table',
  date: 'roadmap',
}

/** A directory of `.rness/`, as a collection names it: never hidden, never a path. */
const DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PRESET = /^[a-z][a-z0-9-]*\/[1-9][0-9]*$/

/** A refused declaration: its full key and why. */
export class BoardRefused extends Error {
  readonly key: string
  constructor(key: string, reason: string) {
    super(`"${key}" ${reason}`)
    this.key = key
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== ''

const isNames = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isText) && new Set(v).size === v.length

const taken = (name: string): boolean =>
  TAKEN_FIELDS.some((t) => t.toLowerCase() === name.toLowerCase())

/** The contract's statuses of a collection that has them; undefined: none. */
export const contractOf = (collection: string): readonly string[] | undefined =>
  // A directory named `constructor` is no member of the contract's table.
  Object.hasOwn(STATUSES, collection)
    ? (STATUSES as Readonly<Record<string, readonly string[] | undefined>>)[
        collection
      ]
    : undefined

function unknownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  at: string,
  what: string
): void {
  for (const k of Object.keys(value))
    if (!keys.includes(k))
      throw new BoardRefused(`${at}.${k}`, `is not a key of ${what}`)
}

function optionalText(
  value: Record<string, unknown>,
  key: string,
  at: string
): string | null {
  const v = value[key]
  if (v === undefined) return null
  if (!isText(v)) throw new BoardRefused(`${at}.${key}`, 'must be text')
  return v
}

function readCollection(
  name: string,
  value: unknown,
  at: string
): CollectionDeclaration {
  if (!DIRECTORY.test(name))
    throw new BoardRefused(at, 'must name a directory of .rness')
  if (!isRecord(value))
    throw new BoardRefused(at, 'must be an object, as { "statuses": "found" }')
  unknownKeys(value, COLLECTION_KEYS, at, 'a collection')
  const label = optionalText(value, 'label', at) ?? labelOf(name)
  const raw = value['statuses']
  const contract = contractOf(name)
  let statuses: StatusesDeclaration
  if (raw === 'contract') {
    if (contract === undefined)
      throw new BoardRefused(
        `${at}.statuses`,
        'is "contract" only for adr, specs and plans'
      )
    statuses = 'contract'
  } else if (raw === 'found') statuses = 'found'
  else if (isNames(raw) && raw.length > 0) {
    // A valid document whose status has no column would vanish from the board.
    const missing = (contract ?? []).filter((s) => !raw.includes(s))
    if (missing.length > 0)
      throw new BoardRefused(
        `${at}.statuses`,
        `must hold every status of the contract: ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } missing`
      )
    statuses = [...raw]
  } else
    throw new BoardRefused(
      `${at}.statuses`,
      'must be "contract", "found" or a list of statuses'
    )
  const field = optionalText(value, 'field', at)
  if (field !== null && taken(field))
    throw new BoardRefused(
      `${at}.field`,
      'is a field of rness or of GitHub: name it otherwise'
    )
  return { label, statuses, field }
}

function readField(name: string, value: unknown, at: string): FieldDeclaration {
  if (taken(name))
    throw new BoardRefused(
      at,
      'is a field of rness or of GitHub: name it otherwise'
    )
  if (!isRecord(value))
    throw new BoardRefused(
      at,
      'must be an object, as { "type": "text", "from": "key" }'
    )
  unknownKeys(value, FIELD_KEYS, at, 'a field')
  const type = FIELD_TYPES.find((t) => t === value['type'])
  if (type === undefined)
    throw new BoardRefused(
      `${at}.type`,
      `must be one of ${FIELD_TYPES.join(', ')}`
    )
  const raw = value['from']
  const from = isText(raw) ? [raw] : raw
  if (!isNames(from) || from.length === 0)
    throw new BoardRefused(
      `${at}.from`,
      'must be a front-matter key, a $ source, or a list of them'
    )
  for (const f of from)
    if (f.startsWith('$') && !(SOURCES as readonly string[]).includes(f))
      throw new BoardRefused(
        `${at}.from`,
        `names ${f}, which rness does not know: ${SOURCES.slice(0, -1).join(', ')} or ${SOURCES.at(-1)}`
      )
  const rawOptions = value['options'] ?? []
  if (
    !(Array.isArray(rawOptions) && rawOptions.length === 0) &&
    !isNames(rawOptions)
  )
    throw new BoardRefused(`${at}.options`, 'must be a list of names')
  const options = [...(rawOptions as string[])]
  if (
    from.includes('$agent') &&
    (type !== 'select' || !options.includes(WORKING))
  )
    throw new BoardRefused(
      at,
      `is a select from $agent: it needs the option ${WORKING}`
    )
  return { type, from: [...from], options }
}

function readLabels(value: unknown, at: string): LabelSource | null {
  if (value === undefined) return null
  if (!isText(value))
    throw new BoardRefused(at, 'must be directory or a front-matter key')
  return value === 'directory'
    ? { kind: 'directory' }
    : { kind: 'key', key: value }
}

interface Known {
  collections: 'all' | Record<string, CollectionDeclaration>
  fields: Record<string, FieldDeclaration>
}

/** A single-select a board view's columns may follow. */
function isColumn(name: string, k: Known): boolean {
  if (name === 'Status') return true
  if (k.fields[name]?.type === 'select') return true
  if (k.collections === 'all') return name.endsWith(' status')
  return Object.values(k.collections).some((c) => c.field === name)
}

/** A field a table view may show. */
function isShown(name: string, k: Known): boolean {
  return (
    SHOWN_FIELDS.includes(name) ||
    Object.hasOwn(k.fields, name) ||
    (k.collections === 'all'
      ? name.endsWith(' status')
      : Object.values(k.collections).some((c) => c.field === name))
  )
}

function readView(value: unknown, at: string, k: Known): ViewDeclaration {
  if (!isRecord(value))
    throw new BoardRefused(
      at,
      'must be an object, as { "name": "Board", "layout": "board" }'
    )
  unknownKeys(value, VIEW_KEYS, at, 'a view')
  if (!isText(value['name']))
    throw new BoardRefused(`${at}.name`, 'must be text')
  const layout = VIEW_LAYOUTS.find((l) => l === value['layout'])
  if (layout === undefined)
    throw new BoardRefused(
      `${at}.layout`,
      `must be ${VIEW_LAYOUTS.slice(0, -1).join(', ')} or ${VIEW_LAYOUTS.at(-1)}`
    )
  for (const [key, only] of Object.entries(LAYOUT_KEY))
    if (value[key] !== undefined && only !== layout)
      throw new BoardRefused(`${at}.${key}`, `is a key of a ${only} view only`)
  const collection = optionalText(value, 'collection', at)
  if (collection !== null) {
    if (k.collections !== 'all' && !Object.hasOwn(k.collections, collection))
      throw new BoardRefused(
        `${at}.collection`,
        `names ${collection}, which is not on this board`
      )
    if (
      !Object.values(k.fields).some(
        (f) => f.type === 'select' && f.from.includes('$collection')
      )
    )
      throw new BoardRefused(
        `${at}.collection`,
        'needs a select field from $collection to filter by'
      )
  }
  const columns = optionalText(value, 'columns', at)
  if (columns !== null && !isColumn(columns, k))
    throw new BoardRefused(
      `${at}.columns`,
      "must name a single-select field: Status, a collection's field or a declared select"
    )
  let fields: string[] | null = null
  if (value['fields'] !== undefined) {
    if (!isNames(value['fields']) || value['fields'].length === 0)
      throw new BoardRefused(`${at}.fields`, 'must be a list of field names')
    const unknown = value['fields'].find((f) => !isShown(f, k))
    if (unknown !== undefined)
      throw new BoardRefused(
        `${at}.fields`,
        `names ${unknown}, which is no field of this board`
      )
    fields = [...value['fields']]
  }
  const date = optionalText(value, 'date', at)
  if (
    layout === 'roadmap' &&
    (date === null || k.fields[date]?.type !== 'date')
  )
    throw new BoardRefused(`${at}.date`, 'must name a date field')
  return {
    name: value['name'],
    layout,
    collection,
    filter: optionalText(value, 'filter', at),
    columns,
    fields,
    date,
  }
}

/** One entry of `projects` that is an object: the board, read whole, or {@link BoardRefused}. */
export function parseBoard(name: string, value: unknown): BoardDeclaration {
  const at = `projects.${name}`
  if (!isRecord(value))
    throw new BoardRefused(
      at,
      'must be an object, as { "number": 5, "collections": …, "views": … }'
    )
  unknownKeys(value, BOARD_KEYS, at, 'a board')
  const number = value['number']
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1)
    throw new BoardRefused(`${at}.number`, 'must be a project number')
  const preset = value['preset']
  if (
    preset !== undefined &&
    (typeof preset !== 'string' || !PRESET.test(preset))
  )
    throw new BoardRefused(
      `${at}.preset`,
      'must name a preset and its revision, as agent-pulse/1'
    )
  if (typeof preset === 'string' && !isPresetRevision(preset))
    throw new BoardRefused(
      `${at}.preset`,
      `names ${preset}, which this rness does not have`
    )

  const rawCollections = value['collections']
  let collections: BoardDeclaration['collections']
  if (rawCollections === 'all') collections = 'all'
  else if (isRecord(rawCollections) && Object.keys(rawCollections).length > 0)
    collections = Object.fromEntries(
      Object.entries(rawCollections).map(([c, v]) => [
        c,
        readCollection(c, v, `${at}.collections.${c}`),
      ])
    )
  else
    throw new BoardRefused(
      `${at}.collections`,
      'must name at least one collection, or be "all"'
    )

  const rawColors = value['colors'] ?? {}
  if (!isRecord(rawColors))
    throw new BoardRefused(`${at}.colors`, 'must map options to colours')
  const colors: Record<string, OptionColor> = {}
  for (const [option, c] of Object.entries(rawColors)) {
    const color = OPTION_COLORS.find((o) => o === c)
    if (color === undefined)
      throw new BoardRefused(
        `${at}.colors.${option}`,
        `must be one of ${OPTION_COLORS.join(', ')}`
      )
    colors[option] = color
  }

  const rawFields = value['fields'] ?? {}
  if (!isRecord(rawFields))
    throw new BoardRefused(`${at}.fields`, 'must map names to fields')
  const fields = Object.fromEntries(
    Object.entries(rawFields).map(([f, v]) => [
      f,
      readField(f, v, `${at}.fields.${f}`),
    ])
  )
  if (collections !== 'all')
    for (const [c, decl] of Object.entries(collections))
      if (decl.field !== null && Object.hasOwn(fields, decl.field))
        throw new BoardRefused(
          `${at}.collections.${c}.field`,
          `names ${decl.field}, which fields declares too`
        )

  const known: Known = { collections, fields }
  const rawViews = value['views']
  if (!Array.isArray(rawViews) || rawViews.length === 0)
    throw new BoardRefused(`${at}.views`, 'must list at least one view')
  const views: ViewDeclaration[] = []
  for (const [i, v] of rawViews.entries()) {
    const view = readView(v, `${at}.views[${i}]`, known)
    if (views.some((w) => w.name === view.name))
      throw new BoardRefused(
        `${at}.views[${i}].name`,
        `is ${view.name} again: a view's name is unique on its board`
      )
    views.push(view)
  }

  return {
    number,
    preset: (preset as string | undefined) ?? null,
    title: optionalText(value, 'title', at),
    description: optionalText(value, 'description', at),
    readme: optionalText(value, 'readme', at),
    updates: optionalText(value, 'updates', at),
    collections,
    colors,
    fields,
    labels: readLabels(value['labels'], `${at}.labels`),
    views,
    source: value,
  }
}
