import type { Desired } from './layout.ts'

/** An item of the board, as the provider reads it. */
export interface BoardItem {
  id: string
  /** Null: made by hand, not rness's. */
  path: string | null
  title: string
  status: string | null
  /** The value of the collection's own status field. */
  collectionStatus: string | null
  type: string | null
  agent: string | null
  session: string | null
}

export type Step =
  | { kind: 'create'; want: Desired }
  | { kind: 'update'; id: string; want: Desired }
  | { kind: 'archive'; id: string }
  | { kind: 'unchanged'; id: string }

/**
 * One way (spec 0017 §4): items are found by `path`; whatever differs from the
 * documents is written back, so a hand-moved item returns. Items without a
 * path are not rness's and are left alone.
 */
export function planSync(
  want: readonly Desired[],
  have: readonly BoardItem[]
): Step[] {
  const byPath = new Map<string, BoardItem>()
  const steps: Step[] = []
  const surplus: Step[] = []
  for (const item of have) {
    if (item.path === null) continue
    // A second item on one path is a leftover: the first is kept.
    if (byPath.has(item.path)) surplus.push({ kind: 'archive', id: item.id })
    else byPath.set(item.path, item)
  }
  const wanted = new Set<string>()
  for (const w of want) {
    wanted.add(w.path)
    const item = byPath.get(w.path)
    if (item === undefined) steps.push({ kind: 'create', want: w })
    else if (
      item.title !== w.title ||
      item.status !== w.status ||
      (w.statusField !== null && item.collectionStatus !== w.status) ||
      item.type !== w.type
    )
      steps.push({ kind: 'update', id: item.id, want: w })
    else steps.push({ kind: 'unchanged', id: item.id })
  }
  for (const [path, item] of byPath)
    if (!wanted.has(path)) steps.push({ kind: 'archive', id: item.id })
  return [...steps, ...surplus]
}
