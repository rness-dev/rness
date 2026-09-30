import { digestOf } from './body.ts'
import type { Desired } from './layout.ts'

/** An item's issue in `.rness`, as the provider reads it. */
export interface ItemIssue {
  number: number
  open: boolean
  /** It carries the label `rness`. */
  labelled: boolean
  body: string
}

/** An item of the board, as the provider reads it. */
export interface BoardItem {
  id: string
  /**
   * Null: not rness's — no `Path`, or content that is neither a draft nor an
   * issue of the organization's `.rness` (spec 0018 §2).
   */
  path: string | null
  /** Its issue in `.rness`; null: a draft of 0.12.0, which becomes one. */
  issue: ItemIssue | null
  title: string
  status: string | null
  /** The value of the collection's own status field. */
  collectionStatus: string | null
  type: string | null
  agent: string | null
  session: string | null
}

/** What `apply` gave a document that had no issue: its item and its number. */
export interface Placed {
  id: string
  number: number
}

/** Pass 2: an issue's body, once every document has its number. */
export type BodyStep = { kind: 'body'; id: string; body: string }

export type Step =
  /** Pass 1 (spec 0018 §4): the document's issue, title, label and fields. */
  | { kind: 'create'; want: Desired }
  | { kind: 'convert'; id: string; want: Desired }
  | { kind: 'update'; id: string; want: Desired; reopen: boolean }
  | { kind: 'unchanged'; id: string }
  /** The document is gone: its issue closed as not planned, its item archived. */
  | { kind: 'close'; id: string }
  /** A draft left over: archived. */
  | { kind: 'archive'; id: string }
  | BodyStep

const differs = (item: BoardItem, w: Desired): boolean =>
  item.title !== w.title ||
  item.status !== w.status ||
  (w.statusField !== null && item.collectionStatus !== w.status) ||
  item.type !== w.type

/** Of several items on one path, the one kept: an open issue, then a closed one, the lowest number first; a draft last. */
const rank = (i: BoardItem): number =>
  i.issue === null ? 2 : i.issue.open ? 0 : 1
const keptFirst = (a: BoardItem, b: BoardItem): number =>
  rank(a) - rank(b) || (a.issue?.number ?? 0) - (b.issue?.number ?? 0)

const gone = (item: BoardItem): Step =>
  item.issue === null
    ? { kind: 'archive', id: item.id }
    : { kind: 'close', id: item.id }

/**
 * Pass 1, one way (spec 0018 §2, §4): items are found by `path`. A document
 * without one gets an issue; a draft of 0.12.0 becomes one; a closed issue
 * is reopened; whatever differs is written back. Items that are not rness's
 * are left alone.
 */
export function planSync(
  want: readonly Desired[],
  have: readonly BoardItem[]
): Step[] {
  const byPath = new Map<string, BoardItem[]>()
  for (const item of have)
    if (item.path !== null)
      byPath.set(item.path, [...(byPath.get(item.path) ?? []), item])
  const kept = new Map<string, BoardItem>()
  const surplus: Step[] = []
  for (const [path, items] of byPath) {
    const [keep, ...rest] = [...items].sort(keptFirst)
    if (keep !== undefined) kept.set(path, keep)
    surplus.push(...rest.map(gone))
  }
  const steps: Step[] = []
  const wanted = new Set<string>()
  for (const w of want) {
    wanted.add(w.path)
    const item = kept.get(w.path)
    if (item === undefined) steps.push({ kind: 'create', want: w })
    else if (item.issue === null)
      steps.push({ kind: 'convert', id: item.id, want: w })
    else if (!item.issue.open || !item.issue.labelled || differs(item, w))
      steps.push({
        kind: 'update',
        id: item.id,
        want: w,
        reopen: !item.issue.open,
      })
    else steps.push({ kind: 'unchanged', id: item.id })
  }
  for (const [path, item] of kept) if (!wanted.has(path)) steps.push(gone(item))
  return [...steps, ...surplus]
}

/** A document's issue after pass 1: its item, its number, its body as read (null: none worth reading). */
export interface Issued {
  id: string
  number: number
  body: string | null
}

/** Each document's issue after pass 1, by path: as the board listed it, or as pass 1 placed it. */
export function issuedAfter(
  steps: readonly Step[],
  have: readonly BoardItem[],
  placed: ReadonlyMap<string, Placed>
): Map<string, Issued> {
  const byId = new Map(have.map((i) => [i.id, i]))
  const issued = new Map<string, Issued>()
  for (const step of steps) {
    if (step.kind === 'create' || step.kind === 'convert') {
      const p = placed.get(step.want.path)
      if (p !== undefined) issued.set(step.want.path, { ...p, body: null })
    } else if (step.kind === 'update' || step.kind === 'unchanged') {
      const item = byId.get(step.id)
      if (item === undefined || item.path === null || item.issue === null)
        continue
      issued.set(item.path, {
        id: item.id,
        number: item.issue.number,
        body: item.issue.body,
      })
    }
  }
  return issued
}

/** Pass 2 (spec 0018 §4): a body is written when its issue's does not carry its digest. */
export function planBodies(
  bodies: ReadonlyMap<string, string>,
  issued: ReadonlyMap<string, Issued>
): BodyStep[] {
  const steps: BodyStep[] = []
  for (const [path, body] of bodies) {
    const i = issued.get(path)
    if (i === undefined) continue
    if (i.body === null || digestOf(i.body) !== digestOf(body))
      steps.push({ kind: 'body', id: i.id, body })
  }
  return steps
}
