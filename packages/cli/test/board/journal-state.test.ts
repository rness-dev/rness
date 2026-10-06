import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  forgetNotes,
  forgetStart,
  issuesNoted,
  notePosted,
  notesPosted,
  recordStart,
  startOf,
} from '../../src/board/journal-state.ts'
import { commitDir, git } from '../helpers/git.ts'

async function repository(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-journal-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'a.md'), 'a\n')
  await commitDir(dir)
  return dir
}

test("a session's notes are counted under its id, the Bash tool's name and the hooks' alike; the issues they went to, each once; forgotten", async (t) => {
  const dir = await repository(t)
  const api = { id: 'I_1', reference: 'acme/api#87' }
  await notePosted(dir, 'claude · 1a2b3c4d', 'plans/0021-x.md', api)
  await notePosted(dir, 'claude · reviewer · 1a2b3c4d', 'plans/0021-x.md', api)
  await notePosted(dir, 'claude · 1a2b3c4d', 'plans/0022-y.md', {
    id: 'I_2',
    reference: 'acme/.rness#12',
  })
  assert.equal(
    await notesPosted(dir, 'claude · 1a2b3c4d', 'plans/0021-x.md'),
    2
  )
  assert.deepEqual(await issuesNoted(dir, 'claude · reviewer · 1a2b3c4d'), [
    api,
    { id: 'I_2', reference: 'acme/.rness#12' },
  ])
  assert.equal(
    await notesPosted(dir, 'claude · 9f9f9f9f', 'plans/0021-x.md'),
    0
  )
  await forgetNotes(dir, 'claude · 1a2b3c4d')
  assert.deepEqual(await issuesNoted(dir, 'claude · 1a2b3c4d'), [])
})

test("a session's start: its HEAD and time, the first kept, removed when forgotten; an id that is not one, none", async (t) => {
  const dir = await repository(t)
  const head = (await git(['rev-parse', 'HEAD'], dir)).trim()
  await recordStart(dir, 'claude · 1a2b3c4d', 1000)
  await recordStart(dir, 'claude · 1a2b3c4d', 2000)
  assert.deepEqual(await startOf(dir, 'claude · 1a2b3c4d'), { head, at: 1000 })
  await forgetStart(dir, 'claude · 1a2b3c4d')
  assert.equal(await startOf(dir, 'claude · 1a2b3c4d'), null)
  await recordStart(dir, 'claude · ../../x', 1000)
  assert.equal(await startOf(dir, 'claude · ../../x'), null)
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'rness-none-')))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await recordStart(outside, 'claude · 1a2b3c4d')
  assert.equal(await startOf(outside, 'claude · 1a2b3c4d'), null)
})
