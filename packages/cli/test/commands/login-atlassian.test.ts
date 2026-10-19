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
import {
  jiraLogin,
  readAuthAt,
  resolveToken,
  writeAuthAt,
} from '../../src/core/auth.ts'
import { requestDeviceCode } from '../../src/core/device-flow.ts'
import {
  HOSTS,
  hostFor,
  providerFlag,
  revokeUrl,
} from '../../src/core/hosts.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'
import { fakeBitbucket } from '../helpers/fake-bitbucket.ts'
import { type Recorded, withEnv } from '../helpers/fake-github.ts'
import { fakeJira } from '../helpers/fake-jira.ts'

// The login of Atlassian (spec 0039 §3; plan 0053 task 2): two API tokens,
// one for Bitbucket and one for the Jira site, typed into masked prompts.

const execFileP = promisify(execFile)
const BIN = '/usr/local/lib/node_modules/@rness/cli/dist/bin/rness.js'
const SITE = 'rness-dev.atlassian.net'
const NOWHERE = tmpdir()

async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-atl-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const gitConfig = join(dir, 'gitconfig')
  await writeFile(gitConfig, '')
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GIT_CONFIG_GLOBAL: gitConfig,
    BITBUCKET_TOKEN: undefined,
    JIRA_EMAIL: undefined,
    JIRA_API_TOKEN: undefined,
  })
  const helpers = (): Promise<string[]> =>
    execFileP('git', [
      'config',
      '--global',
      '--get-all',
      'credential.https://bitbucket.org.helper',
    ]).then(
      (r) => r.stdout.replace(/\n$/, '').split('\n'),
      () => []
    )
  return { dir, helpers }
}

const basic = (email: string, token: string): string =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`

/** Bitbucket and the Jira site, answering one good token each. */
async function atlassian(t: TestContext) {
  const bitbucket = await fakeBitbucket(t, (r: Recorded) => {
    if (r.headers.authorization !== 'Bearer bb-good')
      return { status: 401, json: { type: 'error' } }
    if (r.path === '/2.0/user')
      return {
        json: {
          username: 'cedricmagne',
          display_name: 'Cedric Magne',
          account_id: 'acc-1',
        },
      }
    if (r.path.startsWith('/2.0/user/emails'))
      return {
        json: {
          values: [
            { email: 'old@x.dev', is_primary: false },
            { email: 'cedric@x.dev', is_primary: true },
          ],
        },
      }
    return { status: 404, json: {} }
  })
  const jira = await fakeJira(t, (r: Recorded) =>
    r.path === '/rest/api/3/myself' &&
    r.headers.authorization === basic('cedric@x.dev', 'jira-good')
      ? {
          json: {
            displayName: 'Cedric Magne',
            accountId: 'acc-1',
            emailAddress: 'cedric@x.dev',
          },
        }
      : { status: 401, json: { errorMessages: ['Unauthorized'] } }
  )
  return { bitbucket, jira }
}

const CANCEL = Symbol('cancel')

/** A terminal answering passwords, texts and confirms from scripts; every question recorded. */
function terminal(script: {
  password: (string | typeof CANCEL)[]
  text: string[]
  confirm?: boolean[]
}): { t: Terminal; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    t: {
      isTty: () => true,
      prompts: async () =>
        ({
          async password(o: { message: string }) {
            asked.push(o.message)
            return script.password.shift() ?? CANCEL
          },
          async text(o: { message: string; defaultValue?: string }) {
            asked.push(o.message)
            return script.text.shift() ?? o.defaultValue ?? ''
          },
          async confirm(o: { message: string }) {
            asked.push(o.message)
            return script.confirm?.shift() ?? false
          },
          isCancel: (v: unknown) => v === CANCEL,
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

test('the Bitbucket row: a token login, the tokens page to revoke, --provider atlassian', () => {
  assert.equal(hostFor('atlassian'), HOSTS.bitbucket)
  assert.equal(HOSTS.bitbucket.loginKind, 'token')
  assert.equal(HOSTS.github.loginKind, 'device')
  assert.equal(HOSTS.bitbucket.username, 'x-bitbucket-api-token-auth')
  assert.equal(HOSTS.bitbucket.ssh, 'git@ssh.bitbucket.org:')
  assert.equal(
    revokeUrl(HOSTS.bitbucket),
    'https://id.atlassian.com/manage-profile/security/api-tokens'
  )
  assert.equal(providerFlag(HOSTS.bitbucket), ' --provider atlassian')
})

test('a token row has no device flow', async () => {
  await assert.rejects(requestDeviceCode(HOSTS.bitbucket), {
    message: 'Bitbucket logs in with an API token, not a device flow',
  })
})

test('login --provider atlassian: the page and the scopes, a refused token asked again, both hosts stored, no token printed', async (t) => {
  const m = await machine(t)
  await atlassian(t)
  const term = terminal({
    password: ['bb-bad', 'bb-good', 'jira-good'],
    text: [SITE],
    confirm: [false],
  })
  const r = await run(() =>
    loginCommand(
      { provider: 'atlassian' },
      { terminal: term.t, bin: BIN, cwd: NOWHERE }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/
  )
  assert.match(r.out, /read:repository:bitbucket write:repository:bitbucket/)
  assert.match(r.err + r.out, /Bitbucket refused this token \(401\)/)
  assert.match(r.out, /logged in +as cedricmagne \(bitbucket\.org\)/)
  assert.match(
    r.out,
    /logged in +as Cedric Magne \(rness-dev\.atlassian\.net\)/
  )
  // The email offered is Bitbucket's primary one, accepted as is.
  assert.deepEqual(term.asked.slice(0, 5), [
    'Bitbucket API token',
    'Bitbucket API token',
    'Jira site',
    'Atlassian account email',
    'Jira API token',
  ])
  const bb = await readAuthAt('bitbucket.org')
  assert.equal(bb?.login, 'cedricmagne')
  assert.equal(bb?.tokens.accessToken, 'bb-good')
  assert.equal(bb?.tokens.refreshToken, null)
  const site = await readAuthAt(SITE)
  assert.equal(site?.email, 'cedric@x.dev')
  assert.equal(site?.accountId, 'acc-1')
  assert.equal(site?.tokens.accessToken, 'jira-good')
  assert.doesNotMatch(r.out + r.err, /bb-good|jira-good/)
  const file = await readFile(join(m.dir, 'rness', 'auth.json'), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(file) as object).sort(), [
    'bitbucket.org',
    SITE,
  ])
})

test('nothing is stored until both answer: a cancel at the Jira token leaves no Bitbucket login', async (t) => {
  await machine(t)
  await atlassian(t)
  const term = terminal({ password: ['bb-good', CANCEL], text: [SITE] })
  const r = await run(() =>
    loginCommand(
      { provider: 'atlassian' },
      { terminal: term.t, bin: BIN, cwd: NOWHERE }
    )
  )
  assert.equal(r.code, 0)
  assert.equal(await readAuthAt('bitbucket.org'), null)
  assert.equal(await readAuthAt(SITE), null)
})

test('off a terminal: exit 1, the three variables named, nothing stored', async (t) => {
  await machine(t)
  const r = await run(() =>
    loginCommand({ provider: 'atlassian' }, { terminal: NO_TTY, cwd: NOWHERE })
  )
  assert.equal(r.code, 1)
  assert.match(
    r.err + r.out,
    /needs a terminal: set BITBUCKET_TOKEN, JIRA_EMAIL and JIRA_API_TOKEN instead/
  )
  assert.equal(await readAuthAt('bitbucket.org'), null)
})

test('the environment wins: BITBUCKET_TOKEN for Bitbucket, JIRA_EMAIL with JIRA_API_TOKEN for the site', async (t) => {
  await machine(t)
  await writeAuthAt('bitbucket.org', {
    login: 'cedricmagne',
    tokens: {
      accessToken: 'bb-stored',
      expiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
      scopes: '',
    },
  })
  await writeAuthAt(SITE, {
    login: 'Cedric Magne',
    email: 'cedric@x.dev',
    accountId: 'acc-1',
    tokens: {
      accessToken: 'jira-stored',
      expiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
      scopes: '',
    },
  })
  // A stored token login is never refreshed, whatever its age.
  assert.equal(
    (await resolveToken({ now: () => 9e15 }, HOSTS.bitbucket))?.token,
    'bb-stored'
  )
  assert.deepEqual(await jiraLogin(SITE), {
    email: 'cedric@x.dev',
    token: 'jira-stored',
    source: 'login',
  })
  withEnv(t, {
    BITBUCKET_TOKEN: 'bb-env',
    JIRA_EMAIL: 'ci@x.dev',
    JIRA_API_TOKEN: 'jira-env',
  })
  assert.deepEqual(await resolveToken({}, HOSTS.bitbucket), {
    token: 'bb-env',
    source: 'BITBUCKET_TOKEN',
    login: null,
  })
  assert.deepEqual(await jiraLogin(SITE), {
    email: 'ci@x.dev',
    token: 'jira-env',
    source: 'JIRA_API_TOKEN',
  })
  // The variables name no site: they serve the one the workspace names.
  assert.equal((await jiraLogin('other.atlassian.net'))?.token, 'jira-env')
})

test('git-credential answers bitbucket.org with x-bitbucket-api-token-auth; the Jira token is never given to git', async (t) => {
  await machine(t)
  const tokens = {
    expiresAt: null,
    refreshToken: null,
    refreshExpiresAt: null,
    scopes: '',
  }
  await writeAuthAt('bitbucket.org', {
    login: 'cedricmagne',
    tokens: { accessToken: 'bb-stored', ...tokens },
  })
  await writeAuthAt(SITE, {
    login: 'Cedric Magne',
    email: 'cedric@x.dev',
    tokens: { accessToken: 'jira-stored', ...tokens },
  })
  const ask = (input: string) => run(() => gitCredentialCommand('get', input))
  assert.equal(
    (await ask('protocol=https\nhost=bitbucket.org\n\n')).out,
    'username=x-bitbucket-api-token-auth\npassword=bb-stored\n'
  )
  assert.equal((await ask(`protocol=https\nhost=${SITE}\n\n`)).out, '')
})

test('logout --provider atlassian: both logins forgotten, the helper undone, the tokens page named', async (t) => {
  const m = await machine(t)
  await atlassian(t)
  const term = terminal({
    password: ['bb-good', 'jira-good'],
    text: [SITE],
    confirm: [true],
  })
  assert.equal(
    (
      await run(() =>
        loginCommand(
          { provider: 'atlassian' },
          { terminal: term.t, bin: BIN, cwd: NOWHERE }
        )
      )
    ).code,
    0
  )
  assert.equal((await m.helpers()).length, 2)
  const r = await run(() =>
    logoutCommand({ provider: 'atlassian', cwd: NOWHERE })
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /logged out +cedricmagne \(bitbucket\.org\)/)
  assert.match(r.out, /logged out +Cedric Magne \(rness-dev\.atlassian\.net\)/)
  assert.match(
    r.out,
    /revoke the tokens: https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/
  )
  assert.equal(await readAuthAt('bitbucket.org'), null)
  assert.equal(await readAuthAt(SITE), null)
  assert.deepEqual(await m.helpers(), [])
})
