import { readFile } from 'node:fs/promises'

import { parseDocument } from 'yaml'

import { BoardRefused, parseBoard } from './board-declaration.ts'
import { mergeBoard } from './board-merge.ts'
import { containedPath } from './contained.ts'
import { parseFrontMatter } from './frontmatter.ts'
import { presetSource } from './preset-board.ts'
import {
  type PresetName,
  currentPreset,
  isPresetRevision,
  presetNameOf,
  presetTemplate,
} from './presets.ts'
import type { Manifest, Projects } from './types.ts'

/**
 * What `sync` does to the boards of `rness.json` (plan 0045), in the copy
 * an upgrade runs: a board declared by its number (0.20 and before) written
 * whole; what a collection's `README.md` declared (spec 0025 §4) moved into
 * its board (spec 0031 §6); a newer revision of a preset merged into the
 * boards made from an older one. `upgrade` commits the result.
 */

/** The keys of a collection's README that `rness.json` declares now. */
export const README_KEYS = [
  'description',
  'statuses',
  'fields',
  'labels',
] as const
type ReadmeKey = (typeof README_KEYS)[number]

/** The presets as `sync` knows them: the bundled ones, or a test's. */
export interface Presets {
  current: (name: PresetName) => string
  template: (
    ref: string,
    vars: { collection: string }
  ) => Record<string, unknown>
  knows: (ref: string) => boolean
}
const BUNDLED: Presets = {
  current: currentPreset,
  template: presetTemplate,
  knows: isPresetRevision,
}

const README = (collection: string): string => `${collection}/README.md`

async function readmeOf(
  rnessDir: string,
  collection: string
): Promise<string | null> {
  try {
    return await readFile(
      await containedPath(rnessDir, README(collection)),
      'utf8'
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** What a collection's README still declares, by key; none when it has no README or no such key. */
export async function readmeDeclarations(
  rnessDir: string,
  collection: string
): Promise<Partial<Record<ReadmeKey, unknown>>> {
  const text = await readmeOf(rnessDir, collection)
  if (text === null) return {}
  const front = parseFrontMatter(text) ?? {}
  return Object.fromEntries(
    README_KEYS.filter((k) => front[k] !== undefined).map((k) => [k, front[k]])
  )
}

const FRONT = /^(\uFEFF?)---\r?\n([\s\S]*?)\r?\n?---(\r?\n|$)/

/** `text` without the keys rness.json declares now; a front matter left empty goes whole. */
export function withoutDeclarations(text: string): string {
  const match = FRONT.exec(text)
  if (match === null) return text
  const doc = parseDocument(match[2] ?? '')
  for (const key of README_KEYS) doc.delete(key)
  const rest = String(doc).trim()
  const after = text.slice(match[0].length)
  return rest === '' || rest === '{}'
    ? `${match[1] ?? ''}${after.replace(/^(?:[ \t]*\r?\n)+/, '')}`
    : `${match[1] ?? ''}---\n${rest}\n---${match[3] ?? '\n'}${after}`
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** A README's field as a board's: `from` a list, `options` only when it has some. */
function asBoardField(value: unknown): unknown {
  if (!isRecord(value)) return value
  const from = value['from']
  const options = value['options']
  return {
    type: value['type'],
    from: typeof from === 'string' ? [from] : from,
    ...(Array.isArray(options) && options.length > 0 ? { options } : {}),
  }
}

/** A board's field compared as a README's: `from` a list, no empty options. */
const normalField = (value: unknown): unknown => asBoardField(value)

export interface Migration {
  /** Whether rness.json or a README is to be written. */
  changed: boolean
  projects: Projects | null
  /** The READMEs to write, by path of `.rness/`. */
  readmes: Map<string, string>
  /** What `sync` says, `[verb, rest]`. */
  lines: [string, string][]
}

/**
 * The README declarations of `collection` moved into `source`, a board's
 * JSON: a key the board lacks moved, one it declares alike dropped; one it
 * declares otherwise refused, naming both, the README left as it is.
 */
function moveInto(
  name: string,
  collection: string,
  source: Record<string, unknown>,
  declared: Partial<Record<ReadmeKey, unknown>>
): string | null {
  const collections = source['collections']
  const entry = isRecord(collections) ? collections[collection] : undefined
  const fields = isRecord(source['fields']) ? { ...source['fields'] } : {}
  const conflicts: string[] = []
  const take = (
    key: ReadmeKey,
    ours: unknown,
    theirs: unknown,
    set: () => void
  ) => {
    if (ours === undefined) set()
    else if (!same(ours, theirs)) conflicts.push(key)
  }
  if (declared.description !== undefined)
    take('description', source['description'], declared.description, () => {
      source['description'] = declared.description
    })
  if (declared.statuses !== undefined && isRecord(entry)) {
    const ours = entry['statuses']
    // "found" is no declaration of the board's: the README's list is.
    if (ours === undefined || ours === 'found')
      entry['statuses'] = declared.statuses
    else if (!same(ours, declared.statuses)) conflicts.push('statuses')
  }
  if (declared.labels !== undefined)
    take('labels', source['labels'], declared.labels, () => {
      source['labels'] = declared.labels
    })
  if (isRecord(declared.fields))
    for (const [field, value] of Object.entries(declared.fields)) {
      const ours = fields[field]
      if (ours === undefined) fields[field] = asBoardField(value)
      else if (!same(normalField(ours), asBoardField(value)))
        conflicts.push(`fields.${field}`)
    }
  if (conflicts.length > 0)
    return `${README(collection)} declares ${conflicts.join(', ')} otherwise than projects.${name}: keep one, in rness.json`
  source['fields'] = fields
  return null
}

/** The boards of `manifest` as `sync` leaves them; nothing written here. */
export async function migrateBoards(
  rnessDir: string,
  manifest: Manifest,
  presets: Presets = BUNDLED
): Promise<Migration> {
  const migration: Migration = {
    changed: false,
    projects: manifest.projects,
    readmes: new Map(),
    lines: [],
  }
  if (manifest.projects === null) return migration
  const projects: Projects = {}
  for (const [name, entry] of Object.entries(manifest.projects)) {
    let source: Record<string, unknown>
    if (typeof entry === 'number') {
      // Today's board, from its preset and its README's declarations.
      source = await presetSource(name, rnessDir, entry)
      migration.lines.push([
        'wrote',
        `${name} whole in .rness/rness.json, from ${String(source['preset'])}`,
      ])
      migration.changed = true
    } else source = structuredClone(entry.source) as Record<string, unknown>

    // A collection's README declarations: in the board now (spec 0031 §6).
    const collections = source['collections']
    for (const collection of isRecord(collections)
      ? Object.keys(collections)
      : []) {
      const declared = await readmeDeclarations(rnessDir, collection)
      const keys = Object.keys(declared)
      if (keys.length === 0) continue
      const refused =
        typeof entry === 'number'
          ? null
          : moveInto(name, collection, source, declared)
      if (refused !== null) {
        migration.lines.push(['refused', refused])
        continue
      }
      const text = await readmeOf(rnessDir, collection)
      if (text !== null)
        migration.readmes.set(README(collection), withoutDeclarations(text))
      migration.lines.push([
        'moved',
        `${keys.join(', ')} of ${README(collection)} into rness.json`,
      ])
      migration.changed = true
    }

    // A newer revision of its preset, merged (plan 0045).
    const recorded = source['preset']
    if (typeof recorded === 'string') {
      const preset = presetNameOf(recorded) as PresetName
      const current = presets.current(preset)
      const revision = (ref: string) => Number(ref.split('/')[1])
      if (revision(recorded) < revision(current)) {
        const vars = { collection: name }
        const { board, kept } = mergeBoard(
          name,
          presets.template(recorded, vars),
          source,
          presets.template(current, vars),
          current
        )
        source = board
        migration.lines.push(['merged', `${name} to ${current}`])
        for (const k of kept) migration.lines.push(['kept', k])
        migration.changed = true
      }
    }

    try {
      projects[name] =
        typeof entry === 'number' || migration.changed
          ? parseBoard(name, source, presets.knows)
          : entry
    } catch (e) {
      if (!(e instanceof BoardRefused)) throw e
      // A merge or a move the declaration refuses: the board left as it was.
      migration.lines.push(['refused', e.message])
      projects[name] = entry
    }
  }
  migration.projects = projects
  return migration
}
