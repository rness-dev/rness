import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { scopeChain } from './scope.ts'
import type { Manifest, SkillEntry } from './types.ts'

/**
 * A team skill (spec 0041): declared in `rness.json`, or written by the
 * team as a directory of `.rness/skills/` with no declaration (spec 0034).
 */
export interface TeamSkill {
  name: string
  /** The scope it is declared or written for; null = the whole organization. */
  scope: string | null
  /** Absolute: `<rnessDir>/skills/<name>` or `<rnessDir>/skills/scopes/<scope>/<name>`. */
  dir: string
  /** The declaration; null for a skill the team wrote. */
  entry: SkillEntry | null
}

/** The directories directly under `dir`, by name; none when `dir` is absent. */
async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Every team skill: each declared entry (the top, then every scope, parts
 * included, in the order of `rness.json`) and each directory written by the
 * team at that level with no declaration of its name there. Files such as
 * `README.md` or `.gitkeep` are not skills.
 */
export async function teamSkills(
  rnessDir: string,
  manifest: Manifest
): Promise<TeamSkill[]> {
  const levels: [string | null, Record<string, SkillEntry>, string][] = [
    [null, manifest.skills ?? {}, join(rnessDir, 'skills')],
    ...Object.entries(manifest.scopes).map(
      ([name, s]): [string | null, Record<string, SkillEntry>, string] => [
        name,
        s.skills ?? {},
        join(rnessDir, 'skills', 'scopes', name),
      ]
    ),
  ]
  const found: TeamSkill[] = []
  for (const [scope, declared, base] of levels) {
    for (const [name, entry] of Object.entries(declared))
      found.push({ name, scope, dir: join(base, name), entry })
    for (const name of await subdirectories(base))
      if (
        !(scope === null && name === 'scopes') &&
        !Object.hasOwn(declared, name)
      )
        found.push({ name, scope, dir: join(base, name), entry: null })
  }
  return found
}

/** The skills that apply to `scope`: the top-level ones, and those of `scope` and the scopes it extends. */
export function skillsForScope(
  manifest: Manifest,
  skills: readonly TeamSkill[],
  scope: string | null
): TeamSkill[] {
  const applies = new Set(scopeChain(manifest, scope))
  return skills.filter((s) => s.scope === null || applies.has(s.scope))
}

/**
 * The skills installed in the clone of repository `repo`: those of
 * `skillsForScope` for `repo` and for every part nested under it, a part's
 * skill landing at its repository's clone root (spec 0041 §6).
 */
export function skillsForClone(
  manifest: Manifest,
  skills: readonly TeamSkill[],
  repo: string
): TeamSkill[] {
  const inside = (name: string): boolean => {
    for (
      let at: string | null = name;
      at !== null;
      at = manifest.scopes[at]?.parent ?? null
    )
      if (at === repo) return true
    return false
  }
  const wanted = new Set(
    Object.keys(manifest.scopes)
      .filter(inside)
      .flatMap((n) => skillsForScope(manifest, skills, n))
  )
  return skills.filter((s) => wanted.has(s))
}

/**
 * The lines `validate` refuses on: a name that appears twice in one clone,
 * whether declared at the top and in a scope, in two scopes that both
 * apply, or declared and written by the team (spec 0041 §2). Each once.
 */
export function skillConflicts(
  rnessDir: string,
  manifest: Manifest,
  skills: readonly TeamSkill[]
): string[] {
  const lines = new Set<string>()
  const place = (s: TeamSkill): string =>
    s.scope === null ? 'at the top' : `in scope "${s.scope}"`
  const written = (s: TeamSkill): string =>
    `written by the team at ${relative(rnessDir, s.dir)}`
  for (const [repo, scope] of Object.entries(manifest.scopes)) {
    if (scope.parent !== null) continue
    const seen = new Map<string, TeamSkill>()
    for (const s of skillsForClone(manifest, skills, repo)) {
      const other = seen.get(s.name)
      if (other === undefined) {
        seen.set(s.name, s)
        continue
      }
      // A declared skill is named first: "declared at the top and ...".
      const [a, b] =
        other.entry === null && s.entry !== null ? [s, other] : [other, s]
      const first = a.entry === null ? written(a) : `declared ${place(a)}`
      const second =
        b.entry === null
          ? written(b)
          : a.entry === null
            ? `declared ${place(b)}`
            : place(b)
      lines.add(`skill "${s.name}" is ${first} and ${second}`)
    }
  }
  return [...lines]
}
