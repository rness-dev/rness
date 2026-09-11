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

test('the bin path is already in the form npm publishes (no ./ prefix)', async () => {
  // npm 11 "auto-corrects" a ./-prefixed bin at publish time and warns that
  // it removed the entry — alarming, and one normalisation away from a
  // package with no command. Keep the source form equal to the published form.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    bin: Record<string, string>
  }
  assert.equal(pkg.bin['rness'], 'dist/bin/rness.js')
})
