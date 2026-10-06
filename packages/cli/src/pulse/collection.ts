import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { containedPath } from '../core/contained.ts'
import { parseFrontMatter, stripFrontMatter } from '../core/frontmatter.ts'
import type { Fields } from '../core/types.ts'

/**
 * What a collection with a project of its own says of it, in its files
 * (spec 0025 §4): `README.md` for the project's README, description,
 * columns, fields and labels; `updates/` for its status updates. The CLI
 * adds no field or label of its own: a collection declares them.
 */

export type FieldType = 'text' | 'date' | 'select' | 'number'
const FIELD_TYPES: readonly FieldType[] = ['text', 'date', 'select', 'number']

/** A field a collection declares: filled from `from`, the first key present winning. */
export interface DeclaredField {
  name: string
  type: FieldType
  from: string[]
  /** A `select`'s options, in order; values found elsewhere follow. */
  options: string[]
}

/** Where a document's labels come from: its subdirectory, or a front-matter key. */
export type LabelSource = { kind: 'directory' } | { kind: 'key'; key: string }

export interface CollectionShape {
  /** `README.md` without its front matter; null when there is none. */
  readme: string | null
  description: string | null
  /** The columns, in order, each there even when empty; null: the documents'. */
  statuses: string[] | null
  fields: DeclaredField[]
  labels: LabelSource | null
}

/**
 * The fields a project of rness already has, and GitHub's own: a declared
 * field of the same name would be written over, or refused.
 */
const TAKEN = new Set(
  [
    'Status',
    'Collection',
    'Agent',
    'Working session',
    'Path',
    'Session history',
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
  ].map((n) => n.toLowerCase())
)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isNames = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.every((s) => typeof s === 'string' && s.trim() !== '') &&
  new Set(v).size === v.length

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function readField(where: string, name: string, value: unknown): DeclaredField {
  const key = `fields.${name}`
  if (TAKEN.has(name.toLowerCase()))
    throw new Error(`${where}: "${key}" is a field of rness: name it otherwise`)
  if (!isRecord(value))
    throw new Error(`${where}: "fields" must map names to { type, from }`)
  const type = FIELD_TYPES.find((t) => t === value['type'])
  if (type === undefined)
    throw new Error(
      `${where}: "${key}.type" must be one of ${FIELD_TYPES.join(', ')}`
    )
  const raw = value['from']
  const from = typeof raw === 'string' && raw !== '' ? [raw] : raw
  if (!isNames(from) || from.length === 0)
    throw new Error(
      `${where}: "${key}.from" must be a front-matter key or a list of them`
    )
  const options = value['options'] ?? []
  if (!isNames(options) && !(Array.isArray(options) && options.length === 0))
    throw new Error(`${where}: "${key}.options" must be a list of names`)
  return { name, type, from, options: [...(options as string[])] }
}

function readLabels(where: string, value: unknown): LabelSource | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(
      `${where}: "labels" must be directory or a front-matter key`
    )
  return value === 'directory'
    ? { kind: 'directory' }
    : { kind: 'key', key: value }
}

/** `<collection>/README.md`, read and checked; a declaration that cannot be read throws, naming its key. */
export async function readShape(
  rnessDir: string,
  collection: string
): Promise<CollectionShape> {
  const where = `${collection}/README.md`
  const text = await readText(join(rnessDir, collection, 'README.md'))
  if (text === null)
    return {
      readme: null,
      description: null,
      statuses: null,
      fields: [],
      labels: null,
    }
  let front: Fields | null
  try {
    front = parseFrontMatter(text)
  } catch (e) {
    throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    })
  }
  const f = front ?? {}
  const description = f['description'] ?? null
  if (description !== null && typeof description !== 'string')
    throw new Error(`${where}: "description" must be text`)
  const statuses = f['statuses'] ?? null
  if (statuses !== null && !isNames(statuses))
    throw new Error(`${where}: "statuses" must be a list of names`)
  const fields = f['fields'] ?? {}
  if (!isRecord(fields))
    throw new Error(`${where}: "fields" must map names to { type, from }`)
  return {
    readme: stripFrontMatter(text),
    description: description === null ? null : description.trim(),
    statuses: statuses === null ? null : [...statuses],
    fields: Object.entries(fields).map(([name, v]) =>
      readField(where, name, v)
    ),
    labels: readLabels(where, f['labels']),
  }
}

/** A date's day as written: `2026-10-13T15:00+02:00` is `2026-10-13`. */
function dayOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString().slice(0, 10)
  if (typeof value !== 'string') return null
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value.trim())?.[1]
  return day ?? null
}

function valueOf(field: DeclaredField, fields: Fields): string | null {
  const key = field.from.find(
    (k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== ''
  )
  if (key === undefined) return null
  const raw = fields[key]
  switch (field.type) {
    case 'date':
      return dayOf(raw)
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      return typeof raw !== 'boolean' && Number.isFinite(n) ? String(n) : null
    }
    default:
      if (Array.isArray(raw)) return raw.map(String).join(', ')
      return typeof raw === 'object' ? null : String(raw)
  }
}

/**
 * A document's declared values and labels, from its front matter and its
 * path within the collection (`linkedin/a.md`). A value that its type cannot
 * read is no value: one card is no reason to stop a sync.
 */
export function valuesOf(
  shape: CollectionShape,
  fields: Fields,
  rel: string
): { values: Record<string, string | null>; labels: string[] } {
  const values = Object.fromEntries(
    shape.fields.map((f) => [f.name, valueOf(f, fields)])
  )
  const labels: string[] = []
  if (shape.labels?.kind === 'directory') {
    const slash = rel.indexOf('/')
    if (slash > 0) labels.push(rel.slice(0, slash))
  } else if (shape.labels?.kind === 'key') {
    const raw = fields[shape.labels.key]
    for (const v of Array.isArray(raw) ? raw : [raw])
      if (typeof v === 'string' && v.trim() !== '' && !labels.includes(v))
        labels.push(v.trim())
  }
  return { values, labels }
}

export type Health =
  'on-track' | 'at-risk' | 'off-track' | 'complete' | 'inactive'
const HEALTHS: readonly Health[] = [
  'on-track',
  'at-risk',
  'off-track',
  'complete',
  'inactive',
]

/** A status update of a collection's project: a file of `updates/`. */
export interface StatusUpdate {
  /** Relative to `.rness/`: its marker on the project. */
  path: string
  health: Health
  startDate: string | null
  targetDate: string | null
  body: string
}

/** `dir/*.md` (`marketing/updates`), in the order of their names; a file without a health throws, naming it. */
export async function readUpdates(
  rnessDir: string,
  dir: string
): Promise<StatusUpdate[]> {
  let at: string
  let names: string[]
  try {
    // rness.json names it: a directory out of .rness is refused, and a file
    // there that is a link is no file (`isFile`), never followed out.
    at = await containedPath(rnessDir, dir)
    names = (
      await readdir(at, {
        withFileTypes: true,
      })
    )
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const updates: StatusUpdate[] = []
  for (const name of names) {
    const path = `${dir}/${name}`
    const text = (await readText(join(at, name))) ?? ''
    let front: Fields | null
    try {
      front = parseFrontMatter(text)
    } catch (e) {
      throw new Error(
        `${path}: ${e instanceof Error ? e.message : String(e)}`,
        {
          cause: e,
        }
      )
    }
    const health = HEALTHS.find((h) => h === front?.['health'])
    if (health === undefined)
      throw new Error(`${path}: "health" must be one of ${HEALTHS.join(', ')}`)
    updates.push({
      path,
      health,
      startDate: dayOf(front?.['start_date']),
      targetDate: dayOf(front?.['target_date']),
      body: stripFrontMatter(text),
    })
  }
  return updates
}
