import { findBlock } from './merge.ts'

/**
 * What `rness hook pre-tool-use` decides before Claude Code writes a file
 * (spec 0029 §4): pure functions over the file's text and the tool's input.
 */

/** A file's text as an `Edit` or a `Write` would leave it. */
export interface Replayed {
  after: string
  /** The character ranges of the text the edit replaces; the whole file for a `Write`. */
  spans: readonly (readonly [number, number])[]
}

/** The non-overlapping occurrences of `needle` in `text`, as character ranges. */
function occurrences(text: string, needle: string): [number, number][] {
  const spans: [number, number][] = []
  for (
    let i = text.indexOf(needle);
    i !== -1;
    i = text.indexOf(needle, i + needle.length)
  )
    spans.push([i, i + needle.length])
  return spans
}

const QUOTES: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
}

/**
 * A text as the Edit tool compares it when the exact string is not found:
 * curly quotes read straight, a CRLF reads as LF. `at` maps each of its
 * characters, and its end, back to the original's offsets.
 */
function loose(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    if (c === '\r' && text[i + 1] === '\n') continue
    out += QUOTES[c] ?? c
    at.push(i)
  }
  at.push(text.length)
  return { text: out, at }
}

/**
 * An `Edit` replayed as the tool does it: every occurrence under
 * `replace_all`, else exactly one; the exact string first, then as the tool
 * also finds it, straight quotes for curly ones and LF for CRLF (seen
 * 2026-10-04: `product's` sent for a block's `product’s`). Null when the
 * tool would refuse it (nothing found, found twice, an empty `old_string`):
 * it fails on its own.
 */
export function replayEdit(
  text: string,
  oldString: string,
  newString: string,
  all: boolean
): Replayed | null {
  if (oldString === '') return null
  let spans = occurrences(text, oldString)
  if (spans.length === 0) {
    const file = loose(text)
    spans = occurrences(file.text, loose(oldString).text).map(
      ([s, e]): [number, number] => [file.at[s] ?? 0, (file.at[e - 1] ?? 0) + 1]
    )
  }
  if (spans.length === 0 || (!all && spans.length !== 1)) return null
  let after = text
  for (const [s, e] of [...spans].reverse())
    after = `${after.slice(0, s)}${newString}${after.slice(e)}`
  return { after, spans }
}

/** A line an edit adds, 1-based in the file it leaves. */
export interface AddedLine {
  line: number
  text: string
}

const BREAK = /\r\n|\r|\n/

/** The lines of a text; a final line break ends its last line and starts none. */
function linesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split(BREAK)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** The indexes of `lines` left once each line of `base` is taken out, once per copy. */
function notIn(lines: readonly string[], base: readonly string[]): number[] {
  const left = new Map<string, number>()
  for (const l of base) left.set(l, (left.get(l) ?? 0) + 1)
  const fresh: number[] = []
  lines.forEach((l, i) => {
    const n = left.get(l) ?? 0
    if (n > 0) left.set(l, n - 1)
    else fresh.push(i)
  })
  return fresh
}

/**
 * The lines an `Edit` or a `Write` adds (spec 0040 §4.3), as a commit shows
 * them: the lines of the file after whose whole text the file before does
 * not have, a second copy of a line being one more, numbered in the file
 * after. The lines both start and end with are left aside first, so a line
 * is numbered where the change put it.
 */
export function addedLines(before: string | null, after: string): AddedLine[] {
  const was = before === null ? [] : linesOf(before)
  const now = linesOf(after)
  let head = 0
  while (head < was.length && head < now.length && was[head] === now[head])
    head += 1
  let tail = 0
  while (
    tail < was.length - head &&
    tail < now.length - head &&
    was[was.length - 1 - tail] === now[now.length - 1 - tail]
  )
    tail += 1
  const middle = now.slice(head, now.length - tail)
  return notIn(middle, was.slice(head, was.length - tail)).map((i) => ({
    line: head + i + 1,
    text: middle[i] ?? '',
  }))
}

/** The whole files rness writes in a project directory (spec 0016 §3.2). */
const OWNED = /(?:^|\/)\.claude\/skills\/rness\//

/** Whether a workspace-relative path is one of rness's whole files. */
export const ownedWhole = (rel: string): boolean => OWNED.test(rel)

export function ownedRefusal(label: string): string {
  return `rness: ${label} is written whole by rness sync, and the next sync overwrites it. Leave it to rness.`
}

/** A skill directory rness may have installed: `[org/<repo>/].claude|.agents/skills/<name>`. */
const INSTALLED_AT =
  /^(?:org\/([^/]+)\/)?(\.(?:claude|agents)\/skills\/[^/]+)(?:\/|$)/

/**
 * Where a workspace-relative path sits in a place team skills are installed
 * (spec 0041 §7): the clone's repository name (null at the root) and the
 * skill directory relative to it. Whether rness installed it there is the
 * record's to say.
 */
export function installedSkillAt(
  label: string
): { repo: string | null; dir: string } | null {
  const m = INSTALLED_AT.exec(label)
  return m === null ? null : { repo: m[1] ?? null, dir: m[2] ?? '' }
}

/** Where a team skill lives in `.rness`: `.rness/skills/<name>`, or the scope's directory. */
export const skillHome = (name: string, scope: string | null): string =>
  scope === null
    ? `.rness/skills/${name}`
    : `.rness/skills/scopes/${scope}/${name}`

export const installedSkillRefusal = (label: string, home: string): string =>
  `rness: ${label} is a team skill rness installs from ${home}; edit it there`

/**
 * The skill a path of `.rness` (relative to it) belongs to: `skills/<name>/`
 * or `skills/scopes/<scope>/<name>/`; null for anything else.
 */
export function skillCopyAt(
  rel: string
): { scope: string | null; name: string } | null {
  const scoped = /^skills\/scopes\/([^/]+)\/([^/]+)(?:\/|$)/.exec(rel)
  if (scoped !== null) return { scope: scoped[1] ?? '', name: scoped[2] ?? '' }
  const top = /^skills\/([^/]+)(?:\/|$)/.exec(rel)
  return top === null || top[1] === 'scopes'
    ? null
    : { scope: null, name: top[1] ?? '' }
}

export const declaredCopyRefusal = (name: string, version: string): string =>
  `rness: ${name} is a copy of ${version}; run rness skill update, or remove its source in rness.json to make it the team's own`

const MARKER = /^<!-- rness: (\S+) -->$/

interface Block {
  /** Line indexes, inclusive. */
  begin: number
  end: number
  /** Character offsets: the first of BEGIN, the one after END. */
  from: number
  to: number
  lines: string[]
}

function blockOf(text: string): Block | null {
  const lines = text.split(/\r?\n/)
  const found = findBlock(lines)
  if (found.kind !== 'one') return null
  const starts = [0]
  for (const m of text.matchAll(/\r?\n/g))
    starts.push((m.index ?? 0) + m[0].length)
  const from = starts[found.begin] ?? 0
  const to = (starts[found.end] ?? 0) + (lines[found.end] ?? '').length
  return { begin: found.begin, end: found.end, from, to, lines }
}

/** The line of a character offset. */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length - 1
}

/** The source of a block's line: the nearest rule marker above it in the block. */
function sourceOf(block: Block, line: number): string {
  for (let i = Math.min(line, block.end); i > block.begin; i--) {
    const m = MARKER.exec((block.lines[i] ?? '').trimEnd())
    if (m !== null) return `.rness/${m[1] ?? ''}`
  }
  return '.rness/ and rness.json'
}

function blockRefusal(label: string, block: Block, source: string): string {
  return `rness: lines ${block.begin + 1}–${block.end + 1} of ${label} are generated by rness sync from ${source}. Edit that file, then run rness sync.`
}

/**
 * Why an `Edit` of a file holding the block is refused: one of the ranges it
 * replaces overlaps the block. Null when it leaves the block alone, or when
 * the file has no block (or a broken one, which `sync` reports).
 */
export function editRefusal(
  label: string,
  before: string,
  spans: Replayed['spans']
): string | null {
  const block = blockOf(before)
  if (block === null) return null
  const hit = spans.find(([s, e]) => s < block.to && e > block.from)
  if (hit === undefined) return null
  return blockRefusal(
    label,
    block,
    sourceOf(block, lineAt(before, Math.max(hit[0], block.from)))
  )
}

/**
 * Why a `Write` of a file holding the block is refused: the block is not in
 * the new text byte for byte. The source named is that of the first line
 * that differs.
 */
export function writeRefusal(
  label: string,
  before: string,
  after: string
): string | null {
  const block = blockOf(before)
  if (block === null) return null
  const kept = blockOf(after)
  const was = before.slice(block.from, block.to)
  if (kept !== null && after.slice(kept.from, kept.to) === was) return null
  const next = kept === null ? [] : kept.lines.slice(kept.begin, kept.end + 1)
  const old = block.lines.slice(block.begin, block.end + 1)
  const first = old.findIndex((line, i) => line !== next[i])
  return blockRefusal(
    label,
    block,
    kept === null
      ? '.rness/ and rness.json'
      : sourceOf(block, block.begin + Math.max(first, 0))
  )
}
