import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { syncBlocks } from '../../src/core/sync-blocks.ts'
import { plainUi } from '../../src/core/ui.ts'
import { capture } from '../helpers/capture.ts'

/** A workspace whose `.rness/` holds an installed `@rness/cli` that only says it ran. */
async function withPinnedCopy(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-sb-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(join(cli, 'dist', 'bin'), { recursive: true })
  await writeFile(
    join(cli, 'package.json'),
    JSON.stringify({ version: '0.0.1', bin: { rness: 'dist/bin/rness.js' } })
  )
  await writeFile(
    join(cli, 'dist', 'bin', 'rness.js'),
    "process.stdout.write('pinned copy ran\\n')\n"
  )
  return root
}

function withEnv(t: TestContext, key: string, value: string | undefined) {
  const original = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  t.after(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })
}

test('the installed copy syncs the blocks it will own', async (t) => {
  withEnv(t, 'RNESS_NO_DELEGATE', undefined)
  const root = await withPinnedCopy(t)
  let inPlace = 0
  const c = capture()
  const code = await syncBlocks({ ...plainUi }, root, 'ws', async () => {
    inPlace += 1
    return 0
  })
  c.restore()
  assert.equal(code, 0, c.err())
  assert.equal(inPlace, 0)
  assert.match(c.out(), /pinned copy ran/)
})

test('RNESS_NO_DELEGATE=1 (rness-dev) syncs in place, not through the installed copy', async (t) => {
  withEnv(t, 'RNESS_NO_DELEGATE', '1')
  const root = await withPinnedCopy(t)
  let inPlace = 0
  const c = capture()
  const code = await syncBlocks({ ...plainUi }, root, 'ws', async () => {
    inPlace += 1
    return 0
  })
  c.restore()
  assert.equal(code, 0, c.err())
  assert.equal(inPlace, 1)
  assert.doesNotMatch(c.out(), /pinned copy ran/)
})
