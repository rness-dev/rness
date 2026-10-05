import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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
        },
        {
          id: '0001',
          title: 'First',
          status: 'Completed',
          path: 'plans/0001-a.md',
        },
      ],
    },
  ],
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

/** What the engine answers beneath the plugins in a session; `status` collects the status line. */
function engine(on: On, status: (string | undefined)[] = []) {
  on('session.start', async () => ({ cwd: '/w' }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.status', async (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  // The engine's own drawing: an empty Box where no plugin draws.
  on('ui.render', async () => ({
    type: 'Box' as const,
    props: {},
    children: [],
  }))
}

const start = { cwd: '/w', surface: 'terminal', isInteractive: true } as never

test('the band shows the banner from the start of the session to the first prompt', async ($, on) => {
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
    const band = await $.ui.mount({
      plugin: 'rness',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never,
    })
    expect((await band.find({ key: 'banner' }))?.text).toBe(SNAPSHOT.banner)
  }
  await $.prompt.submit({
    text: 'hello',
    origin: { kind: 'composer' },
  } as never)
  const after = await $.ui.mount({
    plugin: 'rness',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never,
  })
  expect(await after.find({ key: 'banner' })).toBeUndefined()
})

test('a note brings the band back after the first prompt, with its lines', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  cli(on, {
    ...SNAPSHOT,
    notes: ['rness: 1 problem in the workspace context — run rness validate'],
    statusLine: 'global · 1 in progress · ⚠ 1',
  })
  await $.session.start(start)
  await clock.advance(0)
  await $.prompt.submit({
    text: 'hello',
    origin: { kind: 'composer' },
  } as never)
  const band = await $.ui.mount({
    plugin: 'rness',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never,
  })
  expect((await band.find({ key: 'banner' }))?.text).toBe(SNAPSHOT.banner)
  expect((await band.find({ key: 'note-0' }))?.text).toBe(
    'rness: 1 problem in the workspace context — run rness validate'
  )
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
  expect(await band.find({ key: 'banner' })).toBeUndefined()
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
    expect((await pane.find({ key: 'row-0002' }))?.text).toMatch(/Second/)
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
