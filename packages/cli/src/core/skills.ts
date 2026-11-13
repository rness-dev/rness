import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
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
import { fetchRef } from './git.ts'
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
 * whole run: declared or written by the team, whose copy passes the checks,
 * with its name and one-line description as plain text. A copy that does not
 * pass is left out (`validate` says why), and so is everything when the
 * skills cannot be listed: a block is never what fails.
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
  for (const skill of all) {
    try {
      await checkSkillDir(skill.dir, skill.name)
      const fields = parseFrontMatter(
        await readFile(join(skill.dir, 'SKILL.md'), 'utf8')
      )
      const description = fields?.['description']
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

interface SkillFile {
  /** Relative to the skill directory, POSIX separators. */
  path: string
  abs: string
  executable: boolean
  size: number
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

/**
 * The regular files under `dir`, sorted by path in byte order; a `.git` at
 * the root (the fetch's own repository) is not part of the skill. Anything
 * that is neither a regular file nor a directory is refused, naming it.
 */
async function walk(dir: string, name: string): Promise<SkillFile[]> {
  const files: SkillFile[] = []
  const visit = async (abs: string, rel: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      if (rel === '' && d.name === '.git') continue
      const path = rel === '' ? d.name : `${rel}/${d.name}`
      const child = join(abs, d.name)
      if (d.isDirectory()) await visit(child, path)
      else if (d.isFile()) {
        const st = await lstat(child)
        files.push({
          path,
          abs: child,
          executable: (st.mode & 0o100) !== 0,
          size: st.size,
        })
      } else
        throw refusal(
          name,
          `${quoted(path)} is ${d.isSymbolicLink() ? 'a symbolic link' : 'neither a regular file nor a directory'}; only regular files and directories are allowed`
        )
    }
  }
  await visit(dir, '')
  return files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  )
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
 * Check the directory `dir` as the skill `name` (spec 0041 §4): the name
 * rule, regular files only, at most 1 MB, a `SKILL.md` whose `name` is the
 * directory's and which has a `description`. Throws an error naming the
 * skill and the reason; returns the content size and files otherwise.
 */
export async function checkSkillDir(
  dir: string,
  name: string
): Promise<{ bytes: number; files: SkillFile[] }> {
  const bad = nameProblem(name)
  if (bad !== null) throw refusal(name, bad)
  const files = await walk(dir, name)
  for (const f of files) {
    if (CONTROL.test(f.path))
      throw refusal(
        name,
        `file name ${quoted(f.path)} holds a control character`
      )
    if (INVISIBLE.test(f.path))
      throw refusal(
        name,
        `file name ${quoted(f.path)} holds a zero-width or bidirectional character`
      )
  }
  const bytes = files.reduce((n, f) => n + f.size, 0)
  if (bytes > MAX_SKILL_BYTES)
    throw refusal(
      name,
      `its content is ${bytes} bytes, above the limit of ${MAX_SKILL_BYTES} bytes (1 MB)`
    )
  if (!files.some((f) => f.path === 'SKILL.md'))
    throw refusal(name, 'no SKILL.md at the root of its directory')
  let fields
  try {
    fields = parseFrontMatter(await readFile(join(dir, 'SKILL.md'), 'utf8'))
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
  return { bytes, files }
}

/**
 * Per file, a digest of its path-independent identity: bytes and executable
 * bit. For comparing two copies (`diffSkillFiles`), keyed by relative path.
 */
export async function skillFileDigests(
  dir: string
): Promise<Map<string, string>> {
  const digests = new Map<string, string>()
  for (const f of await walk(dir, basename(dir)))
    digests.set(
      f.path,
      createHash('sha256')
        .update(f.executable ? 'x\0' : '-\0')
        .update(await readFile(f.abs))
        .digest('hex')
    )
  return digests
}

/** The paths added, changed (bytes or executable bit) and removed from `before` to `after`. */
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

/**
 * The hash of a skill directory (spec 0041 §9): SHA-256 over each file in
 * byte order of its path, as `path NUL x|- NUL length NUL bytes`, written
 * `sha256-<base64>`. The executable bit is the owner's.
 */
export async function hashSkillDir(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const f of await walk(dir, basename(dir))) {
    const bytes = await readFile(f.abs)
    h.update(`${f.path}\0${f.executable ? 'x' : '-'}\0${bytes.length}\0`)
    h.update(bytes)
  }
  return `sha256-${h.digest('base64')}`
}

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
    const name = parseFrontMatter(
      await readFile(join(dir, 'SKILL.md'), 'utf8')
    )?.['name']
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

/** What `copySkill` made. */
export interface CopiedSkill {
  name: string
  /** Absolute: the copy under `.rness/skills/`. */
  dir: string
  hash: string
  bytes: number
}

/**
 * Check the fetched skill (§4) and copy it into
 * `<rnessDir>/skills/[scopes/<scope>/]<name>/`, `name` being `opts.name`
 * (`--name`: the `name` of the copy's `SKILL.md` is rewritten) or the
 * source's. The copy is written beside its place and swapped in, so a
 * failure leaves the previous copy; files are 0755 when executable, else
 * 0644. The hash is taken on the finished copy.
 */
export async function copySkill(
  rnessDir: string,
  from: FetchedSkill,
  opts: { scope: string | null; name?: string }
): Promise<CopiedSkill> {
  const name = opts.name ?? from.name
  const source = await checkSkillDir(from.dir, from.name)
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
  await mkdir(base, { recursive: true })
  const staged = await mkdtemp(join(base, `.${name}-`))
  try {
    for (const f of source.files) {
      const to = join(staged, ...f.path.split('/'))
      await mkdir(dirname(to), { recursive: true })
      let bytes: Buffer = await readFile(f.abs)
      if (f.path === 'SKILL.md' && name !== from.name)
        bytes = renamed(bytes, from.name, name)
      await writeFile(to, bytes)
      await chmod(to, f.executable ? 0o755 : 0o644)
    }
    const { bytes } = await checkSkillDir(staged, name)
    const hash = await hashSkillDir(staged)
    const old = `${staged}.old`
    const had = await lstat(target).then(
      () => true,
      () => false
    )
    if (had) await rename(target, old)
    await rename(staged, target)
    if (had) await rm(old, { recursive: true, force: true })
    return { name, dir: target, hash, bytes }
  } catch (e) {
    await rm(staged, { recursive: true, force: true })
    throw e
  }
}

/**
 * What `validate` says of the copies (spec 0041 §4): `problems` are
 * refusals (a skill that breaks §4, a declared copy that is missing);
 * `reported` are lines that are said and never refused (a declared copy
 * that differs from its `hash`).
 */
export async function checkSkillCopies(
  rnessDir: string,
  manifest: Manifest
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
  for (const s of await teamSkills(rnessDir, manifest)) {
    if (linked.has(dirname(s.dir))) continue
    const place = plainText(relative(rnessDir, s.dir))
    const st = await lstat(s.dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (st === null) {
      problems.push(
        `skill ${quoted(s.name)} is declared but its copy ${place} is missing: run rness skill update ${plainText(s.name)}`
      )
      continue
    }
    if (!st.isDirectory()) {
      problems.push(
        `skill ${quoted(s.name)}: ${place} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}; only regular files and directories are allowed`
      )
      continue
    }
    try {
      await checkSkillDir(s.dir, s.name)
    } catch (e) {
      problems.push((e as Error).message)
      continue
    }
    if (s.entry !== null && (await hashSkillDir(s.dir)) !== s.entry.hash)
      reported.push(
        `skill ${quoted(s.name)} differs from its source: run rness skill update, or remove its source to make it the team's own`
      )
  }
  return { problems, reported }
}
