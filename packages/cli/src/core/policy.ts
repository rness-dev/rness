import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'

import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from 'yaml'

import { RNESS_PATH, containedPath } from './contained.ts'
import { type AssembleInput, assembleCollection } from './context.ts'
import {
  extractTitle,
  frontMatterBlock,
  stripFrontMatter,
} from './frontmatter.ts'
import { scopeChain } from './scope.ts'
import type { Context, ContextFile, MarkdownItem } from './types.ts'

/**
 * The `policy/` collection (spec 0040 §2): a policy is a document of
 * `.rness/policy/`, its rules data in the front matter, its reason in the
 * body. This module reads one, says what `validate` refuses in it (§7),
 * and resolves the policies of a set of scopes (§2.3). The checks are
 * written by hand; `schema/policy.schema.json` publishes the same contract.
 */

export const POLICY_STATUSES = ['Enabled', 'Disabled'] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]

/** The fixed set of checks rness provides (spec 0040 §3). */
export const POLICY_CHECKS = ['commit-message', 'added-lines', 'push'] as const
export type PolicyCheck = (typeof POLICY_CHECKS)[number]

/** The front matter's keys, all others refused. */
export const POLICY_KEYS = [
  'status',
  'rules',
  'standard',
  'date',
  'updated',
] as const
/** A rule's keys, all required. */
export const RULE_KEYS = ['check', 'deny', 'fix'] as const

/** The one `deny` of a `push` rule in v1. */
export const NON_FAST_FORWARD = 'non-fast-forward'
/** `i`: git trailers ignore case; `u`: `\u2014` names a character. */
export const PATTERN_FLAGS = 'iu'

export interface PolicyRule {
  readonly check: PolicyCheck
  /** A pattern (compiled with `PATTERN_FLAGS`), or `non-fast-forward` for `push`. */
  readonly deny: string
  /** One line: what the agent reads when refused. */
  readonly fix: string
}

export interface Policy {
  /** The file name without `.md`: the policy's id in every message. */
  name: string
  /** `.rness/`-relative, POSIX: `policy/no-em-dash.md`. */
  rel: string
  /** The scope of `policy/<scope>/<name>.md`; null for a global policy. */
  scope: string | null
  /** The `# ` heading. */
  title: string
  status: PolicyStatus
  /** `.rness/`-relative path of the standard that explains the rule. */
  standard: string | null
  rules: readonly PolicyRule[]
  /** The Markdown after the heading: the reason. */
  body: string
}

/** One policy file read: the policy when the file has no problem of its own. */
export interface PolicyRead {
  policy: Policy | null
  /** `validate`'s lines: `policy/x.md:4: ...`, or `policy/x.md: ...` for the file. */
  problems: string[]
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ISO_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const CORE = 'tag:yaml.org,2002:'
/** The tags of YAML 1.2's core schema: written explicitly, still core. */
const CORE_TAGS: ReadonlySet<string> = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((t) => CORE + t)
)
const FENCE =
  "is refused: a policy's front matter is YAML 1.2 core, nothing more"

const has = <T extends string>(
  list: readonly T[],
  value: unknown
): value is T => (list as readonly unknown[]).includes(value)

/** A node's value as YAML gives it: a scalar's, null when there is none, else the node. */
const valueOf = (node: unknown): unknown =>
  node === null || node === undefined
    ? null
    : isScalar(node)
      ? node.value
      : node

const missing = (value: unknown): boolean => value === null || value === ''

const shown = (value: unknown): string =>
  isNode(value) ? String(value) : JSON.stringify(value)

/** The Markdown after the `# ` heading, its leading blank lines and trailing space dropped. */
function bodyAfterTitle(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const heading = lines.findIndex((l) => /^# .+$/.test(l))
  return lines
    .slice(heading + 1)
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
}

interface Inspected extends PolicyRead {
  /** The `standard` named and its line: whether it exists is the disk's question. */
  standard: { path: string; line: number } | null
}

/**
 * Everything one file says of itself: its place and name, the YAML fence
 * (ADR 0011), the keys and rules of spec 0040 §2.1, its title. Pure.
 */
function inspect(rel: string, text: string): Inspected {
  const fileProblems: string[] = []
  const lined: [number, string][] = []
  const segments = rel.split('/')
  const name = posix.basename(rel, '.md')
  const scope = segments.length === 3 ? (segments[1] ?? null) : null
  if (segments.length > 3)
    fileProblems.push(
      `${rel}: a policy is policy/<name>.md or policy/<scope>/<name>.md`
    )
  if (!NAME.test(name))
    fileProblems.push(
      `${rel}: "${name}" is no policy name: lowercase words joined by hyphens, as no-force-push`
    )
  const content = stripFrontMatter(text)
  const title = extractTitle(content)
  const done = (
    policy: Policy | null,
    standard: Inspected['standard'] = null
  ): Inspected => {
    const problems = [
      ...fileProblems,
      ...lined
        .sort((a, b) => a[0] - b[0])
        .map(([line, message]) => `${rel}:${line}: ${message}`),
    ]
    if (title === null || title === '')
      problems.push(`${rel}: missing a "# " title`)
    const unique = [...new Set(problems)]
    return {
      policy: unique.length === 0 ? policy : null,
      problems: unique,
      standard,
    }
  }

  const block = frontMatterBlock(text)
  if (block === null) {
    fileProblems.push(`${rel}: missing a front-matter block`)
    return done(null)
  }
  // The opening fence: where a missing key would go.
  const top = block.line - 1
  const counter = new LineCounter()
  // `uniqueKeys: false`: a duplicate key is the fence's, named below.
  const doc = parseDocument(block.yaml, {
    lineCounter: counter,
    logLevel: 'error',
    uniqueKeys: false,
  })
  const lineAt = (offset: number): number =>
    top + counter.linePos(Math.max(0, offset)).line
  const lineOf = (node: unknown, fallback: number): number => {
    const start = isNode(node) ? node.range?.[0] : undefined
    return start === undefined ? fallback : lineAt(start)
  }
  const at = (line: number, message: string): void => {
    lined.push([line, message])
  }

  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const reason = (e.message.split('\n')[0] ?? 'invalid YAML')
        .replace(/ at line \d+, column \d+:?$/, '')
        .replace(/:$/, '')
      at(lineAt(e.pos[0]), `invalid front matter (${reason})`)
    }
    return done(null)
  }

  // ADR 0011: YAML 1.2 core, nothing more. A node's anchor and tag come
  // before it, on its line or the one above: found in the text, backwards.
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      at(lineOf(node, top), `an alias (*${node.source}) ${FENCE}`)
      return
    }
    if (isPair(node)) {
      if (isScalar(node.key) && node.key.value === '<<')
        at(lineOf(node.key, top), `a merge key (<<) ${FENCE}`)
      return
    }
    if (!isNode(node)) return
    const start = node.range?.[0] ?? 0
    if (node.anchor !== undefined && node.anchor !== '')
      at(
        lineAt(block.yaml.lastIndexOf(`&${node.anchor}`, start)),
        `an anchor (&${node.anchor}) ${FENCE}`
      )
    if (node.tag !== undefined && !CORE_TAGS.has(node.tag))
      at(
        lineAt(block.yaml.lastIndexOf('!', start)),
        `a custom tag (${node.tag.startsWith(CORE) ? `!!${node.tag.slice(CORE.length)}` : node.tag}) ${FENCE}`
      )
    if (isMap(node)) {
      const seen = new Set<unknown>()
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue
        if (seen.has(pair.key.value))
          at(
            lineOf(pair.key, top),
            `a duplicate key (${shown(pair.key.value)}) ${FENCE}`
          )
        seen.add(pair.key.value)
      }
    }
  })
  if (lined.length > 0) return done(null)

  const root = doc.contents
  if (root !== null && !isMap(root)) {
    at(
      lineOf(root, block.line),
      'the front matter must be a mapping of keys to values'
    )
    return done(null)
  }
  const fields = new Map<string, { key: unknown; value: unknown }>()
  for (const pair of root?.items ?? []) {
    const key = valueOf(pair.key)
    if (has(POLICY_KEYS, key)) fields.set(key, pair)
    else
      at(
        lineOf(pair.key, top),
        `unknown key ${JSON.stringify(String(key))} (expected ${POLICY_KEYS.join(', ')})`
      )
  }
  /** The line of a key's value, else of the key. */
  const lineOfField = (field: { key: unknown; value: unknown }): number =>
    lineOf(field.value, lineOf(field.key, top))

  const statusField = fields.get('status')
  const status = valueOf(statusField?.value)
  if (statusField === undefined || missing(status))
    at(top, `missing "status" (${POLICY_STATUSES.join(' or ')})`)
  else if (!has(POLICY_STATUSES, status))
    at(
      lineOfField(statusField),
      `unknown status ${shown(status)} (expected ${POLICY_STATUSES.join(', ')})`
    )

  let standard: Inspected['standard'] = null
  const standardField = fields.get('standard')
  const standardPath = valueOf(standardField?.value)
  if (standardField !== undefined && !missing(standardPath)) {
    const line = lineOfField(standardField)
    if (
      typeof standardPath !== 'string' ||
      !RNESS_PATH.test(standardPath) ||
      !standardPath.startsWith('standards/') ||
      !standardPath.endsWith('.md')
    )
      at(
        line,
        '"standard" must be the path of a standard of .rness, as standards/<name>.md'
      )
    else standard = { path: standardPath, line }
  }

  for (const key of ['date', 'updated'] as const) {
    const field = fields.get(key)
    const value = valueOf(field?.value)
    if (field === undefined || missing(value)) continue
    if (typeof value !== 'string' || !ISO_DATE.test(value))
      at(lineOfField(field), `"${key}" must be an ISO date (YYYY-MM-DD)`)
  }

  function readRule(item: unknown, line: number): PolicyRule | null {
    if (!isMap(item)) {
      at(line, 'a rule is a mapping of check, deny and fix')
      return null
    }
    const keys = new Map<string, unknown>()
    for (const pair of item.items) {
      const key = valueOf(pair.key)
      if (has(RULE_KEYS, key)) keys.set(key, pair.value)
      else
        at(
          lineOf(pair.key, line),
          `unknown rule key ${JSON.stringify(String(key))} (expected ${RULE_KEYS.join(', ')})`
        )
    }
    let valid = true
    for (const key of RULE_KEYS)
      if (missing(valueOf(keys.get(key)))) {
        at(line, `a rule without "${key}"`)
        valid = false
      }
    const check = valueOf(keys.get('check'))
    const deny = valueOf(keys.get('deny'))
    const fix = valueOf(keys.get('fix'))
    if (!missing(check) && !has(POLICY_CHECKS, check)) {
      at(
        lineOf(keys.get('check'), line),
        `unknown check ${shown(check)} (expected ${POLICY_CHECKS.join(', ')})`
      )
      valid = false
    }
    const denyLine = lineOf(keys.get('deny'), line)
    if (!missing(deny)) {
      if (typeof deny !== 'string') {
        at(denyLine, '"deny" must be a string: quote it')
        valid = false
      } else if (check === 'push') {
        if (deny !== NON_FAST_FORWARD) {
          at(
            denyLine,
            `a push rule denies ${NON_FAST_FORWARD}, nothing else (not ${JSON.stringify(deny)})`
          )
          valid = false
        }
      } else
        try {
          new RegExp(deny, PATTERN_FLAGS)
        } catch (e) {
          at(
            denyLine,
            `"deny" does not compile with the flags ${PATTERN_FLAGS} (${e instanceof Error ? e.message : String(e)})`
          )
          valid = false
        }
    }
    if (!missing(fix)) {
      const fixLine = lineOf(keys.get('fix'), line)
      if (typeof fix !== 'string') {
        at(fixLine, '"fix" must be a string: quote it')
        valid = false
      } else if (/[\r\n]/.test(fix)) {
        at(fixLine, '"fix" must be one line: it is what the agent reads')
        valid = false
      }
    }
    return valid &&
      has(POLICY_CHECKS, check) &&
      typeof deny === 'string' &&
      typeof fix === 'string'
      ? { check, deny, fix }
      : null
  }

  const rules: PolicyRule[] = []
  const rulesField = fields.get('rules')
  const list = rulesField?.value
  if (rulesField === undefined || missing(valueOf(list)))
    at(top, 'missing "rules", a list of one rule or more')
  else if (!isSeq(list) || list.items.length === 0)
    at(lineOfField(rulesField), '"rules" must be a list of one rule or more')
  else
    for (const item of list.items) {
      const rule = readRule(item, lineOf(item, lineOfField(rulesField)))
      if (rule !== null) rules.push(rule)
    }

  return done(
    has(POLICY_STATUSES, status) && title !== null
      ? {
          name,
          rel,
          scope,
          title,
          status,
          standard: standard?.path ?? null,
          rules,
          body: bodyAfterTitle(content),
        }
      : null,
    standard
  )
}

/**
 * One policy file, `rel` its `.rness/`-relative path: the policy, or null
 * with what is wrong with the file itself. A policy with a problem of its
 * own is never applied (ADR 0011: the engine works on the validated object);
 * `validate` says why.
 */
export function readPolicy(rel: string, text: string): PolicyRead {
  const { policy, problems } = inspect(rel, text)
  return { policy, problems }
}

async function isFile(rnessDir: string, rel: string): Promise<boolean> {
  try {
    return (await stat(await containedPath(rnessDir, rel))).isFile()
  } catch {
    return false
  }
}

const isGlobal = (rel: string): boolean => rel.split('/').length === 2

/**
 * What `validate` refuses in the policies (spec 0040 §7), `items` those of
 * `policy/` as `collectMarkdown` reads them: each file's own problems, a
 * `standard` that is not there, a name both global and scoped (§2.3: a
 * scoped policy only adds). One line each, the file first.
 */
export async function checkPolicies(
  rnessDir: string,
  items: readonly MarkdownItem[]
): Promise<string[]> {
  const read = items.map((item) => {
    const rel = `policy/${item.rel}`
    return { rel, name: posix.basename(rel, '.md'), ...inspect(rel, item.body) }
  })
  const problems: string[] = []
  for (const file of read) {
    problems.push(...file.problems)
    if (file.standard !== null && !(await isFile(rnessDir, file.standard.path)))
      problems.push(
        `${file.rel}:${file.standard.line}: "standard" names ${file.standard.path}, which is not there`
      )
    const others = read
      .filter(
        (o) => o.name === file.name && isGlobal(o.rel) !== isGlobal(file.rel)
      )
      .map((o) => o.rel)
    if (others.length > 0)
      problems.push(
        `${file.rel}: the name ${file.name} is also that of ${others.join(', ')}: a policy is global or scoped, never both`
      )
  }
  return problems
}

export interface PolicyOptions {
  /** The `Disabled` policies too; by default only the `Enabled` ones. */
  withDisabled?: boolean
}

function policiesIn(
  files: readonly ContextFile[],
  { withDisabled = false }: PolicyOptions
): Policy[] {
  const policies: Policy[] = []
  for (const file of files) {
    const { policy } = readPolicy(`policy/${file.rel}`, file.body)
    if (policy !== null && (withDisabled || policy.status === 'Enabled'))
      policies.push(policy)
  }
  return policies
}

/** The policies of a context already assembled for one scope: the block's. */
export function policiesOf(
  context: Context,
  options: PolicyOptions = {}
): Policy[] {
  const files =
    context.collections.find((c) => c.name === 'policy')?.files ?? []
  return policiesIn(files, options)
}

/**
 * The policies that apply to a set of scopes (spec 0040 §2.3), resolved as
 * the other collections: the global ones, each scope's and those of what it
 * `extends`, nearest first, each once. No scope: the global ones. A file
 * with a problem of its own is left out. Throws on an `extends` cycle.
 */
export async function policiesFor(
  context: Pick<AssembleInput, 'rnessDir' | 'manifest'>,
  scopes: readonly string[],
  options: PolicyOptions = {}
): Promise<Policy[]> {
  const chain = [
    ...new Set(scopes.flatMap((s) => scopeChain(context.manifest, s))),
  ]
  const { files } = await assembleCollection(
    join(context.rnessDir, 'policy'),
    'policy',
    chain
  )
  return policiesIn(files, options)
}
