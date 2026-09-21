import assert from 'node:assert/strict'
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

test('a manifest without "org" validates with a warning on stderr, exit 0', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.equal(c.out().trim(), 'context ok')
  assert.match(
    c.err(),
    /warning: rness\.json: no "org"; using the directory name "ws-scoped"\n/
  )
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
