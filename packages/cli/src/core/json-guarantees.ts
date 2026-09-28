import type { Guarantee } from './agents.ts'

/**
 * Guaranteed values in a JSON file rness shares with the team (spec 0011
 * §3.4): what is missing is added, nothing else is removed, rewritten or
 * reordered, and a file rness cannot read is never overwritten. Pure: text in,
 * text out.
 */
export type Ensured =
  | { kind: 'created' | 'updated' | 'unchanged'; text: string }
  | { kind: 'invalid'; reason: string }

type Json = Record<string, unknown>
type Parsed = { ok: true; data: Json } | { ok: false; reason: string }
type Found =
  | { kind: 'list'; list: unknown[] }
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parse(text: string): Parsed {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  return isObject(data)
    ? { ok: true, data }
    : { ok: false, reason: 'not a JSON object' }
}

/** Walk to the list `g` names; create what is missing when `create`. */
function listAt(root: Json, g: Guarantee, create: boolean): Found {
  let node = root
  for (const [i, key] of g.path.slice(0, -1).entries()) {
    const next = node[key]
    if (next === undefined) {
      if (!create) return { kind: 'absent' }
      node[key] = {}
    } else if (!isObject(next))
      return {
        kind: 'invalid',
        reason: `${g.path.slice(0, i + 1).join('.')} is not an object`,
      }
    node = node[key] as Json
  }
  const last = g.path[g.path.length - 1] ?? ''
  const value = node[last]
  if (value === undefined) {
    if (!create) return { kind: 'absent' }
    const list: unknown[] = []
    node[last] = list
    return { kind: 'list', list }
  }
  if (!Array.isArray(value))
    return { kind: 'invalid', reason: `${g.path.join('.')} is not a list` }
  return { kind: 'list', list: value }
}

/** The text's own indentation, line ending and final newline, reused on output. */
function styleOf(text: string): {
  indent: string
  eol: string
  final: boolean
} {
  const indent = text
    .split(/\r?\n/)
    .slice(1)
    .map((l) => /^[ \t]+/.exec(l)?.[0])
    .find((w) => w !== undefined)
  return {
    indent: indent ?? '  ',
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    final: text.endsWith('\n'),
  }
}

export function ensureGuarantees(
  existing: string | null,
  guarantees: readonly Guarantee[]
): Ensured {
  const parsed: Parsed =
    existing === null ? { ok: true, data: {} } : parse(existing)
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason }
  let changed = false
  for (const g of guarantees) {
    const found = listAt(parsed.data, g, true)
    if (found.kind === 'invalid')
      return { kind: 'invalid', reason: found.reason }
    if (found.kind === 'list' && !found.list.includes(g.contains)) {
      found.list.push(g.contains)
      changed = true
    }
  }
  if (existing === null)
    return {
      kind: 'created',
      text: `${JSON.stringify(parsed.data, null, 2)}\n`,
    }
  if (!changed) return { kind: 'unchanged', text: existing }
  const { indent, eol, final } = styleOf(existing)
  const body = JSON.stringify(parsed.data, null, indent).split('\n').join(eol)
  return { kind: 'updated', text: final ? `${body}${eol}` : body }
}

/** What `ensureGuarantees` would add, or why it would refuse the file. */
export function missingGuarantees(
  existing: string | null,
  guarantees: readonly Guarantee[]
): Guarantee[] | { invalid: string } {
  if (existing === null) return [...guarantees]
  const parsed = parse(existing)
  if (!parsed.ok) return { invalid: parsed.reason }
  const missing: Guarantee[] = []
  for (const g of guarantees) {
    const found = listAt(parsed.data, g, false)
    if (found.kind === 'invalid') return { invalid: found.reason }
    if (found.kind === 'absent' || !found.list.includes(g.contains))
      missing.push(g)
  }
  return missing
}

export function describeGuarantee(g: Guarantee): string {
  return `${g.path.join('.')} lacks ${g.contains}`
}
