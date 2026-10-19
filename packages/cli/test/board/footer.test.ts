import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { digestOf } from '../../src/board/body.ts'
import { splitFooter, withFooter } from '../../src/board/footer.ts'

// The footer of a GitLab card (spec 0037 §7.3): the fields a label cannot
// carry, below the digest, outside it.

const BODY =
  '`specs/0002-b.md` · [on GitLab](u)\n\nText.\n\n<!-- rness 0123456789ab -->'

test('written below the body, one line per field with a value, in the order given; none: no footer', () => {
  const text = withFooter(
    BODY,
    {
      'Session history': 'claude · 9f8e7d6c, claude · 1a2b3c4d',
      'Working session': 'claude · 1a2b3c4d',
      'Publish date': null,
    },
    ['Working session', 'Session history', 'Publish date']
  )
  assert.equal(
    text,
    `${BODY}\n\n---\n\n**Working session**: claude · 1a2b3c4d\n**Session history**: claude · 9f8e7d6c, claude · 1a2b3c4d`
  )
  assert.equal(withFooter(BODY, { 'Working session': null }, []), BODY)
})

test('read back: the body above, the values by name; a description without one is all body', () => {
  const text = withFooter(BODY, { 'Working session': 'claude · 1a2b3c4d' }, [])
  assert.deepEqual(splitFooter(text), {
    body: BODY,
    values: { 'Working session': 'claude · 1a2b3c4d' },
  })
  assert.deepEqual(splitFooter(BODY), { body: BODY, values: {} })
  // A rule in the document itself is no footer: lines that are not fields follow it.
  const ruled = 'Intro\n\n---\n\nMore text.'
  assert.deepEqual(splitFooter(ruled), { body: ruled, values: {} })
})

test('the digest never covers the footer: a mark leaves the body as it was', () => {
  const real = '`a.md` · [on GitLab](u)\n\nText.'
  const d = createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 12)
  const body = `${real}\n\n<!-- rness ${d} -->`
  assert.equal(digestOf(body), d)
  const marked = withFooter(body, { 'Working session': 'claude · 1' }, [])
  assert.equal(digestOf(splitFooter(marked).body), d)
})

test('rewritten by hand, CRLF or trailing blanks: read the same', () => {
  const text = `${BODY}\r\n\r\n---\r\n\r\n**Working session**: claude · 1  \r\n`
  assert.deepEqual(splitFooter(text), {
    body: BODY,
    values: { 'Working session': 'claude · 1' },
  })
})
