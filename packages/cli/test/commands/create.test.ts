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
import { originUrl } from '../../src/core/git.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import type { GitProvider } from '../../src/core/provider.ts'
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
    /^not found acme\/\.rness \(or not visible to you\) — starting a new workspace\ncreated {2}acme\/\.rness \(new workspace\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\ncommitted acme\/\.rness\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n/
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
    'found    acme/.rness — joining\ncloned   acme/.rness (joined acme)\nskipped  install (--skip-install)\ncloned   org/api\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\n'
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
    'found    acme/.rness — joining\ncloned   acme/.rness (joined acme)\nskipped  install (--skip-install)\ncloned   org/api\nnot cloned: web (rness add <name>, or rness sync --all)\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\n'
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
  text?: string[]
  confirm?: (boolean | typeof CANCEL)[]
  pick?: (string[] | typeof CANCEL)[]
  /** "Which GitHub organization?" answers. */
  select?: string[]
  /**
   * The answer to "Log in to GitHub…?". Left out, the question is declined
   * without being recorded: every wizard test that is not about the login
   * reads as it did before there was one.
   */
  login?: boolean
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
      if (opts.message === LOGIN_Q && script.login === undefined) return false
      asked.push(opts.message)
      if (opts.message === LOGIN_Q) return script.login
      return next(script.confirm, opts.message)
    },
    async select(opts: { message: string; options: { value: string }[] }) {
      asked.push(opts.message)
      offered.push(opts.options.map((o) => o.value))
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
  return { deps, asked, refused, offered, preselected }
}

async function wizard(
  opts: Parameters<typeof createCommand>[0],
  deps: CreateDeps,
  transport?: Transport,
  provider?: GitProvider
) {
  const c = capture()
  try {
    const code = await createCommand(opts, {
      terminal: deps,
      ...(transport === undefined ? {} : { transport }),
      ...(provider === undefined ? {} : { provider }),
    })
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

async function stagedJoins(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith('rness-join-'))
}

const ORG_Q = 'What is your GitHub organization named?'
const LOGIN_Q = 'Log in to GitHub to list private repositories?'
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
  // names are case-insensitive); any other is shown disabled, last. Hidden
  // repositories (.rness, .github, …) and archived ones are not listed.
  assert.deepEqual(term.offered, [
    [
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
      `not found acme/.rness (or not visible to you) — starting a new workspace\nlisting  acme repositories…\n${NO_TOKEN_NOTE}names rness cannot declare yet (struck through): -dash\ncreated  acme/.rness (new workspace)\nskipped  install (--skip-install)\ncloned   org/api\ndeclared scope api (org/api)\ncloned   org/website\ndeclared scope website (org/website)\ncommitted acme/.rness\n`
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
    'found    acme/.rness — joining\nlisting  acme repositories…\ncloned   acme/.rness (joined acme)\nskipped  install (--skip-install)\ncloned   org/api\ncloned   org/other\ndeclared scope other (org/other)\nnot cloned: web, secret (rness add <name>, or rness sync --all)\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\nupdated  org/other/AGENTS.md\n'
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
  const term = terminal({ confirm: [false] })
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

const ORG_LIST_Q = 'Which GitHub organization?'

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
  assert.match(
    r.out,
    /^member {3}acme \(as octo\)\nlisting {2}acme repositories…\n/m
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

test('"another one…" and an empty list lead to the text prompt; a restricted organization is said, verbatim', async (t) => {
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
  assert.match(
    r.err,
    /^warning: acme restricts OAuth apps, so its private repositories are hidden from rness\nask an owner to approve it: https:\/\/github\.com\/settings\/connections\/applications\/\S+\n/
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
