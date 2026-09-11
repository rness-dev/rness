import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { collectMarkdown } from '../../src/core/collect.ts'

const wsBasic = fileURLToPath(new URL('../fixtures/ws-basic/.rness/standards', import.meta.url))

test('collects nested markdown sorted by rel', async () => {
  const items = await collectMarkdown(wsBasic)
  assert.deepEqual(items.map((i) => i.rel), ['broken.md', 'coding.md', 'web/seo.md'])
  assert.equal(items[1]?.title, 'Coding')
  assert.deepEqual(items[2]?.fields, { scopes: 'web' })
})

test('a file with invalid front matter is kept, with fields null and an error', async () => {
  const items = await collectMarkdown(wsBasic)
  const broken = items.find((i) => i.rel === 'broken.md')
  assert.ok(broken)
  assert.equal(broken.fields, null)
  assert.match(broken.fieldsError ?? '', /front matter:/)
  assert.equal(broken.title, 'Broken')
})

test('missing directory yields empty list', async () => {
  assert.deepEqual(await collectMarkdown('/no/such/dir/ever'), [])
})
