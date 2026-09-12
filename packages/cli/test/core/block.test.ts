import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BEGIN, END, blockHash, bodyOf, parseHeader, renderBlock } from '../../src/core/block.ts'
import type { Context } from '../../src/core/types.ts'

function ctx(files: Array<{ rel: string; scope: string | null; body: string }>): Context {
  return {
    scope: 'web',
    collections: [
      { name: 'standards', files: files.map((f) => ({ ...f, title: null })) },
      { name: 'adr', files: [] },
      { name: 'specs', files: [] },
      { name: 'plans', files: [] },
      { name: 'skills', files: [] },
    ],
  }
}

const twoStandards = ctx([
  { rel: 'web/seo.md', scope: 'web', body: '# SEO\n\nEvery page sets a title.\n' },
  { rel: 'coding.md', scope: null, body: '\n# Coding\n\nTwo-space indent.\n\n' },
])

test('renders the scope block: markers, header, intro, rules in resolution order', () => {
  const block = renderBlock({ scope: 'web', org: 'acme', depth: 2, context: twoStandards, version: '0.0.0-test' })
  const lines = block.text.split('\n')
  assert.equal(lines[0], BEGIN)
  assert.equal(lines.at(-1), END)
  assert.match(lines[1] ?? '', /^<!-- rness 0\.0\.0-test · scope: web · contract: 1 · hash: [0-9a-f]{12} · generated: run `rness sync`, never edit inside this block -->$/)
  const expectedBody = [
    'This directory is scope `web` of rness workspace `acme`. Full context lives in',
    '`../../.rness/` — read `STATUS.md`, then task-relevant `adr/`, `specs/`, `plans/`;',
    'live: `rness context --scope web`. If `.rness/` is not reachable, this is a',
    'standalone clone: the rules below are all you have.',
    '',
    '## Rules',
    '<!-- rness: standards/web/seo.md -->',
    '# SEO',
    '',
    'Every page sets a title.',
    '',
    '<!-- rness: standards/coding.md -->',
    '# Coding',
    '',
    'Two-space indent.',
  ].join('\n')
  assert.equal(bodyOf(lines), expectedBody)
  assert.equal(block.hash, blockHash(expectedBody))
  assert.equal(block.bytes, Buffer.byteLength(block.text))
})

test('the header carries the body hash and parses back', () => {
  const block = renderBlock({ scope: 'web', org: 'acme', depth: 2, context: twoStandards, version: '0.0.0-test' })
  const header = parseHeader(block.text.split('\n')[1] ?? '')
  assert.deepEqual(header, { version: '0.0.0-test', scope: 'web', hash: block.hash })
  assert.equal(parseHeader('<!-- something else -->'), null)
})

test('the global block names the root, has no relative path, and says where the scoped blocks are', () => {
  const block = renderBlock({ scope: null, org: 'acme', depth: 0, context: ctx([{ rel: 'coding.md', scope: null, body: '# Coding\n' }]), version: '0.0.0-test' })
  const body = bodyOf(block.text.split('\n'))
  assert.match(block.text.split('\n')[1] ?? '', /· scope: global ·/)
  assert.match(body, /^This is the root of rness workspace `acme`\. Full context lives in `\.rness\/` —/)
  assert.match(body, /Every `org\/<repo>\/` carries its own block/)
  assert.doesNotMatch(body, /\.\.\//)
})

test('depth drives the relative path', () => {
  const deep = renderBlock({ scope: 'web', org: 'acme', depth: 4, context: twoStandards, version: '0.0.0-test' })
  assert.match(deep.text, /`\.\.\/\.\.\/\.\.\/\.\.\/\.rness\/`/)
})

test('no standards yields a placeholder line, never an empty Rules section', () => {
  const block = renderBlock({ scope: 'web', org: 'acme', depth: 2, context: ctx([]), version: '0.0.0-test' })
  assert.match(block.text, /## Rules\n_No standards apply to this scope yet\._\n<!-- END rness -->$/)
})

test('the hash ignores line endings and changes with the content', () => {
  assert.equal(blockHash('a\r\nb'), blockHash('a\nb'))
  assert.equal(blockHash('a\rb'), blockHash('a\nb'))
  assert.notEqual(blockHash('a'), blockHash('b'))
  assert.match(blockHash('x'), /^[0-9a-f]{12}$/)
})

test('CRLF and lone-CR standard bodies render as LF, and hash the same as their LF twin', () => {
  const crlf = ctx([{ rel: 'coding.md', scope: null, body: '# Coding\r\n\r\nTwo-space indent.\r\n' }])
  const cr = ctx([{ rel: 'coding.md', scope: null, body: '# Coding\r\rTwo-space indent.\r' }])
  const lf = ctx([{ rel: 'coding.md', scope: null, body: '# Coding\n\nTwo-space indent.\n' }])
  const [a, b, c] = [crlf, cr, lf].map((context) => renderBlock({ scope: 'web', org: 'acme', depth: 2, context, version: '0.0.0-test' }))
  assert.doesNotMatch(a?.text ?? '', /\r/)
  assert.doesNotMatch(b?.text ?? '', /\r/)
  assert.equal(a?.text, c?.text)
  assert.equal(b?.hash, c?.hash)
})

test('parseHeader rejects a line that only shares the header prefix', () => {
  const block = renderBlock({ scope: 'web', org: 'acme', depth: 2, context: twoStandards, version: '0.0.0-test' })
  const header = block.text.split('\n')[1] ?? ''
  assert.notEqual(parseHeader(header), null)
  assert.equal(parseHeader(`${header.slice(0, -3)} tampered -->`), null)
  assert.equal(parseHeader(header.replace('never edit inside this block', 'edit freely')), null)
})
