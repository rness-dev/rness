import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AtlassianProvider } from '../../src/core/atlassian-provider.ts'
import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import { GitLabOAuthProvider } from '../../src/core/gitlab-oauth-provider.ts'
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
  boards: null,
  repos: {},
  scopes: {},
})

test('the registry lists the three providers, each available', () => {
  assert.deepEqual(
    Object.values(PROVIDERS).map((p) => [p.name, p.label, p.available]),
    [
      ['github', 'GitHub', true],
      ['gitlab', 'GitLab', true],
      ['atlassian', 'Atlassian (Bitbucket + Jira)', true],
    ]
  )
  for (const p of Object.values(PROVIDERS))
    assert.equal(typeof p.open, 'function', p.name)
})

test('the refusal of a provider this copy lacks names the ones it has', () => {
  assert.equal(
    unsupportedProviderMessage('atlassian'),
    `rness.json: provider "atlassian" is not supported by @rness/cli ${VERSION} (supported: github, gitlab, atlassian)`
  )
})

test('openProvider opens Atlassian for an Atlassian workspace (plan 0053 task 4)', async () => {
  assert.ok(
    (await openProvider(manifest('atlassian'))) instanceof AtlassianProvider
  )
  assert.ok(
    (await openGitProvider(manifest('atlassian'))) instanceof AtlassianProvider
  )
})

test('openProvider opens GitLab for a GitLab workspace', async () => {
  assert.ok(
    (await openProvider(manifest('gitlab'))) instanceof GitLabOAuthProvider
  )
  assert.ok(
    (await openGitProvider(manifest('gitlab'))) instanceof GitLabOAuthProvider
  )
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
