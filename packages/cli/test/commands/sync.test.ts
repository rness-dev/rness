import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../src/cli.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'
import { commitTo, makeBareRepo } from '../helpers/git.ts'
import { readOrNull } from '../../src/core/fs.ts'
import { BEGIN, END } from '../../src/core/block.ts'

const seo = '# SEO\n\nEvery page sets a title.\n'
const coding = '# Coding\n\nTwo-space indent.\n'

function basic(t: Parameters<typeof makeWorkspace>[0]) {
  return makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' }, api: { path: 'org/api' } },
    files: { 'standards/web/seo.md': seo, 'standards/coding.md': coding },
    dirs: ['org/web'],
  })
}

async function sync(args: string[]) {
  const c = capture()
  const code = await run(['sync', ...args])
  c.restore()
  return { code, out: c.out(), err: c.err() }
}

test('writes the root and scope blocks and the CLAUDE.md pointers; skips scopes not present', async (t) => {
  const root = await basic(t)
  const r = await sync(['--yes', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^updated {2}AGENTS\.md\nupdated {2}org\/web\/AGENTS\.md\nskipped {2}org\/api\/AGENTS\.md \(directory not present\)\n$/)
  const web = await readFile(join(root, 'org', 'web', 'AGENTS.md'), 'utf8')
  assert.match(web, /^<!-- BEGIN rness -->\n<!-- rness \S+ · scope: web ·/)
  assert.match(web, /<!-- rness: standards\/web\/seo\.md -->\n# SEO/)
  assert.match(web, /<!-- rness: standards\/coding\.md -->\n# Coding/)
  assert.match(web, /rness workspace `acme`/)
  assert.equal(await readFile(join(root, 'org', 'web', 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  const rootBlock = await readFile(join(root, 'AGENTS.md'), 'utf8')
  assert.match(rootBlock, /· scope: global ·/)
  assert.doesNotMatch(rootBlock, /standards\/web\/seo\.md/)
  assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
})

test('a second run changes nothing; --check agrees; editing a standard makes --check fail', async (t) => {
  const root = await basic(t)
  await sync(['--yes', '--cwd', root])
  const again = await sync(['--yes', '--cwd', root])
  assert.equal(again.code, 0)
  assert.match(again.out, /^unchanged AGENTS\.md\nunchanged org\/web\/AGENTS\.md\n/)
  const check = await sync(['--check', '--cwd', root])
  assert.equal(check.code, 0)
  await writeFile(join(root, '.rness', 'standards', 'web', 'seo.md'), '# SEO\n\nChanged.\n')
  const stale = await sync(['--check', '--cwd', root])
  assert.equal(stale.code, 1)
  assert.match(stale.out, /stale {4}org\/web\/AGENTS\.md/)
  assert.match(stale.err, /1 block\(s\) out of date — run rness sync/)
  assert.doesNotMatch(await readFile(join(root, 'org', 'web', 'AGENTS.md'), 'utf8'), /Changed\./)
})

test('an existing AGENTS.md keeps its title and foreign blocks; a malformed one is refused', async (t) => {
  const root = await basic(t)
  const file = join(root, 'org', 'web', 'AGENTS.md')
  await writeFile(file, '# web\n\n<!-- BEGIN:nextjs-agent-rules -->\nkeep me\n<!-- END:nextjs-agent-rules -->\n')
  const r = await sync(['--yes', '--scope', 'web', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  const text = await readFile(file, 'utf8')
  assert.match(text, /^# web\n\n<!-- BEGIN rness -->\n/)
  assert.match(text, /<!-- END rness -->\n\n<!-- BEGIN:nextjs-agent-rules -->\nkeep me\n<!-- END:nextjs-agent-rules -->\n$/)
  assert.equal(await readOrNull(join(root, 'AGENTS.md')), null, '--scope web leaves the root alone')

  await writeFile(file, `${BEGIN}\nno end here\n`)
  const bad = await sync(['--yes', '--scope', 'web', '--cwd', root])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /org\/web\/AGENTS\.md: expected exactly one/)
  assert.equal(await readFile(file, 'utf8'), `${BEGIN}\nno end here\n`)
})

test('without a TTY and without --yes it refuses with exit 2; --check never prompts', async (t) => {
  const root = await basic(t)
  const refused = await sync(['--cwd', root])
  assert.equal(refused.code, 2)
  assert.match(refused.err, /pass --yes/)
  assert.equal(await readOrNull(join(root, 'AGENTS.md')), null)
  const check = await sync(['--check', '--cwd', root])
  assert.equal(check.code, 1)
  assert.match(check.out, /stale {4}AGENTS\.md/)
})

test('unknown --scope and a workspace without org/ are handled', async (t) => {
  const root = await basic(t)
  const unknown = await sync(['--yes', '--scope', 'ghost', '--cwd', root])
  assert.equal(unknown.code, 1)
  assert.match(unknown.err, /unknown scope: ghost/)
  const bare = await makeWorkspace(t, { org: 'acme', scopes: { web: { path: 'org/web' } } })
  const r = await sync(['--yes', '--cwd', bare])
  assert.equal(r.code, 0)
  assert.match(r.out, /^skipped {2}blocks \(no org\/ directory here\)\n$/)
})

test('clones missing repositories, pulls with --pull, skips dirty trees, and END stays last', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url } },
    scopes: { api: { path: 'org/api' } },
    files: { 'standards/coding.md': coding },
  })
  const first = await sync(['--yes', '--cwd', root])
  assert.equal(first.code, 0, first.err)
  assert.match(first.out, /^cloned {3}org\/api\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/)
  const agents = await readFile(join(root, 'org', 'api', 'AGENTS.md'), 'utf8')
  assert.equal(agents.trimEnd().endsWith(END), true)

  await commitTo(url, 'NEW.md', 'new\n')
  const pulled = await sync(['--yes', '--pull', '--cwd', root])
  assert.match(pulled.out, /^pulled {3}org\/api\n/)
  assert.equal(pulled.code, 0, pulled.err)
  assert.equal(await readOrNull(join(root, 'org', 'api', 'NEW.md')), 'new\n')

  await writeFile(join(root, 'org', 'api', 'dirty.txt'), 'x')
  const dirty = await sync(['--yes', '--pull', '--cwd', root])
  assert.equal(dirty.code, 0)
  assert.match(dirty.out, /^skipped {2}org\/api \(working tree not clean\)\n/)

  const check = await sync(['--check', '--cwd', root])
  assert.equal(check.code, 0, check.out)
})

test('--pull on a directory that is not a clone is a reported problem; other output survives', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { web: { url: 'file:///unused/web.git' } },
    scopes: { web: { path: 'org/web' }, api: { path: 'org/api' } },
    files: { 'standards/web/seo.md': seo, 'standards/coding.md': coding },
    dirs: ['org/web'],
  })
  await sync(['--yes', '--cwd', root])
  const r = await sync(['--yes', '--pull', '--cwd', root])
  assert.equal(r.code, 1)
  assert.match(r.err, /org\/web: git status failed: /)
  assert.match(r.out, /unchanged AGENTS\.md\nunchanged org\/web\/AGENTS\.md/)
})

test('a clone failure is reported, the manifest is untouched, other work continues', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { ghost: { url: 'file:///no/such/ghost.git' } },
    scopes: {},
    files: { 'standards/coding.md': coding },
    dirs: ['org'],
  })
  const r = await sync(['--yes', '--cwd', root])
  assert.equal(r.code, 1)
  assert.match(r.err, /org\/ghost: git clone failed: /)
  assert.match(r.out, /updated {2}AGENTS\.md/)
})
