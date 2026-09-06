import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { collectMarkdown } from '../../src/core/collect.mjs'

const wsBasic = fileURLToPath(new URL('../fixtures/ws-basic/.rness/standards', import.meta.url))

test('collects nested markdown sorted by rel', async () => {
  const items = await collectMarkdown(wsBasic)
  assert.deepEqual(items.map((i) => i.rel), ['coding.md', 'web/seo.md'])
  assert.equal(items[0].title, 'Coding')
})

test('missing directory yields empty list', async () => {
  assert.deepEqual(await collectMarkdown('/no/such/dir/ever'), [])
})
