import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { RnessSnapshot } from '../types'

// The rness mod (spec 0029 §3), its tests run by `claude plugin test`. The
// pinned CLI is stubbed beneath the plugin: `fs.exists` finds it, and
// `process.run` answers what `rness status --json` would print.

const SURFACES = ['terminal', 'desktop'] as const

const SNAPSHOT: RnessSnapshot = {
  version: '0.19.0',
  workspace: 'acme',
  scope: null,
  banner: 'rness 0.19.0 · acme · global scope — 1 standard, 2 plans',
  statusLine: 'global · 1 in progress',
  inProgress: ['plans/0002-b.md'],
  notes: [],
  pulse: 'https://github.com/orgs/acme/projects/4',
  tabs: [
    { name: 'adr', label: 'ADR', rows: [] },
    {
      name: 'plans',
      label: 'Plans',
      rows: [
        {
          id: '0002',
          title: 'Second',
          status: 'In progress',
          path: 'plans/0002-b.md',
          color: 'yellow',
          link: 'https://github.com/orgs/acme/projects/4?filterQuery=path%3A%22plans%2F0002-b.md%22',
        },
        {
          id: '0001',
          title: 'First',
          status: 'Completed',
          path: 'plans/0001-a.md',
          color: 'green',
          link: 'https://github.com/orgs/acme/projects/4?filterQuery=path%3A%22plans%2F0001-a.md%22',
        },
      ],
    },
  ],
}

/** The one document of `.rness/` the tests open, as the file holds it. */
const DOC = `---
date: 2026-10-05
status: In progress
---

# 0002 — Second

A paragraph.

\`\`\`sh
rness status
\`\`\`
`

/** What the mod reads from `.rness/`: `path` holds `text`; any other path is missing. */
function files(on: On, text: string | null, path = '/.rness/plans/0002-b.md') {
  const reads: string[] = []
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    if (text === null || !e.path.endsWith(path))
      throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  return reads
}

/** The pinned CLI as the module finds it; `runs` counts the status calls, `looked` the paths tried. */
function cli(on: On, snapshot: RnessSnapshot | null, looked: string[] = []) {
  const runs: (readonly string[])[] = []
  on('fs.exists', async (_$, e) => {
    looked.push(e.path)
    return {
      value:
        snapshot !== null &&
        e.path.endsWith('/.rness/node_modules/@rness/cli/dist/bin/rness.js'),
    }
  })
  on('process.run', async (_$, e) => {
    runs.push(e.argv)
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify(snapshot)}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return runs
}

/** The panes the module opened (their arguments) and closed (their ids). */
interface Panes {
  opened: unknown[]
  closed: string[]
}

/** What the engine answers beneath the plugins in a session; `status` collects the status line, `panes` the opens and closes. */
function engine(
  on: On,
  status: (string | undefined)[] = [],
  panes: Panes = { opened: [], closed: [] }
) {
  on('session.start', async () => ({ cwd: '/w' }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.status', async (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async (_$, e) => {
    panes.opened.push(e)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async (_$, e) => {
    panes.closed.push(e.id)
    return { value: undefined }
  })
  // The ring moves where the chain leaves it.
  on('ui.focus', async () => ({}))
  // The engine's own drawing: an empty Box where no plugin draws.
  on('ui.render', async () => ({
    type: 'Box' as const,
    props: {},
    children: [],
  }))
}

const start = { cwd: '/w', surface: 'terminal', isInteractive: true } as never

const BAND = {
  plugin: 'rness',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never,
} as const

const NOTE = 'rness: 1 problem in the workspace context — run rness validate'

test('no note: no band, before and after the first prompt — the session-start line says the banner', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const runs = cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  expect(runs.length).toBe(1)
  expect(runs[0]?.slice(1)).toEqual(
    expect.arrayContaining(['status', '--json'])
  )
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
  }
  await $.prompt.submit({
    text: 'hello',
    origin: { kind: 'composer' },
  } as never)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.findAll({ type: 'Text' })).toHaveLength(0)
})

test('a note: the band with its line and no banner, before and after the first prompt', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, {
    ...SNAPSHOT,
    notes: [NOTE],
    statusLine: 'global · 1 in progress · ⚠ 1',
  })
  await $.session.start(start)
  await clock.advance(0)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ key: 'note-0' }))?.text).toBe(NOTE)
    expect(await band.find({ text: SNAPSHOT.banner })).toBeUndefined()
  }
  await $.prompt.submit({
    text: 'hello',
    origin: { kind: 'composer' },
  } as never)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await after.find({ key: 'note-0' }))?.text).toBe(NOTE)
  expect(await after.findAll({ type: 'Text' })).toHaveLength(1)
})

test('no pinned CLI: no band', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const runs = cli(on, null)
  await $.session.start(start)
  await clock.advance(0)
  expect(runs.length).toBe(0)
  const band = await $.ui.mount({
    plugin: 'rness',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never,
  })
  expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
})

test('the status line carries the snapshot’s', async ($, on) => {
  const clock = mock.clock(on)
  const lines: (string | undefined)[] = []
  engine(on, lines)
  cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  expect(lines).toContain(SNAPSHOT.statusLine)
})

test('an Edit under .rness refreshes the snapshot; an Edit elsewhere does not', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const runs = cli(on, SNAPSHOT)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.session.start(start)
  await clock.advance(0)
  const edit = (file_path: string) =>
    $.tool.call({
      tool: 'Edit',
      file_path,
      old_string: 'a',
      new_string: 'b',
    } as never)
  await edit('/w/org/web/src/index.ts')
  await clock.advance(0)
  expect(runs.length).toBe(1)
  await edit('/w/.rness/plans/0002-b.md')
  await clock.advance(0)
  expect(runs.length).toBe(2)
})

test('/rness:status opens the pane on the tab named, without the skill', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  let skill = false
  on('command.run', async () => {
    skill = true
    return { text: 'the skill' }
  })
  await $.session.start(start)
  await clock.advance(0)
  const ran = await $.command.run({
    command: 'rness:status',
    args: 'plans',
  } as never)
  expect(skill).toBe(false)
  expect(ran.text).toBeDefined()
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({
      plugin: 'rness',
      surface,
      component: 'Pane',
      requestId: 'rness',
      props: {} as never,
    })
    expect((await pane.find({ key: 'open-0002' }))?.props['label']).toMatch(
      /Second/
    )
    await pane.press({ key: 'tab-adr' })
    expect((await pane.find({ key: 'empty' }))?.text).toMatch(/Nothing/)
    // The tab is the session's, whatever draws it: back to Plans for the next surface.
    await pane.press({ key: 'tab-plans' })
  }
})

test('/rness:status with no pinned CLI falls through to the skill', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, null)
  on('command.run', async () => ({ text: 'the skill' }))
  await $.session.start(start)
  await clock.advance(0)
  const ran = await $.command.run({
    command: 'rness:status',
    args: '',
  } as never)
  expect(ran.text).toBe('the skill')
})

test('one path to the pinned CLI, the one sync wrote: a missing copy is never looked for elsewhere', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const looked: string[] = []
  cli(on, null, looked)
  await $.session.start(start)
  await clock.advance(0)
  expect(looked.length).toBe(1)
  expect(looked[0]).toMatch(
    /\/\.rness\/node_modules\/@rness\/cli\/dist\/bin\/rness\.js$/
  )
})

test('/rness:status in a session nobody watches (claude -p): the skill answers with its tables', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  on('command.run', async () => ({ text: 'the skill' }))
  await $.session.start({
    cwd: '/w',
    surface: null,
    isInteractive: false,
  } as never)
  await clock.advance(0)
  const ran = await $.command.run({
    command: 'rness:status',
    args: '',
  } as never)
  expect(ran.text).toBe('the skill')
})

const PANE = {
  plugin: 'rness',
  component: 'Pane',
  requestId: 'rness',
  props: {} as never,
} as const

test('/rness:status takes the keyboard: the pane opens focused, for Esc to close (closeOnEscape)', async ($, on) => {
  const clock = mock.clock(on)
  const panes: Panes = { opened: [], closed: [] }
  engine(on, [], panes)
  cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: '' } as never)
  expect(panes.opened).toEqual([
    expect.objectContaining({ id: 'rness', focus: true, closeOnEscape: true }),
  ])
})

/** The ring moved onto the button keyed `element`: Tab, or ↑/↓ where the body has nothing to scroll. */
const ring = ($: Engine, element: string) =>
  $.ui.focus({
    component: 'Pane',
    requestId: 'rness',
    plugin: 'rness',
    element,
    origin: { kind: 'person' },
  })

test('a digit shows its tab: each tab’s button is on its number, written in its label; the ring starts on the newest row', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ key: 'tab-adr' }))?.props).toMatchObject({
      hotkey: '1',
      label: '1 ADR (0)',
    })
    expect((await pane.find({ key: 'tab-plans' }))?.props).toMatchObject({
      hotkey: '2',
      label: '2 Plans (2)',
    })
    for (const key of ['tab-adr', 'tab-plans', 'open-0001'])
      expect((await pane.find({ key }))?.props['autoFocus']).toBeUndefined()
    expect((await pane.find({ key: 'open-0002' }))?.props).toMatchObject({
      plain: true,
      autoFocus: true,
      label: '0002 Second',
    })
    // An empty tab: the ring starts on its button.
    await pane.press({ key: 'tab-adr' })
    expect((await pane.find({ key: 'empty' }))?.text).toMatch(/Nothing/)
    expect((await pane.find({ key: 'tab-adr' }))?.props['autoFocus']).toBe(true)
    await pane.press({ key: 'tab-plans' })
  }
})

test('the ring moving alone never changes the tab: ↓ on a short tab moves the highlight, not the rows', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ring($, 'tab-adr')
  expect((await pane.find({ key: 'open-0002' }))?.props['label']).toMatch(
    /Second/
  )
})

test('every row is drawn: the engine scrolls them, ↑/↓ as in the full-screen view', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const rows = Array.from({ length: 60 }, (_, i) => {
    const id = String(i + 1).padStart(4, '0')
    return {
      id,
      title: `Plan ${id}`,
      status: 'Draft',
      path: `plans/${id}.md`,
      color: 'gray',
      link: null,
    }
  })
  cli(on, {
    ...SNAPSHOT,
    tabs: [{ name: 'plans', label: 'Plans', rows }],
  })
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: '' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ key: 'open-0060' }))?.props['label']).toMatch(
    /Plan 0060/
  )
})

test('q closes the pane: a plain Close button on q', async ($, on) => {
  const clock = mock.clock(on)
  const panes: Panes = { opened: [], closed: [] }
  engine(on, [], panes)
  cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: '' } as never)
  const drawn = await Promise.all(
    SURFACES.map((surface) => $.ui.mount({ ...PANE, surface }))
  )
  for (const pane of drawn)
    expect((await pane.find({ key: 'close' }))?.props).toMatchObject({
      hotkey: 'q',
      plain: true,
      role: 'dismiss',
    })
  await drawn[0]?.press({ key: 'close' })
  expect(panes.closed).toEqual(['rness'])
})

test('each row’s status in Agent Pulse’s colour, as the CLI names it', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const row = await pane.find({ key: 'row-0002' })
    expect(row?.children).toContainEqual(
      expect.objectContaining({
        type: 'Text',
        props: expect.objectContaining({ color: 'yellow' }),
      })
    )
    const done = await pane.find({ key: 'row-0001' })
    expect(done?.children).toContainEqual(
      expect.objectContaining({
        type: 'Text',
        props: expect.objectContaining({ color: 'green' }),
      })
    )
  }
})

test('Enter on a row opens its document: read from .rness/, drawn without its front matter, Agent Pulse a link; q brings the list back', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  const reads = files(on, DOC)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'open-0002' })
    expect(reads.at(-1)).toMatch(/\/\.rness\/plans\/0002-b\.md$/)
    const drawn = await pane.findAll({ type: 'Markdown' })
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.props['text']).toBe(
      '# 0002 — Second\n\nA paragraph.\n\n```sh\nrness status\n```\n'
    )
    expect((await pane.find({ key: 'head' }))?.text).toMatch(
      /0002 Second.*In progress/s
    )
    expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({
      href: SNAPSHOT.tabs[1]?.rows[0]?.link,
      label: 'Agent Pulse',
    })
    expect((await pane.find({ key: 'back' }))?.props).toMatchObject({
      hotkey: 'q',
      plain: true,
      autoFocus: true,
    })
    expect(await pane.find({ key: 'open-0002' })).toBeUndefined()
    await pane.press({ key: 'back' })
    expect((await pane.find({ key: 'open-0002' }))?.props['label']).toBe(
      '0002 Second'
    )
    expect(await pane.findAll({ type: 'Markdown' })).toHaveLength(0)
  }
})

test('the list links to the board', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  files(on, DOC)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({
    href: SNAPSHOT.pulse,
    label: 'Agent Pulse',
  })
})

test('no pulse declared: no link in the list nor on a document', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, {
    ...SNAPSHOT,
    pulse: null,
    tabs: SNAPSHOT.tabs.map((t) => ({
      ...t,
      rows: t.rows.map((r) => ({ ...r, link: null })),
    })),
  })
  files(on, DOC)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.findAll({ type: 'Link' })).toHaveLength(0)
  await pane.press({ key: 'open-0002' })
  expect(await pane.findAll({ type: 'Link' })).toHaveLength(0)
  expect(await pane.findAll({ type: 'Markdown' })).toHaveLength(1)
})

test('a document that cannot be read says so, and q still brings the list back', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  files(on, null)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'open-0001' })
  expect((await pane.find({ key: 'unread' }))?.text).toMatch(
    /plans\/0001-a\.md cannot be read/
  )
  expect(await pane.findAll({ type: 'Markdown' })).toHaveLength(0)
  await pane.press({ key: 'back' })
  expect(await pane.find({ key: 'open-0001' })).toBeDefined()
})

test('a long document is drawn in pieces a Markdown can take, cut at blank lines, never inside a code fence', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  // 60 paragraphs of 400 characters, then a fenced block of 30 lines of 100.
  const paragraphs = Array.from(
    { length: 60 },
    (_, i) => `${String(i).padStart(3, '0')} ${'x'.repeat(396)}`
  )
  const fence = `\`\`\`\n${Array.from({ length: 30 }, () => 'y'.repeat(100)).join('\n\n')}\n\`\`\``
  files(on, [...paragraphs, fence, 'The end.'].join('\n\n'))
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'open-0002' })
  const drawn = await pane.findAll({ type: 'Markdown' })
  const texts = drawn.map((m) => String(m.props['text']))
  expect(texts.length).toBeGreaterThan(2)
  for (const text of texts) expect(text.length).toBeLessThanOrEqual(10000)
  // Every paragraph whole, in order; the fence in one piece.
  expect(texts.join('\n\n')).toBe(
    [...paragraphs, fence, 'The end.'].join('\n\n')
  )
  expect(texts.filter((t) => t.includes('```'))).toHaveLength(1)
})

test('/rness:status typed while a document shows brings the list back', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  files(on, DOC)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'open-0002' })
  expect(await pane.findAll({ type: 'Markdown' })).toHaveLength(1)
  await $.command.run({ command: 'rness:status', args: '' } as never)
  expect(await pane.find({ key: 'open-0002' })).toBeDefined()
})

test('a refresh reads the open document again: an edit of it shows', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, SNAPSHOT)
  let text = DOC
  on('fs.read', async () => ({ value: text }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.session.start(start)
  await clock.advance(0)
  await $.command.run({ command: 'rness:status', args: 'plans' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'open-0002' })
  text = `${DOC}\nA line added.\n`
  await $.tool.call({
    tool: 'Edit',
    file_path: '/w/.rness/plans/0002-b.md',
    old_string: 'a',
    new_string: 'b',
  } as never)
  await clock.advance(0)
  const drawn = await pane.findAll({ type: 'Markdown' })
  expect(drawn[0]?.props['text']).toMatch(/A line added\.\n$/)
})
