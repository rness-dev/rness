import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import type { CommandDeps } from '../../src/core/deps.ts'
import { originUrl } from '../../src/core/git.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import type { Provider } from '../../src/core/provider.ts'
import {
  INSTEAD_OF_LINES,
  type Transport,
  sshWorkspaceLines,
} from '../../src/core/transport.ts'
import { VERSION } from '../../src/version.ts'
import { capture } from '../helpers/capture.ts'
import { fakeGithub, withEnv as withTestEnv } from '../helpers/fake-github.ts'
import { fakeProvider } from '../helpers/provider.ts'
import { makeRemoteOrg } from '../helpers/remote-org.ts'
import { SSH_DENIED, SSH_OK, fakeTransport } from '../helpers/transport.ts'
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

const manifestText = (repos: Record<string, { url: string }>) =>
  `${JSON.stringify(
    {
      contract: 1,
      org: 'acme',
      repos,
      scopes: Object.fromEntries(
        Object.keys(repos).map((name) => [name, { path: `org/${name}` }])
      ),
    },
    null,
    2
  )}\n`

test('new: ./<org> is scaffolded with org and tokens, commits it, adds --repos, writes the blocks', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
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
  const root = join(cwd, 'acme')
  assert.match(
    r.out,
    /^not found acme\/\.rness \(or not visible to you\) — starting a new workspace\ncreated {2}acme\/\.rness \(new workspace\)\nskipped {2}install with npm \(--skip-install\)\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\ncommitted acme\/\.rness\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n/
  )
  assert.match(r.out, /Workspace for `acme` is ready in acme\/\./)
  assert.match(r.out, /Next:\n {2}cd acme\/\.rness\n/)
  assert.match(r.out, / {2}# then, for every teammate: npm create rness acme\n/)
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
  // The create commit is the first scaffold commit (spec 0013 §1).
  const { stdout: trailer } = await execFileP(
    'git',
    ['log', '-1', '--format=%(trailers:key=Rness-Scaffold,valueonly)', 'main'],
    { cwd: join(root, '.rness') }
  )
  assert.equal(trailer.trim(), VERSION)
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

test('join without --repos: the whole catalogue is cloned', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const contextUrl = await remote.addRepo('.rness', {
    'rness.json': manifestText({ api: { url: apiUrl } }),
    'standards/coding.md': '# Coding\n',
  })
  const cwd = await scratch(t)
  const r = await create([
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
  assert.equal(
    r.out,
    'found    acme/.rness — joining\ncloned   acme/.rness (joined acme)\nskipped  install with npm (--skip-install)\ncloned   org/api\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\n\n  cd acme\n'
  )
  const root = join(cwd, 'acme')
  const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], {
    cwd: join(root, '.rness'),
  })
  assert.equal(stdout.trim(), contextUrl)
  assert.match(
    await readFile(join(root, 'org', 'api', 'AGENTS.md'), 'utf8'),
    /standards\/coding\.md/
  )
})

test('join --repos: catalogue entries are cloned without rewriting rness.json; others are added', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const webUrl = await remote.addRepo('web', { 'README.md': '# web\n' })
  await remote.addRepo('newrepo', { 'README.md': '# newrepo\n' })
  const catalogue = manifestText({
    api: { url: apiUrl },
    web: { url: webUrl },
  })
  await remote.addRepo('.rness', { 'rness.json': catalogue })

  const cwd = await scratch(t)
  const options = [
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
  ]
  const only = await create([...options, '--repos', 'api', '--cwd', cwd])
  assert.equal(only.code, 0, only.err)
  assert.equal(
    only.out,
    'found    acme/.rness — joining\ncloned   acme/.rness (joined acme)\nskipped  install with npm (--skip-install)\ncloned   org/api\nnot cloned: web (rness add <name>, or rness sync --all)\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\n\n  cd acme\n  # clone the catalogue repositories you did not pick: web\n  rness sync --all\n'
  )
  const root = join(cwd, 'acme')
  await assert.rejects(access(join(root, 'org', 'web')))
  assert.equal(
    await readFile(join(root, '.rness', 'rness.json'), 'utf8'),
    catalogue,
    'an unpicked catalogue repository stays; the file is byte-identical'
  )

  const other = await scratch(t)
  const more = await create([
    ...options,
    '--repos',
    'api,newrepo',
    '--cwd',
    other,
  ])
  assert.equal(more.code, 0, more.err)
  assert.match(
    more.out,
    /\ncloned {3}org\/api\ncloned {3}org\/newrepo\ndeclared scope newrepo \(org\/newrepo\)\nnot cloned: web /
  )
  const m = await loadManifest(join(other, 'acme', '.rness'))
  assert.deepEqual(m.repos, {
    api: { url: apiUrl },
    web: { url: webUrl },
    newrepo: { url: `${remote.host}acme/newrepo.git` },
  })
  await access(join(other, 'acme', 'org', 'newrepo', 'AGENTS.md'))
})

test('join: a pinned @rness/cli without its bin is an error, not a fallback', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('.rness', { 'rness.json': manifestText({}) })
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

test('guards: inside a workspace, non-empty target, --template, bad org, no TTY, --pm', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const inside = await makeWorkspace(t, { org: 'acme' })
  const r1 = await create([
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
  await assert.rejects(access(join(inside, 'acme')))

  const cwd = await scratch(t)
  await mkdir(join(cwd, 'acme'))
  await writeFile(join(cwd, 'acme', 'stuff.txt'), 'x')
  const r2 = await create([
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
  assert.equal(r2.err, 'acme is not empty\n')

  const r3 = await create([
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

test('guards without a prompt: the organization is required once; a second argument and --dir are unknown', async (t) => {
  const noOrg = await create(['--yes', '--cwd', await scratch(t)])
  assert.equal(noOrg.code, 2)
  assert.equal(noOrg.err, 'rness create needs --org <name> without a prompt\n')

  const noOrgNoYes = await create(['--cwd', await scratch(t)])
  assert.equal(noOrgNoYes.code, 2)
  assert.match(noOrgNoYes.err, /needs --org <name>/)

  for (const bad of ['-acme', 'acme-', 'ac--me', 'a'.repeat(40)]) {
    const r = await create(['--org', bad, '--yes'])
    assert.equal(r.code, 2, bad)
    assert.match(r.err, /is not a valid GitHub organization name/)
  }

  const twice = await create(['my-ws', '--org', 'acme', '--yes'])
  assert.equal(twice.code, 2)
  assert.equal(
    twice.err,
    'organization given twice: "my-ws" and --org "acme"\n'
  )

  const positional = await create(['acme', 'my-ws', '--yes'])
  assert.equal(positional.code, 2)
  assert.match(positional.err, /too many arguments/)

  const dir = await create(['--org', 'acme', '--dir', 'elsewhere', '--yes'])
  assert.equal(dir.code, 2)
  assert.match(dir.err, /unknown option '--dir'/)
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
  assert.match(r.out, /\ncreated {2}acme\/\.rness \(new workspace\)\n/)
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
})

test('re-running create points at rness add, or at the install a failed join left undone', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)
  const args = ['--org', 'acme', '--yes', '--skip-install', '--host', host]
  const first = await create([...args, '--cwd', cwd])
  assert.equal(first.code, 0, first.err)

  // What a join whose install failed leaves behind: a context clone with no
  // dependencies. `rness add` would only fail again — the install is the fix.
  const notInstalled = await create([...args, '--pm', 'pnpm', '--cwd', cwd])
  assert.equal(notInstalled.code, 1)
  assert.equal(
    notInstalled.err,
    'acme holds an rness workspace whose dependencies are not installed; cd acme/.rness && pnpm install, then rness sync\n'
  )

  await mkdir(join(cwd, 'acme', '.rness', 'node_modules'))
  const again = await create([...args, '--cwd', cwd])
  assert.equal(again.code, 1)
  assert.match(again.err, /already holds an rness workspace/)
})

test('an organization name keeps its case in the directory, the URLs and rness.json', async (t) => {
  const remote = await makeRemoteOrg(t, 'Acme-Corp')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
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
  assert.match(r.out, /Workspace for `Acme-Corp` is ready in Acme-Corp\/\./)
  assert.match(r.out, /npm create rness Acme-Corp\n/)
  const m = await loadManifest(join(cwd, 'Acme-Corp', '.rness'))
  assert.equal(m.org, 'Acme-Corp')
  assert.deepEqual(m.repos, {
    api: { url: `${remote.host}Acme-Corp/api.git` },
  })
  assert.match(
    await readFile(join(cwd, 'Acme-Corp', '.rness', 'rness.json'), 'utf8'),
    /"org": "Acme-Corp"/
  )
  assert.deepEqual(await readdir(cwd), ['.git', 'Acme-Corp'])
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
  text?: (string | typeof CANCEL)[]
  /**
   * The answer to "How do you want to start?". Left out, it is answered
   * "github" without being recorded, as the login is declined: every wizard
   * test that is not about a blank workspace reads as it did before there was
   * one (spec 0012).
   */
  start?: 'github' | 'blank' | typeof CANCEL
  /**
   * The answer to "Where does your organization live?". Left out, it is
   * answered "github" without being recorded, like the start question.
   */
  provider?: string | typeof CANCEL
  /**
   * The answer to "Which agents does your team use?" (spec 0011 §3.2). Left
   * out, it is answered [] without being recorded, as the login is declined.
   */
  agents?: string[] | typeof CANCEL
  confirm?: (boolean | typeof CANCEL)[]
  pick?: (string[] | typeof CANCEL)[]
  /** "Which GitHub organization?" answers. */
  select?: string[]
  /**
   * The answer to "Open github.com to approve rness for <org> now?". Left
   * out, declined without being recorded, as the login is.
   */
  approve?: boolean | typeof CANCEL
  /**
   * The answer to "Log in to GitHub…?". Left out, the question is declined
   * without being recorded: every wizard test that is not about the login
   * reads as it did before there was one.
   */
  login?: boolean
  /** The answer to "Create <org>/.rness on GitHub…?"; left out, declined silently too. */
  publish?: boolean
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
  const preselected: unknown[] = []
  const providerOptions: unknown[] = []
  const orgOptions: unknown[] = []
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
        if (answer === CANCEL) return answer
        const error =
          typeof opts.validate === 'function'
            ? await opts.validate(answer)
            : undefined
        if (error === undefined) return answer
        refused.push(error instanceof Error ? error.message : error)
      }
    },
    async confirm(opts: Parameters<Prompts['confirm']>[0]) {
      if (opts.message === LOGIN_Q && script.login === undefined) return false
      const publishing = PUBLISH_Q.test(opts.message)
      if (publishing && script.publish === undefined) return false
      const approving = APPROVE_Q.test(opts.message)
      if (approving && script.approve === undefined) return false
      asked.push(opts.message)
      if (opts.message === LOGIN_Q) return script.login
      if (publishing) return script.publish
      if (approving) return script.approve
      return next(script.confirm, opts.message)
    },
    async multiselect(opts: { message: string; options: { value: string }[] }) {
      if (opts.message === AGENTS_Q && script.agents === undefined) return []
      asked.push(opts.message)
      offered.push(opts.options.map((o) => o.value))
      if (opts.message === AGENTS_Q) return script.agents
      throw new Error(`no scripted answer for: ${opts.message}`)
    },
    async select(opts: { message: string; options: { value: string }[] }) {
      if (opts.message === PROVIDER_Q) {
        providerOptions.push(opts.options)
        if (script.provider === undefined) return 'github'
        asked.push(opts.message)
        return script.provider
      }
      asked.push(opts.message)
      offered.push(opts.options.map((o) => o.value))
      if (opts.message === ORG_LIST_Q) orgOptions.push(opts.options)
      return next(script.select, opts.message)
    },
    async autocompleteMultiselect(opts: {
      message: string
      options: unknown
      initialValues?: unknown
    }) {
      asked.push(opts.message)
      offered.push(opts.options)
      preselected.push(opts.initialValues)
      return next(script.pick, opts.message)
    },
    isCancel: (value: unknown) => value === CANCEL,
  } as unknown as Prompts
  const deps: CreateDeps = { isTty: () => true, prompts: async () => prompts }
  return {
    deps,
    asked,
    refused,
    offered,
    preselected,
    providerOptions,
    orgOptions,
  }
}

async function wizard(
  opts: Parameters<typeof createCommand>[0],
  deps: CreateDeps,
  transport?: Transport,
  provider?: Provider,
  clock?: Pick<CommandDeps, 'open' | 'sleep' | 'now'>
) {
  const c = capture()
  try {
    const code = await createCommand(opts, {
      terminal: deps,
      ...(transport === undefined ? {} : { transport }),
      ...(provider === undefined ? {} : { provider }),
      ...clock,
    })
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

async function stagedJoins(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith('rness-join-'))
}

const PROVIDER_Q = 'Where does your organization live?'
const ORG_LIST_Q = 'Which GitHub organization?'
const APPROVE_Q = /^Open github\.com to approve rness for \S+ now\?$/
const PROVIDER_OPTIONS = [
  { value: 'github', label: 'GitHub', disabled: false },
  { value: 'gitlab', label: 'GitLab (coming later)', disabled: true },
  {
    value: 'atlassian',
    label: 'Atlassian — Bitbucket + Jira (coming later)',
    disabled: true,
  },
  {
    value: 'blank',
    label: 'No organization yet: a blank local workspace',
    disabled: false,
  },
]
const AGENTS_Q = 'Which agents does your team use?'
const NAME_Q = 'What should the workspace be called?'
const ORG_Q = 'What is your GitHub organization named?'
const LOGIN_Q =
  'Log in to GitHub to list your organizations and private repositories?'
const PUBLISH_Q = /^Create \S+\/\.rness on GitHub \(private\) and push it\?$/
const REPOS_Q = 'Which repositories do you want in your workspace?'
const NO_TOKEN_NOTE =
  'only public repositories are listed; rness login lists the private ones you can access\n'

test('wizard, new: the organization, then the listed repositories; nothing pre-selected', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('web', { 'README.md': '# web\n' })
  await remote.addRepo('api', { 'README.md': '# api\n' })
  await remote.addRepo('website', { 'README.md': '# website\n' })
  const { base, requests } = await githubApi(
    t,
    reposOf([
      { name: 'web' },
      { name: 'old', archived: true },
      { name: '.rness' },
      { name: 'my_lib' },
      { name: '-dash' },
      { name: '.github' },
      { name: '.github-private', private: true },
      { name: 'WebSite' },
      { name: 'api', private: true },
    ])
  )
  const cwd = await scratch(t)
  const term = terminal({
    text: ['Acme Inc', 'acme'],
    pick: [['api', 'website']],
  })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, githubApi: base, cwd },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [ORG_Q, REPOS_Q], 'no separate confirm')
  assert.deepEqual(term.refused, [
    '"Acme Inc" is not a valid GitHub organization name',
  ])
  // A name differing from NAME only by case is offered in lowercase (GitHub
  // names are case-insensitive); any other is shown disabled, last. A leading
  // dot is an ordinary name: `.github` is offered like any repository. Only
  // the context repository `.rness` and archived ones stay out (spec 0009).
  assert.deepEqual(term.offered, [
    [
      { value: '.github', label: '.github' },
      { value: '.github-private', label: '.github-private 🔒' },
      { value: 'api', label: 'api 🔒' },
      { value: 'my_lib', label: 'my_lib' },
      { value: 'web', label: 'web' },
      { value: 'website', label: 'WebSite' },
      {
        value: '-dash',
        label: '-dash',
        hint: 'name not supported yet',
        disabled: true,
      },
    ],
  ])
  assert.deepEqual(term.preselected, [undefined])
  assert.equal(requests[0]?.headers['authorization'], undefined)
  assert.ok(
    r.out.startsWith(
      `not found acme/.rness (or not visible to you) — starting a new workspace\nlisting  acme repositories…\n${NO_TOKEN_NOTE}names rness cannot declare yet (struck through): -dash\ncreated  acme/.rness (new workspace)\nskipped  install with npm (--skip-install)\ncloned   org/api\ndeclared scope api (org/api)\ncloned   org/website\ndeclared scope website (org/website)\ncommitted acme/.rness\n`
    ),
    r.out
  )
  const root = join(cwd, 'acme')
  const m = await loadManifest(join(root, '.rness'))
  assert.equal(m.org, 'acme')
  assert.deepEqual(m.repos, {
    api: { url: `${remote.host}acme/api.git` },
    website: { url: `${remote.host}acme/website.git` },
  })
  await access(join(root, 'org', 'website', 'AGENTS.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('wizard, join: the catalogue is pre-selected and completed; unpicked stays declared, picked-new is added', async (t) => {
  withEnv(t, { GITHUB_TOKEN: 'ghp_test', GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const webUrl = await remote.addRepo('web', { 'README.md': '# web\n' })
  const secretUrl = await remote.addRepo('secret', { 'README.md': '# s\n' })
  await remote.addRepo('other', { 'README.md': '# other\n' })
  const catalogue = manifestText({
    api: { url: apiUrl },
    web: { url: webUrl },
    secret: { url: secretUrl },
  })
  await remote.addRepo('.rness', { 'rness.json': catalogue })
  // `secret` is catalogued but invisible to this API caller.
  const { base, requests } = await githubApi(
    t,
    reposOf([
      { name: 'api' },
      { name: 'web', private: true },
      { name: 'other' },
    ])
  )
  const cwd = await scratch(t)
  const term = terminal({ text: ['acme'], pick: [['api', 'other']] })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, githubApi: base, cwd },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [ORG_Q, REPOS_Q])
  assert.equal(requests[0]?.headers['authorization'], 'Bearer ghp_test')
  assert.deepEqual(term.offered, [
    [
      { value: 'api', label: 'api', hint: 'in .rness' },
      { value: 'other', label: 'other' },
      { value: 'secret', label: 'secret', hint: 'in .rness' },
      { value: 'web', label: 'web 🔒', hint: 'in .rness' },
    ],
  ])
  assert.deepEqual(term.preselected, [['api', 'web', 'secret']])
  assert.equal(
    r.out,
    'found    acme/.rness — joining\nlisting  acme repositories…\ncloned   acme/.rness (joined acme)\nskipped  install with npm (--skip-install)\ncloned   org/api\ncloned   org/other\ndeclared scope other (org/other)\nnot cloned: web, secret (rness add <name>, or rness sync --all)\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\nupdated  org/other/AGENTS.md\n\n  cd acme\n  # clone the catalogue repositories you did not pick: web, secret\n  rness sync --all\n'
  )
  const root = join(cwd, 'acme')
  await assert.rejects(access(join(root, 'org', 'web')))
  await assert.rejects(access(join(root, 'org', 'secret')))
  const m = await loadManifest(join(root, '.rness'))
  assert.deepEqual(Object.keys(m.repos), ['api', 'web', 'secret', 'other'])
  assert.deepEqual(m.repos['other'], { url: `${remote.host}acme/other.git` })
})

test('wizard, join: a cancelled picker exits 0, writes nothing and leaves no staged clone', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  await remote.addRepo('.rness', {
    'rness.json': manifestText({ api: { url: apiUrl } }),
  })
  const { base } = await githubApi(t, reposOf([{ name: 'api' }]))
  const cwd = await scratch(t)
  const before = await stagedJoins()
  const term = terminal({ pick: [CANCEL] })
  const r = await wizard(
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: base,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0)
  assert.equal(r.err, 'cancelled\n')
  assert.equal(
    r.out,
    `found    acme/.rness — joining\nlisting  acme repositories…\n${NO_TOKEN_NOTE}`
  )
  await assert.rejects(access(join(cwd, 'acme')))
  assert.deepEqual(await stagedJoins(), before)
})

test('wizard: flags only, in a terminal, keep one confirm; declining exits 0 and writes nothing', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)
  // An organization settles where it lives: asked, the first question would cancel.
  const term = terminal({ provider: CANCEL, confirm: [false] })
  const r = await wizard(
    {
      org: 'acme',
      repos: 'api',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0)
  assert.equal(r.err, 'cancelled\n')
  assert.deepEqual(term.asked, ['Create workspace acme in ./acme?'])
  await assert.rejects(access(join(cwd, 'acme')))
})

test('wizard: a personal account lists public repositories only, token or not; the page cap is reported', async (t) => {
  withEnv(t, { GITHUB_TOKEN: 'ghp_test', GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'octo')
  const { base } = await githubApi(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/orgs/')) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      link: '<https://api.github.com/user/1/repos?page=999>; rel="next"',
    })
    res.end(
      JSON.stringify([
        {
          name: `repo-${url.searchParams.get('page')}`,
          private: false,
          archived: false,
        },
      ])
    )
  })
  const term = terminal({ pick: [[]] })
  const r = await wizard(
    {
      org: 'octo',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: base,
      cwd: await scratch(t),
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.ok(
    r.out.startsWith(
      'not found octo/.rness (or not visible to you) — starting a new workspace\nlisting  octo repositories…\nonly public repositories of octo are listed; add private ones later with rness add <repo>\nlisted the first 5000 repositories of octo\ncreated  octo/.rness'
    ),
    r.out
  )
  assert.doesNotMatch(r.out, /set GITHUB_TOKEN/)
  assert.equal((term.offered[0] as unknown[]).length, 50)
})

test('wizard: a listing that fails or is empty is a warning, then the one confirm; the workspace is still committed', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const remote = await makeRemoteOrg(t, 'acme')
  const { base: failing } = await githubApi(t, (_req, res) => {
    res.writeHead(500)
    res.end()
  })
  const cwd = await scratch(t)
  const term = terminal({ confirm: [true] })
  const args = { skipInstall: true, pm: 'npm', host: remote.host }
  const r = await wizard(
    { ...args, org: 'acme', githubApi: failing, cwd },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.err,
    'warning: GitHub API answered 500 for /orgs/acme/repos; add repositories later with rness add <repo>\n'
  )
  assert.deepEqual(term.asked, ['Create workspace acme in ./acme?'])
  assert.match(r.out, /committed acme\/\.rness\n/)
  await access(join(cwd, 'acme', 'AGENTS.md'))

  const { base: empty } = await githubApi(
    t,
    reposOf([{ name: 'old', archived: true }, { name: '.rness' }])
  )
  const again = terminal({ confirm: [true] })
  const r2 = await wizard(
    { ...args, org: 'acme', githubApi: empty, cwd: await scratch(t) },
    again.deps
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(r2.err, 'warning: no repositories to list for acme\n')
  assert.deepEqual(again.asked, ['Create workspace acme in ./acme?'])
})

test('wizard: inside a workspace, or with an unusable ./<org>, nothing more is asked', async (t) => {
  const inside = await makeWorkspace(t, { org: 'acme' })
  const term = terminal({})
  const r = await wizard({ cwd: inside }, term.deps)
  assert.equal(r.code, 1)
  assert.match(r.err, /already inside an rness workspace/)
  assert.deepEqual(term.asked, [])

  const cwd = await scratch(t)
  await mkdir(join(cwd, 'acme'))
  await writeFile(join(cwd, 'acme', 'stuff.txt'), 'x')
  const taken = terminal({ text: ['acme'] })
  const r2 = await wizard({ cwd }, taken.deps)
  assert.equal(r2.code, 1)
  assert.equal(r2.err, 'acme is not empty\n')
  assert.deepEqual(taken.asked, [ORG_Q], 'refused right after the organization')
})

// --- [org], and SSH first (spec 0005) ----------------------------------------

test('create <org> is --org <org>; two different names are refused', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const rest = ['--yes', '--skip-install', '--pm', 'npm', '--host', remote.host]
  const cwd = await scratch(t)
  const r = await create(['acme', ...rest, '--repos', 'api', '--cwd', cwd])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual((await loadManifest(join(cwd, 'acme', '.rness'))).repos, {
    api: { url: `${remote.host}acme/api.git` },
  })

  const twice = await scratch(t)
  const same = await create(['acme', '--org', 'acme', ...rest, '--cwd', twice])
  assert.equal(same.code, 0, same.err)

  const other = await scratch(t)
  const r2 = await create(['acme', '--org', 'other', ...rest, '--cwd', other])
  assert.equal(r2.code, 2)
  assert.equal(r2.err, 'organization given twice: "acme" and --org "other"\n')
  assert.deepEqual(await readdir(other), ['.git'])
})

test('--ssh and --https cannot be combined', async (t) => {
  const cwd = await scratch(t)
  const r = await create(['acme', '--yes', '--ssh', '--https', '--cwd', cwd])
  assert.equal(r.code, 2)
  assert.equal(r.err, '--ssh and --https cannot be combined\n')
})

const NO_TTY: CreateDeps = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}
const FLAGS = { org: 'acme', yes: true, skipInstall: true, pm: 'npm' }

test('new workspace: URLs are written over SSH when the SSH test passes, over HTTPS otherwise', async (t) => {
  const ok = await fakeTransport(t, 'acme', SSH_OK)
  await ok.ssh.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await wizard({ ...FLAGS, repos: 'api', cwd }, NO_TTY, ok.transport)
  assert.equal(r.code, 0, r.err)
  assert.ok(
    r.out.startsWith(
      'using    ssh (github.com as octo)\nnot found acme/.rness (or not visible to you) — starting a new workspace\n'
    ),
    r.out
  )
  assert.deepEqual(ok.calls, [{ interactive: false }])
  assert.deepEqual((await loadManifest(join(cwd, 'acme', '.rness'))).repos, {
    api: { url: `${ok.ssh.host}acme/api.git` },
  })

  const denied = await fakeTransport(t, 'acme', SSH_DENIED)
  await denied.https.addRepo('api', { 'README.md': '# api\n' })
  const cwd2 = await scratch(t)
  const r2 = await wizard(
    { ...FLAGS, repos: 'api', cwd: cwd2 },
    NO_TTY,
    denied.transport
  )
  assert.equal(r2.code, 0, r2.err)
  assert.ok(
    r2.out.startsWith(
      'using    https (ssh to github.com unavailable: git@github.com: Permission denied (publickey).)\n'
    ),
    r2.out
  )
  assert.deepEqual((await loadManifest(join(cwd2, 'acme', '.rness'))).repos, {
    api: { url: `${denied.https.host}acme/api.git` },
  })
})

test('--https and --ssh decide without the SSH test', async (t) => {
  const forced = await fakeTransport(t, 'acme', SSH_OK)
  await forced.https.addRepo('api', { 'README.md': '# api\n' })
  await forced.ssh.addRepo('web', { 'README.md': '# web\n' })
  const cwd = await scratch(t)
  const r = await wizard(
    { ...FLAGS, https: true, repos: 'api', cwd },
    NO_TTY,
    forced.transport
  )
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /^using /m)
  assert.deepEqual((await loadManifest(join(cwd, 'acme', '.rness'))).repos, {
    api: { url: `${forced.https.host}acme/api.git` },
  })
  const cwd2 = await scratch(t)
  const r2 = await wizard(
    { ...FLAGS, ssh: true, repos: 'web', cwd: cwd2 },
    NO_TTY,
    forced.transport
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual((await loadManifest(join(cwd2, 'acme', '.rness'))).repos, {
    web: { url: `${forced.ssh.host}acme/web.git` },
  })
  assert.deepEqual(forced.calls, [])
})

test('the SSH test runs unattended first; only when that fails does a terminal get the one that may ask for a passphrase', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const { base } = await githubApi(t, reposOf([{ name: 'api' }]))
  const opts = { org: 'acme', skipInstall: true, pm: 'npm', githubApi: base }

  // A key an agent holds: nothing is announced, nothing can be asked.
  const agent = await fakeTransport(t, 'acme', SSH_OK)
  await agent.ssh.addRepo('api', { 'README.md': '# api\n' })
  const r = await wizard(
    { ...opts, cwd: await scratch(t) },
    terminal({ pick: [['api']] }).deps,
    agent.transport
  )
  assert.equal(r.code, 0, r.err)
  assert.ok(
    r.out.startsWith(
      'using    ssh (github.com as octo)\nnot found acme/.rness'
    ),
    r.out
  )
  assert.deepEqual(agent.calls, [{ interactive: false }])

  // A protected key and no agent: refused unattended, accepted once ssh could ask.
  const locked = await fakeTransport(t, 'acme', [SSH_DENIED, SSH_OK])
  await locked.ssh.addRepo('api', { 'README.md': '# api\n' })
  const r2 = await wizard(
    { ...opts, cwd: await scratch(t) },
    terminal({ pick: [['api']] }).deps,
    locked.transport
  )
  assert.equal(r2.code, 0, r2.err)
  assert.ok(
    r2.out.startsWith(
      'checking ssh access to github.com…\nusing    ssh (github.com as octo)\nnot found acme/.rness'
    ),
    r2.out
  )
  assert.deepEqual(locked.calls, [
    { interactive: false },
    { interactive: true },
  ])
})

test('join: a .rness reachable over SSH only is found, and cloned over SSH', async (t) => {
  const ok = await fakeTransport(t, 'acme', SSH_OK)
  const contextUrl = await ok.ssh.addRepo('.rness', {
    'rness.json': manifestText({}),
  })
  const cwd = await scratch(t)
  const r = await wizard({ ...FLAGS, cwd }, NO_TTY, ok.transport)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^found {4}acme\/\.rness — joining$/m)
  assert.equal(
    await originUrl(join(cwd, 'acme', '.rness')),
    `${ok.ssh.host}acme/.rness.git`
  )
  assert.ok(contextUrl.endsWith('/acme/.rness.git'))

  // The same organization seen without SSH access: nothing to join.
  const denied = await fakeTransport(t, 'acme', SSH_DENIED)
  await denied.ssh.addRepo('.rness', { 'rness.json': manifestText({}) })
  const r2 = await wizard(
    { ...FLAGS, cwd: await scratch(t) },
    NO_TTY,
    denied.transport
  )
  assert.equal(r2.code, 0, r2.err)
  assert.match(r2.out, /^not found acme\/\.rness /m)
})

test('join of an SSH workspace without SSH access stops before anything is written', async (t) => {
  withEnv(t, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined })
  const denied = await fakeTransport(t, 'acme', SSH_DENIED)
  await denied.https.addRepo('.rness', {
    'rness.json': manifestText({
      api: { url: `${denied.ssh.host}acme/api.git` },
    }),
  })
  const expected = `${[...sshWorkspaceLines(SSH_DENIED.ok ? '' : SSH_DENIED.reason), ...INSTEAD_OF_LINES].join('\n')}\n`
  const before = await stagedJoins()

  const cwd = await scratch(t)
  const r = await wizard({ ...FLAGS, cwd }, NO_TTY, denied.transport)
  assert.equal(r.code, 1)
  assert.equal(r.err, expected)
  await assert.rejects(access(join(cwd, 'acme')))
  assert.deepEqual(await stagedJoins(), before)

  // In a terminal: no repository question is asked first.
  const term = terminal({})
  const cwd2 = await scratch(t)
  const r2 = await wizard(
    { org: 'acme', skipInstall: true, pm: 'npm', cwd: cwd2 },
    term.deps,
    denied.transport
  )
  assert.equal(r2.code, 1)
  assert.equal(r2.err, expected)
  assert.deepEqual(term.asked, [])

  // --https chooses the form of new entries; it does not make git@ entries cloneable.
  denied.calls.length = 0
  const cwd3 = await scratch(t)
  const r3 = await wizard(
    { ...FLAGS, https: true, cwd: cwd3 },
    NO_TTY,
    denied.transport
  )
  assert.equal(r3.code, 1)
  assert.equal(r3.err, expected)
  assert.deepEqual(denied.calls, [{ interactive: false }])
  await assert.rejects(access(join(cwd3, 'acme')))
})

// --- logged in to GitHub (spec 0004) -----------------------------------------

test('logged in: the organization is picked from a list, access is stated, private repositories are listed and cloned with the login', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('vault', { 'README.md': '# vault\n' })
  const gh = fakeProvider({
    login: 'octo',
    organizations: ['acme', 'other-org'],
    access: 'member',
    repositories: [
      { name: 'vault', private: true, archived: false },
      { name: 'site', private: false, archived: false },
    ],
  })
  const cwd = await scratch(t)
  const term = terminal({ select: ['acme'], pick: [['vault']] })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, cwd },
    term.deps,
    undefined,
    gh.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [ORG_LIST_Q, REPOS_Q], 'no login question')
  assert.deepEqual(term.offered[0], ['acme', 'other-org', 'octo', ''])
  assert.deepEqual(term.offered[1], [
    { value: 'site', label: 'site' },
    { value: 'vault', label: 'vault 🔒' },
  ])
  // Access is stated before anything reads the organization (spec 0028 §3).
  assert.match(
    r.out,
    /^member {3}acme \(as octo\)\nnot found acme\/\.rness[^\n]*\nlisting {2}acme repositories…\n/m
  )
  assert.doesNotMatch(r.out, /only public repositories/)
  assert.deepEqual(gh.listed, ['acme'])
  // The probe of .rness and the clone were each offered the login.
  assert.deepEqual(gh.asked, [
    `${remote.host}acme/.rness.git`,
    `${remote.host}acme/vault.git`,
  ])
  await access(join(cwd, 'acme', 'org', 'vault', 'README.md'))
})

test('"an organization not listed here…" and an empty list lead to the text prompt; a restricted organization is said, verbatim', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const locked = fakeProvider({
    login: 'octo',
    organizations: ['other-org'],
    access: 'restricted',
    repositories: [{ name: 'site', private: false, archived: false }],
  })
  const term = terminal({ select: [''], text: ['acme'], pick: [[]] })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, cwd: await scratch(t) },
    term.deps,
    undefined,
    locked.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [ORG_LIST_Q, ORG_Q, REPOS_Q])
  assert.deepEqual(term.orgOptions, [
    [
      { value: 'other-org', label: 'other-org' },
      { value: 'octo', label: 'octo', hint: 'your account' },
      {
        value: '',
        label: 'an organization not listed here…',
        hint: 'not a member, or it has not approved rness yet',
      },
    ],
  ])
  // The approval was declined (silently, by the script): the page is named for later.
  assert.match(
    r.err,
    /^warning: acme has not approved rness, so its private repositories are hidden\napprove it later: https:\/\/github\.test\/settings\/connections\/applications\/rness\n/
  )
  assert.doesNotMatch(r.out, /^member /m)

  const alone = fakeProvider({ login: null })
  const anonymous = terminal({ text: ['acme'], confirm: [true] })
  const r2 = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, cwd: await scratch(t) },
    anonymous.deps,
    undefined,
    alone.provider
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(anonymous.asked[0], ORG_Q, 'anonymous: typed, as before')
})

test('anonymous in a terminal: the login is offered before anything is listed; --repos and --yes never ask', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const anonymous = fakeProvider({
    repositories: [{ name: 'api', private: false, archived: false }],
  })
  const declined = terminal({ login: false, pick: [['api']] })
  const r = await wizard(
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd: await scratch(t),
    },
    declined.deps,
    undefined,
    anonymous.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(declined.asked, [LOGIN_Q, REPOS_Q])
  assert.match(r.out, new RegExp(NO_TOKEN_NOTE.trim()))

  const flags = terminal({ confirm: [true] })
  const r2 = await wizard(
    {
      org: 'acme',
      repos: 'api',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd: await scratch(t),
    },
    flags.deps,
    undefined,
    anonymous.provider
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(flags.asked, ['Create workspace acme in ./acme?'])
})

test('accepting the login runs the device flow in place; the listing that follows is the logged-in one', async (t) => {
  const config = await realpath(await mkdtemp(join(tmpdir(), 'rness-cfg-')))
  t.after(() => rm(config, { recursive: true, force: true }))
  await writeFile(join(config, 'gitconfig'), '')
  withTestEnv(t, {
    XDG_CONFIG_HOME: config,
    GIT_CONFIG_GLOBAL: join(config, 'gitconfig'),
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    RNESS_GITHUB_CLIENT_ID: 'client-test',
    // An SSH session: the wizard must not open a browser from a test.
    SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22',
  })
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('vault', { 'README.md': '# vault\n' })
  const gh = await fakeGithub(t, (r) => {
    if (r.path === '/login/device/code')
      return {
        json: {
          device_code: 'd',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 0,
        },
      }
    if (r.path === '/login/oauth/access_token')
      return { json: { access_token: 'ghu_wizard', scope: 'repo,read:org' } }
    if (r.path === '/user') return { json: { login: 'octo' } }
    if (r.path === '/user/memberships/orgs/acme')
      return { json: { state: 'active' } }
    if (r.path.startsWith('/orgs/acme/repos'))
      return { json: [{ name: 'vault', private: true, archived: false }] }
    return { status: 404, json: {} }
  })
  const cwd = await scratch(t)
  // Yes to the login, No to "use rness for git", then the picker.
  const term = terminal({ login: true, confirm: [false], pick: [['vault']] })
  const r = await wizard(
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      githubApi: gh.base,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [
    LOGIN_Q,
    'Use rness to authenticate git over HTTPS for github.com?',
    REPOS_Q,
  ])
  assert.match(
    r.out,
    /^open {5}https:\/\/github\.com\/login\/device\ncode {5}ABCD-1234\nwaiting {2}for you to approve rness on github\.com…\nlogged in as octo \(github\.com\)\n/
  )
  assert.match(r.out, /^member {3}acme \(as octo\)$/m)
  assert.ok(
    !`${r.out}${r.err}`.includes('ghu_wizard'),
    'the token is never printed'
  )
  const listing = gh.requests.find((q) => q.path.startsWith('/orgs/acme/repos'))
  assert.equal(listing?.headers['authorization'], 'Bearer ghu_wizard')
  await access(join(cwd, 'acme', 'org', 'vault', 'README.md'))
})

test('joining a workspace pinned to an older @rness/cli says nothing about versions', async (t) => {
  const pinned = (version: string): string =>
    JSON.stringify({ devDependencies: { '@rness/cli': version } })
  const join = async (version: string) => {
    const remote = await makeRemoteOrg(t, 'acme')
    await remote.addRepo('.rness', {
      'rness.json': manifestText({}),
      'package.json': pinned(version),
    })
    return create([
      'acme',
      '--yes',
      '--skip-install',
      '--pm',
      'npm',
      '--host',
      remote.host,
      '--cwd',
      await scratch(t),
    ])
  }
  // Joining aligns on the organization's pin. Moving it is a maintainer's
  // act, never asked of whoever arrives (spec 0008 §2).
  const older = await join('0.0.1')
  assert.equal(older.code, 0, older.err)
  assert.doesNotMatch(older.out, /pins @rness\/cli/)
  assert.doesNotMatch(older.out, /rness upgrade moves the workspace/)

  const same = await join(VERSION)
  assert.equal(same.code, 0, same.err)
  assert.doesNotMatch(same.out, /pins @rness\/cli/)

  assert.doesNotMatch((await join('^0.0.1')).out, /pins @rness\/cli/)
  assert.doesNotMatch((await join('99.0.0')).out, /pins @rness\/cli/)
})

// --- publishing a new workspace (spec 0004 §3b) ------------------------------

test('logged in, a new workspace is offered to GitHub: the repository is created, then pushed with git', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const gh = fakeProvider({
    login: 'octo',
    organizations: ['acme'],
    access: 'member',
    // GitHub creating acme/.rness: an empty repository appears at the URL.
    create: async (_owner, name) => {
      await remote.addRepo(name, {})
      return { kind: 'created' }
    },
  })
  const cwd = await scratch(t)
  const term = terminal({ select: ['acme'], publish: true })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, repos: '', cwd },
    term.deps,
    undefined,
    gh.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(gh.created, ['acme/.rness'])
  assert.ok(
    term.asked.includes('Create acme/.rness on GitHub (private) and push it?')
  )
  assert.match(
    r.out,
    /^created {2}github\.com\/acme\/\.rness \(private\)\npushed {3}acme\/\.rness$/m
  )
  // What was pushed is the context that was committed.
  const pushed = await execFileP('git', [
    'ls-remote',
    `${remote.host}acme/.rness.git`,
    'refs/heads/main',
  ])
  const local = await execFileP('git', ['rev-parse', 'HEAD'], {
    cwd: join(cwd, 'acme', '.rness'),
  })
  assert.ok(pushed.stdout.startsWith(local.stdout.trim()))
  assert.doesNotMatch(r.out, /git remote add origin|gh repo/)
  assert.match(r.out, / {2}# then, for every teammate: npm create rness acme\n/)
})

test('declined, refused, anonymous or --yes: nothing is created, and the manual steps name git only', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const manual = new RegExp(
    ` {2}# create the empty private repository acme/\\.rness on github\\.com, then:\\n {2}git remote add origin ${remote.host.replaceAll('/', '\\/')}acme\\/\\.rness\\.git && git push -u origin main\\n {2}# or, with the GitHub CLI \\(gh\\) installed, in one step:\\n {2}gh repo create acme\\/\\.rness --private --source \\. --push\\n`
  )
  const opts = {
    org: 'acme',
    skipInstall: true,
    pm: 'npm',
    host: remote.host,
    repos: '',
  }

  const refusing = fakeProvider({
    login: 'octo',
    create: async () => ({ kind: 'refused', reason: 'Not Found (404)' }),
  })
  const r = await wizard(
    { ...opts, cwd: await scratch(t) },
    terminal({ publish: true, confirm: [true] }).deps,
    undefined,
    refusing.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.err,
    /^warning: GitHub did not create acme\/\.rness: Not Found \(404\)$/m
  )
  assert.match(r.out, manual)

  const declining = fakeProvider({ login: 'octo' })
  const r2 = await wizard(
    { ...opts, cwd: await scratch(t) },
    terminal({ publish: false, confirm: [true] }).deps,
    undefined,
    declining.provider
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(declining.created, [])
  assert.match(r2.out, manual)

  const scripted = fakeProvider({ login: 'octo' })
  const r3 = await wizard(
    { ...opts, yes: true, cwd: await scratch(t) },
    NO_TTY,
    undefined,
    scripted.provider
  )
  assert.equal(r3.code, 0, r3.err)
  assert.match(r3.out, manual)
  assert.deepEqual(scripted.created, [], '--yes never creates a repository')
})

test('joining adopts the package manager the workspace declares; --pm still wins', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  await remote.addRepo('.rness', {
    'rness.json': manifestText({ api: { url: apiUrl } }),
    // What the team installs with, committed with the workspace.
    'package.json':
      '{\n  "private": true,\n  "packageManager": "pnpm@12.2.1"\n}\n',
  })
  const options = [
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    remote.host,
  ]
  // `create` was launched by npm (the test runner's agent is not pnpm), yet
  // the workspace's own manager is the one used.
  const adopted = await create([...options, '--cwd', await scratch(t)])
  assert.equal(adopted.code, 0, adopted.err)
  assert.match(
    adopted.out,
    /^skipped {2}install with pnpm \(--skip-install\)$/m
  )

  const forced = await create([
    ...options,
    '--pm',
    'npm',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(forced.code, 0, forced.err)
  assert.match(forced.out, /^skipped {2}install with npm \(--skip-install\)$/m)
})

// --- a blank workspace (spec 0012) -------------------------------------------

/** A provider or a transport whose every use fails: the proof no GitHub step ran. */
function forbidden<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      throw new Error(`${what} used for a blank workspace: ${String(key)}`)
    },
  })
}

const offline = (): [Transport, Provider] => [
  forbidden<Transport>('transport'),
  forbidden<Provider>('provider'),
]

const BLANK_NEXT = [
  'cd my-project',
  '# bring a repository in: <owner>/<repo> on GitHub, or any git URL',
  'rness add <owner>/<repo>',
  '# to share it: set "org" in .rness/rness.json, then push .rness to github.com/<org>/.rness',
]

const NAME_RULE_ERROR = (name: string): string =>
  `workspace name "${name}" may only contain letters, digits, '.', '_' and '-', not starting with '-'`

test('blank: .rness without "org", an empty org/ and the root files — and no GitHub step', async (t) => {
  const cwd = await scratch(t)
  const noTty: CreateDeps = {
    isTty: () => false,
    prompts: () => Promise.reject(new Error('no prompt off a terminal')),
  }
  const r = await wizard(
    {
      blank: true,
      name: 'my-project',
      yes: true,
      skipInstall: true,
      pm: 'npm',
      cwd,
    },
    noTty,
    ...offline()
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.equal(
    r.out,
    [
      'created  my-project/.rness (blank workspace)',
      'skipped  install with npm (--skip-install)',
      'committed my-project/.rness',
      'updated  AGENTS.md',
      '',
      'Workspace `my-project` is ready in my-project/.',
      '',
      'Next:',
      ...BLANK_NEXT.map((l) => `  ${l}`),
      '',
    ].join('\n')
  )
  const root = join(cwd, 'my-project')
  assert.deepEqual((await readdir(root)).sort(), [
    '.rness',
    'AGENTS.md',
    'CLAUDE.md',
    'org',
  ])
  assert.deepEqual(await readdir(join(root, 'org')), [])
  const m = await loadManifest(join(root, '.rness'))
  assert.equal(m.org, null)
  assert.deepEqual(m.repos, {})
  assert.deepEqual(m.scopes, {})
  assert.doesNotMatch(
    await readFile(join(root, '.rness', 'rness.json'), 'utf8'),
    /"org"/
  )
  const pkg = JSON.parse(
    await readFile(join(root, '.rness', 'package.json'), 'utf8')
  ) as { devDependencies: Record<string, string> }
  assert.equal(pkg.devDependencies['@rness/cli'], VERSION)
  const { stdout } = await execFileP('git', ['log', '--oneline', 'main'], {
    cwd: join(root, '.rness'),
  })
  assert.equal(stdout.trim().split('\n').length, 1, 'exactly one commit')
  assert.match(stdout, /chore: rness workspace context/)
  assert.match(
    await readFile(join(root, 'AGENTS.md'), 'utf8'),
    /rness workspace `my-project`/
  )
})

test('blank through the command line: create <name> --blank; the name keeps its case', async (t) => {
  const cwd = await scratch(t)
  const r = await create([
    'My.Project_2',
    '--blank',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^created {2}My\.Project_2\/\.rness \(blank workspace\)\n/
  )
  const m = await loadManifest(join(cwd, 'My.Project_2', '.rness'))
  assert.equal(m.org, null)
  assert.deepEqual(await readdir(cwd), ['.git', 'My.Project_2'])
})

test('blank: refused before anything is written', async (t) => {
  const cwd = await scratch(t)
  const base = ['--yes', '--skip-install', '--cwd', cwd]
  for (const [flags, message] of [
    [['--org', 'acme'], '--blank cannot be combined with --org\n'],
    [['--repos', 'api'], '--blank cannot be combined with --repos\n'],
    [['--ssh'], '--blank cannot be combined with --ssh\n'],
    [['--https'], '--blank cannot be combined with --https\n'],
    [['--host', 'file:///x/'], '--blank cannot be combined with --host\n'],
  ] as const) {
    const r = await create(['my-project', '--blank', ...flags, ...base])
    assert.equal(r.code, 2, flags.join(' '))
    assert.equal(r.err, message)
  }

  const noName = await create(['--blank', ...base])
  assert.equal(noName.code, 2)
  assert.equal(
    noName.err,
    'rness create --blank needs a <name> without a prompt\n'
  )

  for (const bad of ['.', '..', 'a/b', 'my project', 'é']) {
    const r = await create([bad, '--blank', ...base])
    assert.equal(r.code, 2, bad)
    assert.equal(r.err, `${NAME_RULE_ERROR(bad)}\n`)
  }
  // On the command line commander reads a leading '-' as an option; the rule
  // still holds for every other caller.
  const dash = await wizard(
    { blank: true, name: '-x', yes: true, cwd },
    terminal({}).deps,
    ...offline()
  )
  assert.equal(dash.code, 2)
  assert.equal(dash.err, `${NAME_RULE_ERROR('-x')}\n`)

  const noYes = await create([
    'my-project',
    '--blank',
    '--skip-install',
    '--cwd',
    cwd,
  ])
  assert.equal(noYes.code, 2)
  assert.match(noYes.err, /pass --yes/)
  assert.deepEqual(await readdir(cwd), ['.git'])

  await mkdir(join(cwd, 'my-project'))
  await writeFile(join(cwd, 'my-project', 'stuff.txt'), 'x')
  const notEmpty = await create(['my-project', '--blank', ...base])
  assert.equal(notEmpty.code, 1)
  assert.equal(notEmpty.err, 'my-project is not empty\n')

  const inside = await makeWorkspace(t, { org: 'acme' })
  const nested = await create([
    'my-project',
    '--blank',
    '--yes',
    '--skip-install',
    '--cwd',
    inside,
  ])
  assert.equal(nested.code, 1)
  assert.match(nested.err, /already inside an rness workspace/)
  await assert.rejects(access(join(inside, 'my-project')))
})

test('blank: a failed install is rolled back, the directory too', async (t) => {
  const cwd = await scratch(t)
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi',
    'if [ "$1" = "install" ]; then echo "bun install failed: offline" 1>&2; exit 1; fi',
    'exit 0',
  ])
  const r = await create([
    'my-project',
    '--blank',
    '--yes',
    '--pm',
    'bun',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /bun install failed: offline/)
  assert.match(r.err, /removed my-project\/\.rness after the failure/)
  assert.deepEqual(await readdir(cwd), ['.git'])
})

test('wizard, blank: the first question, then the name; GitHub is never asked', async (t) => {
  const cwd = await scratch(t)
  const term = terminal({
    provider: 'blank',
    text: ['my project', 'my-project'],
  })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', cwd },
    term.deps,
    ...offline()
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [PROVIDER_Q, NAME_Q], 'no login, no confirm')
  assert.deepEqual(term.providerOptions, [PROVIDER_OPTIONS])
  assert.deepEqual(term.refused, [NAME_RULE_ERROR('my project')])
  const m = await loadManifest(join(cwd, 'my-project', '.rness'))
  assert.equal(m.org, null)
  await access(join(cwd, 'my-project', 'AGENTS.md'))
})

test('wizard, blank: --blank <name> keeps one confirm; a cancel anywhere writes nothing', async (t) => {
  const cwd = await scratch(t)
  const declined = terminal({ confirm: [false] })
  const r1 = await wizard(
    { blank: true, name: 'my-project', skipInstall: true, pm: 'npm', cwd },
    declined.deps,
    ...offline()
  )
  assert.equal(r1.code, 0)
  assert.equal(r1.err, 'cancelled\n')
  assert.deepEqual(declined.asked, [
    'Create blank workspace my-project in ./my-project?',
  ])

  const atStart = terminal({ provider: CANCEL })
  const r2 = await wizard(
    { skipInstall: true, pm: 'npm', cwd },
    atStart.deps,
    ...offline()
  )
  assert.equal(r2.code, 0)
  assert.deepEqual(atStart.asked, [PROVIDER_Q])

  const atName = terminal({ text: [CANCEL] })
  const r3 = await wizard(
    { blank: true, skipInstall: true, pm: 'npm', cwd },
    atName.deps,
    ...offline()
  )
  assert.equal(r3.code, 0)
  assert.deepEqual(atName.asked, [NAME_Q], '--blank settles the first question')
  assert.deepEqual(await readdir(cwd), ['.git'])
})

// --- next steps in the words of the manager that ran create -----------------

test('next steps spell rness the way create was launched, whatever --pm installs with', async (t) => {
  // One restore for the whole loop: several withEnv calls would restore in
  // the order they were made, and leave the last agent set for the next test.
  withEnv(t, { npm_config_user_agent: undefined })
  for (const [agent, runner] of [
    ['npm/11.13.0 node/v24.16.0 darwin arm64', 'npx @rness/cli'],
    ['pnpm/12.5.1 npm/? node/? darwin arm64', 'pnpm dlx @rness/cli'],
    ['bun/1.3.14 npm/? node/v24.3.0', 'bunx @rness/cli'],
    ['yarn/4.5.0 npm/? node/v24.16.0', 'yarn dlx @rness/cli'],
    // Yarn 1 has no dlx; npx comes with Node.
    ['yarn/1.22.22 npm/? node/v24.16.0', 'npx @rness/cli'],
  ] as const) {
    process.env['npm_config_user_agent'] = agent
    const r = await create([
      'my-project',
      '--blank',
      '--yes',
      '--skip-install',
      '--pm',
      'npm',
      '--cwd',
      await scratch(t),
    ])
    assert.equal(r.code, 0, `${agent}: ${r.err}`)
    assert.match(
      r.out,
      new RegExp(`\\n {2}${runner} add <owner>/<repo>\\n`),
      agent
    )
  }
})

test('new workspace: the retry and the command for teammates follow the launching manager', async (t) => {
  withEnv(t, { npm_config_user_agent: 'bun/1.3.14 npm/? node/v24.3.0' })
  const remote = await makeRemoteOrg(t, 'acme')
  const r = await create([
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'ghost',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r.code, 1)
  assert.match(r.out, /\n {2}bunx @rness\/cli add ghost {3}# failed: /)
  assert.match(r.out, / {2}# then, for every teammate: bun create rness acme\n/)
})

test('join: next steps speak the launching manager, not the one the workspace installs with', async (t) => {
  withEnv(t, { npm_config_user_agent: 'bun/1.1.34 npm/? node/v24.16.0' })
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const webUrl = await remote.addRepo('web', { 'README.md': '# web\n' })
  await remote.addRepo('.rness', {
    'rness.json': manifestText({ api: { url: apiUrl }, web: { url: webUrl } }),
    'package.json':
      '{\n  "private": true,\n  "packageManager": "pnpm@12.2.1"\n}\n',
  })
  const r = await create([
    '--org',
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    remote.host,
    '--repos',
    'api',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^skipped {2}install with pnpm \(--skip-install\)$/m)
  assert.match(r.out, /\n {2}bunx @rness\/cli sync --all\n$/)
})

// --- agents (spec 0011 §3.2) --------------------------------------------------

test('create --agent declares it in the new workspace and writes its files in every clone', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--agent',
    'claude',
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
  const root = join(cwd, 'acme')
  assert.deepEqual((await loadManifest(join(root, '.rness'))).agents, [
    'claude',
  ])
  const settings = JSON.parse(
    await readFile(join(root, 'org', 'api', '.claude', 'settings.json'), 'utf8')
  )
  assert.deepEqual(settings.permissions, {
    additionalDirectories: ['../../.rness'],
  })
  assert.deepEqual(Object.keys(settings.hooks), [
    'SessionStart',
    'PostToolUse',
    'SessionEnd',
  ])
  assert.match(r.out, /updated {2}org\/api\/\.claude\/settings\.json\n/)
  assert.match(r.out, /updated {2}\.claude\/settings\.json\n/)
  await access(join(root, 'org', 'api', '.mcp.json'))

  const blank = await create([
    'demo',
    '--blank',
    '--agent',
    'claude',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--cwd',
    cwd,
  ])
  assert.equal(blank.code, 0, blank.err)
  assert.deepEqual((await loadManifest(join(cwd, 'demo', '.rness'))).agents, [
    'claude',
  ])
})

test('create without --agent and without a terminal writes no agents key', async (t) => {
  const cwd = await scratch(t)
  const r = await create([
    'demo',
    '--blank',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(
    await readFile(join(cwd, 'demo', '.rness', 'rness.json'), 'utf8'),
    /"agents"/
  )
})

test('wizard: a new workspace asks which agents, before the confirm; blank too', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const term = terminal({ agents: ['claude'], confirm: [true] })
  const r = await wizard(
    {
      org: 'acme',
      repos: 'api',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [AGENTS_Q, 'Create workspace acme in ./acme?'])
  assert.deepEqual((await loadManifest(join(cwd, 'acme', '.rness'))).agents, [
    'claude',
  ])
  await access(join(cwd, 'acme', 'org', 'api', '.claude', 'settings.json'))

  const blank = terminal({ provider: 'blank', text: ['demo'], agents: [] })
  const b = await wizard(
    { skipInstall: true, pm: 'npm', cwd },
    blank.deps,
    ...offline()
  )
  assert.equal(b.code, 0, b.err)
  assert.deepEqual(blank.asked, [PROVIDER_Q, NAME_Q, AGENTS_Q])
  assert.deepEqual((await loadManifest(join(cwd, 'demo', '.rness'))).agents, [])

  const cancel = terminal({
    provider: 'blank',
    text: ['other'],
    agents: CANCEL,
  })
  const c = await wizard(
    { skipInstall: true, pm: 'npm', cwd },
    cancel.deps,
    ...offline()
  )
  assert.equal(c.code, 0)
  await assert.rejects(access(join(cwd, 'other')))
})

test('--agent: an unknown agent exits 2 before any question; a join refuses it before any write', async (t) => {
  const unknown = await create([
    'demo',
    '--blank',
    '--agent',
    'codex',
    '--yes',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(unknown.code, 2)
  assert.equal(unknown.err, 'unknown agent "codex" (supported: claude)\n')

  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  await remote.addRepo('.rness', {
    'rness.json': manifestText({ api: { url: apiUrl } }),
  })
  const cwd = await scratch(t)
  const join_ = await create([
    'acme',
    '--agent',
    'claude',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(join_.code, 2)
  assert.match(
    join_.err,
    /acme\/\.rness exists: --agent only applies to a new workspace; after joining, run rness sync --agent claude\n/
  )
  assert.deepEqual(await readdir(cwd), ['.git'])
})

test('wizard: the organization path asks where it lives, GitLab and Atlassian shown disabled; the answer is written', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const term = terminal({ provider: 'github', confirm: [true] })
  const r = await wizard(
    {
      org: 'acme',
      repos: 'api',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  // --org settles it: the wizard starts past the first question (spec 0028 §2).
  assert.deepEqual(term.providerOptions, [])
  assert.match(
    await readFile(join(cwd, 'acme', '.rness', 'rness.json'), 'utf8'),
    /"provider": "github"/
  )
})

test('wizard: where the organization lives is the first question, the blank workspace its last answer; a cancel writes nothing', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  // No --org, no --repos: the question is asked. Anonymous, with nothing
  // to list, the picker is skipped and the typed organization is the confirmation.
  const term = terminal({ provider: 'github', text: ['acme'] })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, cwd },
    term.deps,
    undefined,
    fakeProvider({ repositories: [] }).provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [PROVIDER_Q, ORG_Q])
  assert.deepEqual(term.providerOptions, [PROVIDER_OPTIONS])

  const atStart = terminal({ provider: CANCEL })
  const r2 = await wizard(
    { skipInstall: true, pm: 'npm', cwd: await scratch(t) },
    atStart.deps
  )
  assert.equal(r2.code, 0)
  assert.deepEqual(atStart.asked, [PROVIDER_Q])
})

test('--provider github -y --org acme: no question, and it is written', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const term = terminal({})
  const r = await wizard(
    {
      org: 'acme',
      provider: 'github',
      yes: true,
      repos: 'api',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd,
    },
    term.deps
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.providerOptions, [])
  assert.match(
    await readFile(join(cwd, 'acme', '.rness', 'rness.json'), 'utf8'),
    /"provider": "github"/
  )
})

test('without a terminal and without --provider, a new workspace is GitHub', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
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
    await readFile(join(cwd, 'acme', '.rness', 'rness.json'), 'utf8'),
    /"provider": "github"/
  )
})

test('--provider: an unavailable or unknown provider exits 2 before anything else', async (t) => {
  const cwd = await scratch(t)
  const gitlab = await create(['acme', '--provider', 'gitlab', '--cwd', cwd])
  assert.equal(gitlab.code, 2)
  assert.equal(
    gitlab.err,
    'provider "gitlab" is not available yet (available: github)\n'
  )
  const svn = await create(['acme', '--provider', 'svn', '--cwd', cwd])
  assert.equal(svn.code, 2)
  assert.equal(svn.err, 'unknown provider "svn" (github, gitlab, atlassian)\n')
  await assert.rejects(access(join(cwd, 'acme')))
})

test('--blank asks no provider and writes none; --provider is refused with it', async (t) => {
  const cwd = await scratch(t)
  const term = terminal({ provider: 'blank', text: ['demo'] })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', cwd },
    term.deps,
    ...offline()
  )
  assert.equal(r.code, 0, r.err)
  // The blank workspace is an answer to the provider question, which was asked once.
  assert.equal(term.providerOptions.length, 1)
  assert.doesNotMatch(
    await readFile(join(cwd, 'demo', '.rness', 'rness.json'), 'utf8'),
    /"provider"/
  )
  const clash = await create([
    'demo2',
    '--blank',
    '--provider',
    'github',
    '--cwd',
    cwd,
  ])
  assert.equal(clash.code, 2)
  assert.equal(clash.err, '--blank cannot be combined with --provider\n')
})

test('joining an existing .rness asks nothing and leaves its rness.json as published', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const published = manifestText({ api: { url: apiUrl } })
  await remote.addRepo('.rness', { 'rness.json': published })
  const cwd = await scratch(t)
  const r = await create([
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
  assert.equal(
    await readFile(join(cwd, 'acme', '.rness', 'rness.json'), 'utf8'),
    published
  )
})

test('an organization that has not approved rness wears the padlock and says so; the account is last', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const gh = fakeProvider({
    login: 'octo',
    organizations: [
      { login: 'locked', approved: false, canGrant: true },
      'acme',
    ],
    access: 'member',
    repositories: [],
  })
  const term = terminal({ select: ['acme'], confirm: [true] })
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, cwd: await scratch(t) },
    term.deps,
    undefined,
    gh.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.orgOptions, [
    [
      { value: 'locked', label: 'locked 🔒', hint: 'rness not approved' },
      { value: 'acme', label: 'acme' },
      { value: 'octo', label: 'octo', hint: 'your account' },
      {
        value: '',
        label: 'an organization not listed here…',
        hint: 'not a member, or it has not approved rness yet',
      },
    ],
  ])
})

test('a restricted organization: the approval is asked before the SSH test, the probe and the listing; a cancel writes nothing', async (t) => {
  const { transport, calls } = await fakeTransport(t, 'acme', SSH_OK)
  const locked = fakeProvider({
    login: 'octo',
    access: 'restricted',
    repositories: [{ name: 'site', private: false, archived: false }],
  })
  const term = terminal({ select: [''], text: ['acme'], approve: CANCEL })
  const cwd = await scratch(t)
  const before = await stagedJoins()
  const r = await wizard(
    { skipInstall: true, pm: 'npm', cwd },
    term.deps,
    transport,
    locked.provider
  )
  assert.equal(r.code, 0)
  assert.match(r.err, /cancelled\n$/)
  assert.deepEqual(term.asked, [
    ORG_LIST_Q,
    ORG_Q,
    'Open github.com to approve rness for acme now?',
  ])
  assert.deepEqual(calls, [], 'no SSH test before the answer')
  assert.deepEqual(locked.asked, [], 'no probe before the answer')
  assert.deepEqual(locked.listed, [], 'no listing before the answer')
  assert.deepEqual(await stagedJoins(), before)
  await assert.rejects(access(join(cwd, 'acme')))
})

test('a restricted organization, approved while rness waits: the page opens, the wait ends on the membership, the private repositories are listed', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const locked = fakeProvider({
    login: 'octo',
    access: ['restricted', 'restricted', 'member'],
    repositories: [{ name: 'vault', private: true, archived: false }],
  })
  const term = terminal({
    select: [''],
    text: ['acme'],
    approve: true,
    pick: [[]],
  })
  const opened: string[] = []
  const slept: number[] = []
  const r = await wizard(
    { skipInstall: true, pm: 'npm', host: remote.host, cwd: await scratch(t) },
    term.deps,
    undefined,
    locked.provider,
    {
      open: (u) => opened.push(u),
      sleep: async (ms) => {
        slept.push(ms)
      },
      now: () => 0,
    }
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [
    ORG_LIST_Q,
    ORG_Q,
    'Open github.com to approve rness for acme now?',
    REPOS_Q,
  ])
  assert.deepEqual(opened, [
    'https://github.test/settings/connections/applications/rness',
  ])
  assert.deepEqual(slept, [5000, 5000])
  assert.match(
    r.out,
    /^open {5}https:\/\/github\.test\S+\nwaiting {2}for an owner of acme to approve rness on github\.com…\nmember {3}acme \(as octo\)\n/m
  )
  assert.deepEqual(term.offered[1], [{ value: 'vault', label: 'vault 🔒' }])
  assert.match(r.err, /^warning: acme has not approved rness/m)
})

test('--org in a terminal still reaches the approval; --yes prints the page for an owner and asks nothing', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const locked = fakeProvider({
    login: 'octo',
    access: 'restricted',
    repositories: [],
  })
  const term = terminal({ approve: false, confirm: [true] })
  const r = await wizard(
    {
      org: 'acme',
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd: await scratch(t),
    },
    term.deps,
    undefined,
    locked.provider
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(term.asked, [
    'Open github.com to approve rness for acme now?',
    'Create workspace acme in ./acme?',
  ])
  assert.match(r.err, /approve it later: https:\/\/github\.test\S+\n/)

  const quiet = terminal({})
  const r2 = await wizard(
    {
      org: 'acme',
      yes: true,
      skipInstall: true,
      pm: 'npm',
      host: remote.host,
      cwd: await scratch(t),
    },
    quiet.deps,
    undefined,
    locked.provider
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(quiet.asked, [])
  assert.match(
    r2.err,
    /^warning: acme has not approved rness, so its private repositories are hidden\nan owner approves it at https:\/\/github\.test\S+\n/m
  )
})
