import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'

/**
 * A scope as contract 2 of `rness.json` writes it (spec 0038 §1): a
 * repository by its `url`, a part nested under it by its `path`.
 */
export interface ScopeSpec {
  url?: string
  path?: string
  extends?: string[]
  scopes?: Record<string, ScopeSpec>
}

export interface WorkspaceSpec {
  org?: string
  /** The manifest's `provider` key; left out, the key is absent. */
  provider?: string
  /** The manifest's `boards` key (spec 0033 §3); left out, the key is absent. */
  boards?: Record<string, unknown>
  /** Atlassian's `jira` key (spec 0039 §2); left out, the key is absent. */
  jira?: { site: string; space: string }
  /** The team's agents; left out, the key is absent ("never asked"). */
  agents?: string[]
  scopes?: Record<string, ScopeSpec>
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
    contract: 2,
    scopes: spec.scopes ?? {},
  }
  if (spec.provider !== undefined) manifest['provider'] = spec.provider
  if (spec.org !== undefined) manifest['org'] = spec.org
  if (spec.jira !== undefined) manifest['jira'] = spec.jira
  if (spec.agents !== undefined) manifest['agents'] = spec.agents
  if (spec.boards !== undefined) manifest['boards'] = spec.boards
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

/**
 * Whether the file system holding `dir` ignores case, as macOS and Windows do
 * by default: `org/dApp` and `org/DAPP` can then never coexist, so a test of
 * that case runs on Linux (CI) only.
 */
export async function ignoresCase(dir: string): Promise<boolean> {
  const probe = await mkdtemp(join(dir, 'rness-case-'))
  try {
    await mkdir(join(probe, 'a'))
    await mkdir(join(probe, 'A'))
    return false
  } catch {
    return true
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
}
