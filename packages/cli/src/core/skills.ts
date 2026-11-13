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
  new Error(`skill "${name}": ${reason}`)

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
          `"${path}" is ${d.isSymbolicLink() ? 'a symbolic link' : 'neither a regular file nor a directory'}; only regular files and directories are allowed`
        )
    }
  }
  await visit(dir, '')
  return files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  )
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
    throw refusal(name, `SKILL.md: ${(e as Error).message}`)
  }
  if (fields === null) throw refusal(name, 'SKILL.md has no front matter')
  if (typeof fields['name'] !== 'string' || fields['name'] === '')
    throw refusal(name, 'SKILL.md has no name')
  if (fields['name'] !== name)
    throw refusal(
      name,
      `SKILL.md name "${fields['name']}" is not the directory's name "${name}"`
    )
  const description = fields['description']
  if (typeof description !== 'string' || description.trim() === '')
    throw refusal(name, 'SKILL.md has no description')
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
      `a source is github:<owner>/<repo>, git:<url> or path:<dir>, not "${source}"`
    )
  return `https://github.com/${repo}.git`
}

/** A skill fetched from its source, to be copied; `release` removes the temporary checkout. */
export interface FetchedSkill {
  /** The directory holding the skill (the checkout or its `path`; the directory itself for `path:`). */
  dir: string
  /** The source directory's name: the last segment of `path`, of the repository URL, or of the `path:` directory. */
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
      throw new Error(`no directory "${dir}" for source ${source}`)
    return { dir, name: basename(dir), commit: null, release: async () => {} }
  }
  const sub = opts.path === undefined ? '' : posix.normalize(opts.path)
  if (isAbsolute(sub) || sub === '..' || sub.startsWith('../'))
    throw new Error(`path "${opts.path}" leaves the repository`)
  const tmp = await mkdtemp(join(tmpdir(), 'rness-skill-'))
  const release = (): Promise<void> => rm(tmp, { recursive: true, force: true })
  try {
    const commit = await fetchRef(url, opts.ref ?? null, tmp, opts.credentials)
    const dir = sub === '' || sub === '.' ? tmp : join(tmp, sub)
    // A link inside the checkout must not lead out of it.
    const real = await realpath(dir).catch(() => null)
    if (real === null || !(await stat(real)).isDirectory())
      throw new Error(`no directory "${opts.path}" in ${source}`)
    if (
      real !== (await realpath(tmp)) &&
      !real.startsWith((await realpath(tmp)) + sep)
    )
      throw new Error(`path "${opts.path}" leaves the repository`)
    const name =
      dir === tmp
        ? basename(
            url
              .replace(/\/+$/, '')
              .replace(/\.git$/, '')
              .replace(/^.*:/, '')
          )
        : basename(dir)
    return { dir, name, commit, release }
  } catch (e) {
    await release()
    throw e
  }
}

/** `SKILL.md` with the `name` of its front matter set to `name`, every other byte unchanged. */
function renamed(md: string, from: string, name: string): string {
  const block = md.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/)
  const at = block?.[2]?.search(/^name:.*$/m) ?? -1
  if (block === null || block[2] === undefined || at < 0)
    throw refusal(from, 'SKILL.md has no name line to rewrite')
  const head = (block[1] ?? '').length
  const line = /^name:.*$/m.exec(block[2])?.[0] ?? ''
  const start = head + at
  return md.slice(0, start) + `name: ${name}` + md.slice(start + line.length)
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
  const base =
    opts.scope === null
      ? join(rnessDir, 'skills')
      : join(rnessDir, 'skills', 'scopes', opts.scope)
  const target = join(base, name)
  await mkdir(base, { recursive: true })
  const staged = await mkdtemp(join(base, `.${name}-`))
  try {
    for (const f of source.files) {
      const to = join(staged, ...f.path.split('/'))
      await mkdir(dirname(to), { recursive: true })
      let bytes: Buffer | string = await readFile(f.abs)
      if (f.path === 'SKILL.md' && name !== from.name)
        bytes = renamed(bytes.toString('utf8'), from.name, name)
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
  for (const s of await teamSkills(rnessDir, manifest)) {
    const place = relative(rnessDir, s.dir)
    const st = await lstat(s.dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (st === null) {
      problems.push(
        `skill "${s.name}" is declared but its copy ${place} is missing: run rness skill update ${s.name}`
      )
      continue
    }
    if (!st.isDirectory()) {
      problems.push(
        `skill "${s.name}": ${place} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}; only regular files and directories are allowed`
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
        `skill "${s.name}" differs from its source: run rness skill update, or remove its source to make it the team's own`
      )
  }
  return { problems, reported }
}
