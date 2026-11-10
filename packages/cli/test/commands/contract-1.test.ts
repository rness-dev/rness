import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { capture } from '../helpers/capture.ts'
import {
  CONTRACT_1_LINE,
  makeContract1Workspace,
} from '../helpers/workspace.ts'

// Every command but `upgrade` and `create` on a rness.json still on
// contract 1 (spec 0038 §2): the one line, alone, exit 1, nothing written.
const COMMANDS: readonly (readonly string[])[] = [
  ['sync', '--yes'],
  ['sync', '--check'],
  ['context'],
  ['status', '--json'],
  ['validate'],
  ['doc', 'new', 'adr', '--title', 'x'],
  ['board', 'push', '--yes'],
  ['pulse', 'create', '--yes'],
  ['note', 'a note', '--session', 'abc12345'],
  ['add', 'acme/api'],
  ['written-files'],
]

for (const argv of COMMANDS)
  test(`contract 1: rness ${argv.join(' ')} says the one line, exit 1, writes nothing`, async (t) => {
    const root = await makeContract1Workspace(t)
    const before = await readFile(join(root, '.rness', 'rness.json'), 'utf8')
    const c = capture()
    let code: number
    try {
      code = await run([...argv, '--cwd', root])
    } finally {
      c.restore()
    }
    // `pulse create` says it is now `board push` first, on the same stream.
    const lines = c.err().split('\n').filter(Boolean)
    assert.equal(code, 1, c.err())
    assert.equal(lines.at(-1), CONTRACT_1_LINE)
    assert.equal(lines.filter((l) => l.includes('contract 1')).length, 1)
    assert.equal(c.out(), '')
    assert.equal(
      await readFile(join(root, '.rness', 'rness.json'), 'utf8'),
      before
    )
    assert.deepEqual((await readdir(root)).sort(), ['.rness', 'org'])
    assert.deepEqual(await readdir(join(root, 'org')), ['web'])
  })
