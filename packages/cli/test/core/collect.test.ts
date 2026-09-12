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

test('content drops the front matter while body keeps the whole file', async () => {
  const items = await collectMarkdown(wsBasic)
  const seo = items.find((i) => i.rel === 'web/seo.md')
  assert.ok(seo)
  assert.equal(seo.content.startsWith('# SEO'), true, seo.content)
  assert.doesNotMatch(seo.content, /scopes: web/)
  assert.equal(seo.body.startsWith('---'), true)
  const coding = items.find((i) => i.rel === 'coding.md')
  assert.equal(coding?.content, coding?.body, 'a file without front matter is unchanged')
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
