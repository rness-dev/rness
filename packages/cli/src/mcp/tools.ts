import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { collectMarkdown } from '../core/collect.ts'
import { COLLECTIONS, assembleContext, ownerScope } from '../core/context.ts'
import { STATUSES } from '../core/contract.ts'
import { loadManifest, workspaceName } from '../core/manifest.ts'
import { resolveScope } from '../core/scope.ts'
import type { CollectionName, Manifest, Workspace } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import type { McpTool } from './protocol.ts'

/**
 * The four read-only tools of `rness mcp` (spec 0014 §2), over the
 * workspace found from `cwd`. Everything is read again on each call: an
 * edit in `.rness/` shows at once. Text out, for a model to read.
 */

const LABELS: Record<CollectionName, string> = {
  standards: 'Standards',
  adr: 'Decisions',
  specs: 'Specifications',
  plans: 'Plans',
  skills: 'Skills',
}
/** The scaffold's ADR template is not a decision. */
const TEMPLATE = 'adr/0000-template.md'
const READ_LIMIT = 256 * 1024
const SEARCH_LIMIT = 20
const LINES_PER_HIT = 3
const LINE_WIDTH = 200

interface Doc {
  collection: CollectionName
  path: string
  scope: string | null
  id: string | null
  status: string | null
  title: string
  text: string
}

type Result = { text: string; isError?: boolean }
const refuse = (text: string): Result => ({ text, isError: true })

/** A failure (no workspace, an unreadable rness.json) is an answer too. */
async function guard(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run()
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e))
  }
}

async function workspaceAt(
  cwd: string
): Promise<{ ws: Workspace; manifest: Manifest }> {
  const ws = await findWorkspace(cwd)
  return { ws, manifest: await loadManifest(ws.rnessDir) }
}

/** The scaffold's heading is `NNNN — Title`; the id is shown once. */
function titleOf(heading: string, id: string | null): string {
  if (id === null) return heading
  const rest = new RegExp(`^${id}\\s*[—–:-]\\s*(.+)$`).exec(heading)?.[1]
  return rest ?? heading
}

async function documents(
  rnessDir: string,
  only?: CollectionName
): Promise<Doc[]> {
  const docs: Doc[] = []
  for (const collection of COLLECTIONS) {
    if (only !== undefined && collection !== only) continue
    for (const item of await collectMarkdown(join(rnessDir, collection))) {
      const path = `${collection}/${item.rel}`
      if (path === TEMPLATE) continue
      const status = item.fields?.['status']
      const id = /^(\d{4})-/.exec(posix.basename(item.rel))?.[1] ?? null
      docs.push({
        collection,
        path,
        scope: ownerScope(item.rel),
        id,
        status: typeof status === 'string' ? status : null,
        title: titleOf(item.title ?? posix.basename(item.rel, '.md'), id),
        text: item.body,
      })
    }
  }
  return docs
}

function line(d: Doc, withScope = false): string {
  const head = [d.id, d.status].filter((x) => x !== null).join(' ')
  return `- ${head === '' ? '' : `${head} — `}${d.title}${withScope ? ` — ${d.scope ?? 'global'}` : ''} — ${d.path}`
}

function isCollection(value: unknown): value is CollectionName {
  return (COLLECTIONS as readonly unknown[]).includes(value)
}

const collectionError = (value: unknown): Result =>
  refuse(
    `unknown collection ${JSON.stringify(value)}; one of ${COLLECTIONS.join(', ')}`
  )

async function context(cwd: string, args: Record<string, unknown>) {
  const { ws, manifest } = await workspaceAt(cwd)
  let scope: string | null
  if (args['scope'] !== undefined) {
    const known = Object.keys(manifest.scopes).sort()
    if (
      typeof args['scope'] !== 'string' ||
      !Object.hasOwn(manifest.scopes, args['scope'])
    )
      return refuse(
        `unknown scope ${JSON.stringify(args['scope'])}; known: ${known.length === 0 ? 'none' : known.join(', ')}`
      )
    scope = args['scope']
  } else
    scope = resolveScope(
      manifest,
      relative(ws.root, cwd).split(sep).join(posix.sep)
    )
  const entry = scope === null ? undefined : manifest.scopes[scope]
  const where =
    scope === null || entry === undefined
      ? 'global scope'
      : `scope ${scope} (${entry.path}${entry.extends.length > 0 ? `, extends ${entry.extends.join(', ')}` : ''})`
  const ctx = await assembleContext({ rnessDir: ws.rnessDir, manifest, scope })
  const index = new Map(
    (await documents(ws.rnessDir)).map((d) => [d.path, d] as const)
  )
  const out = [`Workspace ${workspaceName(manifest, ws.root)} · ${where}`]
  for (const collection of ctx.collections) {
    const docs = collection.files
      .map((f) => index.get(`${collection.name}/${f.rel}`))
      .filter((d): d is Doc => d !== undefined)
    if (docs.length === 0) continue
    out.push(`${LABELS[collection.name]} (${docs.length}):`)
    for (const d of docs) out.push(line(d))
  }
  out.push('Read one with rness_read; search with rness_search.')
  return { text: out.join('\n') }
}

async function list(cwd: string, args: Record<string, unknown>) {
  const { ws } = await workspaceAt(cwd)
  const collection = args['collection']
  if (!isCollection(collection)) return collectionError(collection)
  const status = args['status']
  const allowed = STATUSES[collection]
  if (status !== undefined) {
    if (allowed === undefined)
      return refuse(`${collection} have no status to filter on`)
    if (typeof status !== 'string' || !allowed.includes(status))
      return refuse(
        `unknown status ${JSON.stringify(status)} for ${collection}; one of ${allowed.join(', ')}`
      )
  }
  const docs = (await documents(ws.rnessDir, collection)).filter(
    (d) => status === undefined || d.status === status
  )
  if (docs.length === 0)
    return {
      text: `No document in ${collection}${status === undefined ? '' : ` with status ${String(status)}`}.`,
    }
  return {
    text: [
      `${LABELS[collection]} (${docs.length}):`,
      ...docs.map((d) => line(d, true)),
    ].join('\n'),
  }
}

async function read(cwd: string, args: Record<string, unknown>) {
  const { ws } = await workspaceAt(cwd)
  const path = args['path']
  if (typeof path !== 'string' || path.trim() === '')
    return refuse('path is required, relative to .rness/')
  const segments = path.split(/[\\/]/)
  if (
    isAbsolute(path) ||
    segments.includes('..') ||
    segments[0] === '.git' ||
    segments.includes('node_modules')
  )
    return refuse(
      `${path}: not a document of .rness/ (a relative path, no "..", nothing under .git/ or node_modules/)`
    )
  const root = await realpath(ws.rnessDir)
  let real: string
  try {
    real = await realpath(resolve(ws.rnessDir, path))
  } catch {
    return refuse(`${path}: no such file in .rness/`)
  }
  if (!real.startsWith(`${root}${sep}`))
    return refuse(`${path}: leads outside .rness/`)
  const info = await stat(real)
  if (!info.isFile()) return refuse(`${path}: not a file`)
  if (info.size > READ_LIMIT)
    return refuse(
      `${path}: ${info.size} bytes, over the 256 KiB rness_read returns`
    )
  return { text: await readFile(real, 'utf8') }
}

async function search(cwd: string, args: Record<string, unknown>) {
  const { ws } = await workspaceAt(cwd)
  const query = args['query']
  if (typeof query !== 'string' || query.trim() === '')
    return refuse('query is required')
  const collection = args['collection']
  if (collection !== undefined && !isCollection(collection))
    return collectionError(collection)
  const needle = query.toLowerCase()
  const hits = (await documents(ws.rnessDir, collection))
    .map((d) => ({
      d,
      lines: d.text
        .split(/\r?\n/)
        .map((text, i) => ({ n: i + 1, text }))
        .filter((l) => l.text.toLowerCase().includes(needle)),
    }))
    .filter((h) => h.lines.length > 0)
    .sort(
      (a, b) =>
        b.lines.length - a.lines.length || a.d.path.localeCompare(b.d.path)
    )
  if (hits.length === 0)
    return { text: `No document matches ${JSON.stringify(query)}.` }
  const shown = hits.slice(0, SEARCH_LIMIT)
  const out = [
    `${hits.length} document${hits.length === 1 ? '' : 's'} match${hits.length === 1 ? 'es' : ''} ${JSON.stringify(query)}${hits.length > SEARCH_LIMIT ? ` (the ${SEARCH_LIMIT} most matching)` : ''}`,
  ]
  for (const h of shown) {
    out.push(line(h.d, true))
    for (const l of h.lines.slice(0, LINES_PER_HIT))
      out.push(`  ${l.n}: ${l.text.trim().slice(0, LINE_WIDTH)}`)
  }
  return { text: out.join('\n') }
}

const collectionProperty = {
  type: 'string',
  enum: [...COLLECTIONS],
  description:
    'standards (rules), adr (decisions), specs (specifications), plans, skills',
}

export function mcpTools(cwd: string): McpTool[] {
  return [
    {
      name: 'rness_context',
      title: 'rness: what applies here',
      description:
        'The rness scope of the current repository (or the one named) and what applies to it: the standards, decisions (ADRs), specifications and plans of that scope and of the scopes it extends — ids, statuses, titles and paths, no bodies. Start here, then read a document with rness_read.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description:
              'A scope of rness.json; default: the one owning the working directory',
          },
        },
        additionalProperties: false,
      },
      call: (args) => guard(() => context(cwd, args)),
    },
    {
      name: 'rness_list',
      title: 'rness: a collection',
      description:
        'Every document of one collection of .rness/, across all scopes, with id, status, title, scope and path; optionally only those with a given status (for example the Accepted decisions).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: collectionProperty,
          status: {
            type: 'string',
            description:
              'adr: Proposed, Accepted, Rejected, Superseded; specs: Draft, Proposed, Approved, Implemented, Superseded, Rejected; plans: Draft, Ready, In progress, Blocked, Completed, Abandoned',
          },
        },
        required: ['collection'],
        additionalProperties: false,
      },
      call: (args) => guard(() => list(cwd, args)),
    },
    {
      name: 'rness_read',
      title: 'rness: read a document',
      description:
        'One file of .rness/ as it is, by its path relative to .rness/ (as rness_context, rness_list and rness_search give it). Nothing outside .rness/.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'For example adr/0006-workspace.md',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      call: (args) => guard(() => read(cwd, args)),
    },
    {
      name: 'rness_search',
      title: 'rness: search the context',
      description:
        'Where a subject is decided, specified or planned: a case-insensitive search of the documents of .rness/, most matching first, with the matching lines.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find' },
          collection: collectionProperty,
        },
        required: ['query'],
        additionalProperties: false,
      },
      call: (args) => guard(() => search(cwd, args)),
    },
  ]
}
