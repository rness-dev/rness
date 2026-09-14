import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { commitTo } from './git.ts'

const execFileP = promisify(execFile)

export interface RemoteOrg {
  /** Pass as `--host`: `file://<base>/`. */
  host: string
  /** Create `<base>/<org>/<name>.git` with `files` committed; returns its URL. */
  addRepo(name: string, files: Record<string, string>): Promise<string>
}

/** A fake GitHub organisation: bare repositories at `<base>/<org>/<repo>.git`. */
export async function makeRemoteOrg(
  t: TestContext,
  org: string
): Promise<RemoteOrg> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-remote-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, org), { recursive: true })
  return {
    host: `${pathToFileURL(base).href}/`,
    async addRepo(name, files) {
      const bare = join(base, org, `${name}.git`)
      await execFileP('git', ['init', '-q', '--bare', '-b', 'main', bare])
      const url = pathToFileURL(bare).href
      for (const [file, content] of Object.entries(files))
        await commitTo(url, file, content)
      return url
    },
  }
}
