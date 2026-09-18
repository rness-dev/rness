import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LoginError,
  RefreshRejected,
  pollForToken,
  refreshTokenSet,
  requestDeviceCode,
} from '../../src/core/device-flow.ts'
import { type Reply, fakeGithub, withEnv } from '../helpers/fake-github.ts'

const DEVICE = {
  device_code: 'dev-123',
  user_code: '8F43-6B2A',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}
const TOKENS = {
  access_token: 'ghu_access',
  expires_in: 28800,
  refresh_token: 'ghr_refresh',
  refresh_token_expires_in: 15897600,
  scope: 'repo,read:org',
}

test('the device code is asked for with the client ID and the two scopes', async (t) => {
  withEnv(t, { RNESS_GITHUB_CLIENT_ID: 'client-test' })
  const gh = await fakeGithub(t, () => ({ json: DEVICE }))
  assert.deepEqual(await requestDeviceCode(), {
    deviceCode: 'dev-123',
    userCode: '8F43-6B2A',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5,
  })
  assert.equal(gh.requests[0]?.path, '/login/device/code')
  assert.deepEqual(gh.requests[0]?.form, {
    client_id: 'client-test',
    scope: 'repo read:org',
  })
  assert.equal(gh.requests[0]?.headers['accept'], 'application/json')
})

test('a disabled device flow and a missing client ID are said in one line', async (t) => {
  await fakeGithub(t, () => ({ json: { error: 'device_flow_disabled' } }))
  await assert.rejects(requestDeviceCode(), (e: unknown) => {
    assert.ok(e instanceof LoginError)
    assert.equal(
      e.message,
      'the device flow is not enabled on the rness GitHub app'
    )
    return true
  })
  withEnv(t, { RNESS_GITHUB_CLIENT_ID: '' })
  await assert.rejects(
    requestDeviceCode(),
    /rness has no GitHub client ID yet; set RNESS_GITHUB_CLIENT_ID/
  )
})

test('polling waits while pending, slows down when told to, and returns the tokens', async (t) => {
  const replies: Reply[] = [
    { json: { error: 'authorization_pending' } },
    { json: { error: 'slow_down', interval: 10 } },
    { json: { error: 'authorization_pending' } },
    { json: TOKENS },
  ]
  const gh = await fakeGithub(t, () => replies.shift() ?? { json: {} })
  const waits: number[] = []
  const tokens = await pollForToken(
    {
      deviceCode: 'dev-123',
      userCode: 'x',
      verificationUri: 'x',
      expiresIn: 900,
      interval: 5,
    },
    {
      sleep: async (ms) => {
        waits.push(ms)
      },
      now: () => 1_000_000,
    }
  )
  assert.deepEqual(waits, [5000, 5000, 15000, 15000])
  assert.deepEqual(tokens, {
    accessToken: 'ghu_access',
    expiresAt: 1_000_000 + 28800 * 1000,
    refreshToken: 'ghr_refresh',
    refreshExpiresAt: 1_000_000 + 15897600 * 1000,
    scopes: 'repo,read:org',
  })
  assert.equal(
    gh.requests[0]?.form['grant_type'],
    'urn:ietf:params:oauth:grant-type:device_code'
  )
  assert.equal(gh.requests[0]?.form['device_code'], 'dev-123')
})

test('an expired code and a refused login end the polling with one line', async (t) => {
  const code = {
    deviceCode: 'd',
    userCode: 'u',
    verificationUri: 'v',
    expiresIn: 900,
    interval: 1,
  }
  const sleep = async (): Promise<void> => undefined
  let error = 'expired_token'
  await fakeGithub(t, () => ({ json: { error } }))
  await assert.rejects(
    pollForToken(code, { sleep }),
    /the code expired before it was approved/
  )
  error = 'access_denied'
  await assert.rejects(
    pollForToken(code, { sleep }),
    /the login was cancelled on github\.com/
  )
})

test('a refresh needs no secret; a refused one is RefreshRejected, a dead network is not', async (t) => {
  withEnv(t, { RNESS_GITHUB_CLIENT_ID: 'client-test' })
  let reply: Reply = { json: TOKENS }
  const gh = await fakeGithub(t, () => reply)
  const tokens = await refreshTokenSet('ghr_old', () => 0)
  assert.equal(tokens.accessToken, 'ghu_access')
  assert.deepEqual(gh.requests[0]?.form, {
    client_id: 'client-test',
    grant_type: 'refresh_token',
    refresh_token: 'ghr_old',
  })

  reply = { json: { error: 'bad_refresh_token' } }
  await assert.rejects(refreshTokenSet('ghr_old'), RefreshRejected)

  withEnv(t, { RNESS_GITHUB_WEB: 'http://127.0.0.1:1' })
  await assert.rejects(refreshTokenSet('ghr_old'), (e: unknown) => {
    assert.ok(!(e instanceof RefreshRejected))
    assert.match((e as Error).message, /cannot reach github\.com/)
    return true
  })
})
