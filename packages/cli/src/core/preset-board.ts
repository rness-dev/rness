import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { readShape } from '../board/collection.ts'
import { type BoardDeclaration, parseBoard } from './board-declaration.ts'
import { PULSE, loadManifest } from './manifest.ts'
import { currentPreset, presetTemplate } from './presets.ts'
import type { Projects } from './types.ts'

/**
 * A board as `pulse create` and the migration write it (plan 0045): the
 * current revision of its preset, made for this workspace — Agent Pulse
 * for `pulse`, a collection's own board for any other name — and, for a
 * collection, what its `README.md` declared before 0.21.0 (spec 0025 §4).
 */

/** The keys of a board in the order spec 0031 §2.2 gives them. */
const ORDER = [
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

const ordered = (board: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    [
      ...ORDER.filter((k) => Object.hasOwn(board, k)),
      ...Object.keys(board).filter((k) => !ORDER.includes(k)),
    ].map((k) => [k, board[k]])
  )

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The board `name` gets from its preset in this workspace, on project `number`, as `rness.json` holds it. */
export async function presetSource(
  name: string,
  rnessDir: string,
  number: number
): Promise<Record<string, unknown>> {
  if (name === PULSE) {
    const preset = currentPreset('agent-pulse')
    return ordered({
      number,
      preset,
      ...presetTemplate(preset, { collection: name }),
    })
  }
  const preset = currentPreset('collection')
  const board: Record<string, unknown> = {
    number,
    preset,
    ...presetTemplate(preset, { collection: name }),
  }
  if (await exists(join(rnessDir, name, 'README.md')))
    board['readme'] = `${name}/README.md`
  if (await exists(join(rnessDir, name, 'updates')))
    board['updates'] = `${name}/updates`
  // What the README declared before 0.21.0 (spec 0025 §4), as the board's.
  const shape = await readShape(rnessDir, name)
  if (shape.description !== null) board['description'] = shape.description
  const collections = board['collections'] as Record<
    string,
    Record<string, unknown>
  >
  if (shape.statuses !== null && collections[name] !== undefined)
    collections[name]['statuses'] = [...shape.statuses]
  const fields = board['fields'] as Record<string, unknown>
  for (const f of shape.fields)
    fields[f.name] = {
      type: f.type,
      from: f.from.length === 1 ? f.from[0] : [...f.from],
      ...(f.options.length === 0 ? {} : { options: [...f.options] }),
    }
  if (shape.labels !== null)
    board['labels'] =
      shape.labels.kind === 'directory' ? 'directory' : shape.labels.key
  // A date declared: the calendar spec 0025's project had, after the board.
  const date = shape.fields.find((f) => f.type === 'date')
  if (date !== undefined) {
    const views = board['views'] as Record<string, unknown>[]
    const at = views.findIndex(
      (v) => v['collection'] === name && v['layout'] === 'board'
    )
    views.splice(at + 1, 0, {
      name: 'Calendar',
      layout: 'roadmap',
      collection: name,
      date: date.name,
    })
  }
  return ordered(board)
}

/** A board of `projects` as a declaration: a number is its preset, as `sync` would write it. */
export async function declaredBoard(
  name: string,
  entry: Projects[string],
  rnessDir: string
): Promise<BoardDeclaration> {
  if (typeof entry !== 'number') return entry
  return parseBoard(name, await presetSource(name, rnessDir, entry))
}

/** A board of `rness.json`, read whole (a number is its preset). */
export interface NamedBoard {
  name: string
  declaration: BoardDeclaration
}

/**
 * The boards `rness.json` declares, for what reads them on a session's
 * path (the hooks, `rness mcp`): none when it cannot be read, and a board
 * that cannot, left out — `validate` and the safety net say why. Never throws.
 */
export async function readBoards(rnessDir: string): Promise<NamedBoard[]> {
  let projects: Projects
  try {
    projects = (await loadManifest(rnessDir)).projects ?? {}
  } catch {
    return []
  }
  const boards: NamedBoard[] = []
  for (const [name, entry] of Object.entries(projects))
    try {
      boards.push({
        name,
        declaration: await declaredBoard(name, entry, rnessDir),
      })
    } catch {
      // Refused: said elsewhere.
    }
  return boards
}
