import { join } from 'node:path'

import { BLOCK_FILES } from './agent-targets.ts'
import { BLOCK_SIZE_WARNING, isCurrentBlock, renderBlock } from './block.ts'
import { assembleContext } from './context.ts'
import { exists, isSymlink, readOrNull, writeFileAtomic } from './fs.ts'
import { providerOf, repositories, workspaceName } from './manifest.ts'
import {
  type MergeResult,
  claudeMdAtRoot,
  ensureClaudeMd,
  findBlock,
  mergeBlock,
} from './merge.ts'
import { rnessCommand } from './pm.ts'
import { blockSkills } from './skills.ts'
import type { Manifest, Workspace } from './types.ts'
import type { Line } from './ui.ts'
import { orgDirs } from './workspace.ts'

interface Target {
  scope: string | null
  dir: string
  depth: number
  label: string
}

function targetsOf(
  manifest: Manifest,
  root: string,
  only: string | undefined
): Target[] {
  const targets: Target[] = []
  if (only === undefined)
    targets.push({ scope: null, dir: root, depth: 0, label: 'AGENTS.md' })
  for (const [name, entry] of Object.entries(manifest.scopes)) {
    if (only !== undefined && name !== only) continue
    const segments = entry.path.split('/')
    targets.push({
      scope: name,
      dir: join(root, ...segments),
      depth: segments.length,
      label: `${entry.path}/AGENTS.md`,
    })
  }
  return targets
}

/**
 * Bring one file's rness block up to date, or, in `check`, only say whether
 * it is. Current by its hash, not by its text: a block an older CLI wrote,
 * whose header still names that version, is left byte for byte. At the root
 * `CLAUDE.md` a leftover `@AGENTS.md` pointer also makes it out of date.
 */
async function syncBlockFile(
  file: string,
  block: { text: string; hash: string },
  check: boolean,
  rootClaudeMd = false
): Promise<'unchanged' | 'stale' | 'updated' | { error: string }> {
  const existing = await readOrNull(file)
  const existingLines = existing === null ? [] : existing.split(/\r?\n/)
  const span = findBlock(existingLines)
  const current =
    span.kind === 'one' &&
    isCurrentBlock(existingLines.slice(span.begin, span.end + 1), block.hash) &&
    !(rootClaudeMd && existingLines.some((l) => l.trim() === '@AGENTS.md'))
  const merged: MergeResult = current
    ? { ok: true, text: existing ?? '', changed: false }
    : rootClaudeMd
      ? claudeMdAtRoot(existing, block.text)
      : mergeBlock(existing, block.text)
  if (!merged.ok) return { error: merged.error }
  if (!merged.changed) return 'unchanged'
  if (check) return 'stale'
  await writeFileAtomic(file, merged.text)
  return 'updated'
}

/**
 * Which declared repositories have no usable clone. `misnamed`: a directory
 * that differs from the declared name only by case (`org/dApp` for `dapp`):
 * not missing (cloning `org/dapp` would fail where the file system ignores
 * case), and it gets no block until `rness add` renames it. `missing`: the
 * others declared with no directory at all.
 */
export function missingClones(
  manifest: Manifest,
  clones: ReadonlySet<string>,
  unread: readonly string[]
): { misnamed: Set<string>; missing: string[] } {
  const repos = repositories(manifest).map((r) => r.name)
  const declared = new Set(repos)
  const misnamed = new Set(
    unread
      .map((d) => d.toLowerCase())
      .filter((n) => declared.has(n) && !clones.has(n))
  )
  return {
    misnamed,
    missing: repos.filter((n) => !clones.has(n) && !misnamed.has(n)),
  }
}

/** What one pass over the blocks said, and could not do. */
export interface WrittenBlocks {
  lines: (Line | string)[]
  problems: string[]
  /** Blocks that differ from what would be written (what `check` counts). */
  differences: number
}

/**
 * Write the rness block into the AGENTS.md (and the root CLAUDE.md) of the
 * workspace and of each clone, or, in `check`, only say which differ. The
 * step of `sync` that touches the blocks, and nothing else: no clone, no
 * pull, no hook, no skill.
 */
export async function writeBlocks(input: {
  ws: Workspace
  manifest: Manifest
  org: string
  scope: string | undefined
  check: boolean
  /** Clones whose directory differs from the declared name by case: they wait for the rename. */
  misnamed: ReadonlySet<string>
  /** Declared repositories with no clone: their scopes are covered by a `not cloned:` line. */
  notCloned: ReadonlySet<string>
  warn: (text: string) => void
}): Promise<WrittenBlocks> {
  const { ws, manifest, org, check, misnamed, notCloned, warn } = input
  let differences = 0
  const lines: (Line | string)[] = []
  const problems: string[] = []
  for (const t of targetsOf(manifest, ws.root, input.scope)) {
    // `exists()` would find `org/dApp` for `org/dapp` on macOS: the
    // block waits for the rename, on every system alike.
    const owner = t.label.startsWith('org/') ? t.label.split('/')[1] : undefined
    if (owner !== undefined && misnamed.has(owner)) continue
    if (!(await exists(t.dir))) {
      // A scope inside a repository that is not cloned is covered by
      // the `not cloned:` line; only a directory missing from a present
      // clone (or from no repository at all) is worth its own line.
      const repo = t.label.split('/')[1]
      if (
        !t.label.startsWith('org/') ||
        repo === undefined ||
        !notCloned.has(repo)
      )
        lines.push(['skipped', `${t.label} (directory not present)`])
      continue
    }
    // In a scope, one of the pair symlinked to the other (the common
    // `CLAUDE.md → AGENTS.md`) leaves the directory untouched: reading
    // follows the link, and the atomic rename would replace the link with
    // a duplicate of its target. At the root a link is still never
    // rewritten, but the other file is (spec 0011 §2).
    const [agentsLinked, claudeLinked] = await Promise.all(
      BLOCK_FILES.map((f) => isSymlink(join(t.dir, f)))
    )
    const atRoot = t.scope === null
    if (!atRoot && (agentsLinked === true || claudeLinked === true)) {
      lines.push(['skipped', `${t.label} (symlink)`])
      continue
    }
    const context = await assembleContext({
      rnessDir: ws.rnessDir,
      manifest,
      scope: t.scope,
    })
    const block = renderBlock({
      scope: t.scope,
      org,
      depth: t.depth,
      context,
      skills: await blockSkills(ws.rnessDir, manifest, t.scope),
    })
    if (block.bytes > BLOCK_SIZE_WARNING) {
      warn(
        `${t.label}: block is ${Math.round(block.bytes / 1024)} KB (over 32 KB)`
      )
    }
    const agents =
      agentsLinked === true
        ? 'skipped'
        : await syncBlockFile(join(t.dir, 'AGENTS.md'), block, check)
    if (typeof agents === 'object') {
      problems.push(`${t.label}: ${agents.error}`)
      continue
    }
    lines.push(
      agents === 'skipped'
        ? ['skipped', `${t.label} (symlink)`]
        : [agents, t.label]
    )
    if (agents === 'stale') differences += 1
    if (!atRoot) {
      if (!check) await ensureClaudeMd(t.dir)
      continue
    }
    // The root CLAUDE.md follows the root AGENTS.md: its line is said
    // only when its status differs (a pointer converted, a hand edit).
    if (claudeLinked === true) continue
    const claude = await syncBlockFile(
      join(t.dir, 'CLAUDE.md'),
      block,
      check,
      true
    )
    if (typeof claude === 'object') {
      problems.push(`CLAUDE.md: ${claude.error}`)
      continue
    }
    if (claude === 'stale') differences += 1
    if (claude !== agents) lines.push([claude, 'CLAUDE.md'])
  }
  return { lines, problems, differences }
}

/**
 * The blocks after a change of the team's skills (spec 0041 §7): the root's
 * and the clones', as `sync` writes them, said in its style; the lines of
 * what was rewritten only. Nothing is cloned, pulled or installed.
 */
export async function refreshBlocks(
  ws: Workspace,
  manifest: Manifest,
  warn: (text: string) => void
): Promise<{ lines: Line[]; problems: string[] }> {
  // A standalone context checkout has no org/ and no block to refresh.
  if (!(await exists(join(ws.root, 'org')))) return { lines: [], problems: [] }
  const { clones, unread } = await orgDirs(ws.root, providerOf(manifest))
  const { misnamed, missing } = missingClones(manifest, clones, unread)
  const written = await writeBlocks({
    ws,
    manifest,
    org: workspaceName(manifest, ws.root),
    scope: undefined,
    check: false,
    misnamed,
    notCloned: new Set(missing),
    warn,
  })
  return {
    lines: written.lines.filter(
      (l): l is Line => typeof l !== 'string' && l[0] === 'updated'
    ),
    problems: written.problems.map((p) => `${p}; run ${rnessCommand()} sync`),
  }
}
