/**
 * A newer revision of a preset brought into a board made from an older one
 * (plan 0045): a three-way merge, value by value. The base is the revision
 * the board records, the team's value is the board's, the new value the
 * current revision's. A value the team never changed takes the new one; one
 * it changed is kept, and named when the revision changed it too. Pure: no
 * file, no network.
 */

type Json = unknown

const isObject = (v: Json): v is Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function same(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    )
  }
  return false
}

const shown = (v: Json): string =>
  typeof v === 'string' ? v : JSON.stringify(v)

/** What the merge keeps against the revision, as `sync` says it. */
type Kept = string[]

/**
 * One value: `undefined` is a value absent. Two changes alike are one;
 * objects changed on both sides merge key by key; any other pair keeps the
 * team's, named.
 */
function mergeValue(
  at: string,
  base: Json,
  ours: Json,
  theirs: Json,
  ref: string,
  kept: Kept
): Json {
  if (same(ours, theirs)) return ours
  if (same(ours, base)) return theirs
  if (same(theirs, base)) return ours
  if (
    isObject(ours) &&
    isObject(theirs) &&
    (base === undefined || isObject(base))
  )
    return mergeObject(at, isObject(base) ? base : {}, ours, theirs, ref, kept)
  kept.push(
    ours === undefined
      ? `${at}: kept none, ${ref} gives ${shown(theirs)}`
      : theirs === undefined
        ? `${at}: kept ${shown(ours)}, ${ref} removes it`
        : `${at}: kept ${shown(ours)}, ${ref} gives ${shown(theirs)}`
  )
  return ours
}

function mergeObject(
  at: string,
  base: Record<string, Json>,
  ours: Record<string, Json>,
  theirs: Record<string, Json>,
  ref: string,
  kept: Kept
): Record<string, Json> {
  const merged: Record<string, Json> = {}
  const keys = [
    ...Object.keys(ours),
    ...Object.keys(theirs).filter((k) => !Object.hasOwn(ours, k)),
  ]
  for (const key of keys) {
    const value = mergeValue(
      `${at}.${key}`,
      base[key],
      ours[key],
      theirs[key],
      ref,
      kept
    )
    if (value !== undefined) merged[key] = value
  }
  return merged
}

const nameOf = (v: Json): string | undefined =>
  isObject(v) && typeof v['name'] === 'string' ? v['name'] : undefined

const byName = (views: Json): Map<string, Json> =>
  new Map(
    (Array.isArray(views) ? views : []).flatMap((v) => {
      const name = nameOf(v)
      return name === undefined ? [] : [[name, v] as const]
    })
  )

/**
 * Views by name: the team's in its order, each merged; one the revision
 * removed goes when the team never touched it; one it adds comes after.
 */
function mergeViews(
  at: string,
  base: Json,
  ours: Json,
  theirs: Json,
  ref: string,
  kept: Kept
): Json[] {
  const [b, t] = [byName(base), byName(theirs)]
  const merged: Json[] = []
  for (const view of Array.isArray(ours) ? ours : []) {
    const name = nameOf(view)
    if (name === undefined) {
      merged.push(view)
      continue
    }
    const value = mergeValue(
      `${at}.${name}`,
      b.get(name),
      view,
      t.get(name),
      ref,
      kept
    )
    if (value !== undefined) merged.push(value)
  }
  const there = byName(ours)
  for (const [name, view] of t)
    if (!there.has(name) && !b.has(name)) merged.push(view)
  return merged
}

/**
 * The board `name` made from `base` (its preset's revision), `ours` as
 * `rness.json` holds it, brought to `theirs` (revision `ref`): the merged
 * board, recording `ref`, and what was kept against it.
 */
export function mergeBoard(
  name: string,
  base: Record<string, Json>,
  ours: Record<string, Json>,
  theirs: Record<string, Json>,
  ref: string
): { board: Record<string, Json>; kept: string[] } {
  const at = `projects.${name}`
  const kept: Kept = []
  const { number, preset: _, ...team } = ours
  const keys = [
    ...Object.keys(team),
    ...Object.keys(theirs).filter((k) => !Object.hasOwn(team, k)),
  ]
  const board: Record<string, Json> = {}
  if (number !== undefined) board['number'] = number
  board['preset'] = ref
  for (const key of keys) {
    const value =
      key === 'views'
        ? mergeViews(
            `${at}.views`,
            base[key],
            team[key],
            theirs[key],
            ref,
            kept
          )
        : mergeValue(
            `${at}.${key}`,
            base[key],
            team[key],
            theirs[key],
            ref,
            kept
          )
    if (value !== undefined) board[key] = value
  }
  return { board, kept }
}
