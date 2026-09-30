import { digestOf } from './body.ts'
import type { Desired } from './layout.ts'

/** An item's issue in `.rness`, as the provider reads it. */
export interface ItemIssue {
  number: number
  open: boolean
  /** It carries the label `rness`, in any case. */
  labelled: boolean
  /** Null: listed without bodies (`items(board, { bodies: false })`). */
  body: string | null
}

/** An item of the board, as the provider reads it. */
export interface BoardItem {
  id: string
  /**
   * Null: not rness's — no `Path`, or content that is neither a draft nor an
   * issue of the organization's `.rness` (spec 0018 §2); `planSync` adopts
   * one such issue a stopped sync left, by its body's first line.
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
  /** `Sessions`, which a session's end never clears (spec 0020 §3.2). */
  sessions: string | null
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
  item.type !== w.type ||
  item.sessions !== w.sessions

/** Of several items on one path, the one kept: an open issue, then a closed one, the lowest number first; a draft last. */
const rank = (i: BoardItem): number =>
  i.issue === null ? 2 : i.issue.open ? 0 : 1
const keptFirst = (a: BoardItem, b: BoardItem): number =>
  rank(a) - rank(b) || (a.issue?.number ?? 0) - (b.issue?.number ?? 0)

const gone = (item: BoardItem): Step =>
  item.issue === null
    ? { kind: 'archive', id: item.id }
    : { kind: 'close', id: item.id }

/** A body's first line; a CR ends a line as GitHub's editor writes it. */
const firstLine = (body: string): string => body.split(/\r\n?|\n/, 1)[0] ?? ''

/**
 * Issues of `.rness` on the board without `Path` that a sync made and left
 * there: it stopped before writing their `Path` (spec 0018 §2). Labelled
 * `rness`, their body's first line is a document's (§3.1), which
 * `Desired.body` is. By that line, the one to keep first.
 */
function strays(have: readonly BoardItem[]): Map<string, BoardItem[]> {
  const byLine = new Map<string, BoardItem[]>()
  for (const item of have) {
    if (
      item.path !== null ||
      item.issue === null ||
      item.issue.body === null ||
      !item.issue.labelled
    )
      continue
    const line = firstLine(item.issue.body)
    byLine.set(line, [...(byLine.get(line) ?? []), item])
  }
  for (const items of byLine.values()) items.sort(keptFirst)
  return byLine
}

/**
 * The paths `planSync` judges: on the board, no document wanted there — once
 * each. This clone's git, or its record of the issues it opened, decides
 * (`isGone`).
 */
export function unwantedPaths(
  want: readonly Desired[],
  have: readonly BoardItem[]
): string[] {
  const wanted = new Set(want.map((w) => w.path))
  const paths = new Set<string>()
  for (const item of have)
    if (item.path !== null && !wanted.has(item.path)) paths.add(item.path)
  return [...paths]
}

/** The issues this clone's syncs opened, by number: the path each was opened for (spec 0018 §2). */
export type Opened = ReadonlyMap<number, string>

/**
 * Whether an item no document wants is gone (spec 0018 §2): its path is in
 * `seen` — this clone's git holds it, its tree no longer does — or this
 * clone opened its issue for that path (`opened`): a document its agent
 * wrote, then renamed or deleted before any commit. Any other is a
 * teammate's document, or the same developer's from another clone, not
 * pulled yet. A draft has no issue: git's word alone.
 */
function isGone(
  path: string,
  item: BoardItem,
  seen: ReadonlySet<string>,
  opened: Opened
): boolean {
  return (
    seen.has(path) ||
    (item.issue !== null && opened.get(item.issue.number) === path)
  )
}

/**
 * Pass 1, one way (spec 0018 §2, §4): items are found by `path`. A document
 * without one adopts the issue a stopped sync left without `Path`, or gets
 * a new one; a draft of 0.12.0 becomes one; a closed issue is reopened;
 * whatever differs is written back. Items that are not rness's are left
 * alone — and so is a stray whose document has an item: adopting it only
 * ever replaces a second issue. An item with no document is closed only
 * when it `isGone`; any other is unchanged. Told nothing, it closes nothing.
 */
export function planSync(
  want: readonly Desired[],
  have: readonly BoardItem[],
  seen: ReadonlySet<string> = new Set(),
  opened: Opened = new Map()
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
  const left = strays(have)
  const steps: Step[] = []
  const wanted = new Set<string>()
  for (const w of want) {
    wanted.add(w.path)
    const item = kept.get(w.path) ?? left.get(w.body)?.[0]
    if (item === undefined) steps.push({ kind: 'create', want: w })
    else if (item.issue === null)
      steps.push({ kind: 'convert', id: item.id, want: w })
    else if (
      item.path === null ||
      !item.issue.open ||
      !item.issue.labelled ||
      differs(item, w)
    )
      steps.push({
        kind: 'update',
        id: item.id,
        want: w,
        reopen: !item.issue.open,
      })
    else steps.push({ kind: 'unchanged', id: item.id })
  }
  for (const [path, item] of kept)
    if (!wanted.has(path))
      steps.push(
        isGone(path, item, seen, opened)
          ? gone(item)
          : { kind: 'unchanged', id: item.id }
      )
  return [...steps, ...surplus]
}

/**
 * The record after a sync (spec 0018 §2): each issue it created added, for
 * its path; forgotten, one whose path git has seen (`seen` covers every
 * recorded path), one this sync closed or archived (`closed`, by item), one
 * no longer on the board.
 */
export function stillOpened(
  opened: Opened,
  have: readonly BoardItem[],
  seen: ReadonlySet<string>,
  closed: ReadonlySet<string>,
  created: ReadonlyMap<string, Placed>
): Map<number, string> {
  const items = new Map<number, string>()
  for (const item of have)
    if (item.issue !== null) items.set(item.issue.number, item.id)
  const next = new Map<number, string>()
  for (const [number, path] of opened) {
    const id = items.get(number)
    if (id !== undefined && !closed.has(id) && !seen.has(path))
      next.set(number, path)
  }
  for (const [path, placed] of created) next.set(placed.number, path)
  return next
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
      // An adopted issue is listed without `Path`: its step names its document.
      const path = step.kind === 'update' ? step.want.path : item?.path
      if (item === undefined || path == null || item.issue === null) continue
      issued.set(path, {
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
