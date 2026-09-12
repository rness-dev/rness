import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'

export interface WorkspaceSpec {
  org?: string
  repos?: Record<string, { url: string }>
  scopes?: Record<string, { path: string; extends?: string[] }>
  /** `.rness/`-relative markdown files, e.g. `'standards/web/seo.md': '# SEO\n'`. */
  files?: Record<string, string>
  /** Root-relative directories to create (the clones a real workspace would have). */
  dirs?: string[]
}

/** A temporary workspace, removed when the test ends. Returns its (realpath) root. */
export async function makeWorkspace(t: TestContext, spec: WorkspaceSpec): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-ws-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.rness'), { recursive: true })
  const manifest: Record<string, unknown> = { contract: 1, repos: spec.repos ?? {}, scopes: spec.scopes ?? {} }
  if (spec.org !== undefined) manifest['org'] = spec.org
  await writeFile(join(root, '.rness', 'rness.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const file = join(root, '.rness', ...rel.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  for (const dir of spec.dirs ?? []) await mkdir(join(root, ...dir.split('/')), { recursive: true })
  return root
}
