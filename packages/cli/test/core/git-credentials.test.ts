import assert from 'node:assert/strict'
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { clone, pullFastForward } from '../../src/core/git.ts'
import { probeRemote } from '../../src/core/remote.ts'

const SECRET = 'ghu_never_in_argv'
const CREDENTIALS = { username: 'x-access-token', password: SECRET }

/** `git` first on PATH: records its arguments and the two variables, exits 0. */
async function fakeGit(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-fakegit-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = join(dir, 'calls.jsonl')
  const file = join(dir, 'git')
  await writeFile(
    file,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.RNESS_GIT_TOKEN ?? null, username: process.env.RNESS_GIT_USERNAME ?? null, prompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + '\\n')\n`
  )
  await chmod(file, 0o755)
  const saved = process.env['PATH']
  process.env['PATH'] = `${dir}:${saved ?? ''}`
  t.after(() => {
    process.env['PATH'] = saved
  })
  return async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            argv: string[]
            token: string | null
            username: string | null
            prompt: string | null
          }
      )
}

test('with credentials, git gets a helper for this command only and the token in its environment — never in an argument', async (t) => {
  const calls = await fakeGit(t)
  await clone('https://github.com/acme/api.git', '/tmp/rness-x', CREDENTIALS)
  await pullFastForward('/tmp', CREDENTIALS)
  assert.deepEqual(
    await probeRemote('https://github.com/acme/.rness.git', 5000, CREDENTIALS),
    { kind: 'found' }
  )
  const recorded = await calls()
  assert.equal(recorded.length, 3)
  for (const call of recorded) {
    assert.deepEqual(call.argv.slice(0, 3), ['-c', 'credential.helper=', '-c'])
    assert.match(
      call.argv[3] ?? '',
      /^credential\.helper=!f\(\) \{ test "\$1" = get && printf /
    )
    assert.ok(call.argv[3]?.includes('$RNESS_GIT_TOKEN'))
    assert.equal(call.token, SECRET)
    assert.equal(call.username, 'x-access-token')
    assert.equal(call.prompt, '0', 'git never prompts')
    assert.ok(
      !JSON.stringify(call.argv).includes(SECRET),
      'the token is in no argument'
    )
  }
  assert.deepEqual(recorded[0]?.argv.slice(4), [
    'clone',
    '--quiet',
    '--',
    'https://github.com/acme/api.git',
    '/tmp/rness-x',
  ])
  assert.deepEqual(recorded[2]?.argv.slice(4), [
    'ls-remote',
    '--exit-code',
    'https://github.com/acme/.rness.git',
    'HEAD',
  ])
})

test('without credentials the command is what it always was', async (t) => {
  const calls = await fakeGit(t)
  await clone('git@github.com:acme/api.git', '/tmp/rness-x')
  await clone('git@github.com:acme/api.git', '/tmp/rness-x', null)
  await probeRemote('git@github.com:acme/.rness.git', 5000, null)
  for (const call of await calls()) {
    assert.ok(!call.argv.includes('-c'))
    assert.equal(call.token, null)
    assert.equal(call.username, null)
  }
})

test('the helper answers git with the environment it was given', async () => {
  // The helper text, run as git runs it: `sh -c '<helper> get'`.
  const { withCredentials } = await import('../../src/core/git.ts')
  const { args, env } = withCredentials(CREDENTIALS)
  const helper = (args[3] ?? '').replace(/^credential\.helper=!/, '')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('sh', ['-c', `${helper} get`], {
    env: { ...process.env, ...env },
  })
  assert.equal(stdout, `username=x-access-token\npassword=${SECRET}\n`)
  const other = await promisify(execFile)('sh', ['-c', `${helper} store`], {
    env: { ...process.env, ...env },
  }).catch((e: { stdout: string }) => e)
  assert.equal(other.stdout, '', 'only `get` is answered')
})
