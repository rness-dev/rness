import { createHash } from 'node:crypto'
import type { Context } from './types.ts'

export const BEGIN = '<!-- BEGIN rness -->'
export const END = '<!-- END rness -->'
/** Blocks above this size are written with a warning (spec 0003 §4.2). */
export const BLOCK_SIZE_WARNING = 32 * 1024

export interface BlockInput {
  /** Scope name, or null for the workspace-root global block. */
  scope: string | null
  org: string
  /** Path segments between the scope directory and the workspace root (`org/web` → 2; root → 0). */
  depth: number
  context: Context
  version: string
}

export interface RenderedBlock {
  /** The whole block, LF line endings, no trailing newline. */
  text: string
  hash: string
  bytes: number
}

export interface BlockHeader {
  version: string
  scope: string
  hash: string
}

const HEADER = /^<!-- rness (\S+) · scope: (\S+) · contract: 1 · hash: ([0-9a-f]{12}) · generated: run `rness sync`, never edit inside this block -->$/

function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/** SHA-256 of the LF-normalised body, first 12 hex characters. */
export function blockHash(body: string): string {
  return createHash('sha256').update(toLf(body), 'utf8').digest('hex').slice(0, 12)
}

function intro(scope: string | null, org: string, depth: number): string {
  if (scope === null) {
    return [
      `This is the root of rness workspace \`${org}\`. Full context lives in \`.rness/\` —`,
      'read `STATUS.md`, then task-relevant `adr/`, `specs/`, `plans/`; live: `rness context`.',
      'Every `org/<repo>/` carries its own block with the rules that apply there.',
    ].join('\n')
  }
  const rel = `${'../'.repeat(depth)}.rness/`
  return [
    `This directory is scope \`${scope}\` of rness workspace \`${org}\`. Full context lives in`,
    `\`${rel}\` — read \`STATUS.md\`, then task-relevant \`adr/\`, \`specs/\`, \`plans/\`;`,
    `live: \`rness context --scope ${scope}\`. If \`.rness/\` is not reachable, this is a`,
    'standalone clone: the rules below are all you have.',
  ].join('\n')
}

function header(version: string, scope: string | null, hash: string): string {
  return `<!-- rness ${version} · scope: ${scope ?? 'global'} · contract: 1 · hash: ${hash} · generated: run \`rness sync\`, never edit inside this block -->`
}

/** Render the block for one scope (or the root) from an already resolved context. */
export function renderBlock({ scope, org, depth, context, version }: BlockInput): RenderedBlock {
  const standards = context.collections.find((c) => c.name === 'standards')?.files ?? []
  const rules =
    standards.length === 0
      ? ['_No standards apply to this scope yet._']
      : standards.map((f) => `<!-- rness: standards/${f.rel} -->\n${toLf(f.body).trim()}`)
  const body = `${intro(scope, org, depth)}\n\n## Rules\n${rules.join('\n\n')}`
  const hash = blockHash(body)
  const text = [BEGIN, header(version, scope, hash), body, END].join('\n')
  return { text, hash, bytes: Buffer.byteLength(text, 'utf8') }
}

/** Parse the header line of a block; null when the line is not a rness header. */
export function parseHeader(line: string): BlockHeader | null {
  const m = HEADER.exec(line.trimEnd())
  if (m === null) return null
  return { version: m[1] ?? '', scope: m[2] ?? '', hash: m[3] ?? '' }
}

/** The hashed body of a block given its lines (BEGIN, header, body…, END). */
export function bodyOf(blockLines: string[]): string {
  return blockLines.slice(2, -1).join('\n')
}
