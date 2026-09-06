import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontMatter, extractTitle } from '../../src/core/frontmatter.mjs'

test('parses scalar fields and strips quotes', () => {
  const src = '---\nstatus: Draft\nname: "x y"\n---\n# Title\n'
  assert.deepEqual(parseFrontMatter(src), { status: 'Draft', name: 'x y' })
})

test('no front matter returns null', () => {
  assert.equal(parseFrontMatter('# Title only\n'), null)
})

test('extractTitle returns first h1', () => {
  assert.equal(extractTitle('---\na: b\n---\n# Hello\n## no\n'), 'Hello')
})
