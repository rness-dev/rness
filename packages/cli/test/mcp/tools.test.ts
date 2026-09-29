import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { mcpTools } from '../../src/mcp/tools.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const doc = (status: string, title: string, body = '') =>
  `---\ndate: 2026-09-29\nstatus: ${status}\n---\n\n# ${title}\n${body}`

async function fixture(t: TestContext) {
  return makeWorkspace(t, {
    org: 'acme',
    scopes: {
      platform: { path: 'org/platform' },
      web: { path: 'org/platform/apps/web', extends: ['platform'] },
      api: { path: 'org/api' },
    },
    files: {
      'standards/coding.md': '# Coding style\n\nTwo spaces.\n',
      'standards/web/seo.md': '# SEO\n\nEvery page sets a title.\n',
      'standards/api/errors.md': '# Errors\n',
      'adr/0000-template.md': doc('Proposed', 'Template'),
      // The scaffold's heading: the id, a dash, the title.
      'adr/0006-workspace.md': doc(
        'Accepted',
        '0006 — A workspace is a GitHub organisation',
        '\nNever squash an upgrade.\n'
      ),
      'adr/0009-landing.md': doc('Proposed', 'The landing shows the target'),
      'specs/web/0011-agents.md': doc(
        'Implemented',
        'Agent targets',
        '\nSquash is refused.\nSquash again.\n'
      ),
      'plans/platform/0019-agents.md': doc(
        'Completed',
        '0019 - Agent targets, the plan'
      ),
    },
    dirs: ['org/platform/apps/web', 'org/api'],
  })
}

async function call(
  cwd: string,
  tool: string,
  args: Record<string, unknown> = {}
) {
  const t = mcpTools(cwd).find((x) => x.name === tool)
  assert.ok(t, tool)
  return t.call(args)
}

test('the four tools, in a fixed order, each with a strict schema', () => {
  const tools = mcpTools('/')
  assert.deepEqual(
    tools.map((t) => t.name),
    ['rness_context', 'rness_list', 'rness_read', 'rness_search']
  )
  for (const t of tools)
    assert.equal(t.inputSchema['additionalProperties'], false)
})

test('rness_context: the scope of the directory, its chain, and what applies — no bodies, no template', async (t) => {
  const root = await fixture(t)
  const r = await call(
    join(root, 'org', 'platform', 'apps', 'web'),
    'rness_context'
  )
  assert.equal(r.isError, undefined)
  assert.match(
    r.text,
    /^Workspace acme · scope web \(org\/platform\/apps\/web, extends platform\)\n/
  )
  assert.match(r.text, /- SEO — standards\/web\/seo\.md/)
  assert.match(r.text, /- Coding style — standards\/coding\.md/)
  assert.doesNotMatch(r.text, /Errors/, 'another scope')
  assert.match(
    r.text,
    /- 0006 Accepted — A workspace is a GitHub organisation — adr\/0006-workspace\.md/
  )
  assert.match(
    r.text,
    /- 0011 Implemented — Agent targets — specs\/web\/0011-agents\.md/
  )
  assert.match(
    r.text,
    /- 0019 Completed — Agent targets, the plan — plans\/platform\/0019-agents\.md/
  )
  assert.doesNotMatch(r.text, /Template|Two spaces|squash/i)

  const global = await call(root, 'rness_context')
  assert.match(global.text, /^Workspace acme · global scope\n/)
  const named = await call(root, 'rness_context', { scope: 'api' })
  assert.match(named.text, /Errors/)
  const unknown = await call(root, 'rness_context', { scope: 'nope' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /unknown scope "nope"; known: api, platform, web/)
})

test('rness_list: a whole collection across scopes, filtered by status; bad input is refused', async (t) => {
  const root = await fixture(t)
  const all = await call(root, 'rness_list', { collection: 'adr' })
  assert.match(
    all.text,
    /- 0006 Accepted — A workspace is a GitHub organisation — global — adr\/0006-workspace\.md/
  )
  assert.match(all.text, /- 0009 Proposed/)
  assert.doesNotMatch(all.text, /0000/)
  const accepted = await call(root, 'rness_list', {
    collection: 'adr',
    status: 'Accepted',
  })
  assert.doesNotMatch(accepted.text, /0009/)
  const specs = await call(root, 'rness_list', { collection: 'specs' })
  assert.match(specs.text, /— web — specs\/web\/0011-agents\.md/)
  for (const args of [
    { collection: 'nope' },
    { collection: 'adr', status: 'Done' },
    { collection: 'standards', status: 'Accepted' },
  ]) {
    const r = await call(root, 'rness_list', args)
    assert.equal(r.isError, true, JSON.stringify(args))
  }
})

test('rness_read: a file of .rness, and nothing outside it', async (t) => {
  const root = await fixture(t)
  const r = await call(root, 'rness_read', { path: 'adr/0006-workspace.md' })
  assert.match(r.text, /Never squash an upgrade\./)
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'rness-out-')))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret.md'), 'secret\n')
  await symlink(join(outside, 'secret.md'), join(root, '.rness', 'link.md'))
  await writeFile(join(root, '.rness', 'big.md'), 'x'.repeat(256 * 1024 + 1))
  for (const path of [
    '/etc/hosts',
    '../AGENTS.md',
    'adr/../../AGENTS.md',
    '.git/config',
    'node_modules/x/package.json',
    'link.md',
    'adr',
    'big.md',
    'missing.md',
  ]) {
    const refused = await call(root, 'rness_read', { path })
    assert.equal(refused.isError, true, path)
  }
})

test('rness_search: case-insensitive, most matching first, lines numbered, capped', async (t) => {
  const root = await fixture(t)
  const r = await call(root, 'rness_search', { query: 'SQUASH' })
  assert.match(r.text, /^2 documents match "SQUASH"\n/)
  assert.ok(
    r.text.indexOf('specs/web/0011-agents.md') <
      r.text.indexOf('adr/0006-workspace.md'),
    'two matches before one'
  )
  assert.match(r.text, /\n {2}8: Squash is refused\.\n/)
  const onlyAdr = await call(root, 'rness_search', {
    query: 'squash',
    collection: 'adr',
  })
  assert.doesNotMatch(onlyAdr.text, /specs\//)
  const none = await call(root, 'rness_search', { query: 'zzz' })
  assert.match(none.text, /^No document matches "zzz"/)
  const empty = await call(root, 'rness_search', { query: '  ' })
  assert.equal(empty.isError, true)
})

test('rness_search keeps the 20 most matching documents', async (t) => {
  const files: Record<string, string> = {}
  for (let i = 1; i <= 25; i += 1)
    files[`specs/${String(i).padStart(4, '0')}-s.md`] = doc(
      'Draft',
      `Spec ${i}`,
      '\nneedle\n'.repeat(i)
    )
  const root = await makeWorkspace(t, { org: 'acme', files, dirs: ['org'] })
  const r = await call(root, 'rness_search', { query: 'needle' })
  assert.match(
    r.text,
    /^25 documents match "needle" \(the 20 most matching\)\n/
  )
  assert.match(r.text, /specs\/0025-s\.md/)
  assert.doesNotMatch(r.text, /specs\/0005-s\.md/)
})

test('outside a workspace every tool says where it looked', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-none-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const r = await mcpTools(dir)[0]?.call({})
  assert.ok(r)
  assert.equal(r.isError, true)
  assert.match(r.text, /no rness workspace/)
})
