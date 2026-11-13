import { createHash } from 'node:crypto'

import { type Policy, type PolicyRule, policiesOf } from './policy.ts'
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
  /** The team skills that apply to the scope (spec 0041 §7); none by default. */
  skills?: readonly BlockSkill[]
}

/** A team skill as the block lists it: both values already plain text. */
export interface BlockSkill {
  name: string
  description: string
  /** Written by the team (not declared): Claude Code installs it as `/rness:<name>`. */
  written?: boolean
}

export interface RenderedBlock {
  /** The whole block, LF line endings, no trailing newline. */
  text: string
  hash: string
  bytes: number
}

export interface BlockHeader {
  /** The CLI version a 0.2–0.4 header named; null for the current form. */
  version: string | null
  scope: string
  hash: string
}

// The header names no CLI version (spec 0006 §1): nothing read it, and it
// made every upgrade rewrite every block. The 0.2–0.4 form still parses, so a
// block written by an older CLI stays current as long as its hash is.
const HEADER =
  /^<!-- rness (?:(\S+) )?· scope: (\S+) · contract: 1 · hash: ([0-9a-f]{12}) · generated: run `rness sync`, never edit inside this block -->$/

function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/** SHA-256 of the LF-normalised body, first 12 hex characters. */
export function blockHash(body: string): string {
  return createHash('sha256')
    .update(toLf(body), 'utf8')
    .digest('hex')
    .slice(0, 12)
}

function intro(scope: string | null, org: string, depth: number): string {
  if (scope === null) {
    return [
      `This is the root of rness workspace \`${org}\`. Full context lives in \`.rness/\`:`,
      'start at its `AGENTS.md`, then task-relevant `adr/`, `specs/`, `plans/`; live: `rness context`.',
      'Every `org/<repo>/` carries its own block with the rules that apply there.',
    ].join('\n')
  }
  const rel = `${'../'.repeat(depth)}.rness/`
  return [
    `This directory is scope \`${scope}\` of rness workspace \`${org}\`. Full context lives in`,
    `\`${rel}\`: start at its \`AGENTS.md\`, then task-relevant \`adr/\`, \`specs/\`, \`plans/\`;`,
    `live: \`rness context --scope ${scope}\`. If \`.rness/\` is not reachable, this is a`,
    'standalone clone: the rules below are all you have.',
  ].join('\n')
}

function header(scope: string | null, hash: string): string {
  return `<!-- rness · scope: ${scope ?? 'global'} · contract: 1 · hash: ${hash} · generated: run \`rness sync\`, never edit inside this block -->`
}

const REFUSED_AT: Record<PolicyRule['check'], string> = {
  'commit-message': 'Refused at commit (the message)',
  'added-lines': 'Refused at commit and on edit (added lines)',
  push: 'Refused at push (non-fast-forward)',
}

/** One enabled policy: marker and title as a standard's, what is refused where, its standard, its reason. */
function policySection(policy: Policy): string {
  const lines = [
    `<!-- rness: ${policy.rel} -->`,
    `# ${policy.title}`,
    ...policy.rules.map((r) => `- ${REFUSED_AT[r.check]}: ${r.fix}`),
  ]
  if (policy.standard !== null) lines.push(`- Standard: \`${policy.standard}\``)
  if (policy.body !== '') lines.push('', toLf(policy.body).trim())
  return lines.join('\n')
}

/** The `## Policies` section, or '' when no policy is enabled for the scope. */
function policies(context: Context): string {
  const enabled = policiesOf(context)
  return enabled.length === 0
    ? ''
    : `\n\n## Policies\n${enabled.map(policySection).join('\n\n')}`
}

/**
 * A description as the block writes it: an `@` at its start or after
 * whitespace becomes `\@`. Claude Code loads the file of an `@path` it reads
 * in `CLAUDE.md` and `AGENTS.md`, so a skill's description (third-party
 * text) could otherwise load `.env` into every session (ruling R28);
 * Markdown still renders `\@` as `@`.
 */
const inertAt = (description: string): string =>
  description.replace(/(^|\s)@/g, '$1\\@')

/**
 * The `## Team skills` section, or '' when none applies. The command is the
 * bare `rness`, like the intro's: the block is committed in every clone, so it
 * cannot depend on how one developer launched the CLI.
 */
function teamSkills(skills: readonly BlockSkill[]): string {
  if (skills.length === 0) return ''
  return [
    '',
    '',
    '## Team skills',
    ...skills.map(
      (s) =>
        `- ${s.name}${s.written === true ? ` (Claude Code: /rness:${s.name})` : ''}: ${inertAt(s.description)}`
    ),
    "Installed with each developer's consent: `rness skill install`.",
  ].join('\n')
}

/** Render the block for one scope (or the root) from an already resolved context. */
export function renderBlock({
  scope,
  org,
  depth,
  context,
  skills = [],
}: BlockInput): RenderedBlock {
  const standards =
    context.collections.find((c) => c.name === 'standards')?.files ?? []
  const rules =
    standards.length === 0
      ? ['_No standards apply to this scope yet._']
      : standards.map(
          (f) => `<!-- rness: standards/${f.rel} -->\n${toLf(f.content).trim()}`
        )
  const body = `${intro(scope, org, depth)}\n\n## Rules\n${rules.join('\n\n')}${policies(context)}${teamSkills(skills)}`
  const hash = blockHash(body)
  const text = [BEGIN, header(scope, hash), body, END].join('\n')
  return { text, hash, bytes: Buffer.byteLength(text, 'utf8') }
}

/** Parse the header line of a block; null when the line is not a rness header. */
export function parseHeader(line: string): BlockHeader | null {
  const m = HEADER.exec(line.trimEnd())
  if (m === null) return null
  return { version: m[1] ?? null, scope: m[2] ?? '', hash: m[3] ?? '' }
}

/** The hashed body of a block given its lines (BEGIN, header, body…, END). */
export function bodyOf(blockLines: string[]): string {
  return blockLines.slice(2, -1).join('\n')
}

/**
 * Is this block (BEGIN, header, body…, END) what a fresh render would write?
 * By hash, never by text: the header's hash is the fresh one, and the body
 * still hashes to it — a hand edit inside the block breaks the second half.
 */
export function isCurrentBlock(
  blockLines: string[],
  freshHash: string
): boolean {
  const header = parseHeader(blockLines[1] ?? '')
  return (
    header !== null &&
    header.hash === freshHash &&
    blockHash(bodyOf(blockLines)) === freshHash
  )
}
