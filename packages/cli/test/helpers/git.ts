import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { TestContext } from 'node:test'

const execFileP = promisify(execFile)
const IDENTITY = ['-c', 'user.name=rness-test', '-c', 'user.email=test@rness.invalid', '-c', 'commit.gpgsign=false']

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return stdout
}

/** A bare repository with one commit (`README.md`), as a file:// URL. */
export async function makeBareRepo(t: TestContext, name: string): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-git-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const bare = join(base, `${name}.git`)
  await git(['init', '-q', '--bare', '-b', 'main', bare], base)
  const url = pathToFileURL(bare).href
  await commitTo(url, 'README.md', `# ${name}\n`)
  return url
}

/** Add one commit to the bare repository through a throwaway clone. */
export async function commitTo(bareUrl: string, file: string, content: string): Promise<void> {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'rness-gitwork-')))
  try {
    await git(['clone', '-q', bareUrl, 'w'], work)
    const clone = join(work, 'w')
    await writeFile(join(clone, file), content)
    await git(['add', '-A'], clone)
    await git(['commit', '-q', '-m', `add ${file}`], clone)
    await git(['push', '-q', 'origin', 'HEAD:main'], clone)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
