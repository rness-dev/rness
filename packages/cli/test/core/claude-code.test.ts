import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { configDir } from '../../src/core/auth.ts'
import {
  MOD_FLOOR,
  belowModFloor,
  claudeCodeVersion,
  takeModNotice,
} from '../../src/core/claude-code.ts'

// The config directory is the one test/setup.ts gives this process, empty
// at start; each test that records starts from no file.
const file = (): string => join(configDir(), 'claude-code.json')
const fresh = (): Promise<void> => rm(file(), { force: true })

const agent = (version: string, entrypoint?: string): NodeJS.ProcessEnv => ({
  AI_AGENT: `claude-code_${version.replaceAll('.', '-')}_harness`,
  ...(entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint }),
})

const line = (version: string): string =>
  `rness: Claude Code ${version} shows no rness band, status line or pane; 2.1.280 or later does — claude update`

test('the version is read from AI_AGENT; anything else is no version', () => {
  assert.equal(
    claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-240_harness' }),
    '2.1.240'
  )
  assert.equal(claudeCodeVersion({ AI_AGENT: 'claude-code_x_harness' }), null)
  assert.equal(claudeCodeVersion({ AI_AGENT: 'codex_1-2-3_harness' }), null)
  assert.equal(claudeCodeVersion({ AI_AGENT: '' }), null)
  assert.equal(claudeCodeVersion({}), null)
})

test('the floor is 2.1.280, compared on the three numbers', () => {
  assert.equal(MOD_FLOOR, '2.1.280')
  assert.equal(belowModFloor('2.1.279'), true)
  assert.equal(belowModFloor('2.1.240'), true)
  assert.equal(belowModFloor('2.0.999'), true)
  assert.equal(belowModFloor('1.9.999'), true)
  assert.equal(belowModFloor('2.1.280'), false)
  assert.equal(belowModFloor('2.1.289'), false)
  assert.equal(belowModFloor('2.2.0'), false)
  assert.equal(belowModFloor('3.0.0'), false)
})

test('the line once per version: then nothing on the same one, again on another old one', async () => {
  await fresh()
  assert.equal(await takeModNotice(agent('2.1.240')), line('2.1.240'))
  assert.equal(await takeModNotice(agent('2.1.240')), null)
  assert.equal(await takeModNotice(agent('2.1.250')), line('2.1.250'))
  assert.equal(await takeModNotice(agent('2.1.250')), null)
  assert.equal(await takeModNotice(agent('2.1.240')), null)
})

test('nothing at or above the floor, nor without a version', async () => {
  await fresh()
  assert.equal(await takeModNotice(agent('2.1.280')), null)
  assert.equal(await takeModNotice(agent('2.2.0')), null)
  assert.equal(await takeModNotice({}), null)
  await assert.rejects(readFile(file()), { code: 'ENOENT' })
})

test('a session nobody watches (sdk-…) neither shows the line nor records it', async () => {
  await fresh()
  assert.equal(await takeModNotice(agent('2.1.240', 'sdk-cli')), null)
  assert.equal(await takeModNotice(agent('2.1.240', 'sdk-ts')), null)
  await assert.rejects(readFile(file()), { code: 'ENOENT' })
  assert.equal(await takeModNotice(agent('2.1.240', 'cli')), line('2.1.240'))
})

test('a claude-code.json that is not JSON: the line, then the file rewritten', async () => {
  await mkdir(configDir(), { recursive: true })
  await writeFile(file(), '{ oops')
  assert.equal(await takeModNotice(agent('2.1.240')), line('2.1.240'))
  assert.deepEqual(JSON.parse(await readFile(file(), 'utf8')), {
    modNoticeShown: ['2.1.240'],
  })
  assert.equal(await takeModNotice(agent('2.1.240')), null)
})

test('a claude-code.json that cannot be written: the line all the same, no throw', async (t) => {
  await fresh()
  await mkdir(file(), { recursive: true })
  t.after(() => rm(file(), { recursive: true, force: true }))
  assert.equal(await takeModNotice(agent('2.1.240')), line('2.1.240'))
  assert.equal(await takeModNotice(agent('2.1.240')), line('2.1.240'))
})
