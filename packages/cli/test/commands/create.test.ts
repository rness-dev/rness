import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { run } from '../../src/cli.ts'
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

test('new: scaffolds .rness with org and tokens, commits it, adds --repos, writes the blocks', async (t) => {
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
  const root = join(cwd, 'acme')
  assert.match(
    r.out,
    /^created {2}acme\/\.rness \(new workspace\)\nskipped {2}install \(--skip-install\)\ncommitted acme\/\.rness\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n/
  )
  assert.match(r.out, /Next:\n[\s\S]*acme\/\.rness/)
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
  await access(join(root, 'AGENTS.md'))
  await access(join(root, 'CLAUDE.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('join: clones the organisation .rness and syncs its repositories', async (t) => {
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
    /^cloned {3}acme\/\.rness \(joined acme\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
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

test('guards: inside a workspace, non-empty target, --template, bad org, no TTY', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const inside = await makeWorkspace(t, { org: 'acme' })
  const r1 = await create([
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

  const cwd = await scratch(t)
  await mkdir(join(cwd, 'acme'))
  await writeFile(join(cwd, 'acme', 'stuff.txt'), 'x')
  const r2 = await create([
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
    '--yes',
    '--template',
    'saas',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r3.code, 2)
  assert.match(r3.err, /--template is reserved/)

  const r4 = await create(['Acme Inc', '--yes', '--cwd', await scratch(t)])
  assert.equal(r4.code, 2)
  assert.match(r4.err, /organisation name/)

  const r5 = await create([
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
    '--yes',
    '--pm',
    'cargo',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r6.code, 2)
  assert.match(r6.err, /--pm must be one of npm, pnpm, yarn, bun/)
})
