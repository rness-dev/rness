import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { AtlassianProvider } from '../../src/core/atlassian-provider.ts'
import {
  type ResolvedToken,
  type StoredLogin,
  readAuthAt,
  writeAuthAt,
} from '../../src/core/auth.ts'
import { fakeBitbucket } from '../helpers/fake-bitbucket.ts'
import { type Recorded, type Reply, withEnv } from '../helpers/fake-github.ts'
import { fakeJira } from '../helpers/fake-jira.ts'

// The Atlassian adapter's Bitbucket reads (spec 0039 §4, §5; plan 0053
// task 3). Jira's boards and journal come with tasks 5 and 6.

const LOGIN: ResolvedToken = {
  token: 'tok',
  source: 'login',
  login: 'smarttdev',
}

const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname

/** Routes by path; anything else is a 404. */
function routes(table: Record<string, Reply>): (r: Recorded) => Reply {
  return (r) => table[pathOf(r)] ?? { status: 404, json: {} }
}

const repo = (
  slug: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  slug,
  is_private: true,
  project: { name: 'CLI' },
  ...extra,
})

test("a workspace's repositories: the slug as the name, the padlock, the project as the hint; .rness left out", async (t) => {
  await fakeBitbucket(
    t,
    routes({
      '/2.0/repositories/acme': {
        json: {
          values: [
            repo('web', { is_private: false, project: { name: 'Platform' } }),
            repo('.rness'),
            repo('api'),
            repo('tools', { project: null }),
          ],
        },
      },
    })
  )
  const provider = new AtlassianProvider({ token: LOGIN })
  assert.deepEqual(await provider.listRepositories('acme'), {
    repositories: [
      { name: 'api', private: true, archived: false, hint: 'CLI' },
      { name: 'tools', private: true, archived: false },
      { name: 'web', private: false, archived: false, hint: 'Platform' },
    ],
    owner: 'org',
    truncated: false,
  })
  await assert.rejects(provider.listRepositories('nobody'), {
    message:
      'Bitbucket has no workspace named "nobody" (or it is not visible to you); add repositories later with rness add <repo>',
  })
})

test('the organizations are the workspaces, named, approved, with nothing to grant; none anonymously', async (t) => {
  await fakeBitbucket(
    t,
    routes({
      '/2.0/user/workspaces': {
        json: {
          values: [
            { workspace: { slug: 'smartt' } },
            { workspace: { slug: 'acme' } },
          ],
        },
      },
      '/2.0/workspaces/acme': { json: { name: 'Acme' } },
    })
  )
  assert.deepEqual(
    await new AtlassianProvider({ token: LOGIN }).listOrganizations(),
    [
      { login: 'acme', approved: true, canGrant: null, hint: 'Acme' },
      { login: 'smartt', approved: true, canGrant: null },
    ]
  )
  assert.deepEqual(
    await new AtlassianProvider({ token: null }).listOrganizations(),
    []
  )
  assert.equal(new AtlassianProvider({ token: LOGIN }).approvalUrl(), null)
})

test("access and role: Bitbucket's permission; a stranger; unknown otherwise or anonymously", async (t) => {
  let reply: Reply = { json: { permission: 'owner' } }
  const bb = await fakeBitbucket(t, () => reply)
  const provider = new AtlassianProvider({ token: LOGIN })
  assert.equal(await provider.organizationAccess('acme'), 'member')
  assert.equal(await provider.organizationRole('acme'), 'owner')
  // One call answers both.
  assert.equal(bb.requests.length, 1)

  reply = { status: 403, json: {} }
  assert.equal(await provider.organizationAccess('other'), 'not-member')
  assert.equal(await provider.organizationRole('other'), null)

  reply = { status: 500, json: {} }
  assert.equal(await provider.organizationAccess('broken'), 'unknown')
  assert.equal(
    await new AtlassianProvider({ token: null }).organizationAccess('acme'),
    'unknown'
  )
})

test('.rness is created private in the workspace; refused anonymously', async (t) => {
  const bb = await fakeBitbucket(t, () => ({ status: 200, json: {} }))
  assert.deepEqual(
    await new AtlassianProvider({ token: LOGIN }).createRepository(
      'acme',
      '.rness'
    ),
    { kind: 'created' }
  )
  assert.equal(bb.requests[0]?.path, '/2.0/repositories/acme/.rness')
  assert.deepEqual(bb.requests[0]?.body, { scm: 'git', is_private: true })
  assert.deepEqual(
    await new AtlassianProvider({ token: null }).createRepository(
      'acme',
      '.rness'
    ),
    { kind: 'refused', reason: 'not logged in' }
  )
})

test("git over HTTPS: x-bitbucket-api-token-auth and the token for bitbucket.org's HTTPS URLs only", () => {
  const provider = new AtlassianProvider({ token: LOGIN })
  assert.deepEqual(
    provider.credentialsFor('https://bitbucket.org/acme/api.git'),
    { username: 'x-bitbucket-api-token-auth', password: 'tok' }
  )
  assert.equal(
    provider.credentialsFor('git@ssh.bitbucket.org:acme/api.git'),
    null
  )
  assert.equal(provider.credentialsFor('https://gitlab.com/acme/api.git'), null)
  assert.equal(
    new AtlassianProvider({ token: null }).credentialsFor(
      'https://bitbucket.org/acme/api.git'
    ),
    null
  )
})

test('the identity: the stored login, else asked; null anonymously; no scopes to read', async (t) => {
  const bb = await fakeBitbucket(
    t,
    routes({ '/2.0/user': { json: { username: 'ci-bot' } } })
  )
  assert.deepEqual(await new AtlassianProvider({ token: LOGIN }).identity(), {
    login: 'smarttdev',
  })
  assert.equal(bb.requests.length, 0)
  assert.deepEqual(
    await new AtlassianProvider({
      token: { token: 'env', source: 'BITBUCKET_TOKEN', login: null },
    }).identity(),
    { login: 'ci-bot' }
  )
  assert.equal(await new AtlassianProvider({ token: null }).identity(), null)
  assert.equal(await new AtlassianProvider({ token: LOGIN }).scopes(), null)
})

async function configDir(t: TestContext): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-atl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, { XDG_CONFIG_HOME: dir })
}

const STORED: StoredLogin = {
  login: 'smarttdev',
  tokens: {
    accessToken: 'tok',
    expiresAt: null,
    refreshToken: null,
    refreshExpiresAt: null,
    scopes: '',
  },
}

test('a stored token refused (401) is cleared and said once; a refused BITBUCKET_TOKEN clears nothing', async (t) => {
  await configDir(t)
  await fakeBitbucket(t, () => ({ status: 401, json: {} }))
  await writeAuthAt('bitbucket.org', STORED)
  const said: string[] = []
  const provider = new AtlassianProvider({
    token: LOGIN,
    notify: (l) => said.push(l),
  })
  await assert.rejects(provider.listRepositories('acme'), {
    message: 'Bitbucket refused this token (401)',
  })
  await assert.rejects(provider.listOrganizations(), {
    message: 'Bitbucket refused this token (401)',
  })
  assert.equal(await readAuthAt('bitbucket.org'), null)
  assert.deepEqual(said, [
    'your Bitbucket token was refused (expired or revoked); run rness login --provider atlassian',
  ])

  await writeAuthAt('bitbucket.org', STORED)
  const env = new AtlassianProvider({
    token: { token: 'env', source: 'BITBUCKET_TOKEN', login: null },
    notify: (l) => said.push(l),
  })
  await assert.rejects(env.listRepositories('acme'), {
    message: 'BITBUCKET_TOKEN was refused by Bitbucket (401)',
  })
  assert.deepEqual(await readAuthAt('bitbucket.org'), STORED)
})

test("a branch's pull request comes from Bitbucket, in the journal's words; no board is ever created: the space has its own", async (t) => {
  let state = 'OPEN'
  await fakeBitbucket(t, () => ({ json: { values: [{ id: 4, state }] } }))
  const provider = new AtlassianProvider({ token: LOGIN })
  for (const [given, said] of [
    ['OPEN', 'opened'],
    ['MERGED', 'merged'],
    ['DECLINED', 'closed'],
    ['SUPERSEDED', 'closed'],
  ]) {
    state = given ?? ''
    assert.deepEqual(await provider.pullRequestFor('acme', 'api', 'feat/x'), {
      number: 4,
      state: said,
    })
  }
  await assert.rejects(provider.createBoard('acme'), {
    message:
      "on Atlassian the board is the Jira space's own: rness never creates one",
  })
  assert.deepEqual(await provider.describe(), [])
  assert.deepEqual(await provider.postUpdates(), [])
})

test("the journal and the space checks need the workspace's jira: refused without it", async () => {
  const provider = new AtlassianProvider({ token: LOGIN })
  const refused = {
    message: 'this workspace has no Jira space: add "jira" to rness.json',
  }
  await assert.rejects(provider.checkIssues('acme'), refused)
  await assert.rejects(
    provider.journalIssue('acme', 'api', 'plans/x.md'),
    refused
  )
})

// The tracker: Jira's spaces for the wizard (spec 0039 §4; plan 0053 task 4).
const JIRA_STORED: StoredLogin = {
  login: 'Cédric Magne',
  email: 'me@acme.io',
  accountId: 'acc-1',
  tokens: {
    accessToken: 'jira-tok',
    expiresAt: null,
    refreshToken: null,
    refreshExpiresAt: null,
    scopes: '',
  },
}

test("the tracker: the sites the login holds, a site's spaces, a free key, a new space led by the user", async (t) => {
  await configDir(t)
  withEnv(t, { JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined })
  await writeAuthAt('bitbucket.org', STORED, [
    'acme.atlassian.net',
    JIRA_STORED,
  ])
  const jira = await fakeJira(
    t,
    routes({
      '/rest/api/3/project/search': {
        json: { values: [{ key: 'OPS', name: 'Operations' }], isLast: true },
      },
      '/rest/api/3/projectvalidate/key': {
        json: { errorMessages: [], errors: {} },
      },
      '/rest/api/3/myself': {
        json: { displayName: 'Cédric Magne', accountId: 'acc-1' },
      },
      '/rest/api/3/project': { status: 201, json: { key: 'RNESS' } },
    })
  )
  const tracker = new AtlassianProvider({ token: LOGIN }).tracker
  assert.equal(tracker.label, 'Jira')
  assert.equal(tracker.keyPattern.test('RNESS'), true)
  assert.equal(tracker.keyPattern.test('rness'), false)
  assert.deepEqual(tracker.manualSteps('acme.atlassian.net', 'RNESS'), [
    '# create a team-managed Kanban space with the key RNESS on acme.atlassian.net',
    '# (Jira > Spaces > Create space > Kanban > Team-managed), then: rness board push',
  ])
  assert.deepEqual(await tracker.sites(), ['acme.atlassian.net'])
  assert.deepEqual(await tracker.spaces('acme.atlassian.net'), [
    { key: 'OPS', name: 'Operations' },
  ])
  assert.equal(await tracker.keyFree('acme.atlassian.net', 'RNESS'), true)
  assert.deepEqual(await tracker.createSpace('acme.atlassian.net', 'RNESS'), {
    kind: 'created',
  })
  const created = jira.requests.find((r) => r.method === 'POST')
  assert.equal(
    (created?.body as { leadAccountId?: string } | undefined)?.leadAccountId,
    'acc-1'
  )
  assert.equal(
    created?.headers['authorization'],
    `Basic ${Buffer.from('me@acme.io:jira-tok').toString('base64')}`
  )
})

test('the tracker without a Jira login says how to get one; a refused stored token is cleared and said once', async (t) => {
  await configDir(t)
  withEnv(t, { JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined })
  const said: string[] = []
  const tracker = new AtlassianProvider({
    token: LOGIN,
    notify: (l) => said.push(l),
  }).tracker
  assert.deepEqual(await tracker.sites(), [])
  await assert.rejects(tracker.spaces('acme.atlassian.net'), {
    message:
      'no Jira login for acme.atlassian.net: run rness login --provider atlassian',
  })

  await writeAuthAt('acme.atlassian.net', JIRA_STORED)
  await fakeJira(t, () => ({ status: 401, json: {} }))
  await assert.rejects(tracker.spaces('acme.atlassian.net'), {
    message: 'acme.atlassian.net refused this email and token (401)',
  })
  await assert.rejects(tracker.keyFree('acme.atlassian.net', 'RNESS'))
  assert.equal(await readAuthAt('acme.atlassian.net'), null)
  assert.deepEqual(said, [
    'your Jira token was refused (expired or revoked); run rness login --provider atlassian',
  ])
})

test("the journal in the workspace's space: found, made, linked, commented; the space checked before a board writes", async (t) => {
  await configDir(t)
  withEnv(t, { JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined })
  await writeAuthAt('acme.atlassian.net', JIRA_STORED)
  let canEdit = true
  const jira = await fakeJira(t, (r) => {
    const path = pathOf(r)
    if (path === '/rest/api/3/project/RNESS')
      return { json: { id: '10002', key: 'RNESS' } }
    if (path === '/rest/api/3/mypermissions')
      return {
        json: {
          permissions: {
            CREATE_ISSUES: { havePermission: true },
            EDIT_ISSUES: { havePermission: canEdit },
            TRANSITION_ISSUES: { havePermission: true },
          },
        },
      }
    if (path === '/rest/api/3/search/jql')
      return { json: { issues: [], isLast: true } }
    if (path === '/rest/api/3/issue/createmeta/RNESS/issuetypes')
      return { json: { issueTypes: [{ id: '10012', hierarchyLevel: 0 }] } }
    if (r.method === 'POST' && path === '/rest/api/3/issue')
      return { status: 201, json: { key: 'RNESS-14' } }
    if (path === '/rest/api/3/issue/RNESS-3')
      return {
        json: {
          key: 'RNESS-3',
          fields: { status: { statusCategory: { key: 'new' } } },
        },
      }
    if (r.method === 'POST') return { status: 201, json: {} }
    return { status: 404, json: {} }
  })
  const provider = new AtlassianProvider({
    token: LOGIN,
    jira: { site: 'acme.atlassian.net', space: 'RNESS' },
  })
  await provider.checkIssues('acme')
  assert.equal(
    await provider.journalIssue('acme', 'api', 'plans/0053-x.md'),
    null
  )
  assert.deepEqual(
    await provider.createJournalIssue('acme', 'api', 'plans/0053-x.md', {
      title: 'Implement',
      body: 'Plan',
    }),
    { id: 'RNESS-14', number: 14, repository: 'RNESS', reference: 'RNESS-14' }
  )
  assert.deepEqual(await provider.issueOf('acme', '.rness', 3), {
    id: 'RNESS-3',
    number: 3,
    open: true,
  })
  await provider.addSubIssue('RNESS-3', 'RNESS-14')
  await provider.comment('RNESS-14', 'A note')
  assert.ok(
    jira.requests.some(
      (r) => r.method === 'POST' && pathOf(r) === '/rest/api/3/issueLink'
    )
  )
  assert.ok(
    jira.requests.some(
      (r) =>
        r.method === 'POST' &&
        pathOf(r) === '/rest/api/3/issue/RNESS-14/comment'
    )
  )
  canEdit = false
  await assert.rejects(provider.checkIssues('acme'), {
    message: 'the boards need EDIT_ISSUES in RNESS on acme.atlassian.net',
  })
})
