import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import {
  PROVIDERS,
  openGitProvider,
  openProvider,
  unsupportedProviderMessage,
} from '../../src/core/providers.ts'
import type { Manifest } from '../../src/core/types.ts'
import { VERSION } from '../../src/version.ts'

const manifest = (provider: Manifest['provider']): Manifest => ({
  contract: 1,
  provider,
  org: 'acme',
  agents: null,
  projects: null,
  repos: {},
  scopes: {},
})

test('the registry lists the three providers, only GitHub available', () => {
  assert.deepEqual(
    Object.values(PROVIDERS).map((p) => [p.name, p.label, p.available]),
    [
      ['github', 'GitHub', true],
      ['gitlab', 'GitLab', false],
      ['atlassian', 'Atlassian — Bitbucket + Jira', false],
    ]
  )
  assert.equal(typeof PROVIDERS.github.open, 'function')
  assert.equal(PROVIDERS.gitlab.open, undefined)
  assert.equal(PROVIDERS.atlassian.open, undefined)
})

test('openProvider refuses a provider this copy does not support', async () => {
  const message = `rness.json: provider "gitlab" is not supported by @rness/cli ${VERSION} (supported: github)`
  assert.equal(unsupportedProviderMessage('gitlab'), message)
  await assert.rejects(openProvider(manifest('gitlab')), { message })
})

test('openProvider opens GitHub for a manifest without a key, or none', async () => {
  assert.ok((await openProvider(null)) instanceof GitHubOAuthProvider)
  assert.ok((await openProvider(manifest(null))) instanceof GitHubOAuthProvider)
  assert.ok(
    (await openProvider(manifest('github'), { apiBase: 'http://x' })) instanceof
      GitHubOAuthProvider
  )
})

test('a host detected from a repository URL still opens GitHub', async () => {
  const m = {
    ...manifest(null),
    repos: { api: { url: 'https://gitlab.com/acme/api.git' } },
  }
  assert.ok((await openProvider(m)) instanceof GitHubOAuthProvider)
  assert.ok((await openGitProvider(m)) instanceof GitHubOAuthProvider)
})

test('openGitProvider gives none for a written provider it lacks', async () => {
  assert.equal(await openGitProvider(manifest('gitlab')), null)
})
