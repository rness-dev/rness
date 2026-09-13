import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkContract } from '../../src/core/contract.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { SCAFFOLD_FILES, scaffoldDir } from '../../src/core/scaffold.ts'

test('every scaffold file exists', async () => {
  for (const rel of SCAFFOLD_FILES)
    await access(join(scaffoldDir(), ...rel.split('/')))
})

test('the scaffold ships _gitignore, never .gitignore', async () => {
  assert.ok(SCAFFOLD_FILES.includes('_gitignore'))
  await assert.rejects(access(join(scaffoldDir(), '.gitignore')))
})

test('the scaffold manifest is a valid empty workspace', async () => {
  const m = await loadManifest(scaffoldDir())
  assert.deepEqual(m, { contract: 1, org: null, repos: {}, scopes: {} })
})

test('the scaffold passes the contract (template ADR is skipped)', async () => {
  assert.deepEqual(await checkContract(scaffoldDir()), [])
})

test('package.json and the workflow carry the tokens create replaces', async () => {
  const raw = await readFile(join(scaffoldDir(), 'package.json'), 'utf8')
  assert.match(raw, /"@rness\/cli": "__RNESS_VERSION__"/)
  assert.match(raw, /"packageManager": "__RNESS_PM__"/)
  assert.doesNotThrow(() => JSON.parse(raw))
  const workflow = await readFile(
    join(scaffoldDir(), '.github', 'workflows', 'validate.yml'),
    'utf8'
  )
  assert.match(workflow, /@rness\/cli@__RNESS_VERSION__ validate/)
})
