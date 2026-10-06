import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { readOpened, writeOpened } from '../../src/board/opened.ts'

async function dir(t: TestContext) {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'rness-opened-')))
  t.after(() => rm(d, { recursive: true, force: true }))
  return d
}

test('the record: missing, corrupt, or not a map of numbers to paths — none recorded, never a throw; a bad entry skipped', async (t) => {
  const d = await dir(t)
  const file = join(d, 'opened')
  assert.deepEqual([...(await readOpened(null))], [])
  assert.deepEqual([...(await readOpened(file))], [])
  for (const text of ['{not json', '[1, 2]', 'null', '"x"', '']) {
    await writeFile(file, text)
    assert.deepEqual([...(await readOpened(file))], [], text)
  }
  await writeFile(
    file,
    JSON.stringify({
      '12': 'specs/0003-c.md',
      '0': 'zero.md',
      '-1': 'neg.md',
      '1.5': 'half.md',
      '013': 'padded.md',
      x: 'x.md',
      '14': 7,
      '15': '',
    })
  )
  assert.deepEqual([...(await readOpened(file))], [[12, 'specs/0003-c.md']])
})

test('the record written whole, read back; none left, no file; nowhere to write, nothing done', async (t) => {
  const d = await dir(t)
  const file = join(d, 'rness', 'opened')
  await writeOpened(
    file,
    new Map([
      [14, 'b.md'],
      [3, 'a.md'],
    ])
  )
  assert.deepEqual(
    [...(await readOpened(file))],
    [
      [3, 'a.md'],
      [14, 'b.md'],
    ]
  )
  assert.equal(
    await readFile(file, 'utf8'),
    '{\n  "3": "a.md",\n  "14": "b.md"\n}\n'
  )
  await writeOpened(file, new Map())
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  await writeOpened(null, new Map([[1, 'a.md']]))
})
