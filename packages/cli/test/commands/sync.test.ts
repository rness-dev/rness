import assert from 'node:assert/strict'
import {
  access,
  lstat,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { type SyncOptions, syncCommand } from '../../src/commands/sync.ts'
import { BEGIN, END } from '../../src/core/block.ts'
import { readOrNull } from '../../src/core/fs.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import {
  INSTEAD_OF_LINES,
  sshWorkspaceLines,
} from '../../src/core/transport.ts'
import { capture } from '../helpers/capture.ts'
import { commitTo, makeBareRepo } from '../helpers/git.ts'
import { SSH_DENIED, SSH_OK, fakeTransport } from '../helpers/transport.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

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
  assert.match(
    r.out,
    /^updated {2}AGENTS\.md\nupdated {2}org\/web\/AGENTS\.md\nskipped {2}org\/api\/AGENTS\.md \(directory not present\)\n$/
  )
  const web = await readFile(join(root, 'org', 'web', 'AGENTS.md'), 'utf8')
  assert.match(web, /^<!-- BEGIN rness -->\n<!-- rness · scope: web ·/)
  assert.match(web, /<!-- rness: standards\/web\/seo\.md -->\n# SEO/)
  assert.match(web, /<!-- rness: standards\/coding\.md -->\n# Coding/)
  assert.match(web, /rness workspace `acme`/)
  assert.equal(
    await readFile(join(root, 'org', 'web', 'CLAUDE.md'), 'utf8'),
    '@AGENTS.md\n'
  )
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
  assert.match(
    again.out,
    /^unchanged AGENTS\.md\nunchanged org\/web\/AGENTS\.md\n/
  )
  const check = await sync(['--check', '--cwd', root])
  assert.equal(check.code, 0)
  await writeFile(
    join(root, '.rness', 'standards', 'web', 'seo.md'),
    '# SEO\n\nChanged.\n'
  )
  const stale = await sync(['--check', '--cwd', root])
  assert.equal(stale.code, 1)
  assert.match(stale.out, /stale {4}org\/web\/AGENTS\.md/)
  assert.match(stale.err, /1 block\(s\) out of date — run rness sync/)
  assert.doesNotMatch(
    await readFile(join(root, 'org', 'web', 'AGENTS.md'), 'utf8'),
    /Changed\./
  )
})

test('an existing AGENTS.md keeps its title and foreign blocks; a malformed one is refused', async (t) => {
  const root = await basic(t)
  const file = join(root, 'org', 'web', 'AGENTS.md')
  await writeFile(
    file,
    '# web\n\n<!-- BEGIN:nextjs-agent-rules -->\nkeep me\n<!-- END:nextjs-agent-rules -->\n'
  )
  const r = await sync(['--yes', '--scope', 'web', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  const text = await readFile(file, 'utf8')
  assert.match(text, /^# web\n\n<!-- BEGIN rness -->\n/)
  assert.match(
    text,
    /<!-- END rness -->\n\n<!-- BEGIN:nextjs-agent-rules -->\nkeep me\n<!-- END:nextjs-agent-rules -->\n$/
  )
  assert.equal(
    await readOrNull(join(root, 'AGENTS.md')),
    null,
    '--scope web leaves the root alone'
  )

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
  const bare = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' } },
  })
  const r = await sync(['--yes', '--cwd', bare])
  assert.equal(r.code, 0)
  assert.match(r.out, /^skipped {2}blocks \(no org\/ directory here\)\n$/)
})

test('a missing clone is reported, not cloned; --check agrees; no per-scope line under it', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url } },
    scopes: {
      api: { path: 'org/api' },
      'api-docs': { path: 'org/api/docs', extends: ['api'] },
    },
    files: { 'standards/coding.md': coding },
    dirs: ['org'],
  })
  const r = await sync(['--yes', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.out,
    'not cloned: api (rness add <name>, or rness sync --all)\nupdated  AGENTS.md\n'
  )
  await assert.rejects(access(join(root, 'org', 'api')))

  const check = await sync(['--check', '--cwd', root])
  assert.equal(check.code, 0, check.err)
  assert.equal(
    check.out,
    'not cloned: api (rness add <name>, or rness sync --all)\nunchanged AGENTS.md\n'
  )
  assert.doesNotMatch(check.out, /missing/)

  // With --all, the scope directory absent from a present clone keeps its line.
  const all = await sync(['--yes', '--all', '--cwd', root])
  assert.equal(all.code, 0, all.err)
  assert.equal(
    all.out,
    'cloned   org/api\nunchanged AGENTS.md\nupdated  org/api/AGENTS.md\nskipped  org/api/docs/AGENTS.md (directory not present)\n'
  )
})

test('--all clones missing repositories, pulls with --pull, skips dirty trees, and END stays last', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url } },
    scopes: { api: { path: 'org/api' } },
    files: { 'standards/coding.md': coding },
  })
  const first = await sync(['--yes', '--all', '--cwd', root])
  assert.equal(first.code, 0, first.err)
  assert.match(
    first.out,
    /^cloned {3}org\/api\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
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

// A symlinked pair is the common `CLAUDE.md → AGENTS.md` setup. Following it
// would make the link a regular file holding a duplicate of its target, so the
// whole directory is skipped and neither file is touched.
for (const [link, target] of [
  ['CLAUDE.md', 'AGENTS.md'],
  ['AGENTS.md', 'CLAUDE.md'],
] as const) {
  test(`${link} symlinked to ${target} is left alone, in --yes and in --check`, async (t) => {
    const root = await basic(t)
    const dir = join(root, 'org', 'web')
    const real = '# web\n\nHand-written.\n'
    await writeFile(join(dir, target), real)
    await symlink(target, join(dir, link))

    const r = await sync(['--yes', '--cwd', root])
    assert.equal(r.code, 0, r.err)
    assert.match(
      r.out,
      /^updated {2}AGENTS\.md\nskipped {2}org\/web\/AGENTS\.md \(symlink\)\n/
    )
    assert.equal(
      await readFile(join(dir, target), 'utf8'),
      real,
      `${target} untouched`
    )
    assert.equal(
      (await lstat(join(dir, link))).isSymbolicLink(),
      true,
      `${link} is still a symlink`
    )
    assert.equal(await readlink(join(dir, link)), target)
    assert.doesNotMatch(
      await readFile(join(dir, target), 'utf8'),
      /BEGIN rness/
    )

    const check = await sync(['--check', '--cwd', root])
    assert.equal(check.code, 0, check.err)
    assert.match(check.out, /skipped {2}org\/web\/AGENTS\.md \(symlink\)/)
    assert.equal((await lstat(join(dir, link))).isSymbolicLink(), true)
    assert.equal(await readFile(join(dir, target), 'utf8'), real)
  })
}

test('with --all, a clone failure is reported, the manifest is untouched, other work continues', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { ghost: { url: 'file:///no/such/ghost.git' } },
    scopes: {},
    files: { 'standards/coding.md': coding },
    dirs: ['org'],
  })
  const r = await sync(['--yes', '--all', '--cwd', root])
  assert.equal(r.code, 1)
  assert.match(r.err, /org\/ghost: git clone failed: /)
  assert.match(r.out, /updated {2}AGENTS\.md/)
})

// --- in a terminal, through the Terminal seam --------------------------------

const CANCEL = Symbol('cancel')

interface Asked {
  kind: 'picker' | 'confirm'
  message: string
  values?: string[]
  labels?: string[]
}

/** Scripted prompts: an unexpected question fails the test. */
function scripted(answers: { pick?: unknown; confirm?: unknown }) {
  const asked: Asked[] = []
  const prompts = {
    async autocompleteMultiselect(o: {
      message: string
      options: { value: string; label?: string }[]
    }) {
      asked.push({
        kind: 'picker',
        message: o.message,
        values: o.options.map((x) => x.value),
        labels: o.options.map((x) => x.label ?? x.value),
      })
      if (!('pick' in answers)) throw new Error('unexpected picker')
      return answers.pick
    },
    async confirm(o: { message: string }) {
      asked.push({ kind: 'confirm', message: o.message })
      if (!('confirm' in answers)) throw new Error('unexpected confirm')
      return answers.confirm
    },
    async text() {
      throw new Error('unexpected text prompt')
    },
    isCancel: (v: unknown) => v === CANCEL,
  } as unknown as Prompts
  const terminal: Terminal = { isTty: () => true, prompts: async () => prompts }
  return { asked, terminal }
}

async function syncIn(opts: SyncOptions, terminal: Terminal) {
  const c = capture()
  const code = await syncCommand(opts, terminal)
  c.restore()
  return { code, out: c.out(), err: c.err() }
}

async function catalogueWorkspace(t: Parameters<typeof makeWorkspace>[0]) {
  const api = await makeBareRepo(t, 'api')
  const docs = await makeBareRepo(t, 'docs')
  return makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url: api }, docs: { url: docs } },
    scopes: { api: { path: 'org/api' }, docs: { path: 'org/docs' } },
    files: { 'standards/coding.md': coding },
    dirs: ['org'],
  })
}

test('terminal: catalogue repositories not cloned are offered; picked ones are cloned, the rest named', async (t) => {
  const root = await catalogueWorkspace(t)
  const { asked, terminal } = scripted({ pick: ['api'] })
  const r = await syncIn({ cwd: root }, terminal)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(asked, [
    {
      kind: 'picker',
      message: 'Do you want to sync as well?',
      values: ['*', 'api', 'docs'],
      labels: ['Select all', 'api', 'docs'],
    },
  ])
  assert.equal(
    r.out,
    'cloned   org/api\nnot cloned: docs (rness add <name>, or rness sync --all)\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\n'
  )
  await assert.rejects(access(join(root, 'org', 'docs')))
})

test('terminal: "Select all" clones every catalogue repository that is missing', async (t) => {
  const root = await catalogueWorkspace(t)
  const { terminal } = scripted({ pick: ['*'] })
  const r = await syncIn({ cwd: root }, terminal)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^cloned {3}org\/api\ncloned {3}org\/docs\n/)
  assert.doesNotMatch(r.out, /not cloned/)
})

test('terminal: cancelling the picker writes nothing', async (t) => {
  const root = await catalogueWorkspace(t)
  const { terminal } = scripted({ pick: CANCEL })
  const r = await syncIn({ cwd: root }, terminal)
  assert.equal(r.code, 1)
  assert.equal(r.err, 'cancelled\n')
  assert.equal(r.out, '')
  assert.equal(await readOrNull(join(root, 'AGENTS.md')), null)
  await assert.rejects(access(join(root, 'org', 'api')))
})

test('terminal: nothing to offer asks for confirmation; a clone rness.json does not know is named', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' } },
    files: { 'standards/coding.md': coding },
    dirs: ['org/web', 'org/extra'],
  })
  const { asked, terminal } = scripted({ confirm: true })
  const r = await syncIn({ cwd: root }, terminal)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(
    asked.map((a) => a.kind),
    ['confirm']
  )
  assert.match(
    r.out,
    /^not in rness\.json: extra \(rness add <name> declares it\)\n/
  )
  assert.match(r.out, /updated {2}org\/web\/AGENTS\.md/)
})

test('terminal: --scope and --all skip the picker and only confirm', async (t) => {
  const root = await catalogueWorkspace(t)
  const scoped = scripted({ confirm: true })
  const r = await syncIn({ cwd: root, scope: 'api' }, scoped.terminal)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(
    scoped.asked.map((a) => a.kind),
    ['confirm']
  )
  assert.match(r.out, /not cloned: api, docs/)

  const all = scripted({ confirm: true })
  const r2 = await syncIn({ cwd: root, all: true }, all.terminal)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(
    all.asked.map((a) => a.kind),
    ['confirm']
  )
  assert.match(r2.out, /^cloned {3}org\/api\ncloned {3}org\/docs\n/)
})

// --- SSH first (spec 0005) ---------------------------------------------------

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

test('a git@ catalogue entry is not cloned without SSH access: sync stops before any clone or block', async (t) => {
  const denied = await fakeTransport(t, 'acme', SSH_DENIED)
  await denied.ssh.addRepo('api', { 'README.md': '# api\n' })
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url: `${denied.ssh.host}acme/api.git` } },
    scopes: { api: { path: 'org/api' } },
    dirs: ['org'],
  })
  const c = capture()
  const code = await syncCommand(
    { cwd: root, all: true, yes: true },
    NO_TTY,
    denied.transport
  )
  c.restore()
  assert.equal(code, 1)
  assert.equal(
    c.err(),
    `${[...sshWorkspaceLines(SSH_DENIED.ok ? '' : SSH_DENIED.reason), ...INSTEAD_OF_LINES].join('\n')}\n`
  )
  assert.equal(c.out(), '')
  assert.deepEqual(denied.calls, [{ interactive: false }])
  await assert.rejects(access(join(root, 'org', 'api')))
  await assert.rejects(access(join(root, 'AGENTS.md')))
})

test('with SSH access the git@ entry is cloned; the SSH test runs only when such a clone is due', async (t) => {
  const ok = await fakeTransport(t, 'acme', SSH_OK)
  await ok.ssh.addRepo('api', { 'README.md': '# api\n' })
  const webUrl = await ok.https.addRepo('web', { 'README.md': '# web\n' })
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: {
      api: { url: `${ok.ssh.host}acme/api.git` },
      web: { url: webUrl },
    },
    scopes: { api: { path: 'org/api' }, web: { path: 'org/web' } },
    dirs: ['org'],
  })
  const run = async (opts: SyncOptions) => {
    const c = capture()
    const code = await syncCommand(
      { cwd: root, yes: true, ...opts },
      NO_TTY,
      ok.transport
    )
    c.restore()
    return { code, out: c.out(), err: c.err() }
  }
  // Nothing is cloned without --all, and --check never clones.
  assert.equal((await run({})).code, 0)
  assert.equal((await run({ all: true, check: true })).code, 0)
  assert.deepEqual(ok.calls, [])

  const all = await run({ all: true })
  assert.equal(all.code, 0, all.err)
  assert.match(all.out, /^cloned {3}org\/api\ncloned {3}org\/web\n/)
  assert.deepEqual(ok.calls, [{ interactive: false }])

  // Everything is cloned now: no test.
  assert.equal((await run({ all: true })).code, 0)
  assert.equal(ok.calls.length, 1)
})

// --- a version written in one place (spec 0006 §1) ---------------------------

test('a block whose header still names an older CLI is current by its hash: upgrading rewrites nothing', async (t) => {
  const root = await basic(t)
  assert.equal((await sync(['--yes', '--cwd', root])).code, 0)
  const files = [join(root, 'AGENTS.md'), join(root, 'org', 'web', 'AGENTS.md')]
  // What 0.3.0 wrote: the same block, its header naming the version.
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    await writeFile(
      file,
      text.replace('<!-- rness · scope:', '<!-- rness 0.3.0 · scope:')
    )
  }
  const before = await Promise.all(files.map((f) => readFile(f, 'utf8')))
  assert.match(before[1] ?? '', /<!-- rness 0\.3\.0 · scope: web ·/)

  const check = await sync(['--check', '--cwd', root])
  assert.equal(check.code, 0, check.err)
  const again = await sync(['--yes', '--cwd', root])
  assert.equal(again.code, 0, again.err)
  assert.match(
    again.out,
    /^unchanged AGENTS\.md\nunchanged org\/web\/AGENTS\.md\n/
  )
  assert.deepEqual(
    await Promise.all(files.map((f) => readFile(f, 'utf8'))),
    before
  )

  // The content changes: the block is rewritten, with the current header.
  await writeFile(
    join(root, '.rness', 'standards', 'coding.md'),
    '# Coding\n\nNew rule.\n'
  )
  const changed = await sync(['--yes', '--cwd', root])
  assert.equal(changed.code, 0, changed.err)
  assert.match(
    changed.out,
    /^updated {2}AGENTS\.md\nupdated {2}org\/web\/AGENTS\.md\n/
  )
  assert.match(
    await readFile(files[1] ?? '', 'utf8'),
    /<!-- rness · scope: web · contract: 1 · hash: [0-9a-f]{12} ·/
  )
})
