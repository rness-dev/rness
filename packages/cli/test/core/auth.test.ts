import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  clearAuth,
  configDir,
  readAuth,
  resolveToken,
  writeAuth,
} from '../../src/core/auth.ts'
import { fakeGithub, withEnv } from '../helpers/fake-github.ts'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

/** A private config directory, and no token in the environment. */
async function home(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-config-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    RNESS_GITHUB_CLIENT_ID: 'client-test',
  })
  return dir
}

const login = (expiresAt: number | null) => ({
  login: 'octo',
  tokens: {
    accessToken: 'ghu_old',
    expiresAt,
    refreshToken: 'ghr_old',
    refreshExpiresAt: NOW + 1000 * HOUR,
    scopes: 'repo,read:org',
  },
})

test('the login is one file, readable by its owner only', async (t) => {
  const dir = await home(t)
  assert.equal(configDir(), join(dir, 'rness'))
  assert.equal(await readAuth(), null)
  await writeAuth(login(null))
  const file = join(dir, 'rness', 'auth.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(join(dir, 'rness'))).mode & 0o777, 0o700)
  assert.deepEqual(await readAuth(), login(null))
  await clearAuth()
  assert.equal(await readAuth(), null)
})

test('GITHUB_TOKEN wins over GH_TOKEN, which wins over the stored login', async (t) => {
  await home(t)
  assert.equal(await resolveToken(), null)
  await writeAuth(login(null))
  assert.deepEqual(await resolveToken(), {
    token: 'ghu_old',
    source: 'login',
    login: 'octo',
  })
  withEnv(t, { GH_TOKEN: 'gh-env' })
  assert.equal((await resolveToken())?.source, 'GH_TOKEN')
  withEnv(t, { GITHUB_TOKEN: 'github-env' })
  assert.deepEqual(await resolveToken(), {
    token: 'github-env',
    source: 'GITHUB_TOKEN',
    login: null,
  })
})

test('a token about to expire is refreshed once, even by two processes at a time, and stored', async (t) => {
  await home(t)
  const gh = await fakeGithub(t, () => ({
    json: {
      access_token: 'ghu_new',
      expires_in: 28800,
      refresh_token: 'ghr_new',
      refresh_token_expires_in: 15897600,
      scope: 'repo,read:org',
    },
  }))
  await writeAuth(login(NOW + 60_000))
  const now = (): number => NOW
  const [a, b] = await Promise.all([
    resolveToken({ now }),
    resolveToken({ now }),
  ])
  assert.equal(a?.token, 'ghu_new')
  assert.equal(b?.token, 'ghu_new')
  assert.equal(gh.requests.length, 1, 'one refresh request')
  const stored = await readAuth()
  assert.equal(stored?.tokens.refreshToken, 'ghr_new')
  assert.equal(stored?.tokens.expiresAt, NOW + 28800 * 1000)

  // Plenty of time left: no request at all.
  assert.equal((await resolveToken({ now }))?.token, 'ghu_new')
  assert.equal(gh.requests.length, 1)
})

test('GitHub refusing the refresh ends the login; a dead network does not', async (t) => {
  const dir = await home(t)
  await fakeGithub(t, () => ({ json: { error: 'bad_refresh_token' } }))
  await writeAuth(login(NOW - HOUR))
  const said: string[] = []
  assert.equal(
    await resolveToken({ now: () => NOW, notify: (l) => said.push(l) }),
    null
  )
  assert.deepEqual(said, ['your GitHub login expired; run rness login'])
  assert.equal(await readAuth(), null)

  // Offline, expired: no token, but the login is kept for when the network is back.
  withEnv(t, { RNESS_GITHUB_WEB: 'http://127.0.0.1:1' })
  await writeAuth(login(NOW - HOUR))
  assert.equal(await resolveToken({ now: () => NOW }), null)
  assert.notEqual(await readAuth(), null)
  // Offline, inside the refresh margin: the token still works, so it is used.
  await writeAuth(login(NOW + 60_000))
  assert.equal((await resolveToken({ now: () => NOW }))?.token, 'ghu_old')
  // The token never reaches a log: the file is the only place it lives.
  assert.match(
    await readFile(join(dir, 'rness', 'auth.json'), 'utf8'),
    /ghu_old/
  )
})
