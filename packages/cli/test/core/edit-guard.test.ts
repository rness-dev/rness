import assert from 'node:assert/strict'
import { test } from 'node:test'

import { replayEdit } from '../../src/core/edit-guard.ts'

// The Edit tool finds an old_string as Claude Code does: straight quotes
// match curly ones, and a LF matches a CRLF (seen 2026-10-04: the model
// sent `product's` for the block's `product’s`, and the edit went through).

test('replayEdit: an exact match, once', () => {
  assert.deepEqual(replayEdit('a b a', 'b', 'c', false), {
    after: 'a c a',
    spans: [[2, 3]],
  })
})

test('replayEdit: straight quotes find curly ones, the spans in the file’s own offsets', () => {
  const text = 'the product’s “real” owner'
  const r = replayEdit(text, `product's "real"`, 'X', false)
  assert.deepEqual(r?.spans, [[4, 20]])
  assert.equal(r?.after, 'the X owner')
})

test('replayEdit: a LF in old_string finds a CRLF in the file', () => {
  const text = 'one\r\ntwo\r\nthree'
  const r = replayEdit(text, 'one\ntwo', 'x', false)
  assert.deepEqual(r?.spans, [[0, 8]])
  assert.equal(r?.after, 'x\r\nthree')
})

test('replayEdit: not found, or found twice without replace_all, is the tool’s own refusal', () => {
  assert.equal(replayEdit('abc', 'z', 'y', false), null)
  assert.equal(replayEdit('a a', 'a', 'b', false), null)
  assert.deepEqual(replayEdit('a a', 'a', 'b', true)?.after, 'b b')
})
