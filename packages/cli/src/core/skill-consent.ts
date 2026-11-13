import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { exists, writeFileAtomic } from './fs.ts'
import { gitPath } from './git.ts'
import { repositories } from './manifest.ts'
import {
  type TeamSkill,
  checkSkillDir,
  hashSkillDir,
  skillsForClone,
  teamSkills,
} from './skills.ts'
import type { Manifest, Workspace } from './types.ts'

// The developer's consent to team skills (spec 0041 §5): one record in the
// git directory of `.rness`, never committed, mapping each skill to the
// content hash the developer accepted or declined.

export type ConsentAnswer = 'accepted' | 'declined'

export interface ConsentEntry {
  hash: string
  answer: ConsentAnswer
  /** `YYYY-MM-DD`. */
  date: string
}

export interface Consent {
  version: 1
  /** By skill id (`skillId`): the last answer only. */
  skills: Record<string, ConsentEntry>
}

/**
 * installed = accepted at the current hash; changed = accepted at another
 * one (pending); invalid = the copy is missing or fails the checks of
 * spec 0041 §4: it cannot be offered or installed, `validate` says why.
 */
export type SkillState =
  'installed' | 'declined' | 'pending' | 'changed' | 'invalid'

/** A team skill that applies to this workspace, with what the consent decides on. */
export interface AppliedSkill {
  id: string
  skill: TeamSkill
  /** The hash of the copy in `.rness` now; null when the copy is invalid. */
  hash: string | null
  state: SkillState
  /** Why the copy is invalid (the check's message); set exactly when `state` is `invalid`. */
  problem?: string
}

/** An applied skill whose copy passed the checks: it has a hash and can be offered. */
export const isValid = (
  a: AppliedSkill
): a is AppliedSkill & { hash: string } => a.hash !== null

/** The record's key: `<name>` at the top, `<scope>/<name>` for a scope's skill (two repositories may each declare `deploy`). */
export const skillId = (skill: TeamSkill): string =>
  skill.scope === null ? skill.name : `${skill.scope}/${skill.name}`

/** The record's file; refused when `.rness` has no git directory. */
export async function consentFile(rnessDir: string): Promise<string> {
  const file = await gitPath(rnessDir, 'rness/skills.json')
  if (file === null)
    throw new Error(
      `${rnessDir} is not a git repository: the consent to team skills is kept in its git directory`
    )
  return file
}

const isEntry = (v: unknown): v is ConsentEntry => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e['hash'] === 'string' &&
    (e['answer'] === 'accepted' || e['answer'] === 'declined') &&
    typeof e['date'] === 'string'
  )
}

/**
 * The developer's record. Missing reads as empty; an unreadable one too,
 * after `onUnreadable` (called once) says so: a damaged record asks the
 * questions again, it never stops a command.
 */
export async function readConsent(
  rnessDir: string,
  onUnreadable?: (file: string) => void
): Promise<Consent> {
  const file = await consentFile(rnessDir)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, skills: {} }
    onUnreadable?.(file)
    return { version: 1, skills: {} }
  }
  try {
    const data: unknown = JSON.parse(text)
    const skills = (data as { skills?: unknown }).skills
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { version?: unknown }).version !== 1 ||
      typeof skills !== 'object' ||
      skills === null ||
      !Object.values(skills).every(isEntry)
    )
      throw new Error('not a consent record')
    return {
      version: 1,
      skills: { ...(skills as Record<string, ConsentEntry>) },
    }
  } catch {
    onUnreadable?.(file)
    return { version: 1, skills: {} }
  }
}

export async function writeConsent(
  rnessDir: string,
  consent: Consent
): Promise<void> {
  const file = await consentFile(rnessDir)
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(consent, null, 2)}\n`)
}

export function stateOf(
  consent: Consent,
  id: string,
  hash: string
): SkillState {
  const entry = Object.hasOwn(consent.skills, id)
    ? consent.skills[id]
    : undefined
  if (entry === undefined) return 'pending'
  if (entry.hash === hash)
    return entry.answer === 'accepted' ? 'installed' : 'declined'
  return entry.answer === 'accepted' ? 'changed' : 'pending'
}

/** A skill awaits the developer's answer. */
export const isPending = (state: SkillState): boolean =>
  state === 'pending' || state === 'changed'

/**
 * The team skills that apply to this workspace: the top-level ones, and
 * those of each repository of `rness.json` whose clone `org/<repo>` exists
 * (parts included), each with the hash of its copy and its state for the
 * developer. The order is that of `teamSkills`.
 */
export async function appliedSkills(
  ws: Workspace,
  manifest: Manifest,
  consent: Consent
): Promise<AppliedSkill[]> {
  const all = await teamSkills(ws.rnessDir, manifest)
  const applying = new Set(all.filter((s) => s.scope === null))
  for (const repo of repositories(manifest))
    if (await exists(join(ws.root, repo.dir)))
      for (const s of skillsForClone(manifest, all, repo.name)) applying.add(s)
  const applied: AppliedSkill[] = []
  for (const skill of all.filter((s) => applying.has(s))) {
    const id = skillId(skill)
    try {
      if (!(await exists(skill.dir)))
        throw new Error(`skill "${skill.name}": its copy is missing`)
      await checkSkillDir(skill.dir, skill.name)
      const hash = await hashSkillDir(skill.dir)
      applied.push({ id, skill, hash, state: stateOf(consent, id, hash) })
    } catch (e) {
      applied.push({
        id,
        skill,
        hash: null,
        state: 'invalid',
        problem: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return applied
}

/** How many of `applied` await an answer (the `sync` line, the session start). */
export const pendingCount = (applied: readonly AppliedSkill[]): number =>
  applied.filter((a) => isPending(a.state)).length

/** `source@ref`, the ref as given or the commit's first 7 characters; the source alone for `path:`. */
export const versionOf = (
  source: string,
  ref: string | undefined,
  commit: string | null | undefined
): string =>
  source.startsWith('path:')
    ? source
    : `${source}@${ref ?? commit?.slice(0, 7) ?? 'HEAD'}`

/** Where a skill comes from: its source and version, or "written by the team". */
export const originOf = (skill: TeamSkill): string =>
  skill.entry === null
    ? 'written by the team'
    : versionOf(skill.entry.source, skill.entry.ref, skill.entry.commit)
