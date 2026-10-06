import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { containedPath } from '../../src/core/contained.ts'

async function tree(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-in-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, '.rness')
  await mkdir(join(root, 'marketing'), { recursive: true })
  await writeFile(join(root, 'marketing', 'README.md'), '# Launch\n')
  await writeFile(join(base, 'secret'), 'a key\n')
  return { base, root }
}

test('a path of .rness: read; one not there: ENOENT, as realpath says', async (t) => {
  const { root } = await tree(t)
  assert.equal(
    await containedPath(root, 'marketing/README.md'),
    join(root, 'marketing', 'README.md')
  )
  await assert.rejects(() => containedPath(root, 'marketing/none.md'), {
    code: 'ENOENT',
  })
})

test('a path out of .rness, or hidden, is refused before anything is read', async (t) => {
  const { root } = await tree(t)
  for (const rel of [
    '../secret',
    'marketing/../../secret',
    '/etc/passwd',
    '.git/config',
    'marketing/.hidden',
    'marketing//README.md',
    'marketing\\README.md',
  ])
    await assert.rejects(() => containedPath(root, rel), {
      message: `${rel} is not a path within .rness`,
    })
})

test('a link that leads out of .rness is refused, whatever it is named', async (t) => {
  const { base, root } = await tree(t)
  await symlink(join(base, 'secret'), join(root, 'marketing', 'notes.md'))
  await symlink(base, join(root, 'out'))
  await assert.rejects(() => containedPath(root, 'marketing/notes.md'), {
    message:
      'marketing/notes.md leads out of .rness: rness reads nothing there',
  })
  await assert.rejects(() => containedPath(root, 'out/secret'), {
    message: 'out/secret leads out of .rness: rness reads nothing there',
  })
})
