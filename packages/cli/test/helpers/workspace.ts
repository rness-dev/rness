import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'

export interface WorkspaceSpec {
  org?: string
  /** The manifest's `provider` key; left out, the key is absent. */
  provider?: string
  /** The manifest's `pulse` key; left out, the key is absent. */
  pulse?: { project: number }
  /** The team's agents; left out, the key is absent ("never asked"). */
  agents?: string[]
  repos?: Record<string, { url: string }>
  scopes?: Record<string, { path: string; extends?: string[] }>
  /** `.rness/`-relative markdown files, e.g. `'standards/web/seo.md': '# SEO\n'`. */
  files?: Record<string, string>
  /** Root-relative directories to create (the clones a real workspace would have). */
  dirs?: string[]
}

/** A temporary workspace, removed when the test ends. Returns its (realpath) root. */
export async function makeWorkspace(
  t: TestContext,
  spec: WorkspaceSpec
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-ws-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.rness'), { recursive: true })
  const manifest: Record<string, unknown> = {
    contract: 1,
    repos: spec.repos ?? {},
    scopes: spec.scopes ?? {},
  }
  if (spec.provider !== undefined) manifest['provider'] = spec.provider
  if (spec.org !== undefined) manifest['org'] = spec.org
  if (spec.agents !== undefined) manifest['agents'] = spec.agents
  if (spec.pulse !== undefined) manifest['pulse'] = spec.pulse
  await writeFile(
    join(root, '.rness', 'rness.json'),
    JSON.stringify(manifest, null, 2)
  )
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const file = join(root, '.rness', ...rel.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  for (const dir of spec.dirs ?? [])
    await mkdir(join(root, ...dir.split('/')), { recursive: true })
  return root
}
