import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { promisify } from 'node:util'

import { run } from '../../src/cli.ts'
import {
  type CreateDeps,
  type Prompts,
  createCommand,
} from '../../src/commands/create.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { VERSION } from '../../src/version.ts'
import { capture } from '../helpers/capture.ts'
import { makeRemoteOrg } from '../helpers/remote-org.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

const execFileP = promisify(execFile)

async function scratch(
  t: Parameters<typeof makeWorkspace>[0]
): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-create-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // A repository above the temp workspace: proves create's git init/commit/clone
  // never walk up into a parent repository (a plan-0003 lesson).
  await execFileP('git', ['init', '-q'], { cwd: dir })
  return dir
}

async function create(args: string[]) {
  const c = capture()
  const code = await run(['create', ...args])
  c.restore()
  return { code, out: c.out(), err: c.err() }
}

/**
 * An executable `<name>` first on `PATH` for the rest of the test, restored
 * afterwards. Tests run one at a time inside a file, so the mutation is
 * contained.
 */
async function fakeBin(
  t: Parameters<typeof makeWorkspace>[0],
  name: string,
  script: string[]
): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'rness-bin-'))
  t.after(() => rm(binDir, { recursive: true, force: true }))
  const file = join(binDir, name)
  await writeFile(file, [...script, ''].join('\n'))
  await chmod(file, 0o755)
  const originalPath = process.env['PATH']
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`
  t.after(() => {
    if (originalPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = originalPath
  })
}

test('new: scaffolds .rness with org and tokens, commits it, adds --repos, writes the blocks', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
    'my-ws',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  const root = join(cwd, 'my-ws')
  await assert.rejects(
    access(join(cwd, 'acme')),
    'nothing is named after the org'
  )
  assert.match(
    r.out,
    /^created {2}my-ws\/\.rness \(new workspace\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\ncommitted my-ws\/\.rness\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n/
  )
  assert.match(r.out, /Workspace for `acme` is ready in my-ws\/\./)
  assert.match(r.out, /Next:\n {2}cd my-ws\/\.rness\n/)
  assert.match(r.out, /npm create rness my-ws -- --org acme\n/)
  const m = await loadManifest(join(root, '.rness'))
  assert.equal(m.org, 'acme')
  assert.deepEqual(Object.keys(m.repos), ['api'])
  const pkg = JSON.parse(
    await readFile(join(root, '.rness', 'package.json'), 'utf8')
  ) as { devDependencies: Record<string, string>; packageManager: string }
  assert.equal(pkg.devDependencies['@rness/cli'], VERSION)
  assert.match(pkg.packageManager, /^npm@\d+\.\d+\.\d+/)
  await access(join(root, '.rness', '.gitignore'))
  const { stdout } = await execFileP('git', ['log', '--oneline', 'main'], {
    cwd: join(root, '.rness'),
  })
  assert.equal(
    stdout.trim(),
    stdout.trim().split('\n')[0],
    'exactly one commit'
  )
  assert.match(stdout, /chore: rness workspace context/)
  const { stdout: committed } = await execFileP(
    'git',
    ['show', 'main:rness.json'],
    { cwd: join(root, '.rness') }
  )
  assert.match(
    committed,
    /"api"/,
    'the --repos addition is part of the one commit, not left uncommitted'
  )
  await access(join(root, 'AGENTS.md'))
  await access(join(root, 'CLAUDE.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('join: clones the organization .rness and syncs its repositories', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const manifest = {
    contract: 1,
    org: 'acme',
    repos: { api: { url: apiUrl } },
    scopes: { api: { path: 'org/api' } },
  }
  const contextUrl = await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'standards/coding.md': '# Coding\n',
  })
  const cwd = await scratch(t)
  const r = await create([
    'my-ws',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^cloned {3}my-ws\/\.rness \(joined acme\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
  const root = join(cwd, 'my-ws')
  const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], {
    cwd: join(root, '.rness'),
  })
  assert.equal(stdout.trim(), contextUrl)
  assert.match(
    await readFile(join(root, 'org', 'api', 'AGENTS.md'), 'utf8'),
    /standards\/coding\.md/
  )
})

test('join: --repos adds repositories the organisation has not declared yet', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} }, null, 2)}\n`,
    'standards/coding.md': '# Coding\n',
  })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^cloned {3}acme\/\.rness \(joined acme\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
  const root = join(cwd, 'acme')
  const m = await loadManifest(join(root, '.rness'))
  assert.deepEqual(m.repos, { api: { url: `${remote.host}acme/api.git` } })
  assert.deepEqual(m.scopes['api'], { path: 'org/api', extends: [] })
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('join: a pinned @rness/cli without its bin is an error, not a fallback', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} }, null, 2)}\n`,
  })
  const cwd = await scratch(t)
  // An install that leaves the package's manifest but not its `dist/`: a
  // half-unpacked or hand-edited `node_modules`.
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "1.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  mkdir -p node_modules/@rness/cli',
    '  echo \'{"version":"0.3.0","bin":{"rness":"dist/bin/rness.js"}}\' > node_modules/@rness/cli/package.json',
    '  exit 0',
    'fi',
    'exit 0',
  ])
  const r = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /^@rness\/cli in acme\/\.rness is not installed correctly \(missing dist\/bin\/rness\.js\); reinstall in \.rness\/\n$/
  )
})

test('guards: inside a workspace, non-empty target, --template, bad org, no TTY', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const inside = await makeWorkspace(t, { org: 'acme' })
  const r1 = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    inside,
  ])
  assert.equal(r1.code, 1)
  assert.match(r1.err, /already inside an rness workspace/)

  // The target is checked too: a workspace directory pointing into a workspace would nest
  // a second `.rness` under the first, however innocent the current directory.
  const outside = await scratch(t)
  const r1b = await create([
    join(inside, 'nested'),
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    outside,
  ])
  assert.equal(r1b.code, 1)
  assert.match(r1b.err, /already inside an rness workspace/)
  await assert.rejects(access(join(inside, 'nested')))

  const cwd = await scratch(t)
  await mkdir(join(cwd, 'acme'))
  await writeFile(join(cwd, 'acme', 'stuff.txt'), 'x')
  const r2 = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(r2.code, 1)
  assert.match(r2.err, /acme is not empty/)

  const r3 = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--template',
    'saas',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r3.code, 2)
  assert.match(r3.err, /--template is reserved/)

  const r4 = await create([
    'my-ws',
    '--org',
    'Acme Inc',
    '--yes',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r4.code, 2)
  assert.equal(
    r4.err,
    'organization name "Acme Inc" is not a valid GitHub organization name\n'
  )

  const r5 = await create([
    'acme',
    '--org',
    'acme',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r5.code, 2)
  assert.match(r5.err, /pass --yes/)

  const r6 = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--pm',
    'cargo',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r6.code, 2)
  assert.match(r6.err, /--pm must be one of npm, pnpm, yarn, bun/)
})

test('a failed install after the scaffold copy is rolled back, not left dirty', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)

  // A fake `bun` on PATH: `--version` succeeds (create needs it for the
  // package.json token before install ever runs), `install` fails offline
  // and deterministically, like a real registry outage would.
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "1.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  echo "bun install failed: network unreachable" 1>&2',
    '  exit 1',
    'fi',
    'exit 0',
  ])

  const r = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /bun install failed/)
  assert.match(r.err, /removed acme\/\.rness/)
  assert.ok(
    r.err.indexOf('bun install failed') < r.err.indexOf('removed acme/.rness'),
    'the cause (the install failure) is reported before the consequence (the rollback)'
  )
  await assert.rejects(access(join(cwd, 'acme', '.rness')))
  await assert.rejects(
    access(join(cwd, 'acme')),
    'the target directory this call created goes too, so the retry is not refused as non-empty'
  )

  // `create .`: the target is the directory the command runs in. The rollback
  // must not pull the ground from under the user's shell.
  const here = join(cwd, 'here')
  await mkdir(here)
  const inPlace = await create([
    '.',
    '--org',
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    here,
  ])
  assert.equal(inPlace.code, 1)
  assert.match(inPlace.err, /removed \.\/\.rness after the failure/)
  await assert.rejects(access(join(here, '.rness')))
  await access(here)
})

test('a successful install is reported and the workspace is complete', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "1.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  mkdir -p node_modules',
    '  : > node_modules/.installed',
    '  exit 0',
    'fi',
    'exit 0',
  ])
  const r = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^created {2}acme\/\.rness \(new workspace\)\n/)
  assert.match(r.out, /installed dependencies with bun\n/)
  await access(join(cwd, 'acme', '.rness', 'node_modules', '.installed'))
  await access(join(cwd, 'acme', 'AGENTS.md'))
})

test('a probe that cannot access the remote exits 1 and creates nothing', async (t) => {
  const cwd = await scratch(t)
  // After scratch(): its `git init` must run before the fake git shadows the
  // real one.
  await fakeBin(t, 'git', [
    '#!/bin/sh',
    'echo "fatal: could not read Username for \'https://github.com\': terminal prompts disabled" 1>&2',
    'exit 128',
  ])
  const r = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    'https://github.com/',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /cannot access https:\/\/github\.com\/acme\/\.rness\.git/)
  await assert.rejects(access(join(cwd, 'acme')))
})

test('a repository that fails is reported and skipped; the workspace is still finished', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api,ghost',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /^ghost: git clone failed: /m)
  const root = join(cwd, 'acme')
  assert.match(r.out, /cloned {3}org\/api\ndeclared scope api \(org\/api\)\n/)
  assert.match(r.out, /committed acme\/\.rness\n/)
  assert.match(r.out, /updated {2}org\/api\/AGENTS\.md\n/)
  assert.match(
    r.out,
    /Next:\n {2}cd acme\/\.rness\n {2}rness add ghost {3}# failed: git clone failed: /
  )
  assert.deepEqual(
    Object.keys((await loadManifest(join(root, '.rness'))).repos),
    ['api']
  )
  const { stdout: committed } = await execFileP(
    'git',
    ['show', 'main:rness.json'],
    { cwd: join(root, '.rness') }
  )
  assert.match(committed, /"api"/)
  await access(join(root, 'AGENTS.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))

  // The install was skipped, so nothing installed `.rness/node_modules`; a
  // real run has it and takes the "already holds" branch below.
  await mkdir(join(root, '.rness', 'node_modules'))
  const again = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(again.code, 1)
  assert.match(again.err, /already holds an rness workspace/)
})

test('re-running create points at rness add, or at the install a failed join left undone', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)
  const first = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(first.code, 0, first.err)

  // What a join whose install failed leaves behind: a context clone with no
  // dependencies. `rness add` would only fail again — the install is the fix.
  const notInstalled = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'pnpm',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(notInstalled.code, 1)
  assert.match(
    notInstalled.err,
    /^acme holds an rness workspace whose dependencies are not installed; cd acme\/\.rness && pnpm install, then rness sync\n$/
  )

  await mkdir(join(cwd, 'acme', '.rness', 'node_modules'))
  const again = await create([
    'acme',
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(again.code, 1)
  assert.match(again.err, /already holds an rness workspace/)
})

test('guards without a prompt: the workspace and --org are required, --dir is gone', async (t) => {
  const noWorkspace = await create([
    '--org',
    'acme',
    '--yes',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(noWorkspace.code, 2)
  assert.equal(
    noWorkspace.err,
    'rness create needs a workspace directory: rness create <workspace> --org <name>\n'
  )

  const noOrg = await create(['my-ws', '--yes', '--cwd', await scratch(t)])
  assert.equal(noOrg.code, 2)
  assert.equal(noOrg.err, 'rness create needs --org <name> without a prompt\n')

  // Without a TTY and without --yes, the missing org is still what is named.
  const noOrgNoYes = await create(['my-ws', '--cwd', await scratch(t)])
  assert.equal(noOrgNoYes.code, 2)
  assert.match(noOrgNoYes.err, /needs --org <name>/)

  for (const bad of ['-acme', 'acme-', 'ac--me', 'a'.repeat(40)]) {
    const r = await create(['my-ws', '--org', bad, '--yes'])
    assert.equal(r.code, 2, bad)
    assert.match(r.err, /is not a valid GitHub organization name/)
  }

  const dir = await create([
    'my-ws',
    '--org',
    'acme',
    '--dir',
    'elsewhere',
    '--yes',
  ])
  assert.equal(dir.code, 2)
  assert.match(dir.err, /unknown option '--dir'/)
})

test('an organization name keeps its case in the URLs and rness.json', async (t) => {
  const remote = await makeRemoteOrg(t, 'Acme-Corp')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
    'my-ws',
    '--org',
    'Acme-Corp',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Workspace for `Acme-Corp` is ready in my-ws\/\./)
  const m = await loadManifest(join(cwd, 'my-ws', '.rness'))
  assert.equal(m.org, 'Acme-Corp')
  assert.deepEqual(m.repos, {
    api: { url: `${remote.host}Acme-Corp/api.git` },
  })
  assert.match(
    await readFile(join(cwd, 'my-ws', '.rness', 'rness.json'), 'utf8'),
    /"org": "Acme-Corp"/
  )
})

// --- the wizard, through the CreateDeps seam ---------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** A local stand-in for api.github.com on 127.0.0.1, closed after the test. */
async function githubApi(
  t: TestContext,
  handler: Handler
): Promise<{ base: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => {
    requests.push(req)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, requests }
}

function reposOf(
  list: { name: string; private?: boolean; archived?: boolean }[]
): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        list.map((r) => ({
          name: r.name,
          private: r.private ?? false,
          archived: r.archived ?? false,
        }))
      )
    )
  }
}

/** Set (or, with `undefined`, unset) environment variables for the rest of the test. */
function withEnv(
  t: TestContext,
  vars: Record<string, string | undefined>
): void {
  for (const [key, value] of Object.entries(vars)) {
    const original = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    t.after(() => {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    })
  }
}

const CANCEL = Symbol('cancel')

interface Script {
  text?: string[]
  confirm?: boolean[]
  pick?: (string[] | typeof CANCEL)[]
}

/**
 * A terminal with scripted answers. Every question is recorded; a text answer
 * its `validate` refuses is recorded as an error and the next answer is used,
 * as a user retyping would.
 */
function terminal(script: Script) {
  const asked: string[] = []
  const refused: string[] = []
  const offered: unknown[] = []
  const next = <T>(queue: T[] | undefined, message: string): T => {
    const answer = queue?.shift()
    if (answer === undefined)
      throw new Error(`no scripted answer for: ${message}`)
    return answer
  }
  const prompts = {
    async text(opts: Parameters<Prompts['text']>[0]) {
      asked.push(opts.message)
      for (;;) {
        const answer = next(script.text, opts.message)
        const error =
          typeof opts.validate === 'function'
            ? await opts.validate(answer)
            : undefined
        if (error === undefined) return answer
        refused.push(error instanceof Error ? error.message : error)
      }
    },
    async confirm(opts: Parameters<Prompts['confirm']>[0]) {
      asked.push(opts.message)
      return next(script.confirm, opts.message)
    },
    async autocompleteMultiselect(opts: { message: string; options: unknown }) {
      asked.push(opts.message)
      offered.push(opts.options)
      return next(script.pick, opts.message)
    },
    isCancel: (value: unknown) => value === CANCEL,
  } as unknown as Prompts
  const deps: CreateDeps = { isTty: () => true, prompts: async () => prompts }
  return { deps, asked, refused, offered }
}

async function wizard(
  workspace: string | undefined,
  opts: Parameters<typeof createCommand>[1],
  deps: CreateDeps
) {
  const c = capture()
  try {
    const code = await createCommand(workspace, opts, deps)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const WORKSPACE_Q = 'What is your workspace named?'
const ORG_Q = 'What is your GitHub organization named?'
const REPOS_Q = 'Which repositories do you want to add?'

test('wizard: asks the workspace, the organization, the confirm, then picks from the listed repositories', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('web', { 'README.md': '# web\n' })
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const { base, requests } = await githubApi(
    t,
    reposOf([
      { name: 'web' },
      { name: 'old', archived: true },
      { name: '.rness' },
      { name: '.github' },
      { name: 'Website' },
      { name: 'api', private: true },
    ])
  )
  const cwd = await scratch(t)
  await mkdir(join(cwd, 'taken'))
  await writeFile(join(cwd, 'taken', 'stuff.txt'), 'x')
  const term = terminal({
    text: ['  ', 'taken', 'my-ws', 'Acme Inc', 'acme'],
    confirm: [true],
    pick: [['api', 'web']],
  })
  const r = await wizard(
    undefined,
    { skipInstall: true, pm: 'npm', host: remote.host, githubApi: base, cwd },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [
    WORKSPACE_Q,
    ORG_Q,
    `No ${remote.host}acme/.rness.git found (or no access to it). Start a new workspace for \`acme\` in my-ws/?`,
    REPOS_Q,
  ])
  assert.deepEqual(term.refused, [
    'the workspace needs a directory name',
    'taken is not empty',
    '"Acme Inc" is not a valid GitHub organization name',
  ])
  assert.deepEqual(term.offered, [
    [
      { value: 'api', label: 'api', hint: 'private' },
      { value: 'web', label: 'web' },
    ],
  ])
  assert.equal(requests[0]?.headers['authorization'], undefined)
  assert.match(
    r.out,
    /skipped {2}install \(--skip-install\)\nonly public repositories are listed; set GITHUB_TOKEN to include private ones, or add them later with rness add <repo>\nskipped {2}2 repositories whose names rness cannot declare yet\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\ncloned {3}org\/web\ndeclared scope web \(org\/web\)\ncommitted my-ws\/\.rness\n/
  )
  const root = join(cwd, 'my-ws')
  const m = await loadManifest(join(root, '.rness'))
  assert.equal(m.org, 'acme')
  assert.deepEqual(m.repos, {
    api: { url: `${remote.host}acme/api.git` },
    web: { url: `${remote.host}acme/web.git` },
  })
  await access(join(root, 'org', 'web', 'AGENTS.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('wizard: a cancelled picker exits 1; a token lists private repositories without the note', async (t) => {
  withEnv(t, { GITHUB_TOKEN: 'ghp_test', GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  const { base, requests } = await githubApi(t, reposOf([{ name: 'web' }]))
  const term = terminal({ confirm: [true], pick: [CANCEL] })
  const r = await wizard(
    'my-ws',
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: base,
      cwd: await scratch(t),
    },
    term.deps
  )
  assert.equal(r.code, 1)
  assert.equal(r.err, 'cancelled\n')
  assert.doesNotMatch(r.out, /only public repositories/)
  assert.equal(requests[0]?.headers['authorization'], 'Bearer ghp_test')
  assert.equal(term.asked.at(-1), REPOS_Q)
  assert.ok(!term.asked.includes(WORKSPACE_Q) && !term.asked.includes(ORG_Q))
})

test('wizard: a listing that fails or is empty is a warning; the workspace is still committed', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  const { base: failing } = await githubApi(t, (_req, res) => {
    res.writeHead(500)
    res.end()
  })
  const cwd = await scratch(t)
  const term = terminal({ confirm: [true] })
  const r = await wizard(
    'my-ws',
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: failing,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, 'warning: GitHub API answered 500 for /orgs/acme/repos\n')
  assert.ok(!term.asked.includes(REPOS_Q))
  assert.match(r.out, /committed my-ws\/\.rness\n/)
  await access(join(cwd, 'my-ws', 'AGENTS.md'))

  const { base: empty } = await githubApi(
    t,
    reposOf([{ name: 'old', archived: true }, { name: '.rness' }])
  )
  const again = terminal({ confirm: [true] })
  const r2 = await wizard(
    'other-ws',
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: empty,
      cwd,
    },
    again.deps
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(r2.err, 'warning: no repositories to list for acme\n')
  assert.ok(!again.asked.includes(REPOS_Q))
  assert.match(r2.out, /committed other-ws\/\.rness\n/)
})

test('wizard: joining never lists repositories; the organization manifest is authoritative', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} }, null, 2)}\n`,
  })
  const { base, requests } = await githubApi(t, reposOf([{ name: 'web' }]))
  const term = terminal({ text: ['acme'], confirm: [true] })
  const r = await wizard(
    'my-ws',
    {
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: base,
      cwd: await scratch(t),
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [
    ORG_Q,
    `Join organization \`acme\`: clone ${remote.host}acme/.rness.git into my-ws/.rness and sync its repositories?`,
  ])
  assert.equal(requests.length, 0)
  assert.match(r.out, /^cloned {3}my-ws\/\.rness \(joined acme\)\n/)
})

test('wizard: inside a workspace, nothing is asked', async (t) => {
  const inside = await makeWorkspace(t, { org: 'acme' })
  const term = terminal({})
  const r = await wizard(undefined, { cwd: inside }, term.deps)
  assert.equal(r.code, 1)
  assert.match(r.err, /already inside an rness workspace/)
  assert.deepEqual(term.asked, [])
})
