import { posix, relative, resolve, sep } from 'node:path'

import { BLOCK_FILES, wholeFileContents } from './agent-targets.ts'
import { renderBlock } from './block.ts'
import { assembleContext } from './context.ts'
import { ownedWhole } from './edit-guard.ts'
import { workspaceName } from './manifest.ts'
import type { AddedLinesFile } from './policy-check.ts'
import { type Policy, policiesFor } from './policy.ts'
import { resolveScope } from './scope.ts'
import { type ListedSkill, blockSkillsOf, listedSkills } from './skills.ts'
import type { Manifest, Workspace } from './types.ts'

/**
 * What the policy checker needs to know of a workspace (spec 0040 §2.3, §3):
 * where a work tree stands, which policies apply to a path, and what proves
 * a file or a block is rness's own output. The git hooks (`rness policy
 * check`) and the Claude Code guard both ask here; paths are
 * workspace-relative and POSIX, as `checkAddedLines` takes them.
 */

export interface PolicyWorkspace extends Workspace {
  manifest: Manifest
}

/** Where a work tree stands in the workspace. */
export type WorkTreePlace =
  /** `.rness` itself: the global policies. */
  | { kind: 'context'; prefix: string }
  /** A clone holding scopes of `rness.json`: theirs. */
  | { kind: 'clone'; prefix: string; scopes: string[] }
  /** A directory that is no scope: nothing is checked there. */
  | { kind: 'outside'; prefix: string }

const toPosix = (p: string): string => p.split(sep).join(posix.sep)

/**
 * Whether `outer` is `inner` or holds it, segment by segment, whatever the
 * case. `org/Web` is clone `org/web` where the file system ignores case
 * (macOS by default); where it does not, taking it for that clone applies
 * the clone's policies all the same: a policy fails closed on a name.
 */
const holds = (outer: string, inner: string): boolean => {
  const o = outer.toLowerCase()
  const i = inner.toLowerCase()
  return i === o || i.startsWith(`${o}/`)
}

/**
 * The place of the work tree at `dir`: `.rness`, a clone with the scopes
 * whose path is its own or under it (a monorepo's packages), whatever the
 * case, or neither.
 */
export function placeOf(ws: PolicyWorkspace, dir: string): WorkTreePlace {
  const prefix = toPosix(relative(ws.root, resolve(dir)))
  if (resolve(dir) === resolve(ws.rnessDir)) return { kind: 'context', prefix }
  const scopes = Object.entries(ws.manifest.scopes)
    .filter(([, e]) => holds(prefix, e.path))
    .map(([name]) => name)
  return scopes.length === 0
    ? { kind: 'outside', prefix }
    : { kind: 'clone', prefix, scopes }
}

/** The scopes a commit message or a push of this place answers to: all of the clone's. */
export function scopesOf(place: WorkTreePlace): string[] {
  return place.kind === 'clone' ? place.scopes : []
}

/**
 * Whether `path` lies in a clone of `org/` that holds no scope: there, as
 * for its hooks (`placeOf` says `outside`), no policy applies.
 */
function inUndeclaredClone(ws: PolicyWorkspace, path: string): boolean {
  const [top, name, ...rest] = path.split('/')
  if (top !== 'org' || name === undefined || rest.length === 0) return false
  return placeOf(ws, resolve(ws.root, 'org', name)).kind === 'outside'
}

/**
 * The enabled policies of each path's own scope, the deepest whose path
 * holds it whatever the case (the global ones for a path in no scope),
 * read once per scope. A path in a clone that holds no scope, or not given
 * here, gets none.
 */
export async function policiesByPath(
  ws: PolicyWorkspace,
  paths: readonly string[]
): Promise<(path: string) => readonly Policy[]> {
  const scopeOf = new Map<string, string | null>()
  const byScope = new Map<string | null, Policy[]>()
  // The scopes' paths in lower case, so that `resolveScope` matches as `holds` does.
  const lowered = {
    ...ws.manifest,
    scopes: Object.fromEntries(
      Object.entries(ws.manifest.scopes).map(([name, e]) => [
        name,
        { ...e, path: e.path.toLowerCase() },
      ])
    ),
  }
  for (const path of paths) {
    if (inUndeclaredClone(ws, path)) continue
    const scope = resolveScope(lowered, path.toLowerCase())
    scopeOf.set(path, scope)
    if (!byScope.has(scope))
      byScope.set(scope, await policiesFor(ws, scope === null ? [] : [scope]))
  }
  return (path) => {
    const scope = scopeOf.get(path)
    return scope === undefined ? [] : (byScope.get(scope) ?? [])
  }
}

/**
 * The hash of the block `sync` writes in a block file of this path, from a
 * fresh render, as sync renders it: the root's (global) and each scope's,
 * at the scope's own directory. Null where sync writes no block. `listed`:
 * the team skills already checked for this run (`listedSkills`).
 */
export async function freshBlockHash(
  ws: PolicyWorkspace,
  path: string,
  listed?: () => Promise<readonly ListedSkill[]>
): Promise<string | null> {
  if (!BLOCK_FILES.includes(posix.basename(path))) return null
  const dir = posix.dirname(path)
  let scope: string | null = null
  if (dir !== '.') {
    const found = Object.entries(ws.manifest.scopes).find(
      ([, e]) => e.path === dir
    )
    if (found === undefined) return null
    scope = found[0]
  }
  const context = await assembleContext({
    rnessDir: ws.rnessDir,
    manifest: ws.manifest,
    scope,
  })
  return renderBlock({
    scope,
    org: workspaceName(ws.manifest, ws.root),
    depth: dir === '.' ? 0 : dir.split('/').length,
    context,
    skills: blockSkillsOf(
      ws.manifest,
      await (listed?.() ?? listedSkills(ws.rnessDir, ws.manifest)),
      scope
    ),
  }).hash
}

/**
 * What proves, for these paths, that a change is rness's own output: a file
 * `sync` writes whole whose text is the one it writes, and the block a fresh
 * render gives. Both read the workspace now; the checker asks them by path.
 */
export async function rnessOutputProofs(
  ws: PolicyWorkspace,
  paths: readonly string[]
): Promise<
  Required<Pick<AddedLinesFile, 'isRnessOutput' | 'expectedBlockHash'>>
> {
  const whole = paths.some(ownedWhole)
    ? await wholeFileContents(ws.root, ws.manifest)
    : new Map<string, string>()
  const hashes = new Map<string, string>()
  let listed: Promise<ListedSkill[]> | undefined
  const once = (): Promise<ListedSkill[]> =>
    (listed ??= listedSkills(ws.rnessDir, ws.manifest))
  for (const path of new Set(paths)) {
    const hash = await freshBlockHash(ws, path, once)
    if (hash !== null) hashes.set(path, hash)
  }
  return {
    isRnessOutput: (path, after) =>
      ownedWhole(path) && whole.has(path) && whole.get(path) === after,
    expectedBlockHash: (path) => hashes.get(path) ?? null,
  }
}
