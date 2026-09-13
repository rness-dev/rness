import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  extractTitle,
  parseFrontMatter,
  stripFrontMatter,
} from '../../src/core/frontmatter.ts'

test('parses scalar fields and strips quotes', () => {
  const src = '---\nstatus: Draft\nname: "x y"\n---\n# Title\n'
  assert.deepEqual(parseFrontMatter(src), { status: 'Draft', name: 'x y' })
})

test('no front matter returns null', () => {
  assert.equal(parseFrontMatter('# Title only\n'), null)
})

test('an empty block is an empty mapping', () => {
  assert.deepEqual(parseFrontMatter('---\n---\n# T\n'), {})
})

test('yaml types: numbers are numbers, dates and multi-word values stay strings', () => {
  const src =
    '---\ncontract: 1\ndate: 2026-09-07\nstatus: In progress\n---\n# T\n'
  assert.deepEqual(parseFrontMatter(src), {
    contract: 1,
    date: '2026-09-07',
    status: 'In progress',
  })
})

test('literal blocks keep their lines', () => {
  const src = '---\nsummary: |\n  one\n  two\n---\n# T\n'
  assert.deepEqual(parseFrontMatter(src), { summary: 'one\ntwo\n' })
})

test('lists are lists', () => {
  assert.deepEqual(parseFrontMatter('---\nscopes: [web, ui]\n---\n'), {
    scopes: ['web', 'ui'],
  })
})

test('invalid yaml throws a prefixed error', () => {
  assert.throws(
    () => parseFrontMatter('---\nstatus: [unclosed\n---\n'),
    /^Error: front matter:/
  )
})

test('a non-mapping document throws a prefixed error', () => {
  assert.throws(
    () => parseFrontMatter('---\n- a\n- b\n---\n'),
    /front matter: .*mapping/
  )
})

test('a leading UTF-8 BOM does not hide the front matter block', () => {
  assert.deepEqual(parseFrontMatter('﻿---\nstatus: Draft\n---\n# T\n'), {
    status: 'Draft',
  })
})

test('stripFrontMatter removes the block and the blank lines after it', () => {
  assert.equal(
    stripFrontMatter('---\nrepo: api\n---\n\n# API rules\n'),
    '# API rules\n'
  )
  assert.equal(
    stripFrontMatter('---\nrepo: api\n---\n# API rules\n'),
    '# API rules\n'
  )
  assert.equal(
    stripFrontMatter('---\r\nrepo: api\r\n---\r\n\r\n# API rules\r\n'),
    '# API rules\r\n'
  )
  assert.equal(stripFrontMatter('---\n---\n# T\n'), '# T\n')
})

test('stripFrontMatter leaves a document without front matter alone', () => {
  assert.equal(
    stripFrontMatter('# Title only\n\n---\n\nA rule.\n'),
    '# Title only\n\n---\n\nA rule.\n'
  )
  assert.equal(stripFrontMatter(''), '')
})

test('stripFrontMatter is BOM-aware and strips even an unparsable block', () => {
  assert.equal(stripFrontMatter('﻿---\nstatus: Draft\n---\n\n# T\n'), '# T\n')
  assert.equal(stripFrontMatter('﻿# No block\n'), '# No block\n')
  assert.equal(
    stripFrontMatter('---\nstatus: [unclosed\n---\n\n# Broken\n'),
    '# Broken\n'
  )
})

test('extractTitle returns first h1', () => {
  assert.equal(extractTitle('---\na: b\n---\n# Hello\n## no\n'), 'Hello')
  assert.equal(extractTitle('no title here\n'), null)
})
