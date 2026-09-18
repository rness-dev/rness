import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BEGIN,
  END,
  blockHash,
  bodyOf,
  isCurrentBlock,
  parseHeader,
  renderBlock,
} from '../../src/core/block.ts'
import type { Context } from '../../src/core/types.ts'

function ctx(
  files: Array<{
    rel: string
    scope: string | null
    body: string
    content?: string
  }>
): Context {
  return {
    scope: 'web',
    collections: [
      {
        name: 'standards',
        files: files.map((f) => ({
          ...f,
          title: null,
          content: f.content ?? f.body,
        })),
      },
      { name: 'adr', files: [] },
      { name: 'specs', files: [] },
      { name: 'plans', files: [] },
      { name: 'skills', files: [] },
    ],
  }
}

const twoStandards = ctx([
  {
    rel: 'web/seo.md',
    scope: 'web',
    body: '# SEO\n\nEvery page sets a title.\n',
  },
  {
    rel: 'coding.md',
    scope: null,
    body: '\n# Coding\n\nTwo-space indent.\n\n',
  },
])

test('renders the scope block: markers, header, intro, rules in resolution order', () => {
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: twoStandards,
  })
  const lines = block.text.split('\n')
  assert.equal(lines[0], BEGIN)
  assert.equal(lines.at(-1), END)
  assert.match(
    lines[1] ?? '',
    /^<!-- rness · scope: web · contract: 1 · hash: [0-9a-f]{12} · generated: run `rness sync`, never edit inside this block -->$/
  )
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
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: twoStandards,
  })
  const header = parseHeader(block.text.split('\n')[1] ?? '')
  assert.deepEqual(header, {
    version: null,
    scope: 'web',
    hash: block.hash,
  })
  assert.equal(
    block.text.split('\n')[1],
    `<!-- rness · scope: web · contract: 1 · hash: ${block.hash} · generated: run \`rness sync\`, never edit inside this block -->`
  )
  assert.equal(parseHeader('<!-- something else -->'), null)
})

test('the global block names the root, has no relative path, and says where the scoped blocks are', () => {
  const block = renderBlock({
    scope: null,
    org: 'acme',
    depth: 0,
    context: ctx([{ rel: 'coding.md', scope: null, body: '# Coding\n' }]),
  })
  const body = bodyOf(block.text.split('\n'))
  assert.match(block.text.split('\n')[1] ?? '', /· scope: global ·/)
  assert.match(
    body,
    /^This is the root of rness workspace `acme`\. Full context lives in `\.rness\/` —/
  )
  assert.match(body, /Every `org\/<repo>\/` carries its own block/)
  assert.doesNotMatch(body, /\.\.\//)
})

test('depth drives the relative path', () => {
  const deep = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 4,
    context: twoStandards,
  })
  assert.match(deep.text, /`\.\.\/\.\.\/\.\.\/\.\.\/\.rness\/`/)
})

test('no standards yields a placeholder line, never an empty Rules section', () => {
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: ctx([]),
  })
  assert.match(
    block.text,
    /## Rules\n_No standards apply to this scope yet\._\n<!-- END rness -->$/
  )
})

test('a standard with front matter renders its content only, never the --- fences', () => {
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: ctx([
      {
        rel: 'web/seo.md',
        scope: 'web',
        body: '---\nrepo: api\n---\n\n# API rules\n',
        content: '# API rules\n',
      },
    ]),
  })
  assert.match(
    block.text,
    /<!-- rness: standards\/web\/seo\.md -->\n# API rules\n<!-- END rness -->$/
  )
  assert.doesNotMatch(block.text, /---/)
  assert.doesNotMatch(block.text, /repo: api/)
})

test('the hash ignores line endings and changes with the content', () => {
  assert.equal(blockHash('a\r\nb'), blockHash('a\nb'))
  assert.equal(blockHash('a\rb'), blockHash('a\nb'))
  assert.notEqual(blockHash('a'), blockHash('b'))
  assert.match(blockHash('x'), /^[0-9a-f]{12}$/)
})

test('CRLF and lone-CR standard bodies render as LF, and hash the same as their LF twin', () => {
  const crlf = ctx([
    {
      rel: 'coding.md',
      scope: null,
      body: '# Coding\r\n\r\nTwo-space indent.\r\n',
    },
  ])
  const cr = ctx([
    { rel: 'coding.md', scope: null, body: '# Coding\r\rTwo-space indent.\r' },
  ])
  const lf = ctx([
    { rel: 'coding.md', scope: null, body: '# Coding\n\nTwo-space indent.\n' },
  ])
  const [a, b, c] = [crlf, cr, lf].map((context) =>
    renderBlock({
      scope: 'web',
      org: 'acme',
      depth: 2,
      context,
    })
  )
  assert.doesNotMatch(a?.text ?? '', /\r/)
  assert.doesNotMatch(b?.text ?? '', /\r/)
  assert.equal(a?.text, c?.text)
  assert.equal(b?.hash, c?.hash)
})

test('parseHeader rejects a line that only shares the header prefix', () => {
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: twoStandards,
  })
  const header = block.text.split('\n')[1] ?? ''
  assert.notEqual(parseHeader(header), null)
  assert.equal(parseHeader(`${header.slice(0, -3)} tampered -->`), null)
  assert.equal(
    parseHeader(header.replace('never edit inside this block', 'edit freely')),
    null
  )
})

test('the 0.2–0.4 header, which named the CLI version, still parses', () => {
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: twoStandards,
  })
  const old = `<!-- rness 0.4.0 · scope: web · contract: 1 · hash: ${block.hash} · generated: run \`rness sync\`, never edit inside this block -->`
  assert.deepEqual(parseHeader(old), {
    version: '0.4.0',
    scope: 'web',
    hash: block.hash,
  })
})

test('a block is current by its hash, whichever header form it has', () => {
  const block = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context: twoStandards,
  })
  const lines = block.text.split('\n')
  assert.equal(isCurrentBlock(lines, block.hash), true)

  const old = [...lines]
  old[1] = (old[1] ?? '').replace('<!-- rness · ', '<!-- rness 0.3.0 · ')
  assert.equal(isCurrentBlock(old, block.hash), true)

  assert.equal(isCurrentBlock(lines, '000000000000'), false, 'content changed')
  const edited = [...lines]
  edited[3] = `${edited[3] ?? ''} (hand edit)`
  assert.equal(isCurrentBlock(edited, block.hash), false, 'hand edit')
  const broken = [...lines]
  broken[1] = '<!-- something else -->'
  assert.equal(isCurrentBlock(broken, block.hash), false, 'no header')
})
