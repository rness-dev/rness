import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { type TestContext, test } from 'node:test'

import { run } from '../../src/cli.ts'
import { statusCommand } from '../../src/commands/status.ts'
import { VERSION } from '../../src/version.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const doc = (status: string, title: string) =>
  `---\nstatus: ${status}\n---\n\n# ${title}\n`

async function workspace(t: TestContext) {
  return makeWorkspace(t, {
    org: 'acme',
    files: {
      'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
      'specs/0002-b.md': doc('Approved', '0002 — Second'),
      'specs/0001-a.md': doc('Implemented', '0001 — First'),
    },
  })
}

test('off a terminal: Markdown, every tab or the one named', async (t) => {
  const root = await workspace(t)
  const c = capture()
  const code = await run(['status', '--cwd', root])
  c.restore()
  assert.equal(code, 0, c.err())
  assert.match(c.out(), /^acme · status\n\n## ADR \(1\)\n/)
  assert.match(c.out(), /\n\| 0002 \| Second \| Approved \|\n/)
  assert.match(c.out(), /\n## Plans \(0\)\n\n_Nothing yet\._\n$/)

  const one = capture()
  assert.equal(await run(['status', 'SPECS', '--cwd', root]), 0)
  one.restore()
  assert.match(one.out(), /^acme · status\n\n## Specs \(2\)\n/)
  assert.doesNotMatch(one.out(), /ADR/)
})

test('an unknown tab is a usage error naming the tabs', async (t) => {
  const root = await workspace(t)
  const c = capture()
  const code = await run(['status', 'kanban', '--cwd', root])
  c.restore()
  assert.equal(code, 2)
  assert.equal(c.err(), 'unknown tab "kanban" (tabs: adr, specs, plans)\n')
})

/** A terminal the view can take: keys in, screens out, its raw mode recorded. */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    raw: [] as boolean[],
    setRawMode(on: boolean) {
      input.raw.push(on)
      return input
    },
  })
  let written = ''
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 60,
    rows: 10,
    write(chunk: string) {
      written += chunk
      return true
    },
  })
  return {
    terminal: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    input,
    output,
    written: () => written,
  }
}

/** Wait for `cond`, the view's reads and redraws being asynchronous. */
async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 2000
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Plain text: the active tab between brackets instead of reverse video. */
function noColor(t: TestContext): void {
  process.env['NO_COLOR'] = '1'
  t.after(() => {
    delete process.env['NO_COLOR']
  })
}

const screens = (out: string) => out.split('\x1b[H').length - 1

test('in a terminal: the alternate screen, a tab per arrow, a redraw on resize, q restores the screen', async (t) => {
  noColor(t)
  const root = await workspace(t)
  const fake = fakeTerminal()
  const done = statusCommand(undefined, { cwd: root }, fake.terminal)
  // Once drawn: one tab right, a resize, then close.
  await until(() => screens(fake.written()) === 1)
  fake.input.write('\x1b[C')
  await until(() => screens(fake.written()) === 2)
  fake.output.columns = 40
  fake.output.emit('resize')
  fake.input.write('q')
  assert.equal(await done, 0)

  const out = fake.written()
  assert.ok(
    out.startsWith('\x1b[?1049h\x1b[?25l'),
    'enters the alternate screen'
  )
  assert.ok(out.endsWith('\x1b[?25h\x1b[?1049l'), 'leaves it last')
  const drawn = out.split('\x1b[H').slice(1)
  assert.equal(
    drawn.length,
    3,
    'drawn, then after the arrow, then after the resize'
  )
  assert.match(drawn[0] ?? '', /\[ADR \(1\)\]/)
  assert.match(drawn[1] ?? '', /\[Specs \(2\)\]/)
  assert.match(drawn[1] ?? '', /0002 {2}Second/)
  assert.deepEqual(fake.input.raw, [true, false])
})

test('in a terminal, a tab named opens the view on it', async (t) => {
  noColor(t)
  const root = await workspace(t)
  const fake = fakeTerminal()
  const done = statusCommand('plans', { cwd: root }, fake.terminal)
  await until(() => screens(fake.written()) === 1)
  fake.input.write('\x03') // Ctrl+C closes too
  assert.equal(await done, 0)
  assert.match(fake.written(), /\[Plans \(0\)\]/)
  assert.match(fake.written(), /Nothing here yet\./)
})

// --- --json: what the Claude Code mod draws (spec 0029 §3.2) ---------------

async function snapshot(args: string[]) {
  const c = capture()
  const code = await run(['status', '--json', ...args])
  c.restore()
  return { code, json: code === 0 ? JSON.parse(c.out()) : null, err: c.err() }
}

async function scoped(t: TestContext, files: Record<string, string> = {}) {
  return makeWorkspace(t, {
    org: 'acme',
    repos: { web: { url: 'https://github.com/acme/web.git' } },
    scopes: { web: { path: 'org/web' } },
    files: {
      'standards/style.md': '# Style\n',
      'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
      'plans/0002-b.md': doc('In progress', '0002 — Second'),
      'plans/0001-a.md': doc('Completed', '0001 — First'),
      ...files,
    },
    dirs: ['org/web'],
  })
}

test('--json at the workspace root: the banner, the status line, the tabs', async (t) => {
  const root = await scoped(t)
  const { code, json, err } = await snapshot(['--cwd', root])
  assert.equal(code, 0, err)
  assert.equal(json.version, VERSION)
  assert.equal(json.workspace, 'acme')
  assert.equal(json.scope, null)
  assert.equal(
    json.banner,
    `rness ${VERSION} · acme · global scope — 1 standard, 1 decision, 2 plans`
  )
  assert.deepEqual(json.inProgress, ['plans/0002-b.md'])
  assert.deepEqual(json.notes, [])
  assert.equal(json.statusLine, 'global · 1 in progress')
  assert.deepEqual(
    json.tabs.map((tab: { name: string }) => tab.name),
    ['adr', 'specs', 'plans']
  )
  assert.deepEqual(json.tabs[2].rows[0], {
    id: '0002',
    title: 'Second',
    status: 'In progress',
    path: 'plans/0002-b.md',
    color: 'yellow',
    link: null,
  })
  assert.equal(json.pulse, null)
})

test('--json: each row in Agent Pulse’s colour; with a pulse, the board and each row’s item on it', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    projects: { pulse: 4, marketing: 7 },
    files: {
      'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
      'specs/0003-c.md': doc('Reviewing', '0003 — Third'),
      'specs/0002-b.md': '# 0002 — No front matter\n',
      'plans/0002-b.md': doc('In progress', '0002 — Second'),
      'plans/0001-a.md': doc('Draft', '0001 — First'),
    },
  })
  const { code, json, err } = await snapshot(['--cwd', root])
  assert.equal(code, 0, err)
  assert.equal(json.pulse, 'https://github.com/orgs/acme/projects/4')
  const colors = Object.fromEntries(
    json.tabs.flatMap((tab: { rows: { path: string; color: string }[] }) =>
      tab.rows.map((row) => [row.path, row.color])
    )
  )
  assert.deepEqual(colors, {
    'adr/0001-org.md': 'green',
    'specs/0003-c.md': 'yellow',
    'specs/0002-b.md': 'red',
    'plans/0002-b.md': 'yellow',
    'plans/0001-a.md': 'gray',
  })
  assert.equal(
    json.tabs[2].rows[0].link,
    'https://github.com/orgs/acme/projects/4?filterQuery=path%3A%22plans%2F0002-b.md%22'
  )
})

test('--json without an organization: no pulse, no item, even with a project declared', async (t) => {
  const root = await makeWorkspace(t, {
    projects: { pulse: 4 },
    files: { 'plans/0001-a.md': doc('Draft', '0001 — First') },
  })
  const { json } = await snapshot(['--cwd', root])
  assert.equal(json.pulse, null)
  assert.equal(json.tabs[2].rows[0].link, null)
})

test('--json in a clone: the scope of the directory', async (t) => {
  const root = await scoped(t)
  const { json } = await snapshot(['--cwd', join(root, 'org', 'web')])
  assert.equal(json.scope, 'web')
  assert.match(json.banner, / · acme · scope web — /)
  assert.equal(json.statusLine, 'web · 1 in progress')
})

test('--json: the notes of the safety net, counted on the status line', async (t) => {
  const root = await scoped(t, { 'specs/0001-a.md': doc('Done', '0001 — A') })
  await writeFile(
    join(root, '.rness', 'package.json'),
    JSON.stringify({ devDependencies: { '@rness/cli': '9.9.9' } })
  )
  const { json } = await snapshot(['--cwd', root])
  assert.deepEqual(json.notes, [
    'rness: .rness pins @rness/cli 9.9.9 but nothing is installed — run npm install in .rness',
    'rness: 1 problem in the workspace context — run rness validate',
    'rness:   specs/0001-a.md: unknown status "Done" (expected Draft, Proposed, Approved, Implemented, Superseded, Rejected)',
  ])
  assert.equal(json.statusLine, 'global · 1 in progress · ⚠ 2')
})

test('--json with a tab: that tab only; an unknown one is a usage error', async (t) => {
  const root = await scoped(t)
  const { json } = await snapshot(['plans', '--cwd', root])
  assert.deepEqual(
    json.tabs.map((tab: { name: string }) => tab.name),
    ['plans']
  )
  const bad = await snapshot(['kanban', '--cwd', root])
  assert.equal(bad.code, 2)
})

test(
  '--json in a terminal: JSON, never the view',
  { timeout: 3000 },
  async (t) => {
    const root = await scoped(t)
    const fake = fakeTerminal()
    const code = await statusCommand(
      undefined,
      { cwd: root, json: true },
      fake.terminal
    )
    assert.equal(code, 0)
    assert.ok(!fake.written().includes('\x1b[?1049h'), 'no alternate screen')
    assert.equal(JSON.parse(fake.written()).workspace, 'acme')
  }
)
