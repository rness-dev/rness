import { glob, readFile } from 'node:fs/promises'
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

  const scopes: Record<string, ScopeEntry> = {
    ...input.manifest.scopes,
    [name]: { path: `org/${name}`, extends: [] },
  }
  const declared = [name]
  for (const sub of input.scopes) {
    const clean = sub.replace(/^\/+|\/+$/g, '')
    const base = clean.split('/').at(-1) ?? ''
    const path = `org/${name}/${clean}`
    if (!NAME.test(base))
      throw new Error(`sub-scope "${clean}" needs a [a-z0-9-] last segment`)
    if (!(await exists(join(input.root, ...path.split('/')))))
      throw new Error(`${path} does not exist`)
    const existing = scopes[base]
    if (existing !== undefined && existing.path !== path)
      throw new Error(`scope "${base}" already points at ${existing.path}`)
    scopes[base] = { path, extends: [name] }
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
