import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parseFrontMatter } from './frontmatter.ts'
import { readOrNull, writeFileAtomic } from './fs.ts'
import {
  type ObjectStore,
  blobIds,
  gitPath,
  listTree,
  objectStore,
  pathTrees,
  readObjects,
  trackedPaths,
} from './git.ts'
import { providerOf, repositories } from './manifest.ts'
import { rnessCommand } from './pm.ts'
import {
  type AppliedSkill,
  COMMIT_FIRST,
  appliedSkills,
  droppedLine,
  isValid,
  readConsent,
} from './skill-consent.ts'
import {
  type SkillFile,
  type SkillTree,
  allowedToolsText,
  pathProblem,
  plainText,
  quoted,
  skillsForClone,
} from './skills.ts'
import { count } from './style.ts'
import type { Manifest, Workspace } from './types.ts'
import type { Line } from './ui.ts'
import { orgDirs } from './workspace.ts'

// The projection of the team skills a developer accepted (spec 0041 §6):
// copies written into the clones of the workspace and at its root from the
// commit at `HEAD` of `.rness` (decision 8), excluded from git, recorded,
// and removed when no longer accepted or declared. rness only ever removes
// or rewrites a path its record names, never through a symbolic link, never
// outside the clone or the root (decision 7).

/** The line `.git/info/exclude` keeps rness's lines under (ruling R7), up to `EXCLUDE_END`. */
export const EXCLUDE_HEADER =
  '# rness: team skills (rness sync keeps these lines)'

/** The line that closes rness's block of `.git/info/exclude`: what follows is the developer's. */
export const EXCLUDE_END = '# rness: end of team skills'

/** What a clone's record holds for one skill: the tree it was written from, the paths written. */
export interface InstalledEntry {
  /** The id of the skill's tree at `HEAD` of `.rness` when it was written. */
  tree: string
  /** Relative to the clone (or the root): `.claude/skills/<name>`, `.agents/skills/<name>`. */
  paths: string[]
}

/** `.git/rness/skills.json` of a clone, `rness/root-skills.json` in the git directory of `.rness` for the root. */
export interface InstalledRecord {
  version: 1
  /** By skill name (one name per clone: `validate` refuses a name twice). */
  skills: Record<string, InstalledEntry>
}

/** A clone holds both directories; the root only `.claude/skills` (spec 0041 §6). */
export type InstalledKind = 'clone' | 'root'

const NAME = '[a-z0-9]+(?:-[a-z0-9]+)*'
const CLONE_PATH = new RegExp(`^\\.(?:claude|agents)/skills/${NAME}$`)
const ROOT_PATH = new RegExp(`^\\.claude/skills/${NAME}$`)
const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const EXCLUDE_LINE = /^\/\.(?:claude|agents)\/skills\/[^/]+\/$/

/** The record of the clone `clone`; null when it is no git repository. */
export const installedFile = (clone: string): Promise<string | null> =>
  gitPath(clone, 'rness/skills.json')

/** The record of the workspace root, in the git directory of `.rness`; null when `.rness` is no git repository. */
export const rootInstalledFile = (rnessDir: string): Promise<string | null> =>
  gitPath(rnessDir, 'rness/root-skills.json')

const emptyRecord = (): InstalledRecord => ({ version: 1, skills: {} })

/** True when `p` is a path rness writes `name` to in a place of `kind`. */
const isSkillPath = (kind: InstalledKind, name: string, p: string): boolean =>
  (kind === 'root' ? ROOT_PATH : CLONE_PATH).test(p) &&
  p.endsWith(`/skills/${name}`)

/**
 * The record at `file` (`installedFile`, `rootInstalledFile`). Missing: an
 * empty record. Null when it cannot be trusted: unreadable, not JSON, or
 * naming a path rness never writes (anything but `.claude/skills/<name>`,
 * and `.agents/skills/<name>` in a clone, `<name>` its key). Nothing is
 * removed or rewritten on a null record: the guard and the projection only
 * act on paths a valid record names.
 */
export async function readInstalled(
  file: string,
  kind: InstalledKind = 'clone'
): Promise<InstalledRecord | null> {
  let text: string | null
  try {
    text = await readOrNull(file)
  } catch {
    return null
  }
  if (text === null) return emptyRecord()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { version, skills } = data as { version?: unknown; skills?: unknown }
  if (version !== 1 || typeof skills !== 'object' || skills === null)
    return null
  const record = emptyRecord()
  for (const [name, entry] of Object.entries(skills)) {
    if (typeof entry !== 'object' || entry === null) return null
    const { tree, paths } = entry as { tree?: unknown; paths?: unknown }
    if (
      typeof tree !== 'string' ||
      !TREE.test(tree) ||
      !Array.isArray(paths) ||
      paths.length === 0 ||
      new Set(paths).size !== paths.length ||
      !paths.every((p) => typeof p === 'string' && isSkillPath(kind, name, p))
    )
      return null
    record.skills[name] = { tree, paths: paths as string[] }
  }
  return record
}

/** Write the record at `file`, atomically. */
export async function writeInstalled(
  file: string,
  record: InstalledRecord
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
}

/** A new version of an accepted skill, written over the one installed (spec 0041 §5). */
export interface SkillUpdate {
  /** The skill's id (`skillId`), and its name. */
  id: string
  name: string
  /** The trees, before and after. */
  from: string
  to: string
  /** The `allowed-tools` of the two, as plain text, when they differ; null when they do not or the old one cannot be read. */
  tools: [string, string] | null
}

/** What one place (a clone or the root) became. Names sorted. */
export interface Projection {
  /** Written where they were not. */
  installed: string[]
  /** Written over the copy of an earlier version. */
  updated: SkillUpdate[]
  /** Written again over a copy rness wrote whose files no longer match git's. */
  rewritten: string[]
  /** At least one path removed. */
  removed: string[]
  /** Said, never a failure: a clash, a symbolic link, an unreadable record. */
  notes: string[]
  /** Failures. */
  problems: string[]
}

const nothing = (): Projection => ({
  installed: [],
  updated: [],
  rewritten: [],
  removed: [],
  notes: [],
  problems: [],
})

interface Place {
  kind: InstalledKind
  base: string
  /** The objects of `.rness`: what is written comes from them. */
  store: ObjectStore
  label: string
  /** The git directory's `rness/`: the record's directory, and where copies are staged. */
  gitDir: string
  record: string
  /** `.git/info/exclude`, found when first needed; null at the root (no repository). */
  exclude: (() => Promise<string | null>) | null
  /** `.claude/skills`, `.agents/skills`, as `agents` and the place want. */
  dirs: string[]
  candidates: readonly AppliedSkill[]
  /** Set: write these names only, remove nothing (`ProjectOptions`). */
  only: ReadonlySet<string> | null
  /** Set: remove the recorded copies of these ids only, write nothing (`ProjectOptions`). */
  uninstall: ReadonlySet<string> | null
}

/** How far one projection may go. */
export interface ProjectOptions {
  /**
   * Write these skill names only, and remove nothing, every other copy and
   * record entry left as it is: `install` after reading an unreadable
   * consent record, when the earlier answers are unknown (ruling R22), or
   * the accepted skills of a bare `install` (ruling R38).
   */
  only?: ReadonlySet<string>
  /**
   * Remove the recorded copies of these skill ids, whatever the state of
   * their copy in `.rness`, and nothing else: no copy written, no other
   * entry touched (`uninstall`, rulings R36, R40).
   */
  uninstall?: ReadonlySet<string>
}

/** `p` under `base`, absolute; throws unless `p` is a skill path and stays inside `base` (decision 7). */
function inside(base: string, p: string): string {
  if (!CLONE_PATH.test(p))
    throw new Error(`refusing ${p}: not a path rness writes a team skill to`)
  const abs = join(base, ...p.split('/'))
  const rel = relative(base, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`refusing ${abs}: outside ${base}`)
  return abs
}

const lstatOrNull = (p: string) =>
  lstat(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })

/** Why nothing may be written under `top` (`.claude`, `.agents`) of `base`; null when it may. */
async function levelProblem(base: string, top: string): Promise<string | null> {
  for (const rel of [top, `${top}/skills`]) {
    const st = await lstatOrNull(join(base, rel))
    if (st === null) return null
    if (st.isSymbolicLink())
      return `${rel} is a symbolic link; rness writes no team skill through it`
    if (!st.isDirectory())
      return `${rel} is not a directory; rness writes no team skill there`
  }
  return null
}

/**
 * Replace rness's block of `.git/info/exclude` with the lines of `paths`:
 * the header, one `/<path>/` line each, the end line; no block when there
 * is no path. Every other line of the file is kept in place: a line the
 * developer adds after the end line is theirs. Inside the block, a line
 * that names no skill path (a comment) is kept, after the new block.
 * Without its end line (an edit by hand), the block is the header and the
 * lines right after it that name a path of `previous`, the record before
 * this run.
 */
async function updateExclude(
  file: string,
  paths: readonly string[],
  previous: readonly string[]
): Promise<void> {
  const text = (await readOrNull(file)) ?? ''
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const at = lines.indexOf(EXCLUDE_HEADER)
  const section =
    paths.length === 0
      ? []
      : [EXCLUDE_HEADER, ...[...paths].sort().map((p) => `/${p}/`), EXCLUDE_END]
  if (at === -1 && section.length === 0) return
  let next: string[]
  if (at === -1) next = [...lines, ...section]
  else {
    const close = lines.indexOf(EXCLUDE_END, at + 1)
    let end = at + 1
    let others: string[] = []
    if (close !== -1) {
      others = lines.slice(at + 1, close).filter((l) => !EXCLUDE_LINE.test(l))
      end = close + 1
    } else {
      const ours = new Set(previous.map((p) => `/${p}/`))
      while (end < lines.length && ours.has(lines[end] ?? '')) end += 1
    }
    next = [...lines.slice(0, at), ...section, ...others, ...lines.slice(end)]
  }
  const out = next.length === 0 ? '' : `${next.join('\n')}\n`
  if (out === text) return
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, out)
}

interface SkillBytes {
  path: string
  executable: boolean
  bytes: Buffer
}

/**
 * The file `path` of a skill's tree under the copy `to`, absolute; throws
 * unless it is a path a copy may hold (`pathProblem`: no `..`, no `.git`)
 * that stays inside `to` (ruling R34). The trees were checked already: a
 * crafted one must not reach the disk all the same.
 */
function fileIn(to: string, path: string): string {
  const problem = pathProblem(path)
  if (problem !== null)
    throw new Error(`refusing ${quoted(path)}: it ${problem}`)
  const at = resolve(to, ...path.split('/'))
  const rel = relative(to, at)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new Error(`refusing ${quoted(path)}: outside ${to}`)
  return at
}

async function writeFiles(files: readonly SkillBytes[], to: string) {
  await mkdir(to, { recursive: true })
  for (const f of files) {
    const at = fileIn(to, f.path)
    await mkdir(dirname(at), { recursive: true })
    await writeFile(at, f.bytes)
    await chmod(at, f.executable ? 0o755 : 0o644)
  }
}

/**
 * The files of the skill `head` from git's objects in `.rness` (decision
 * 8): each blob's bytes as committed, with no checkout filter, so a clone
 * of `.rness` converting line ends never changes what is installed.
 */
async function committedFiles(
  store: ObjectStore,
  head: SkillTree
): Promise<SkillBytes[]> {
  for (const f of head.files) {
    const problem = pathProblem(f.path)
    if (problem !== null)
      throw new Error(`refusing ${quoted(f.path)}: it ${problem}`)
  }
  const blobs = await readObjects(
    store,
    head.files.map((f) => f.id)
  )
  return head.files.map((f) => {
    const bytes = blobs.get(f.id)
    if (bytes === null || bytes === undefined)
      throw new Error(`${f.path}: blob ${f.id} is not in .rness`)
    return { path: f.path, executable: f.executable, bytes }
  })
}

/**
 * Put the copy `files` of skill `name` at `abs`: staged in the git
 * directory, then moved in place of what rness wrote there before.
 */
async function placeCopy(
  place: Place,
  name: string,
  files: readonly SkillBytes[],
  abs: string
): Promise<void> {
  await mkdir(place.gitDir, { recursive: true })
  const tmp = await mkdtemp(join(place.gitDir, 'staging-'))
  try {
    const staged = join(tmp, name)
    await writeFiles(files, staged)
    await mkdir(dirname(abs), { recursive: true })
    await rm(abs, { recursive: true, force: true })
    try {
      await rename(staged, abs)
    } catch (e) {
      // The git directory on another device (a worktree's): written in place.
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await writeFiles(files, abs)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * The files under `dir`, by path relative to it, with their executable
 * bit; null when it holds anything but directories and regular files, or
 * cannot be read. A `.DS_Store` (Finder writes one when it opens a
 * directory) is no part of a copy, unless `kept` says the tree compared
 * holds one at that path.
 */
async function filesUnder(
  dir: string,
  kept: (path: string) => boolean
): Promise<Map<string, boolean> | null> {
  const files = new Map<string, boolean>()
  const visit = async (abs: string, rel: string): Promise<boolean> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const path = rel === '' ? d.name : `${rel}/${d.name}`
      if (d.name === '.DS_Store' && !kept(path)) continue
      const child = join(abs, d.name)
      if (d.isDirectory()) {
        if (!(await visit(child, path))) return false
      } else if (d.isFile())
        files.set(path, ((await lstat(child)).mode & 0o100) !== 0)
      else return false
    }
    return true
  }
  try {
    return (await visit(dir, '')) ? files : null
  } catch {
    return null
  }
}

/**
 * Whether each copy holds the files `files` exactly, file by file: the
 * same paths, the same executable bits, and the blob id git gives each
 * file's bytes as they are (`hash-object --no-filters` in `.rness`, one
 * call for them all), equal to the committed one.
 */
async function copiesMatch(
  store: ObjectStore,
  copies: readonly { abs: string; files: readonly SkillFile[] }[]
): Promise<boolean[]> {
  const result = copies.map(() => false)
  const hashed: { at: number; abs: string; id: string }[] = []
  for (const [at, c] of copies.entries()) {
    const paths = new Set(c.files.map((f) => f.path))
    const seen = await filesUnder(c.abs, (p) => paths.has(p))
    if (
      seen === null ||
      seen.size !== c.files.length ||
      c.files.some((f) => seen.get(f.path) !== f.executable)
    )
      continue
    result[at] = true
    for (const f of c.files)
      hashed.push({ at, abs: fileIn(c.abs, f.path), id: f.id })
  }
  const ids = await blobIds(
    store,
    hashed.map((h) => h.abs)
  )
  hashed.forEach((h, i) => {
    if (ids[i] !== h.id) result[h.at] = false
  })
  return result
}

/**
 * The tree of an earlier commit of the skill at `dir` in `.rness` whose
 * files the copy at `abs` holds exactly, blob for blob; null when it holds
 * none of the last 20 versions. A copy rness wrote from an earlier commit,
 * its record lost, is then known for what it is.
 */
async function earlierTreeOf(
  store: ObjectStore,
  dir: string,
  abs: string,
  current: string
): Promise<string | null> {
  const path = relative(store.dir, dir).split(sep).join('/')
  const trees = (await pathTrees(store, path, 20)).filter((t) => t !== current)
  if (trees.length === 0) return null
  // Every file, each .DS_Store included: a version compared decides on it.
  const seen = await filesUnder(abs, () => true)
  if (seen === null) return null
  const paths = [...seen.keys()]
  if (paths.some((p) => pathProblem(p) !== null)) return null
  const ids = await blobIds(
    store,
    paths.map((p) => fileIn(abs, p))
  )
  const copy = new Map(
    paths.map((p, i) => [
      p,
      `${seen.get(p) === true ? '100755' : '100644'}:${ids[i] ?? ''}`,
    ])
  )
  for (const tree of trees) {
    const files = (await listTree(store, tree).catch(() => [])).filter(
      (e) => e.type !== 'tree'
    )
    const inTree = new Set(files.map((f) => f.path))
    const mine = [...copy.keys()].filter(
      (p) => inTree.has(p) || p.split('/').at(-1) !== '.DS_Store'
    )
    if (
      mine.length === files.length &&
      files.every((f) => copy.get(f.path) === `${f.mode}:${f.id}`)
    )
      return tree
  }
  return null
}

/** The `allowed-tools` of a `SKILL.md`'s front matter, as plain text; `none` when it asks for none. */
const toolsOf = (fields: Record<string, unknown> | null): string =>
  plainText(allowedToolsText(fields?.['allowed-tools']) ?? 'none')

/** The `allowed-tools` of the `SKILL.md` of the tree `tree` in `.rness`; null when git does not have it. */
async function toolsAt(
  store: ObjectStore,
  tree: string
): Promise<string | null> {
  try {
    const md = (await readObjects(store, [`${tree}:SKILL.md`])).get(
      `${tree}:SKILL.md`
    )
    return md === null || md === undefined
      ? null
      : toolsOf(parseFrontMatter(md.toString('utf8')))
  } catch {
    return null
  }
}

type PathState = 'absent' | 'ours' | 'foreign' | 'odd' | 'tracked' | 'blocked'

/** One place: the decisions of spec 0041 §6, then the removals, the record and exclude, the copies. */
async function project(place: Place): Promise<Projection> {
  const out = nothing()
  const note = (line: string): void => {
    out.notes.push(`${place.label}: ${line}`)
  }
  const onDisk = await readInstalled(place.record, place.kind)
  if (onDisk === null) {
    note(
      `${relative(place.base, place.record)} is unreadable; team skills left as they are there`
    )
    return out
  }
  const byName = new Map<string, AppliedSkill[]>()
  for (const a of place.candidates)
    byName.set(a.skill.name, [...(byName.get(a.skill.name) ?? []), a])
  // What each name should be here: written from its committed tree, left as
  // it is (invalid, or a name twice), or nothing.
  const want = new Map<string, AppliedSkill & { head: SkillTree }>()
  const kept = new Set<string>()
  for (const [name, list] of byName) {
    const one = list.length === 1 ? list[0] : undefined
    if (place.uninstall !== null) {
      // An uninstall removes the copies of its ids and writes nothing (R40).
      if (one === undefined || !place.uninstall.has(one.id)) kept.add(name)
    } else if (one === undefined) {
      // Said once it matters: one of them accepted, or a copy here already.
      if (
        list.some((a) => a.state === 'installed') ||
        Object.hasOwn(onDisk.skills, name)
      )
        note(
          `team skill ${name} applies here more than once (${rnessCommand()} validate says where); left as it is`
        )
      kept.add(name)
    } else if (one.state === 'invalid') kept.add(name)
    else if (one.state === 'installed' && isValid(one) && place.dirs.length > 0)
      want.set(name, one)
  }
  if (place.only !== null)
    for (const name of [...Object.keys(onDisk.skills), ...byName.keys()])
      if (!place.only.has(name)) {
        kept.add(name)
        want.delete(name)
      }
  if (place.uninstall !== null)
    for (const name of Object.keys(onDisk.skills))
      if (!byName.has(name)) kept.add(name)
  const names = [...new Set([...Object.keys(onDisk.skills), ...want.keys()])]
    .filter((n) => !kept.has(n))
    .sort()
  // Ruling R29: a name applying once, accepted, that the record does not
  // name: its copies may be rness's, the record lost (a new clone of .rness,
  // a deleted file).
  const adoptable = [...byName].flatMap(([name, list]) => {
    const a = list.length === 1 ? list[0] : undefined
    return place.uninstall === null &&
      a !== undefined &&
      a.state === 'installed' &&
      isValid(a) &&
      !Object.hasOwn(onDisk.skills, name)
      ? [{ name, head: a.head, dir: a.skill.dir }]
      : []
  })
  if (names.length === 0 && (adoptable.length === 0 || place.dirs.length === 0))
    return out

  // Decision 7: the home directory is never a place.
  const home = await realpath(homedir()).catch(() => null)
  if (home !== null && (await realpath(place.base)) === home) {
    note('it is your home directory; rness never writes a team skill there')
    return out
  }

  const levels = new Map<string, string | null>()
  for (const top of ['.claude', '.agents'])
    levels.set(top, await levelProblem(place.base, top))
  const wantedPaths = (name: string): string[] =>
    want.has(name) ? place.dirs.map((d) => `${d}/${name}`) : []
  const all = names.flatMap((n) => [
    ...new Set([...wantedPaths(n), ...(onDisk.skills[n]?.paths ?? [])]),
  ])
  const adoptPaths = adoptable.flatMap((c) =>
    place.dirs.map((d) => `${d}/${c.name}`)
  )
  const topOf = (p: string): string => p.split('/')[0] ?? ''
  const tracked =
    place.kind === 'clone'
      ? await trackedPaths(
          place.base,
          [...new Set([...all, ...adoptPaths])].filter(
            (p) => levels.get(topOf(p)) === null
          )
        )
      : new Set<string>()

  // An untracked directory there whose files are the committed ones, blob
  // for blob, is the copy rness wrote: recorded again, so it is excluded and
  // managed; one holding an earlier commit of the skill is recorded at that
  // tree, and the new version is written over it below. Any other directory
  // stays foreign: left alone, and said.
  const record: InstalledRecord = { version: 1, skills: { ...onDisk.skills } }
  const found: {
    name: string
    head: SkillTree
    dir: string
    p: string
    abs: string
  }[] = []
  for (const c of adoptable)
    for (const d of place.dirs) {
      const p = `${d}/${c.name}`
      if (levels.get(topOf(p)) !== null || tracked.has(p)) continue
      const abs = inside(place.base, p)
      const st = await lstatOrNull(abs)
      if (st !== null && !st.isSymbolicLink() && st.isDirectory())
        found.push({ ...c, p, abs })
    }
  const adopted = await copiesMatch(
    place.store,
    found.map((f) => ({ abs: f.abs, files: f.head.files }))
  )
  for (const [i, f] of found.entries()) {
    const earlier =
      adopted[i] === true
        ? null
        : await earlierTreeOf(place.store, f.dir, f.abs, f.head.tree)
    if (adopted[i] !== true && earlier === null) continue
    const entry = record.skills[f.name]
    // One tree per skill: an earlier one wins, so every path gets the new version.
    const was = entry?.tree !== undefined && entry.tree !== f.head.tree
    record.skills[f.name] = {
      tree: earlier ?? (was ? (entry?.tree ?? f.head.tree) : f.head.tree),
      paths: [...(entry?.paths ?? []), f.p],
    }
    note(
      earlier === null
        ? `${f.p} is team skill ${f.name} as committed; recorded again`
        : `${f.p} is team skill ${f.name} as committed before (${earlier.slice(0, 7)}); recorded again`
    )
  }
  const state = new Map<string, PathState>()
  for (const p of all) {
    if (levels.get(topOf(p)) !== null) state.set(p, 'blocked')
    else if (tracked.has(p)) state.set(p, 'tracked')
    else {
      const st = await lstatOrNull(inside(place.base, p))
      const recorded = Object.values(record.skills).some((e) =>
        e.paths.includes(p)
      )
      state.set(
        p,
        st === null
          ? 'absent'
          : st.isSymbolicLink() || !st.isDirectory()
            ? 'odd'
            : recorded
              ? 'ours'
              : 'foreign'
      )
    }
  }

  const next: InstalledRecord = emptyRecord()
  const removals: { name: string; path: string }[] = []
  const retained: { name: string; path: string }[] = []
  type Write = { name: string; path: string; kind: 'fresh' | 'update' | 'edit' }
  const writes: Write[] = []
  const verify: { name: string; path: string; files: readonly SkillFile[] }[] =
    []
  const blockedSaid = new Set<string>()
  for (const name of Object.keys(record.skills).sort())
    if (kept.has(name))
      next.skills[name] = record.skills[name] as InstalledEntry
  for (const name of names) {
    const entry = record.skills[name]
    const a = want.get(name)
    let paths = wantedPaths(name)
    const clashes = paths.filter((p) => {
      const s = state.get(p)
      return s !== 'absent' && s !== 'ours'
    })
    for (const p of clashes) {
      const s = state.get(p)
      if (s === 'blocked') {
        const top = topOf(p)
        if (!blockedSaid.has(top)) note(levels.get(top) ?? '')
        blockedSaid.add(top)
      } else if (s === 'tracked')
        note(
          `${p} is the repository's own; team skill ${name} not installed there`
        )
      else
        note(
          `${p} is not one rness wrote; team skill ${name} not installed there`
        )
    }
    if (clashes.length > 0) paths = []
    // Only what the record names and is still a directory rness wrote goes;
    // a path now tracked, linked or replaced is forgotten, never touched.
    // When nothing may be removed, it stays rness's, in the record.
    for (const p of entry?.paths ?? [])
      if (!paths.includes(p) && state.get(p) === 'ours')
        (place.only === null ? removals : retained).push({ name, path: p })
    if (a === undefined || paths.length === 0) continue
    next.skills[name] = { tree: a.head.tree, paths }
    for (const p of paths)
      if (state.get(p) === 'absent')
        writes.push({ name, path: p, kind: 'fresh' })
      else if (entry?.tree !== a.head.tree)
        writes.push({ name, path: p, kind: 'update' })
      else verify.push({ name, path: p, files: a.head.files })
  }
  // A copy at the recorded tree is checked file by file against git's blob
  // ids: an edit, an added file or a changed mode is written over.
  const intact = await copiesMatch(
    place.store,
    verify.map((v) => ({ abs: inside(place.base, v.path), files: v.files }))
  )
  verify.forEach((v, i) => {
    if (intact[i] !== true)
      writes.push({ name: v.name, path: v.path, kind: 'edit' })
  })

  const removed = new Set<string>()
  for (const r of removals)
    try {
      await rm(inside(place.base, r.path), { recursive: true, force: true })
      removed.add(r.name)
    } catch (e) {
      out.problems.push(`${place.label}: ${(e as Error).message}`)
      // Still rness's: kept in the record, removed again by the next run.
      retained.push(r)
    }
  for (const r of retained) {
    const kept = next.skills[r.name]
    const was = record.skills[r.name]
    if (was !== undefined)
      next.skills[r.name] = {
        tree: kept?.tree ?? was.tree,
        paths: [...(kept?.paths ?? []), r.path],
      }
  }

  // The record and the exclude lines name a copy before it is written: an
  // interrupted run leaves a path rness owns and rewrites, never a stray
  // directory it would take for the repository's own.
  const sorted: InstalledRecord = {
    version: 1,
    skills: Object.fromEntries(
      Object.entries(next.skills).sort(([x], [y]) => (x < y ? -1 : 1))
    ),
  }
  const had = Object.keys(onDisk.skills).length > 0
  if (
    (had || Object.keys(sorted.skills).length > 0) &&
    JSON.stringify(sorted) !== JSON.stringify(onDisk)
  )
    await writeInstalled(place.record, sorted)
  if (place.exclude !== null) {
    const file = await place.exclude()
    if (file !== null)
      await updateExclude(
        file,
        Object.values(sorted.skills).flatMap((e) => e.paths),
        Object.values(onDisk.skills).flatMap((e) => e.paths)
      )
  }

  const done = {
    fresh: new Set<string>(),
    update: new Set<string>(),
    edit: new Set<string>(),
  }
  const byWrite = new Map<string, Write[]>()
  for (const w of writes)
    byWrite.set(w.name, [...(byWrite.get(w.name) ?? []), w])
  for (const [name, list] of byWrite) {
    const a = want.get(name)
    if (a === undefined) continue
    try {
      const files = await committedFiles(place.store, a.head)
      for (const w of list) {
        await placeCopy(place, name, files, inside(place.base, w.path))
        done[w.kind].add(name)
      }
    } catch (e) {
      out.problems.push(`${place.label}: ${(e as Error).message}`)
    }
  }
  for (const name of [...done.update].sort()) {
    const from = record.skills[name]?.tree
    const a = want.get(name)
    if (from === undefined || a === undefined) continue
    const before = await toolsAt(place.store, from)
    const after = toolsOf(a.head.fields)
    out.updated.push({
      id: a.id,
      name,
      from,
      to: a.head.tree,
      tools: before === null || before === after ? null : [before, after],
    })
  }
  out.installed = [...done.fresh].sort()
  out.rewritten = [...done.edit]
    .filter((n) => !done.fresh.has(n) && !done.update.has(n))
    .sort()
  out.removed = [...removed].sort()
  return out
}

const dirsOf = (manifest: Manifest, kind: InstalledKind): string[] => [
  ...((manifest.agents ?? []).includes('claude') ? ['.claude/skills'] : []),
  ...(kind === 'clone' ? ['.agents/skills'] : []),
]

/**
 * Install in the clone `org/<repo>` the skills that apply to it (its
 * repository's, its parts', the top-level ones) and that the developer
 * accepted, as committed at `HEAD` of `.rness`; remove what rness wrote
 * there and is no longer accepted or declared. A clone that is no git
 * repository is left alone, as the hooks leave it.
 */
export async function projectClone(
  ws: Workspace,
  manifest: Manifest,
  applied: readonly AppliedSkill[],
  repo: string,
  opts: ProjectOptions = {}
): Promise<Projection> {
  const base = join(ws.root, 'org', repo)
  const gitDir = await gitPath(base, 'rness')
  if (gitDir === null) return nothing()
  const applies = new Set(
    skillsForClone(
      manifest,
      applied.map((a) => a.skill),
      repo
    )
  )
  return project({
    kind: 'clone',
    base,
    store: objectStore(ws.rnessDir),
    label: `org/${repo}`,
    gitDir,
    record: join(gitDir, 'skills.json'),
    exclude: () => gitPath(base, 'info/exclude'),
    dirs: dirsOf(manifest, 'clone'),
    candidates: applied.filter((a) => applies.has(a.skill)),
    only: opts.only ?? null,
    uninstall: opts.uninstall ?? null,
  })
}

/** The label of the root in what is said. */
export const ROOT_LABEL = 'workspace root'

/**
 * Install the top-level skills accepted at the workspace root's
 * `.claude/skills/` when `agents` declares `claude`, for a session opened
 * there; their record lives in the git directory of `.rness`.
 */
export async function projectRoot(
  ws: Workspace,
  manifest: Manifest,
  applied: readonly AppliedSkill[],
  opts: ProjectOptions = {}
): Promise<Projection> {
  // A context checkout on its own (`rness.json` at its top) has no root of
  // its own: its parent directory is no workspace.
  if (ws.rnessDir !== join(ws.root, '.rness')) return nothing()
  const gitDir = await gitPath(ws.rnessDir, 'rness')
  if (gitDir === null) return nothing()
  return project({
    kind: 'root',
    base: ws.root,
    store: objectStore(ws.rnessDir),
    label: ROOT_LABEL,
    gitDir,
    record: join(gitDir, 'root-skills.json'),
    exclude: null,
    dirs: dirsOf(manifest, 'root'),
    candidates: applied.filter((a) => a.skill.scope === null),
    only: opts.only ?? null,
    uninstall: opts.uninstall ?? null,
  })
}

/**
 * The applied skills of a run, and whether the projection may act: never
 * when `.rness` is no git repository (no consent can exist: none is listed
 * either, so nothing is said pending) or its record is unreadable (what was
 * accepted is unknown: everything is left as it is).
 */
export async function skillsOfRun(
  ws: Workspace,
  manifest: Manifest,
  warn: (text: string) => void
): Promise<{ applied: AppliedSkill[]; act: boolean }> {
  // No consent record can exist: nothing is pending, nothing is asked.
  if ((await gitPath(ws.rnessDir, 'rness')) === null)
    return { applied: [], act: false }
  let act = true
  const consent = await readConsent(
    ws.rnessDir,
    (file) => {
      act = false
      warn(
        `${file} is unreadable: team skills left as they are; ${rnessCommand()} skill install asks again`
      )
    },
    (file, ids) => warn(droppedLine(file, ids))
  )
  return { applied: await appliedSkills(ws, manifest, consent), act }
}

/** The declared repositories cloned in `org/`, by name: where `install` writes. */
export async function declaredClones(
  ws: Workspace,
  manifest: Manifest
): Promise<string[]> {
  const { clones } = await orgDirs(ws.root, providerOf(manifest))
  return repositories(manifest)
    .map((r) => r.name)
    .filter((n) => clones.has(n))
}

/**
 * The `updated` lines of a run (spec 0041 §5): one per skill and change of
 * tree, whatever the number of places it was written to, with the
 * `allowed-tools` of the two versions when they differ. A skill is named
 * by its id when another of `applied` has its name (ruling R27).
 */
export function updateLines(
  projections: readonly Projection[],
  applied: readonly AppliedSkill[]
): Line[] {
  const seen = new Set<string>()
  const lines: Line[] = []
  for (const u of projections.flatMap((p) => p.updated)) {
    const key = `${u.id} ${u.from} ${u.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = applied.some((a) => a.id !== u.id && a.skill.name === u.name)
      ? u.id
      : u.name
    lines.push([
      'updated',
      `${plainText(label)} (${u.from.slice(0, 7)} -> ${u.to.slice(0, 7)})${u.tools === null ? '' : `, allowed-tools: ${u.tools[0]} -> ${u.tools[1]}`}`,
    ])
  }
  return lines
}

/**
 * The line said for each applied skill not committed in `.rness` yet,
 * accepted or awaiting an answer: it installs from the commit. A declined
 * one is not the developer's concern.
 */
export const uncommittedLines = (
  applied: readonly AppliedSkill[],
  label: (a: AppliedSkill) => string
): string[] =>
  applied
    .filter((a) => a.uncommitted === true && a.answer !== 'declined')
    .map((a) => `${plainText(label(a))}: ${COMMIT_FIRST}`)

/** `sync`'s lines for one place: what was written and removed, then the notes. */
export function projectionLines(
  label: string,
  p: Projection
): (Line | string)[] {
  const said = (names: readonly string[]): string =>
    `${label} team ${names.length === 1 ? 'skill' : 'skills'} (${names.join(', ')})`
  return [
    ...(p.installed.length > 0
      ? [['installed', said(p.installed)] as const]
      : []),
    ...(p.rewritten.length > 0
      ? [['rewrote', said(p.rewritten)] as const]
      : []),
    ...(p.removed.length > 0 ? [['removed', said(p.removed)] as const] : []),
    ...p.notes,
  ]
}

/** The line said when skills await the developer's answer (spec 0041 §5). */
export const pendingLine = (
  n: number,
  env: NodeJS.ProcessEnv = process.env
): Line => [
  'skills',
  `${count(n, ['team skill awaits', 'team skills await'])} your consent: ${rnessCommand(env)} skill install`,
]
