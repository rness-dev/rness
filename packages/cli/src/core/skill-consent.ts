import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { exists, writeFileAtomic } from './fs.ts'
import { gitPath } from './git.ts'
import { repositories } from './manifest.ts'
import {
  type SkillTree,
  type TeamSkill,
  plainText,
  quoted,
  reservedNameProblem,
  skillsAtHead,
  skillsForClone,
  teamSkills,
} from './skills.ts'
import type { Manifest, Workspace } from './types.ts'

// The developer's consent to team skills (spec 0041 §5, decision 9): one
// record in the git directory of `.rness`, never committed, holding one
// answer per skill. An accepted skill's new versions install without a new
// question; a declined one stays declined, whatever its version.

export type ConsentAnswer = 'accepted' | 'declined'

export interface ConsentEntry {
  answer: ConsentAnswer
  /** `YYYY-MM-DD`. */
  date: string
  /** The tree accepted, for information: a new version needs no new answer. */
  tree?: string
}

export interface Consent {
  version: 1
  /** By skill id (`skillId`): the last answer only. */
  skills: Record<string, ConsentEntry>
}

/**
 * installed = accepted; pending = no answer yet; invalid = the copy
 * committed at `HEAD` of `.rness` fails the checks of spec 0041 §4, or the
 * skill is not committed there yet: it cannot be offered or installed.
 */
export type SkillState = 'installed' | 'declined' | 'pending' | 'invalid'

/** A team skill that applies to this workspace, with what the consent decides on. */
export interface AppliedSkill {
  id: string
  skill: TeamSkill
  /** The copy committed at `HEAD` of `.rness`, checked: what is installed; null when the state is `invalid`. */
  head: SkillTree | null
  state: SkillState
  /** Why it is invalid (the check's message, or `commit .rness first`); set exactly when `state` is `invalid`. */
  problem?: string
  /** True when the skill is not committed in `.rness` yet: invalid, for that reason alone. */
  uncommitted?: true
  /** The developer's answer, whatever the state; absent when they gave none. */
  answer?: ConsentAnswer
}

/** The line said for a skill not committed in `.rness` yet: it is installed from the commit. */
export const COMMIT_FIRST = 'commit .rness first'

/** An applied skill whose committed copy passed the checks: it can be offered and installed. */
export const isValid = (
  a: AppliedSkill
): a is AppliedSkill & { head: SkillTree } => a.head !== null

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
    (e['answer'] === 'accepted' || e['answer'] === 'declined') &&
    typeof e['date'] === 'string' &&
    (e['tree'] === undefined || typeof e['tree'] === 'string')
  )
}

/**
 * The developer's record. Missing reads as empty; an unreadable one too,
 * after `onUnreadable` (called once) says so: a damaged record asks the
 * questions again, it never stops a command. A malformed entry in a record
 * otherwise sound is dropped alone, `onDropped` (called once) naming them:
 * the other answers stand, and that skill is asked again.
 */
export async function readConsent(
  rnessDir: string,
  onUnreadable?: (file: string) => void,
  onDropped?: (file: string, ids: string[]) => void
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
  let entries: [string, unknown][]
  try {
    const data: unknown = JSON.parse(text)
    const skills = (data as { skills?: unknown }).skills
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { version?: unknown }).version !== 1 ||
      typeof skills !== 'object' ||
      skills === null ||
      Array.isArray(skills)
    )
      throw new Error('not a consent record')
    entries = Object.entries(skills)
  } catch {
    onUnreadable?.(file)
    return { version: 1, skills: {} }
  }
  const dropped = entries.filter(([, e]) => !isEntry(e)).map(([id]) => id)
  if (dropped.length > 0) onDropped?.(file, dropped)
  return {
    version: 1,
    // Own keys only: an id such as `__proto__` stays a key, never a prototype.
    skills: Object.fromEntries(
      entries.filter((pair): pair is [string, ConsentEntry] => isEntry(pair[1]))
    ),
  }
}

/** The line said when `readConsent` dropped malformed entries. */
export const droppedLine = (file: string, ids: readonly string[]): string =>
  `${file}: ${ids.length === 1 ? '1 malformed entry' : `${ids.length} malformed entries`} dropped (${ids.map(quoted).join(', ')}); those skills are asked again`

export async function writeConsent(
  rnessDir: string,
  consent: Consent
): Promise<void> {
  const file = await consentFile(rnessDir)
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(consent, null, 2)}\n`)
}

/** The state the developer's answer gives a skill whose committed copy is valid. */
export function stateOf(consent: Consent, id: string): SkillState {
  const entry = Object.hasOwn(consent.skills, id)
    ? consent.skills[id]
    : undefined
  if (entry === undefined) return 'pending'
  return entry.answer === 'accepted' ? 'installed' : 'declined'
}

/** A skill awaits the developer's answer. */
export const isPending = (state: SkillState): boolean => state === 'pending'

/**
 * The team skills that apply to this workspace: the top-level ones, and
 * those of each repository of `rness.json` whose clone `org/<repo>` exists
 * (parts included), each with its copy as committed at `HEAD` of `.rness`
 * (decision 8: what is installed) and its state for the developer. The
 * order is that of `teamSkills`.
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
  const skills = all.filter((s) => applying.has(s))
  const heads = await skillsAtHead(ws.rnessDir, skills)
  const applied: AppliedSkill[] = []
  for (const skill of skills) {
    const id = skillId(skill)
    const head = heads.get(skill.dir) ?? null
    const given = Object.hasOwn(consent.skills, id)
      ? consent.skills[id]?.answer
      : undefined
    const answer = given === undefined ? {} : { answer: given }
    const reserved =
      skill.entry === null ? reservedNameProblem(skill.name) : null
    if (reserved !== null)
      applied.push({
        id,
        skill,
        head: null,
        state: 'invalid',
        problem: `skill ${quoted(skill.name)}: ${reserved}`,
        ...answer,
      })
    else if (head === null)
      applied.push(
        // Not at HEAD: its copy waits for a commit, or there is none at all.
        (await exists(skill.dir))
          ? {
              id,
              skill,
              head: null,
              state: 'invalid',
              problem: COMMIT_FIRST,
              uncommitted: true,
              ...answer,
            }
          : {
              id,
              skill,
              head: null,
              state: 'invalid',
              problem: `skill ${quoted(skill.name)}: its copy is missing`,
              ...answer,
            }
      )
    else if (head instanceof Error)
      applied.push({
        id,
        skill,
        head: null,
        state: 'invalid',
        problem: plainText(head.message),
        ...answer,
      })
    else
      applied.push({ id, skill, head, state: stateOf(consent, id), ...answer })
  }
  return applied
}

/**
 * How a skill is named to the developer, to the agent and to `install`
 * (ruling R27): its name, or its id (`<scope>/<name>`) when another skill
 * of `applied`, in any state, has the same name.
 */
export const skillLabel =
  (applied: readonly AppliedSkill[]) =>
  (a: AppliedSkill): string =>
    applied.some((o) => o !== a && o.skill.name === a.skill.name)
      ? a.id
      : a.skill.name

/**
 * The skills of `applied` a name given to `install` designates: the one
 * whose id it is (`<scope>/<name>`, or `<name>` for a top-level skill),
 * else every skill of that name.
 */
export function designated(
  applied: readonly AppliedSkill[],
  given: string
): AppliedSkill[] {
  const byId = applied.filter((a) => a.id === given)
  return byId.length > 0 ? byId : applied.filter((a) => a.skill.name === given)
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
