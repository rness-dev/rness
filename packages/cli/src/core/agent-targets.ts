import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type AgentTarget, type Guarantee, TARGETS } from './agents.ts'
import { exists, readOrNull, writeFileAtomic } from './fs.ts'
import {
  describeGuarantee,
  ensureGuarantees,
  missingGuarantees,
} from './json-guarantees.ts'
import type { Manifest } from './types.ts'

/** What one target file turned out to be, as `sync` and `validate` say it. */
export interface TargetOutcome {
  /** Workspace-relative: `org/<repo>/.claude/settings.json`. */
  label: string
  status: 'updated' | 'unchanged' | 'stale' | 'invalid'
  /** What is missing (stale) or why the file is refused (invalid). */
  detail: string | null
}

interface OwnedFile {
  guarantees: readonly Guarantee[]
  file: string
  label: string
}

/**
 * Every file the given targets own a part of: the workspace root's first
 * (spec 0015 §2.1), then one per target and per repository of the catalogue
 * that is cloned under `org/`. The root of a clone only — a nested scope's
 * path to `.rness` is not verified (spec 0011 §5).
 */
async function filesOf(
  root: string,
  manifest: Manifest,
  targets: readonly AgentTarget[]
): Promise<OwnedFile[]> {
  const files: OwnedFile[] = []
  for (const target of targets)
    for (const owned of target.files)
      if (owned.at === 'root')
        files.push({
          guarantees: owned.guarantees,
          file: join(root, ...owned.file.split('/')),
          label: owned.file,
        })
  for (const repo of Object.keys(manifest.repos)) {
    if (!(await exists(join(root, 'org', repo)))) continue
    for (const target of targets)
      for (const owned of target.files)
        if (owned.at === 'clones')
          files.push({
            guarantees: owned.guarantees,
            file: join(root, 'org', repo, ...owned.file.split('/')),
            label: `org/${repo}/${owned.file}`,
          })
  }
  return files
}

function declared(manifest: Manifest): AgentTarget[] {
  return (manifest.agents ?? []).flatMap((name) =>
    Object.hasOwn(TARGETS, name) ? [TARGETS[name] as AgentTarget] : []
  )
}

/** The files holding the generated block, in every clone. */
export const BLOCK_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md']

/**
 * Every file `sync` writes in a clone, relative to it: the block's, and the
 * declared agents' (spec 0011 §3.3). Not the workspace root's: it is in no
 * repository (spec 0015 §2.1).
 */
export function writtenFiles(manifest: Manifest): string[] {
  return [
    ...BLOCK_FILES,
    ...declared(manifest).flatMap((t) =>
      t.files.filter((f) => f.at === 'clones').map((f) => f.file)
    ),
  ]
}

/**
 * Compile the declared agents into every clone (spec 0011 §3.3), or with
 * `check` only say what is missing. Unsupported names are the caller's to
 * refuse; they are skipped here.
 */
export async function agentTargets(
  root: string,
  manifest: Manifest,
  opts: { check: boolean }
): Promise<TargetOutcome[]> {
  const outcomes: TargetOutcome[] = []
  for (const { guarantees, file, label } of await filesOf(
    root,
    manifest,
    declared(manifest)
  )) {
    const existing = await readOrNull(file)
    if (opts.check) {
      const missing = missingGuarantees(existing, guarantees)
      if ('invalid' in missing)
        outcomes.push({ label, status: 'invalid', detail: missing.invalid })
      else if (missing.length > 0)
        outcomes.push({
          label,
          status: 'stale',
          detail: missing.map(describeGuarantee).join('; '),
        })
      else outcomes.push({ label, status: 'unchanged', detail: null })
      continue
    }
    const ensured = ensureGuarantees(existing, guarantees)
    if (ensured.kind === 'invalid') {
      outcomes.push({ label, status: 'invalid', detail: ensured.reason })
      continue
    }
    if (ensured.kind === 'unchanged') {
      outcomes.push({ label, status: 'unchanged', detail: null })
      continue
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, ensured.text)
    outcomes.push({ label, status: 'updated', detail: null })
  }
  return outcomes
}

/**
 * Files that still carry every value of a target the team no longer
 * declares. rness cannot tell its entries from the team's, so it leaves them
 * and says where they are (spec 0011 §3.4). Nothing when `agents` was never
 * set: a file written by hand is none of rness's business then.
 */
export async function leftoverTargets(
  root: string,
  manifest: Manifest
): Promise<string[]> {
  if (manifest.agents === null) return []
  const agents = manifest.agents
  const undeclared = Object.values(TARGETS).filter(
    (t) => !agents.includes(t.name)
  )
  const leftovers: string[] = []
  for (const { guarantees, file, label } of await filesOf(
    root,
    manifest,
    undeclared
  )) {
    const existing = await readOrNull(file)
    if (existing === null) continue
    const missing = missingGuarantees(existing, guarantees)
    if (!('invalid' in missing) && missing.length === 0) leftovers.push(label)
  }
  return leftovers
}
