import { join } from 'node:path'
import { BEGIN, END } from './block.ts'
import { isSymlink, readOrNull, writeFileAtomic } from './fs.ts'

export type FindResult =
  | { kind: 'none' }
  | { kind: 'one'; begin: number; end: number }
  | { kind: 'error'; message: string }

/** Locate the single rness span (line indexes, inclusive). Anything but 0 or 1 span is an error. */
export function findBlock(lines: string[]): FindResult {
  const begins: number[] = []
  const ends: number[] = []
  lines.forEach((line, i) => {
    const l = line.trimEnd()
    if (l === BEGIN) begins.push(i)
    if (l === END) ends.push(i)
  })
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' }
  const begin = begins[0]
  const end = ends[0]
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    return { kind: 'error', message: `expected exactly one ${BEGIN} … ${END} span, found ${begins.length} BEGIN and ${ends.length} END` }
  }
  if (end < begin) return { kind: 'error', message: `${END} comes before ${BEGIN}` }
  return { kind: 'one', begin, end }
}

export type MergeResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string }

/**
 * Merge `block` (LF, no trailing newline) into `existing` (spec 0003 §4.3):
 * missing file → the block; one span → replaced in place; no span → after a
 * leading `# H1` + blank line, else at the top. Bytes outside the span are
 * preserved, including the file's line-ending style.
 */
export function mergeBlock(existing: string | null, block: string): MergeResult {
  if (existing === null) return { ok: true, text: `${block}\n`, changed: true }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing.split(/\r?\n/)
  const found = findBlock(lines)
  if (found.kind === 'error') return { ok: false, error: found.message }
  const rendered = block.split('\n').join(eol)
  // Offsets of every line start in the original text, so the regions outside the
  // span are copied byte for byte — a file mixing LF and CRLF keeps every separator.
  const starts: number[] = [0]
  for (const m of existing.matchAll(/\r?\n/g)) starts.push((m.index ?? 0) + m[0].length)
  const lineStart = (i: number): number => starts[i] ?? existing.length
  let text: string
  if (found.kind === 'one') {
    const endLine = lines[found.end] ?? ''
    const afterEnd = lineStart(found.end) + endLine.length
    text = `${existing.slice(0, lineStart(found.begin))}${rendered}${existing.slice(afterEnd)}`
  } else if (lines.length >= 3 && (lines[0] ?? '').startsWith('# ') && lines[1] === '') {
    const at = lineStart(2)
    text = `${existing.slice(0, at)}${rendered}${eol}${eol}${existing.slice(at)}`
  } else {
    text = `${rendered}${eol}${eol}${existing}`
  }
  return { ok: true, text, changed: text !== existing }
}

/**
 * `CLAUDE.md` next to an `AGENTS.md`: create with `@AGENTS.md`, or prepend that
 * line when absent. A symlinked `CLAUDE.md` is left exactly as it is — reading
 * would follow it and the atomic rename would replace the link with a regular
 * file holding a copy of its target. (`sync` skips such a directory outright;
 * this guard is defence in depth for any other caller.)
 */
export async function ensureClaudeMd(dir: string): Promise<'created' | 'prepended' | 'unchanged'> {
  const file = join(dir, 'CLAUDE.md')
  if (await isSymlink(file)) return 'unchanged'
  const existing = await readOrNull(file)
  if (existing === null) {
    await writeFileAtomic(file, '@AGENTS.md\n')
    return 'created'
  }
  if (existing.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md')) return 'unchanged'
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  await writeFileAtomic(file, `@AGENTS.md${eol}${existing}`)
  return 'prepended'
}
