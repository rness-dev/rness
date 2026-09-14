import { glob, readFile, rm } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'

import { exists } from './fs.ts'
import { clone, originUrl } from './git.ts'
import { NAME, parseRepoSpec, writeManifest } from './manifest.ts'
import type { Manifest, ScopeEntry } from './types.ts'

export interface AddRepositoryInput {
  root: string
  rnessDir: string
  manifest: Manifest
  /** `<repo>`, `<owner>/<repo>`, or a clone URL. */
  spec: string
  org: string
  host: string
  /** Sub-scopes relative to the repository (`apps/web`); each becomes scope `<basename>` extending `<repo>`. */
  scopes: readonly string[]
}

export interface AddRepositoryResult {
  manifest: Manifest
  name: string
  url: string
  action: 'cloned' | 'adopted'
  /** Scope names written to the manifest, repository scope first. */
  declared: string[]
}

/** Clone (or adopt) a repository under `org/` and declare it — manifest written last (spec 0003 §3). */
export async function addRepository(
  input: AddRepositoryInput
): Promise<AddRepositoryResult> {
  const { name, url } = parseRepoSpec(input.spec, input.org, input.host)
  const dir = join(input.root, 'org', name)

  // Validate every scope before touching the filesystem: a malformed request
  // must never leave a clone behind that the manifest doesn't know about. Only
  // the per-sub directory-existence check needs the clone (or adoption) to have
  // happened, so it waits until after.
  const repoPath = `org/${name}`
  // The repository scope gets the same protection as a sub-scope: a name
  // already taken by another path is a collision, not something to overwrite.
  // At the same path the entry keeps its `extends` — a hand-added shared
  // parent scope survives every later `add` of the repository.
  const current = input.manifest.scopes[name]
  if (current !== undefined && current.path !== repoPath)
    throw new Error(`scope "${name}" already points at ${current.path}`)
  const scopes: Record<string, ScopeEntry> = {
    ...input.manifest.scopes,
    [name]: { path: repoPath, extends: current?.extends ?? [] },
  }
  const subs: { path: string; base: string }[] = []
  for (const sub of input.scopes) {
    const clean = sub.replace(/^\/+|\/+$/g, '')
    const segments = clean.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..'))
      throw new Error(
        `sub-scope "${clean}" must be a relative path inside the repository`
      )
    const base = segments.at(-1) ?? ''
    const path = `org/${name}/${clean}`
    if (!NAME.test(base))
      throw new Error(`sub-scope "${clean}" needs a [a-z0-9-] last segment`)
    const existing = scopes[base]
    if (existing !== undefined && existing.path !== path)
      throw new Error(`scope "${base}" already points at ${existing.path}`)
    scopes[base] = { path, extends: [name] }
    subs.push({ path, base })
  }

  let action: AddRepositoryResult['action']
  if (await exists(dir)) {
    const origin = await originUrl(dir)
    if (origin === null)
      throw new Error(`org/${name} exists and is not a git clone`)
    if (origin !== url)
      throw new Error(`org/${name} is a clone of ${origin}, not ${url}`)
    action = 'adopted'
  } else {
    await clone(url, dir)
    action = 'cloned'
  }

  const declared = [name]
  for (const { path, base } of subs) {
    if (!(await exists(join(input.root, ...path.split('/'))))) {
      // Only a clone this call just made is ours to remove: it isn't in the
      // manifest yet, so nothing is lost. An adopted directory predates this
      // call and is left alone.
      if (action === 'cloned') await rm(dir, { recursive: true, force: true })
      throw new Error(`${path} does not exist`)
    }
    declared.push(base)
  }

  const manifest: Manifest = {
    ...input.manifest,
    repos: { ...input.manifest.repos, [name]: { url } },
    scopes,
  }
  await writeManifest(input.rnessDir, manifest)
  return { manifest, name, url, action, declared }
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
