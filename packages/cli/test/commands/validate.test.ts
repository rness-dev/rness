import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { run } from '../../src/cli.ts'
import { validateCommand } from '../../src/commands/validate.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// eslint forbids a control character in a literal regex, so the escape is
// built from its code point.
const ESC = String.fromCharCode(27)

const brokenCwd = fileURLToPath(
  new URL('../fixtures/ws-broken', import.meta.url)
)
const scopedCwd = fileURLToPath(
  new URL('../fixtures/ws-scoped', import.meta.url)
)
const cycleCwd = fileURLToPath(new URL('../fixtures/ws-cycle', import.meta.url))

test('returns 1 on a broken tree and lists every problem', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', brokenCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /specs\/bad\.md/)
  assert.match(c.err(), /plans\/invalid-yaml\.md/)
})

test('returns 0 and prints "context ok" on a valid tree', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.equal(c.out().trim(), 'context ok')
})

test('reports an extends cycle instead of passing', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', cycleCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /cycle/)
})

test('rejects an unknown flag with bad-usage exit 2', async () => {
  const c = capture()
  const code = await run(['validate', '--bogus'])
  c.restore()
  assert.equal(code, 2)
})

test('rejects --cwd with no value with bad-usage exit 2', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd'])
  c.restore()
  assert.equal(code, 2)
})

test('a manifest without "org" validates without a warning, exit 0', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.equal(c.out().trim(), 'context ok')
  // No "org" is a blank workspace (spec 0012), not a slip to warn about.
  assert.doesNotMatch(c.err(), /"org"/)
})

test('validate reports a stale block as a problem and a missing one as a warning', async (t) => {
  const { makeWorkspace } = await import('../helpers/workspace.ts')
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' } },
    files: { 'standards/web/seo.md': '# SEO\n' },
    dirs: ['org/web'],
  })
  let c = capture()
  let code = await run(['validate', '--cwd', root])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.err(), /warning: AGENTS\.md: no rness block yet/)
  assert.match(c.err(), /warning: org\/web\/AGENTS\.md: no rness block yet/)

  c = capture()
  assert.equal(await run(['sync', '--yes', '--cwd', root]), 0)
  c.restore()
  await writeFile(
    join(root, '.rness', 'standards', 'web', 'seo.md'),
    '# SEO\n\nChanged.\n'
  )
  c = capture()
  code = await run(['validate', '--cwd', root])
  c.restore()
  assert.equal(code, 1)
  assert.match(
    c.err(),
    /^org\/web\/AGENTS\.md: stale rness block \(run rness sync\)\n/
  )
})

/**
 * A terminal whose prompts carry the session API, so `makeUi` renders the
 * session look instead of falling back to the plain one.
 */
function sessionTerminal() {
  const said: string[] = []
  const prompts = {
    intro: (t: string) => said.push(`intro ${t}`),
    outro: (t: string) => said.push(`outro ${t}`),
    cancel: () => undefined,
    note: () => undefined,
    spinner: () => ({
      start: () => undefined,
      stop: () => undefined,
      message: () => undefined,
    }),
    log: {
      step: (t: string) => said.push(`step ${t}`),
      info: (t: string) => said.push(`info ${t}`),
      warn: (t: string) => said.push(`warn ${t}`),
      error: (t: string) => said.push(`error ${t}`),
      message: (t: string) => said.push(`message ${t}`),
    },
  }
  return {
    said,
    terminal: {
      isTty: () => true,
      prompts: () => Promise.resolve(prompts as never),
    },
  }
}

test('in a terminal, validate reports one line per target, the conforming ones grey', async (t) => {
  // makeUi also needs a real stdout and no CI, which the test runner has not.
  const stdout = process.stdout as { isTTY?: boolean }
  const wasTty = stdout.isTTY
  const wasCi = process.env['CI']
  stdout.isTTY = true
  delete process.env['CI']
  t.after(() => {
    if (wasTty === undefined) delete stdout.isTTY
    else stdout.isTTY = wasTty
    if (wasCi !== undefined) process.env['CI'] = wasCi
  })

  // A workspace whose blocks were actually written: the fixtures carry none,
  // and a conforming target is what this test is about.
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' } },
    files: { 'standards/coding.md': '# Coding\n' },
    dirs: ['org/web'],
  })
  const synced = capture()
  await run(['sync', '--yes', '--cwd', root])
  synced.restore()

  const { said, terminal } = sessionTerminal()
  const c = capture()
  const code = await validateCommand({ cwd: root }, { terminal })
  c.restore()
  assert.equal(code, 0)
  // One line per target, as `sync` reports one per file it walked.
  assert.deepEqual(
    said
      .filter((l) => l.startsWith('message'))
      .map((l) =>
        l
          .split(ESC)
          .join('')
          .replace(/\[\d+m/g, '')
      ),
    ['message AGENTS.md current', 'message org/web/AGENTS.md current']
  )
  assert.ok(
    said.some((l) => l.startsWith('outro') && l.includes('Context OK')),
    `the verdict closes the session: ${JSON.stringify(said)}`
  )
  // A conforming block is grey, never green: green means something was
  // written (spec 0007 §4).
  assert.equal(
    said.filter((l) => l.startsWith('step')).length,
    0,
    'nothing is reported as a change'
  )
  assert.equal(c.out(), '', 'the session look writes through clack, not stdout')
})

test('in a terminal, a broken tree ends on the failing verdict and exit 1', async (t) => {
  const stdout = process.stdout as { isTTY?: boolean }
  const wasTty = stdout.isTTY
  const wasCi = process.env['CI']
  stdout.isTTY = true
  delete process.env['CI']
  t.after(() => {
    if (wasTty === undefined) delete stdout.isTTY
    else stdout.isTTY = wasTty
    if (wasCi !== undefined) process.env['CI'] = wasCi
  })

  const { said, terminal } = sessionTerminal()
  const c = capture()
  const code = await validateCommand({ cwd: brokenCwd }, { terminal })
  c.restore()
  assert.equal(code, 1)
  assert.ok(
    said.some((l) => l.startsWith('error') && l.includes('specs/bad.md')),
    `every problem is named: ${JSON.stringify(said)}`
  )
  assert.ok(
    said.some((l) => l.startsWith('outro') && l.includes('Context mismatch')),
    `the verdict says it failed: ${JSON.stringify(said)}`
  )
})

test('off a terminal the bytes do not change, whatever the reporter could do', async () => {
  const c = capture()
  const code = await validateCommand({ cwd: scopedCwd })
  c.restore()
  assert.equal(code, 0)
  assert.equal(c.out(), 'context ok\n')
  assert.ok(!c.out().includes('blocks current'), 'no session wording')
})

// --- agents (spec 0011 §3) ---------------------------------------------------

test('validate refuses an agent this version cannot compile, and a missing guaranteed value', async (t) => {
  const spec = {
    org: 'acme',
    repos: { api: { url: 'https://github.com/acme/api.git' } },
    scopes: { api: { path: 'org/api' } },
    dirs: ['org/api'],
  }
  const codex = await makeWorkspace(t, { ...spec, agents: ['codex'] })
  const c1 = capture()
  const unsupported = await run(['validate', '--cwd', codex])
  c1.restore()
  assert.equal(unsupported, 1)
  assert.match(
    c1.err(),
    /rness\.json: agent "codex" is not supported by @rness\/cli \S+ \(supported: claude\)\n/
  )

  const claude = await makeWorkspace(t, { ...spec, agents: ['claude'] })
  const c2 = capture()
  const missing = await run(['validate', '--cwd', claude])
  c2.restore()
  assert.equal(missing, 1)
  assert.match(
    c2.err(),
    /^org\/api\/\.claude\/settings\.json: permissions\.additionalDirectories lacks \.\.\/\.\.\/\.rness; hooks\.SessionStart lacks the rness session-start hook; hooks\.PostToolUse lacks the rness post-tool-use hook; hooks\.SessionEnd lacks the rness session-end hook \(run rness sync\)$/m
  )
  assert.match(
    c2.err(),
    /^org\/api\/\.mcp\.json: mcpServers\.rness is missing \(run rness sync\)$/m
  )

  const c3 = capture()
  assert.equal(await run(['sync', '--yes', '--cwd', claude]), 0)
  const ok = await run(['validate', '--cwd', claude])
  c3.restore()
  assert.equal(ok, 0, c3.err())
  assert.match(c3.out(), /context ok\n$/)
})

// --- the scaffold (spec 0013 §4) ---------------------------------------------

test('validate warns when the scaffold merged in .rness is not the pinned version', async (t) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const git = (dir: string, ...args: string[]) =>
    promisify(execFile)('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t.invalid',
      },
    })
  const at = async (pin: string, message: string) => {
    const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
    const rness = join(root, '.rness')
    await writeFile(
      join(rness, 'package.json'),
      JSON.stringify({ devDependencies: { '@rness/cli': pin } })
    )
    await git(rness, 'init', '-q', '-b', 'main')
    await git(rness, 'add', '-A')
    await git(rness, 'commit', '-q', '-m', message)
    return root
  }
  const validate = async (root: string) => {
    const c = capture()
    const code = await run(['validate', '--cwd', root])
    c.restore()
    return { code, err: c.err() }
  }
  const create = (v: string) =>
    `chore: rness workspace context\n\nRness-Scaffold: ${v}`

  const current = await validate(await at('0.8.0', create('0.8.0')))
  assert.equal(current.code, 0)
  assert.doesNotMatch(current.err, /scaffold/)

  const behind = await validate(await at('0.9.0', create('0.8.0')))
  assert.equal(behind.code, 0, 'a warning, never a problem')
  assert.match(
    behind.err,
    /warning: the @rness\/cli 0\.9\.0 scaffold is not merged here: run rness upgrade\n/
  )

  for (const message of ['chore: rness workspace context', 'chore: baseline']) {
    const untracked = await validate(await at('0.9.0', message))
    assert.match(
      untracked.err,
      /warning: the scaffold is not tracked in \.rness yet: run rness upgrade\n/,
      message
    )
  }

  // The commit that records a scaffold merge runs validate (the scaffold's
  // pre-commit hook) before it exists: the merge in progress counts.
  const merging = await at('0.9.0', create('0.8.0'))
  const repo = join(merging, '.rness')
  await git(repo, 'checkout', '-q', '-b', 'scaffold')
  const scaffold = ['commit', '-q', '--allow-empty', '-m']
  await git(repo, ...scaffold, 'chore: rness scaffold 0.9.0')
  await git(repo, 'checkout', '-q', 'main')
  await git(repo, 'merge', '-q', '--no-commit', '--no-ff', 'scaffold')
  const during = await validate(merging)
  assert.equal(during.code, 0)
  assert.doesNotMatch(during.err, /scaffold/)

  // A one-commit CI checkout has no history to read: nothing is said.
  const origin = await at('0.9.0', create('0.8.0'))
  await git(
    join(origin, '.rness'),
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'more'
  )
  const shallow = join(origin, 'shallow')
  await git(
    origin,
    'clone',
    '-q',
    '--depth',
    '1',
    `file://${join(origin, '.rness')}`,
    join(shallow, '.rness')
  )
  await git(origin, 'init', '-q', join(shallow, 'org'))
  const ci = await validate(shallow)
  assert.doesNotMatch(ci.err, /scaffold/)
})

test('a standalone checkout of .rness with claude declared validates: the root hooks need an org/', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-standalone-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = join(dir, 'ctx')
  await mkdir(ctx)
  await writeFile(
    join(ctx, 'rness.json'),
    JSON.stringify({ contract: 1, agents: ['claude'], repos: {}, scopes: {} })
  )
  const c = capture()
  const code = await run(['validate', '--cwd', ctx])
  c.restore()
  assert.equal(code, 0, c.err())
  assert.equal(c.out(), 'context ok\n')
})

test('reports a provider this copy does not support', async (t) => {
  const cwd = await makeWorkspace(t, { provider: 'gitlab' })
  const c = capture()
  const code = await run(['validate', '--cwd', cwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(
    c.err(),
    /rness\.json: provider "gitlab" is not supported by @rness\/cli \S+ \(supported: github\)/
  )
})

test('a host detected from a repository URL is not a problem', async (t) => {
  const cwd = await makeWorkspace(t, {
    repos: { api: { url: 'https://gitlab.com/acme/api.git' } },
  })
  const c = capture()
  const code = await run(['validate', '--cwd', cwd])
  c.restore()
  assert.equal(code, 0, c.err())
})

test('two documents with one number: exit 1, both named', async (t) => {
  const doc = (title: string) =>
    `---\ndate: 2026-10-02\nstatus: Draft\nrepo: x\n---\n\n# ${title}\n`
  const root = await makeWorkspace(t, {
    files: {
      'specs/0029-a.md': doc('0029 — A'),
      'specs/0029-b.md': doc('0029 — B'),
    },
  })
  const c = capture()
  try {
    const code = await validateCommand({ cwd: root })
    assert.equal(code, 1)
    assert.equal(
      c.err(),
      'specs/0029-a.md: the number 0029 is also that of specs/0029-b.md\n' +
        'specs/0029-b.md: the number 0029 is also that of specs/0029-a.md\n'
    )
  } finally {
    c.restore()
  }
})

test('a plan without a number: exit 1, named with the next number', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'plans/dapp/2026-10-02-copy-fix.md':
        '---\ndate: 2026-10-02\nstatus: Completed\nrepo: dapp\n---\n\n# Copy fix\n',
    },
  })
  const c = capture()
  try {
    const code = await validateCommand({ cwd: root })
    assert.equal(code, 1)
    assert.equal(
      c.err(),
      'plans/dapp/2026-10-02-copy-fix.md: not numbered; name it 0001-<slug>.md, the next number of plans\n'
    )
  } finally {
    c.restore()
  }
})
