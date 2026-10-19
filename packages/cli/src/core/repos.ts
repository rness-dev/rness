import { glob, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { exists } from './fs.ts'
import { clone, originUrl } from './git.ts'
import {
  NAME,
  NAME_RULE,
  parseRepoSpec,
  providerOf,
  writeManifest,
} from './manifest.ts'
import type { GitCredentials } from './provider.ts'
import { sameRemote } from './remote.ts'
import type { Manifest, ScopeEntry } from './types.ts'
import { entryFor } from './workspace.ts'

export interface AddRepositoryInput {
  root: string
  rnessDir: string
  manifest: Manifest
  /** `<repo>`, `<owner>/<repo>`, or a clone URL. */
  spec: string
  /** The owner of a bare `<repo>`; null in a blank workspace, which refuses one. */
  org: string | null
  host: string
  /** Sub-scopes relative to the repository (`apps/web`); each becomes scope `<basename>` extending `<repo>`. */
  scopes: readonly string[]
  /** HTTPS credentials for the URL the spec resolves to, when there are any. */
  credentialsFor?: (url: string) => GitCredentials | null
}

export interface AddRepositoryResult {
  manifest: Manifest
  name: string
  url: string
  action: 'cloned' | 'adopted'
  /** The directory the adopted clone had, when only its case differed from `org/<name>`; null otherwise. */
  renamed: string | null
  /** Scope names written to the manifest, repository scope first. */
  declared: string[]
}

/** Clone (or adopt) a repository under `org/` and declare it — manifest written last (spec 0003 §3). */
export async function addRepository(
  input: AddRepositoryInput
): Promise<AddRepositoryResult> {
  const { name, url } = parseRepoSpec(
    input.spec,
    input.org,
    input.host,
    providerOf(input.manifest)
  )
  const orgDir = join(input.root, 'org')
  const dir = join(orgDir, name)

  // Validate every scope before touching the filesystem: a malformed request
  // must never leave a clone behind that the manifest doesn't know about. Only
  // the per-sub directory-existence check needs the clone (or adoption) to have
  // happened, so it waits until after.
  const repoPath = `org/${name}`
  // The repository scope gets the same protection as a sub-scope: a name
  // already taken by another path is a collision, not something to overwrite.
  // At the same path the entry keeps its `extends` — a hand-added shared
  // parent scope survives every later `add` of the repository.
  // A path that differs only by case (`org/dApp`) is this clone under its
  // former name, rewritten here as the directory is renamed below.
  const current = input.manifest.scopes[name]
  if (current !== undefined && current.path.toLowerCase() !== repoPath)
    throw new Error(`scope "${name}" already points at ${current.path}`)
  const scopes: Record<string, ScopeEntry> = {
    ...input.manifest.scopes,
    [name]: { path: repoPath, extends: current?.extends ?? [] },
  }
  const subs: { clean: string; base: string }[] = []
  for (const sub of input.scopes) {
    const clean = sub.replace(/^\/+|\/+$/g, '')
    const segments = clean.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..'))
      throw new Error(
        `sub-scope "${clean}" must be a relative path inside the repository`
      )
    // The key is lowercase, as a repository's; the path is the directory as
    // it is on disk.
    const base = (segments.at(-1) ?? '').toLowerCase()
    const path = `org/${name}/${clean}`
    if (!NAME.test(base))
      throw new Error(
        `the last segment of sub-scope "${clean}" may only contain ${NAME_RULE}`
      )
    const existing = scopes[base]
    if (
      existing !== undefined &&
      existing.path.toLowerCase() !== path.toLowerCase()
    )
      throw new Error(`scope "${base}" already points at ${existing.path}`)
    scopes[base] = { path, extends: [name] }
    subs.push({ clean, base })
  }

  // The directory on disk: `org/<name>`, or one that differs only by case,
  // checked here and renamed to `org/<name>` once nothing else can fail.
  const entry = await entryFor(input.root, name)
  let action: AddRepositoryResult['action']
  if (entry !== null) {
    const found = join(orgDir, entry)
    const origin = await originUrl(found)
    if (origin === null)
      throw new Error(`org/${entry} exists and is not a git clone`)
    if (!sameRemote(origin, url))
      throw new Error(`org/${entry} is a clone of ${origin}, not ${url}`)
    action = 'adopted'
  } else {
    await clone(url, dir, input.credentialsFor?.(url) ?? null)
    action = 'cloned'
  }

  const holder = join(orgDir, entry ?? name)
  const declared = [name]
  for (const { clean, base } of subs) {
    if (!(await exists(join(holder, ...clean.split('/'))))) {
      // Only a clone this call just made is ours to remove: it isn't in the
      // manifest yet, so nothing is lost. An adopted directory predates this
      // call and is left alone.
      if (action === 'cloned') await rm(dir, { recursive: true, force: true })
      throw new Error(`org/${entry ?? name}/${clean} does not exist`)
    }
    declared.push(base)
  }

  const renamed = entry !== null && entry !== name ? entry : null
  if (renamed !== null) await renameCase(orgDir, renamed, name)

  const manifest: Manifest = {
    ...input.manifest,
    repos: { ...input.manifest.repos, [name]: { url } },
    scopes,
  }
  await writeManifest(input.rnessDir, manifest)
  return { manifest, name, url, action, renamed, declared }
}

/**
 * `org/<from>` renamed `org/<to>`, two names that differ only by case. Two
 * steps, through a name `NAME` refuses so that nothing reads it as a clone:
 * a file system that ignores case may refuse or ignore a direct rename. A
 * failed second step puts the directory back.
 */
async function renameCase(
  orgDir: string,
  from: string,
  to: string
): Promise<void> {
  const step = `${from}.rness-rename`
  if (await exists(join(orgDir, step)))
    throw new Error(
      `org/${step} exists, left by an interrupted rename: move it back to org/${from}, then run rness add again`
    )
  await rename(join(orgDir, from), join(orgDir, step))
  try {
    await rename(join(orgDir, step), join(orgDir, to))
  } catch (e) {
    await rename(join(orgDir, step), join(orgDir, from))
    throw e
  }
}

/** The clone of `repos` that holds `dir`: its name, directory and URL; null in `.rness/`, at the root, or outside. */
export function cloneHolding(
  root: string,
  repos: Manifest['repos'],
  dir: string
): { name: string; dir: string; url: string } | null {
  for (const [name, repo] of Object.entries(repos)) {
    const clone = resolve(root, 'org', name)
    const r = relative(clone, resolve(dir))
    if (r === '' || (!r.startsWith('..') && !isAbsolute(r)))
      return { name, dir: clone, url: repo.url }
  }
  return null
}

/** Directories matched by `package.json#workspaces` that hold a `package.json`, POSIX-relative, sorted. */
export async function workspaceDirs(repoDir: string): Promise<string[]> {
  let patterns: string[] = []
  try {
    const pkg = JSON.parse(
      await readFile(join(repoDir, 'package.json'), 'utf8')
    ) as { workspaces?: unknown }
    const w = pkg.workspaces
    if (Array.isArray(w))
      patterns = w.filter((p): p is string => typeof p === 'string')
    else if (
      w !== null &&
      typeof w === 'object' &&
      Array.isArray((w as { packages?: unknown }).packages)
    ) {
      patterns = (w as { packages: unknown[] }).packages.filter(
        (p): p is string => typeof p === 'string'
      )
    }
  } catch {
    return []
  }
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd: repoDir })) {
      const rel = match.split(sep).join(posix.sep)
      if (await exists(join(repoDir, ...rel.split(posix.sep), 'package.json')))
        dirs.add(rel)
    }
  }
  return [...dirs].sort()
}
