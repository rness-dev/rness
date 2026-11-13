import { type Dirent, constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'

import { parseFrontMatter } from './frontmatter.ts'
import {
  type ObjectStore,
  type ScratchIndex,
  type TreeEntry,
  fetchRef,
  listTree,
  objectStore,
  readObjects,
  withScratchIndex,
} from './git.ts'
import type { GitCredentials } from './provider.ts'
import { scopeChain } from './scope.ts'
import { CONTROL, INVISIBLE, plainText, quoted } from './text.ts'
import type { Manifest, SkillEntry } from './types.ts'

export { plainText, quoted }

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

/**
 * The directories and symbolic links directly under `dir`, by name; none
 * when `dir` is absent. A link is listed so that the checks refuse it
 * (spec 0041 §4); any other failure is not hidden.
 */
async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(
        (d) =>
          (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.')
      )
      .map((d) => d.name)
      .sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
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
    // A linked level is refused by `checkSkillCopies`, never read through.
    const linked = (await linkedLevel(rnessDir, base)) !== null
    for (const name of linked ? [] : await subdirectories(base))
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

/** A team skill as the blocks list it: its name and description as plain text. */
export interface ListedSkill {
  skill: TeamSkill
  name: string
  description: string
}

/**
 * Every team skill the blocks may list (spec 0041 §7), checked once for a
 * whole run: declared or written by the team, whose `SKILL.md` passes the
 * checks of its name and front matter, with its name and one-line
 * description as plain text. No tree is built: the blocks are written on
 * paths that run every turn (ruling R30); `validate` checks the rest of a
 * copy and says why one fails. A skill that does not pass is left out, and
 * so is everything when the skills cannot be listed: a block is never what
 * fails.
 */
export async function listedSkills(
  rnessDir: string,
  manifest: Manifest
): Promise<ListedSkill[]> {
  let all: TeamSkill[]
  try {
    all = await teamSkills(rnessDir, manifest)
  } catch {
    return []
  }
  const listed: ListedSkill[] = []
  const linked = new Map<string, boolean>()
  for (const skill of all) {
    try {
      // Never read through a link (ruling R35): a linked level or skill
      // directory leaves the skill out, as `validate` refuses it.
      const base = dirname(skill.dir)
      if (!linked.has(base))
        linked.set(base, (await linkedLevel(rnessDir, base)) !== null)
      if (linked.get(base) === true) continue
      if (!(await lstat(skill.dir)).isDirectory()) continue
      const description = (await readSkillMd(skill.dir, skill.name))[
        'description'
      ]
      if (typeof description !== 'string') continue
      listed.push({
        skill,
        name: plainText(skill.name),
        description: plainText(description).replace(/ {2,}/g, ' ').trim(),
      })
    } catch {
      continue
    }
  }
  return listed
}

/** The skills the block of `scope` lists, from `listedSkills`: those that apply to it, a name once (the first, in the order of `teamSkills`). */
export function blockSkillsOf(
  manifest: Manifest,
  listed: readonly ListedSkill[],
  scope: string | null
): { name: string; description: string }[] {
  let applies: Set<TeamSkill>
  try {
    applies = new Set(
      skillsForScope(
        manifest,
        listed.map((l) => l.skill),
        scope
      )
    )
  } catch {
    return []
  }
  const seen = new Set<string>()
  const out: { name: string; description: string }[] = []
  for (const l of listed) {
    if (!applies.has(l.skill) || seen.has(l.skill.name)) continue
    seen.add(l.skill.name)
    out.push({ name: l.name, description: l.description })
  }
  return out
}

/** The skills the block of `scope` lists: `listedSkills` then `blockSkillsOf`, for a single block. */
export async function blockSkills(
  rnessDir: string,
  manifest: Manifest,
  scope: string | null
): Promise<{ name: string; description: string }[]> {
  return blockSkillsOf(manifest, await listedSkills(rnessDir, manifest), scope)
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
  return [
    ...new Set(
      skillConflictsByName(rnessDir, manifest, skills).map((c) => c.line)
    ),
  ]
}

/** `skillConflicts`, each line with the name it is about, for callers that decide by name. */
export function skillConflictsByName(
  rnessDir: string,
  manifest: Manifest,
  skills: readonly TeamSkill[]
): { name: string; line: string }[] {
  const found = new Map<string, { name: string; line: string }>()
  const place = (s: TeamSkill): string =>
    s.scope === null ? 'at the top' : `in scope ${quoted(s.scope)}`
  const written = (s: TeamSkill): string =>
    `written by the team at ${plainText(relative(rnessDir, s.dir))}`
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
      const line = `skill ${quoted(s.name)} is ${first} and ${second}`
      found.set(line, { name: s.name, line })
    }
  }
  return [...found.values()]
}

// ---- A skill's content (spec 0041 §3, §4, §9) ----

/** The most a skill may hold, in bytes of file content (spec 0041 §4). */
export const MAX_SKILL_BYTES = 1024 * 1024

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A file of a skill as a tree of `.rness` holds it. */
export interface SkillFile {
  /** Relative to the skill directory, POSIX separators. */
  path: string
  executable: boolean
  /** The id git gives its bytes (a blob). */
  id: string
  size: number
}

/**
 * A skill's copy as a tree of `.rness` holds it (spec 0041 decision 8): the
 * files git takes, after its ignore rules (the skill's own `.gitignore`
 * included), checked (§4).
 */
export interface SkillTree {
  /** The id of the tree: the skill's fingerprint. */
  tree: string
  files: SkillFile[]
  /** File content, in all. */
  bytes: number
  /** The front matter of its `SKILL.md`. */
  fields: Record<string, unknown>
}

const refusal = (name: string, reason: string): Error =>
  new Error(`skill ${quoted(name)}: ${reason}`)

/** Why `name` cannot name a team skill; null when it can. */
function nameProblem(name: string): string | null {
  if (name === 'rness')
    return 'the name "rness" collides with the rness plugin\'s directory'
  if (name.length > 64) return 'the name is at most 64 characters'
  if (!SKILL_NAME.test(name))
    return 'the name must be lowercase letters, digits and hyphens'
  return null
}

/** Free text (a description) may span lines and hold tabs; a `\r` only before a `\n`. */
const hasControlInText = (text: string): boolean =>
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text.replace(/\r\n/g, '\n'))

/** The `allowed-tools` field as text: a string as is, a list of strings joined (an empty one as `[]`), anything else as JSON; null when absent. */
export function allowedToolsText(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value === 'string') return value
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string')
  )
    return value.join(', ')
  return JSON.stringify(value)
}

/**
 * The front matter of `text`, the `SKILL.md` of skill `name`, checked
 * (spec 0041 §4): a `name` equal to `name`, a `description`, and no control
 * character in the description or `allowed-tools`. Throws the refusal.
 */
function checkSkillMd(name: string, text: string): Record<string, unknown> {
  let fields
  try {
    fields = parseFrontMatter(text)
  } catch (e) {
    throw refusal(name, `SKILL.md: ${plainText((e as Error).message)}`)
  }
  if (fields === null) throw refusal(name, 'SKILL.md has no front matter')
  if (typeof fields['name'] !== 'string' || fields['name'] === '')
    throw refusal(name, 'SKILL.md has no name')
  if (fields['name'] !== name)
    throw refusal(
      name,
      `SKILL.md name ${quoted(fields['name'])} is not the directory's name ${quoted(name)}`
    )
  const description = fields['description']
  if (typeof description !== 'string' || description.trim() === '')
    throw refusal(name, 'SKILL.md has no description')
  if (hasControlInText(description))
    throw refusal(name, 'SKILL.md description holds a control character')
  const tools = allowedToolsText(fields['allowed-tools'])
  if (tools !== null && hasControlInText(tools))
    throw refusal(name, 'SKILL.md allowed-tools holds a control character')
  return fields
}

/**
 * The `SKILL.md` of the directory `dir` read from disk and checked as the
 * skill `name` (its name, its front matter), with no tree built: what the
 * blocks and the per-turn safety net can afford (ruling R30), and what a
 * source is checked on before anything is copied. Read only when it is a
 * regular file, never a link, of at most 1 MB (ruling R35). Returns its
 * front matter.
 */
export async function readSkillMd(
  dir: string,
  name: string
): Promise<Record<string, unknown>> {
  const bad = nameProblem(name)
  if (bad !== null) throw refusal(name, bad)
  return checkSkillMd(name, await skillMdText(dir, name))
}

/**
 * The text of `dir/SKILL.md`, read only when it is a regular file of at
 * most 1 MB and never through a link (ruling R35): `lstat` first (a link,
 * a FIFO or a device is never opened), then opened with `O_NOFOLLOW` and
 * checked again on the open file. Throws the refusal of skill `name`.
 */
async function skillMdText(dir: string, name: string): Promise<string> {
  const file = join(dir, 'SKILL.md')
  const shape = (st: {
    isFile(): boolean
    isSymbolicLink(): boolean
    size: number
  }) => {
    if (!st.isFile())
      throw refusal(
        name,
        `"SKILL.md" is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}; only regular files and directories are allowed`
      )
    if (st.size > MAX_SKILL_BYTES)
      throw refusal(
        name,
        `SKILL.md is ${st.size} bytes, above the limit of ${MAX_SKILL_BYTES} bytes (1 MB)`
      )
  }
  const st = await lstat(file).catch(() => null)
  if (st === null)
    throw refusal(name, 'no SKILL.md at the root of its directory')
  shape(st)
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  ).catch(() => {
    throw refusal(name, '"SKILL.md" could not be opened as a regular file')
  })
  try {
    shape(await handle.stat())
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/** Code points HFS+ ignores in a name: there, `.g\u200cit` is `.git`. */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

/**
 * True when a file system may take `name` for `.git`: in any case, with
 * the trailing dots and spaces NTFS drops, as NTFS's short name `git~1`,
 * or with the code points HFS+ ignores (rulings R34, R35).
 */
export function isGitName(name: string): boolean {
  const bare = name
    .replace(HFS_IGNORED, '')
    .replace(/[. ]+$/, '')
    .toLowerCase()
  return bare === '.git' || /^git~\d+$/.test(bare)
}

/**
 * Why `path`, a file of a skill's tree (relative, `/` between its parts),
 * cannot be written as one; null when it can (ruling R34). A crafted tree
 * may hold names git's own tools refuse: an empty part, `.` or `..`, a
 * `.git` in any form, a backslash or a colon, a control, bidirectional or
 * zero-width character.
 */
export function pathProblem(path: string): string | null {
  if (CONTROL.test(path)) return 'holds a control character'
  if (INVISIBLE.test(path))
    return 'holds a zero-width or bidirectional character'
  if (path.includes('\\')) return 'holds a backslash'
  if (path.includes(':')) return 'holds a colon'
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..')
      return 'holds an empty, "." or ".." part'
    if (isGitName(part)) return 'names a .git; a skill holds no repository'
  }
  return null
}

/** `dir` relative to `rnessDir`, with `/`: its path in a tree of `.rness`. */
const pathIn = (rnessDir: string, dir: string): string =>
  relative(rnessDir, dir).split(sep).join('/')

/** The entry of `listing` at `path`, and the entries below it, relative to it; null when it has none. */
function entriesOf(
  listing: readonly TreeEntry[],
  path: string
): { self: TreeEntry; inside: TreeEntry[] } | null {
  const self = listing.find((e) => e.path === path)
  if (self === undefined) return null
  const prefix = `${path}/`
  return {
    self,
    inside: listing
      .filter((e) => e.path.startsWith(prefix))
      .map((e) => ({ ...e, path: e.path.slice(prefix.length) })),
  }
}

const REGULAR = new Set(['100644', '100755'])

/** What a mode other than a regular file's is, said in a refusal. */
const modeProblem = (mode: string): string =>
  mode === '120000'
    ? 'is a symbolic link; only regular files and directories are allowed'
    : mode === '160000'
      ? 'is a nested repository; a skill holds no repository'
      : `has git mode ${mode}; only regular files and directories are allowed`

/**
 * The checks of spec 0041 §4 on the entries of a skill's tree, but for its
 * `SKILL.md`'s content: the name rule, every path one that can be written
 * (`pathProblem`: no `..`, no `.git`, no control, bidirectional or
 * zero-width character, ruling R34), regular files only (a symbolic link or
 * a gitlink refused, naming it), at most 1 MB, a `SKILL.md` at the root.
 * Returns the files and the id of the `SKILL.md` to read; throws the
 * refusal.
 */
function checkEntries(
  name: string,
  path: string,
  found: { self: TreeEntry; inside: TreeEntry[] }
): { files: SkillFile[]; bytes: number; md: string } {
  const bad = nameProblem(name)
  if (bad !== null) throw refusal(name, bad)
  if (found.self.type !== 'tree')
    throw refusal(name, `${plainText(path)} ${modeProblem(found.self.mode)}`)
  // Every entry, its directories included: a crafted tree names them too.
  for (const e of found.inside) {
    const problem = pathProblem(e.path)
    if (problem !== null)
      throw refusal(name, `file name ${quoted(e.path)} ${problem}`)
  }
  const leaves = found.inside.filter((e) => e.type !== 'tree')
  for (const e of leaves)
    if (!REGULAR.has(e.mode))
      throw refusal(name, `${quoted(e.path)} ${modeProblem(e.mode)}`)
  const files = leaves.map((e) => ({
    path: e.path,
    executable: e.mode === '100755',
    id: e.id,
    size: e.size ?? 0,
  }))
  const bytes = files.reduce((n, f) => n + f.size, 0)
  if (bytes > MAX_SKILL_BYTES)
    throw refusal(
      name,
      `its content is ${bytes} bytes, above the limit of ${MAX_SKILL_BYTES} bytes (1 MB)`
    )
  const md = files.find((f) => f.path === 'SKILL.md')
  if (md === undefined)
    throw refusal(name, 'no SKILL.md at the root of its directory')
  return { files, bytes, md: md.id }
}

/** A skill to look up in a tree of `.rness`: its name, and its directory there. */
export interface SkillAt {
  name: string
  dir: string
}

/**
 * Each of `skills` as the tree `treeish` of `.rness` holds it (`HEAD`, or
 * a tree a scratch index wrote), keyed by its directory: its `SkillTree`
 * when it passes the checks of §4, the refusal when it does not, null when
 * that tree has nothing at its path. One `ls-tree` and one `cat-file` for
 * them all.
 */
export async function skillTreesAt(
  store: ObjectStore,
  rnessDir: string,
  treeish: string,
  skills: readonly SkillAt[]
): Promise<Map<string, SkillTree | Error | null>> {
  if (skills.length === 0) return new Map()
  return skillTreesIn(
    store,
    rnessDir,
    await listTree(store, treeish, ['skills']),
    skills
  )
}

/** `skillTreesAt` on a listing of the tree already made. */
async function skillTreesIn(
  store: ObjectStore,
  rnessDir: string,
  listing: readonly TreeEntry[],
  skills: readonly SkillAt[]
): Promise<Map<string, SkillTree | Error | null>> {
  const found = new Map<string, SkillTree | Error | null>()
  const checked: (ReturnType<typeof checkEntries> & {
    s: SkillAt
    tree: string
  })[] = []
  for (const s of skills) {
    const path = pathIn(rnessDir, s.dir)
    const at = entriesOf(listing, path)
    if (at === null) found.set(s.dir, null)
    else
      try {
        checked.push({ s, tree: at.self.id, ...checkEntries(s.name, path, at) })
      } catch (e) {
        found.set(s.dir, e as Error)
      }
  }
  const mds = await readObjects(
    store,
    checked.map((c) => c.md)
  )
  for (const c of checked)
    try {
      const md = mds.get(c.md)
      if (md === null || md === undefined)
        throw refusal(c.s.name, 'its SKILL.md cannot be read from git')
      found.set(c.s.dir, {
        tree: c.tree,
        files: c.files,
        bytes: c.bytes,
        fields: checkSkillMd(c.s.name, md.toString('utf8')),
      })
    } catch (e) {
      found.set(c.s.dir, e as Error)
    }
  return found
}

/**
 * Each of `skills` as committed at `HEAD` of `.rness` (spec 0041 §6): what
 * is installed. Null for one `HEAD` does not hold (not committed yet, or no
 * commit at all). Object reads only: no index, no tree built.
 */
export async function skillsAtHead(
  rnessDir: string,
  skills: readonly SkillAt[]
): Promise<Map<string, SkillTree | Error | null>> {
  if (skills.length === 0) return new Map()
  const store = objectStore(rnessDir)
  let listing: TreeEntry[]
  try {
    listing = await listTree(store, 'HEAD', ['skills'])
  } catch {
    return new Map(skills.map((s) => [s.dir, null]))
  }
  return skillTreesIn(store, rnessDir, listing, skills)
}

/**
 * Each of `skills` as git would commit its copy in `.rness` now, keyed by
 * its directory: the files of the working tree a scratch index takes
 * (`withScratchIndex`, one for them all), checked (§4). A copy git cannot
 * add (a nested repository with no commit) is refused alone.
 */
async function workingTrees(
  rnessDir: string,
  skills: readonly SkillAt[]
): Promise<Map<string, SkillTree | Error | null>> {
  if (skills.length === 0) return new Map()
  return withScratchIndex(rnessDir, async (index) => {
    const failed = new Map<string, Error>()
    try {
      await index.add(skills.map((s) => pathIn(rnessDir, s.dir)))
    } catch {
      // One copy git refuses fails the whole `add`: each alone says which.
      await index.reset()
      for (const s of skills)
        await index
          .add([pathIn(rnessDir, s.dir)])
          .catch((e: unknown) => failed.set(s.dir, cannotAdd(s.name, e)))
    }
    const trees = await skillTreesAt(
      index,
      rnessDir,
      await index.writeTree(),
      skills.filter((s) => !failed.has(s.dir))
    )
    for (const [dir, e] of failed) trees.set(dir, e)
    return trees
  })
}

const cannotAdd = (name: string, e: unknown): Error =>
  refusal(
    name,
    `git cannot take its copy: ${plainText(e instanceof Error ? e.message : String(e))}`
  )

/** The paths added, changed (bytes or executable bit) and removed from `before` to `after`, each a map of path to mode and blob id. */
export function diffSkillFiles(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): { added: string[]; changed: string[]; removed: string[] } {
  return {
    added: [...after.keys()].filter((p) => !before.has(p)),
    changed: [...after]
      .filter(([p, d]) => before.has(p) && before.get(p) !== d)
      .map(([p]) => p),
    removed: [...before.keys()].filter((p) => !after.has(p)),
  }
}

/** Path to mode and blob id, the form `diffSkillFiles` compares. */
export const fileDigests = (files: readonly SkillFile[]): Map<string, string> =>
  new Map(
    files.map((f) => [f.path, `${f.executable ? '100755' : '100644'}:${f.id}`])
  )

/** The git URL of a `github:` or `git:` source; null for a `path:` source. */
export function skillSourceUrl(source: string): string | null {
  if (source.startsWith('path:')) return null
  if (source.startsWith('git:')) return source.slice(4)
  const repo = source.startsWith('github:') ? source.slice(7) : null
  if (repo === null || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    throw new Error(
      `a source is github:<owner>/<repo>, git:<url> or path:<dir>, not ${quoted(source)}`
    )
  return `https://github.com/${repo}.git`
}

/** The `name` field of `dir/SKILL.md`; the repository's own name when there is none to read. */
async function declaredName(dir: string, url: string): Promise<string> {
  try {
    // Never through a link: a checkout may hold one to any file.
    const name = parseFrontMatter(await skillMdText(dir, basename(dir)))?.[
      'name'
    ]
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // Unreadable: the check of the copy says why.
  }
  return basename(
    url
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .replace(/^.*:/, '')
  )
}

/** A skill fetched from its source, to be copied; `release` removes the temporary checkout. */
export interface FetchedSkill {
  /** The directory holding the skill (the checkout or its `path`; the directory itself for `path:`). */
  dir: string
  /** The source's name: the `name` of its SKILL.md at a repository root, else its directory's (last segment of `path`, or of the `path:` directory). */
  name: string
  /** The commit fetched; null for a `path:` source. */
  commit: string | null
  release: () => Promise<void>
}

/**
 * Fetch `source` (spec 0041 §3): a repository into a temporary directory at
 * `ref` (`HEAD` when absent), then its `path` subdirectory when given; a
 * `path:` directory is read in place, relative to `rnessDir`, and takes no
 * `path` or `ref`. `credentials` as the other git commands take them.
 */
export async function fetchSkill(
  rnessDir: string,
  source: string,
  opts: { path?: string; ref?: string; credentials: GitCredentials | null }
): Promise<FetchedSkill> {
  const url = skillSourceUrl(source)
  if (url === null) {
    const dir = resolve(rnessDir, source.slice(5))
    if (
      !(await stat(dir).then(
        (s) => s.isDirectory(),
        () => false
      ))
    )
      throw new Error(
        `no directory ${quoted(dir)} for source ${quoted(source)}`
      )
    return { dir, name: basename(dir), commit: null, release: async () => {} }
  }
  const sub = opts.path === undefined ? '' : posix.normalize(opts.path)
  if (isAbsolute(sub) || sub === '..' || sub.startsWith('../'))
    throw new Error(`path ${quoted(opts.path ?? '')} leaves the repository`)
  const tmp = await mkdtemp(join(tmpdir(), 'rness-skill-'))
  const release = (): Promise<void> => rm(tmp, { recursive: true, force: true })
  try {
    // git's own message quotes the URL it was given.
    const commit = await fetchRef(
      url,
      opts.ref ?? null,
      tmp,
      opts.credentials
    ).catch((e: unknown) => {
      throw new Error(plainText(e instanceof Error ? e.message : String(e)), {
        cause: e,
      })
    })
    const dir = sub === '' || sub === '.' ? tmp : join(tmp, sub)
    // A link inside the checkout must not lead out of it.
    const real = await realpath(dir).catch(() => null)
    if (real === null || !(await stat(real)).isDirectory())
      throw new Error(
        `no directory ${quoted(opts.path ?? '')} in ${quoted(source)}`
      )
    if (
      real !== (await realpath(tmp)) &&
      !real.startsWith((await realpath(tmp)) + sep)
    )
      throw new Error(`path ${quoted(opts.path ?? '')} leaves the repository`)
    // At the root of a repository the name is the `name` of its SKILL.md
    // (the repository's own name says nothing of the skill); elsewhere the
    // directory's, which §4 requires SKILL.md to repeat.
    const name = dir === tmp ? await declaredName(dir, url) : basename(dir)
    return { dir, name, commit, release }
  } catch (e) {
    await release()
    throw e
  }
}

/**
 * `SKILL.md` with the value of the `name` field of its front matter set to
 * `name`; every other byte, a quote style or a comment after the value
 * included, is unchanged. Works on bytes (as latin1), so no byte is altered
 * by a text round trip.
 */
function renamed(md: Buffer, from: string, name: string): Buffer {
  const text = md.toString('latin1')
  const block = text.match(/^((?:\xEF\xBB\xBF)?---\r?\n)([\s\S]*?)\r?\n---/)
  const field =
    block === null ? null : /^name:[ \t]*(["']?)/m.exec(block[2] ?? '')
  if (block === null || field === null)
    throw refusal(from, 'SKILL.md has no name line to rewrite')
  const start = (block[1] ?? '').length + field.index + field[0].length
  const rest = text.slice(start)
  const quote = field[1] ?? ''
  const length =
    quote !== ''
      ? Math.max(rest.indexOf(quote), 0)
      : (/^[^\r\n]*/.exec(rest)?.[0] ?? '')
          .replace(/[ \t]+#.*$/, '')
          .replace(/[ \t]+$/, '').length
  return Buffer.from(
    text.slice(0, start) + name + text.slice(start + length),
    'latin1'
  )
}

const linkRefusal = (rnessDir: string, path: string): string =>
  `${plainText(relative(rnessDir, path))} is a symbolic link; only regular files and directories are allowed`

/**
 * The first of `skills/`, `skills/scopes/` and `skills/scopes/<scope>/`
 * leading to `base` (a level's directory) that is a symbolic link, absolute;
 * null when none is. Writing or reading through one would leave `.rness`.
 */
async function linkedLevel(
  rnessDir: string,
  base: string
): Promise<string | null> {
  let at = join(rnessDir, 'skills')
  for (const part of ['', ...relative(at, base).split(sep).filter(Boolean)]) {
    at = join(at, part)
    const st = await lstat(at).catch(() => null)
    if (st?.isSymbolicLink() === true) return at
  }
  return null
}

/**
 * Why nothing may be written or deleted at the level of `scope`
 * (`skills/`, or `skills/scopes/<scope>/`): a symbolic link on the way,
 * named; null when there is none.
 */
export async function linkedLevelProblem(
  rnessDir: string,
  scope: string | null
): Promise<string | null> {
  const base =
    scope === null
      ? join(rnessDir, 'skills')
      : join(rnessDir, 'skills', 'scopes', scope)
  const link = await linkedLevel(rnessDir, base)
  return link === null ? null : linkRefusal(rnessDir, link)
}

/** What `copySkill` made. */
export interface CopiedSkill {
  name: string
  /** Absolute: the copy under `.rness/skills/`. */
  dir: string
  /** The copy as git takes it in `.rness`, checked: its tree is the declared `tree`. */
  copy: SkillTree
  /** The copy it replaced, by path (`fileDigests`); empty when there was none. */
  before: Map<string, string>
}

const there = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false
  )

/**
 * Why the entry `d` of a source, at `path`, is never copied into `.rness`;
 * null when it may be. A `.git` below the skill's root, in any form a file
 * system takes for one, is a repository whose configuration git would run
 * for anyone working there (ruling R35); a device or a socket is no file.
 */
function sourceProblem(d: Dirent, path: string): string | null {
  if (isGitName(d.name))
    return `${quoted(path)} is a .git below the skill's root; a skill holds no repository`
  if (!d.isDirectory() && !d.isFile() && !d.isSymbolicLink())
    return `${quoted(path)} is neither a regular file nor a directory; only regular files and directories are allowed`
  return null
}

/** Each entry of the source `from` with its path, the source's own `.git` (at its root) left out; links never followed. */
async function walkSource(
  from: string,
  each: (d: Dirent, path: string, abs: string) => Promise<void>
): Promise<void> {
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (rel === '' && d.name === '.git') continue
      const path = rel === '' ? d.name : `${rel}/${d.name}`
      const abs = join(dir, d.name)
      await each(d, path, abs)
      if (d.isDirectory()) await visit(abs, path)
    }
  }
  await visit(from, '')
}

/** The source `from` of skill `name` refused, naming the entry, when one is never copied (`sourceProblem`). */
async function checkSource(name: string, from: string): Promise<void> {
  await walkSource(from, async (d, path) => {
    const problem = sourceProblem(d, path)
    if (problem !== null) throw refusal(name, problem)
  })
}

/**
 * Copy the directory `from` to `to` as it is: directories, files (0755 when
 * executable, else 0644) and symbolic links, a link copied as a link and
 * never followed. The source's own repository (a `.git` at its root) is no
 * part of it; anything else is copied, and git decides what the copy holds.
 * `md` rewrites the bytes of the root `SKILL.md`. `copySkill` checks the
 * source whole first (`checkSource`); each entry is checked again as it is
 * copied, the source being free to change in between.
 */
async function copyDir(
  name: string,
  from: string,
  to: string,
  md: (bytes: Buffer) => Buffer
): Promise<void> {
  await mkdir(to, { recursive: true })
  await walkSource(from, async (d, path, abs) => {
    const problem = sourceProblem(d, path)
    if (problem !== null) throw refusal(name, problem)
    const t = join(to, ...path.split('/'))
    if (d.isDirectory()) await mkdir(t, { recursive: true })
    else if (d.isSymbolicLink()) await symlink(await readlink(abs), t)
    else {
      const bytes = await readFile(abs)
      await writeFile(t, path === 'SKILL.md' ? md(bytes) : bytes)
      await chmod(t, ((await lstat(abs)).mode & 0o100) !== 0 ? 0o755 : 0o644)
    }
  })
}

/** The files of the copy at `dir` as `index` takes them, unchecked (`fileDigests`'s form); empty when git takes none. */
async function filesOf(
  index: ScratchIndex,
  rnessDir: string,
  dir: string
): Promise<Map<string, string>> {
  try {
    await index.reset()
    await index.add([pathIn(rnessDir, dir)])
    const at = entriesOf(
      await listTree(index, await index.writeTree(), ['skills']),
      pathIn(rnessDir, dir)
    )
    return new Map(
      (at?.inside ?? [])
        .filter((e) => e.type !== 'tree')
        .map((e) => [e.path, `${e.mode}:${e.id}`])
    )
  } catch {
    return new Map()
  }
}

/**
 * Copy the fetched skill into `<rnessDir>/skills/[scopes/<scope>/]<name>/`,
 * `name` being `opts.name` (`--name`: the `name` of the copy's `SKILL.md` is
 * rewritten) or the source's, then check it (§4) on the tree git gives it
 * there (decision 8): what git leaves out, by its ignore rules or the
 * skill's own `.gitignore`, is no part of it. The source's `SKILL.md` is
 * checked first, so a refusal there writes nothing. The copy is written
 * beside its place and swapped in; refused, it is removed and the previous
 * copy put back.
 */
export async function copySkill(
  rnessDir: string,
  from: FetchedSkill,
  opts: { scope: string | null; name?: string }
): Promise<CopiedSkill> {
  const name = opts.name ?? from.name
  // The source refused before anything is written to `.rness` (R35).
  await readSkillMd(from.dir, from.name)
  await checkSource(name, from.dir)
  const bad = nameProblem(name)
  if (bad !== null) throw refusal(name, bad)
  if (opts.scope === null && name === 'scopes')
    throw refusal(
      name,
      'the name "scopes" is the directory of the scoped skills'
    )
  const base =
    opts.scope === null
      ? join(rnessDir, 'skills')
      : join(rnessDir, 'skills', 'scopes', opts.scope)
  const link = await linkedLevel(rnessDir, base)
  if (link !== null) throw refusal(name, linkRefusal(rnessDir, link))
  const target = join(base, name)
  return withScratchIndex(rnessDir, async (index) => {
    const had = await there(target)
    const before = had ? await filesOf(index, rnessDir, target) : new Map()
    await mkdir(base, { recursive: true })
    const staged = await mkdtemp(join(base, `.${name}-`))
    const old = `${staged}.old`
    let moved = false
    let swapped = false
    try {
      await copyDir(name, from.dir, staged, (bytes) =>
        name === from.name ? bytes : renamed(bytes, from.name, name)
      )
      if (had) {
        await rename(target, old)
        moved = true
      }
      await rename(staged, target)
      swapped = true
      // The tree is taken at the copy's own place: git's ignore rules are
      // those of that path in `.rness`.
      await index.reset()
      await index
        .add([pathIn(rnessDir, target)])
        .catch((e: unknown) => Promise.reject(cannotAdd(name, e)))
      const copy = (
        await skillTreesAt(index, rnessDir, await index.writeTree(), [
          { name, dir: target },
        ])
      ).get(target)
      if (copy instanceof Error) throw copy
      if (copy === null || copy === undefined)
        throw refusal(name, 'no SKILL.md at the root of its directory')
      if (moved) await rm(old, { recursive: true, force: true })
      return { name, dir: target, copy, before }
    } catch (e) {
      if (swapped) await rm(target, { recursive: true, force: true })
      else await rm(staged, { recursive: true, force: true })
      if (moved) await rename(old, target)
      throw e
    }
  })
}

/**
 * What `validate` says of the copies (spec 0041 §4): `problems` are
 * refusals (a skill that breaks §4, a declared copy that is missing);
 * `reported` are lines that are said and never refused (a declared copy
 * whose tree differs from its `tree`). With `trees` false (the per-turn
 * safety net, ruling R30) no tree is built: each skill's `SKILL.md` alone
 * is checked (`readSkillMd`), and no copy is compared to its `tree`.
 */
export async function checkSkillCopies(
  rnessDir: string,
  manifest: Manifest,
  opts: { trees: boolean }
): Promise<{ problems: string[]; reported: string[] }> {
  const problems: string[] = []
  const reported: string[] = []
  const levels = [
    join(rnessDir, 'skills'),
    ...Object.keys(manifest.scopes).map((n) =>
      join(rnessDir, 'skills', 'scopes', n)
    ),
  ]
  const linked = new Set<string>()
  for (const base of levels) {
    const link = await linkedLevel(rnessDir, base)
    if (link !== null) linked.add(base)
    if (link !== null) {
      const line = `skills: ${linkRefusal(rnessDir, link)}`
      if (!problems.includes(line)) problems.push(line)
    }
  }
  // Per skill, in the order of `teamSkills`: its problem, or the copy to check.
  const found: (string | TeamSkill)[] = []
  for (const s of await teamSkills(rnessDir, manifest)) {
    if (linked.has(dirname(s.dir))) continue
    const place = plainText(relative(rnessDir, s.dir))
    const st = await lstat(s.dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (st === null)
      found.push(
        `skill ${quoted(s.name)} is declared but its copy ${place} is missing: run rness skill update ${plainText(s.name)}`
      )
    else if (!st.isDirectory())
      found.push(
        `skill ${quoted(s.name)}: ${place} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}; only regular files and directories are allowed`
      )
    else found.push(s)
  }
  const copies = found.filter((f): f is TeamSkill => typeof f !== 'string')
  const trees = opts.trees
    ? await workingTrees(rnessDir, copies)
    : new Map<string, SkillTree | Error | null>()
  for (const f of found) {
    if (typeof f === 'string') {
      problems.push(f)
      continue
    }
    if (!opts.trees) {
      await readSkillMd(f.dir, f.name).catch((e: Error) =>
        problems.push(e.message)
      )
      continue
    }
    const t = trees.get(f.dir) ?? null
    if (t === null)
      problems.push(
        refusal(f.name, 'no SKILL.md at the root of its directory').message
      )
    else if (t instanceof Error) problems.push(t.message)
    else if (f.entry !== null && t.tree !== f.entry.tree)
      reported.push(
        `skill ${quoted(f.name)} differs from its source: run rness skill update, or remove its source to make it the team's own`
      )
  }
  return { problems, reported }
}
