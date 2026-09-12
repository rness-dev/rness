import { join } from 'node:path'
import { BEGIN, END } from './block.ts'
import { readOrNull, writeFileAtomic } from './fs.ts'

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
  const blockLines = block.split('\n')
  const found = findBlock(lines)
  if (found.kind === 'error') return { ok: false, error: found.message }
  let out: string[]
  if (found.kind === 'one') {
    out = [...lines.slice(0, found.begin), ...blockLines, ...lines.slice(found.end + 1)]
  } else if ((lines[0] ?? '').startsWith('# ') && (lines[1] ?? '') === '') {
    out = [lines[0] ?? '', '', ...blockLines, '', ...lines.slice(2)]
  } else {
    out = [...blockLines, '', ...lines]
  }
  const text = out.join(eol)
  return { ok: true, text, changed: text !== existing }
}

/** `CLAUDE.md` next to an `AGENTS.md`: create with `@AGENTS.md`, or prepend that line when absent. */
export async function ensureClaudeMd(dir: string): Promise<'created' | 'prepended' | 'unchanged'> {
  const file = join(dir, 'CLAUDE.md')
  const existing = await readOrNull(file)
  if (existing === null) {
    await writeFileAtomic(file, '@AGENTS.md\n')
    return 'created'
  }
  if (existing.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md')) return 'unchanged'
  await writeFileAtomic(file, `@AGENTS.md\n${existing}`)
  return 'prepended'
}
