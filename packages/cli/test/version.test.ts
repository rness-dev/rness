import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { VERSION } from '../src/version.ts'

test('VERSION matches package.json and the package is @rness/cli', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string
    version: string
  }
  assert.equal(pkg.name, '@rness/cli')
  assert.equal(VERSION, pkg.version)
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})
