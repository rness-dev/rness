import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  editedLines,
  replayEdit,
  writtenLines,
} from '../../src/core/edit-guard.ts'

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

// The lines an edit adds (spec 0040 §4.3): numbered in the file it leaves.

test('writtenLines: the lines of the content the file does not have, each copy counted', () => {
  assert.deepEqual(writtenLines(null, 'a\nb\n'), [
    { line: 1, text: 'a' },
    { line: 2, text: 'b' },
  ])
  assert.deepEqual(writtenLines('a\nb\n', 'b\na\nc\n'), [
    { line: 3, text: 'c' },
  ])
  assert.deepEqual(writtenLines('a\n', 'a\na\n'), [{ line: 2, text: 'a' }])
  assert.deepEqual(writtenLines('a\r\nb', 'a\nb\n'), [])
  assert.deepEqual(writtenLines('a\n', ''), [])
})

test('editedLines: the lines of new_string that old_string does not have, read whole in the file after', () => {
  const at = (text: string, o: string, n: string, all = false) => {
    const r = replayEdit(text, o, n, all)
    assert.ok(r !== null)
    return editedLines(r, o, n)
  }
  assert.deepEqual(at('one\ntwo foo three\n', 'foo', 'bar'), [
    { line: 2, text: 'two bar three' },
  ])
  assert.deepEqual(at('a\nb\nc\n', 'b\n', 'b\nx\ny\n'), [
    { line: 3, text: 'x' },
    { line: 4, text: 'y' },
  ])
  assert.deepEqual(at('a\nb\n', 'a\nb', 'b\na'), [])
  assert.deepEqual(at('x 1\nx 2\nx 3\n', 'x', 'y', true), [
    { line: 1, text: 'y 1' },
    { line: 2, text: 'y 2' },
    { line: 3, text: 'y 3' },
  ])
  // `z\nz z\nz\nz\nz\n`: two replacements meet on line 2, named once; each
  // replacement is longer than what it replaces, and shifts the next.
  assert.deepEqual(at('ab ab\nab\n', 'ab', 'z\nz', true), [
    { line: 1, text: 'z' },
    { line: 2, text: 'z z' },
    { line: 3, text: 'z' },
    { line: 4, text: 'z' },
    { line: 5, text: 'z' },
  ])
})
