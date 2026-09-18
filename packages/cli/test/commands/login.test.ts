import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { promisify } from 'node:util'

import { gitCredentialCommand } from '../../src/commands/git-credential.ts'
import { loginCommand } from '../../src/commands/login.ts'
import { logoutCommand } from '../../src/commands/logout.ts'
import { readAuth, writeAuth } from '../../src/core/auth.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'
import { type Recorded, fakeGithub, withEnv } from '../helpers/fake-github.ts'

const execFileP = promisify(execFile)
const HELPER_KEY = 'credential.https://github.com.helper'
const BIN = '/usr/local/lib/node_modules/@rness/cli/dist/bin/rness.js'

/** A private config directory and a private global git config. */
async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-login-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const gitConfig = join(dir, 'gitconfig')
  await writeFile(gitConfig, '')
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GIT_CONFIG_GLOBAL: gitConfig,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    SSH_CONNECTION: undefined,
    RNESS_GITHUB_CLIENT_ID: 'client-test',
  })
  const helpers = async (): Promise<string[]> =>
    execFileP('git', ['config', '--global', '--get-all', HELPER_KEY]).then(
      (r) => r.stdout.replace(/\n$/, '').split('\n'),
      () => []
    )
  return { dir, helpers }
}

const github = (r: Recorded) => {
  if (r.path === '/login/device/code')
    return {
      json: {
        device_code: 'dev-1',
        user_code: '8F43-6B2A',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    }
  if (r.path === '/login/oauth/access_token')
    return {
      json: {
        access_token: 'ghu_access',
        expires_in: 28800,
        refresh_token: 'ghr_refresh',
        refresh_token_expires_in: 15897600,
        scope: 'repo,read:org',
      },
    }
  if (r.path === '/user') return { json: { login: 'octo' } }
  return { status: 404, json: {} }
}

function terminal(answers: boolean[]): { t: Terminal; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    t: {
      isTty: () => true,
      prompts: async () =>
        ({
          async confirm(o: { message: string }) {
            asked.push(o.message)
            return answers.shift() ?? false
          },
          isCancel: () => false,
        }) as unknown as Prompts,
    },
  }
}
const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

async function run<T>(work: () => Promise<T>) {
  const c = capture()
  try {
    const code = await work()
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const sleep = async (): Promise<void> => undefined

test('login: the code, the wait, the name — and the token is stored, never printed', async (t) => {
  const { dir } = await machine(t)
  const gh = await fakeGithub(t, github)
  const opened: string[] = []
  const term = terminal([false])
  const r = await run(() =>
    loginCommand(
      { githubApi: gh.base },
      { terminal: term.t, sleep, open: (u) => opened.push(u), bin: BIN }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.out,
    [
      'open     https://github.com/login/device',
      'code     8F43-6B2A',
      'waiting  for you to approve rness on github.com…',
      'logged in as octo (github.com)',
      '',
    ].join('\n')
  )
  assert.deepEqual(opened, ['https://github.com/login/device'])
  assert.deepEqual(term.asked, [
    'Use rness to authenticate git over HTTPS for github.com?',
  ])
  assert.ok(!`${r.out}${r.err}`.includes('ghu_access'))
  assert.equal((await readAuth())?.login, 'octo')
  assert.match(
    await readFile(join(dir, 'rness', 'auth.json'), 'utf8'),
    /ghu_access/
  )

  // Again: nothing is asked of GitHub's login endpoints.
  const before = gh.requests.length
  const again = await run(() =>
    loginCommand(
      { githubApi: gh.base, setupGit: false },
      { terminal: term.t, sleep, bin: BIN }
    )
  )
  assert.equal(
    again.out,
    'logged in as octo (github.com); rness logout to switch\n'
  )
  assert.equal(gh.requests.length, before)
})

test('login over SSH or without a terminal opens no browser and asks nothing', async (t) => {
  await machine(t)
  const gh = await fakeGithub(t, github)
  const opened: string[] = []
  const open = (u: string): void => {
    opened.push(u)
  }
  const r = await run(() =>
    loginCommand(
      { githubApi: gh.base },
      { terminal: NO_TTY, sleep, open, bin: BIN }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(opened.length, 0)

  await logoutCommand()
  withEnv(t, { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' })
  const term = terminal([false])
  await run(() =>
    loginCommand(
      { githubApi: gh.base },
      { terminal: term.t, sleep, open, bin: BIN }
    )
  )
  assert.deepEqual(opened, [], 'an SSH session has no browser to open')
})

test('a refused login and a disabled device flow are one line, exit 1', async (t) => {
  await machine(t)
  await fakeGithub(t, (r) =>
    r.path === '/login/device/code'
      ? { json: { error: 'device_flow_disabled' } }
      : { json: {} }
  )
  const r = await run(() =>
    loginCommand({}, { terminal: NO_TTY, sleep, bin: BIN })
  )
  assert.equal(r.code, 1)
  assert.equal(
    r.err,
    'the device flow is not enabled on the rness GitHub app\n'
  )
  assert.equal(await readAuth(), null)
})

test('setup-git writes the empty entry and rness by absolute path; logout removes exactly those', async (t) => {
  const { helpers } = await machine(t)
  const gh = await fakeGithub(t, github)
  // Someone else's helper is there first, and must survive.
  await execFileP('git', [
    'config',
    '--global',
    '--add',
    HELPER_KEY,
    '!gh auth git-credential',
  ])

  const term = terminal([true])
  const r = await run(() =>
    loginCommand(
      { githubApi: gh.base },
      { terminal: term.t, sleep, open: () => undefined, bin: BIN }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(await helpers(), [
    '!gh auth git-credential',
    '',
    `!'${process.execPath}' '${BIN}' git-credential`,
  ])
  assert.match(
    r.out,
    /^updated {2}git: rness answers for https:\/\/github\.com/m
  )

  const out = await run(() => logoutCommand())
  assert.equal(out.code, 0, out.err)
  assert.deepEqual(await helpers(), ['!gh auth git-credential'])
  assert.equal(await readAuth(), null)
  assert.match(out.out, /^logged out octo \(github\.com\)$/m)
  assert.match(
    out.out,
    /^revoke rness on GitHub: https:\/\/github\.com\/settings\/connections\/applications\/client-test$/m
  )
  assert.equal((await run(() => logoutCommand())).out, 'not logged in\n')
})

test('--setup-git asks nothing; under npx the install line replaces the question', async (t) => {
  const { helpers } = await machine(t)
  const gh = await fakeGithub(t, github)
  const flag = await run(() =>
    loginCommand(
      { githubApi: gh.base, setupGit: true },
      { terminal: NO_TTY, sleep, bin: BIN }
    )
  )
  assert.equal(flag.code, 0, flag.err)
  assert.equal((await helpers()).length, 2)

  await logoutCommand()
  const term = terminal([true])
  const npx = await run(() =>
    loginCommand(
      { githubApi: gh.base },
      {
        terminal: term.t,
        sleep,
        open: () => undefined,
        bin: '/Users/x/.npm/_npx/abc123/node_modules/@rness/cli/dist/bin/rness.js',
      }
    )
  )
  assert.equal(npx.code, 0, npx.err)
  assert.deepEqual(term.asked, [])
  assert.match(
    npx.out,
    /^install rness globally to let git use your login: npm i -g @rness\/cli$/m
  )
  assert.deepEqual(await helpers(), [])
})

test('git-credential answers `get` for https://github.com, and nothing else', async (t) => {
  await machine(t)
  await writeAuth({
    login: 'octo',
    tokens: {
      accessToken: 'ghu_stored',
      expiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
      scopes: 'repo',
    },
  })
  const ask = (operation: string, input: string) =>
    run(() => gitCredentialCommand(operation, input))

  const get = await ask('get', 'protocol=https\nhost=github.com\n\n')
  assert.equal(get.code, 0)
  assert.equal(get.out, 'username=x-access-token\npassword=ghu_stored\n')

  for (const [operation, input] of [
    ['get', 'protocol=https\nhost=gitlab.com\n'],
    ['get', 'protocol=http\nhost=github.com\n'],
    ['get', 'protocol=https\nhost=github.com.evil.example\n'],
    ['store', 'protocol=https\nhost=github.com\npassword=x\n'],
    ['erase', 'protocol=https\nhost=github.com\n'],
  ] satisfies [string, string][]) {
    const r = await ask(operation, input)
    assert.equal(r.code, 0)
    assert.equal(r.out, '', `${operation} ${input.split('\n')[1]}`)
  }

  withEnv(t, { GITHUB_TOKEN: 'ghp_env' })
  assert.match(
    (await ask('get', 'protocol=https\nhost=github.com\n')).out,
    /password=ghp_env/
  )
  withEnv(t, { GITHUB_TOKEN: undefined })
  await logoutCommand()
  assert.equal((await ask('get', 'protocol=https\nhost=github.com\n')).out, '')
})
