import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BODY_LIMIT,
  type BodySource,
  digestOf,
  headerOf,
  issueBody,
} from '../../src/pulse/body.ts'

const BLOB = 'https://github.com/acme/.rness/blob/main'
const ISSUES = 'https://github.com/acme/.rness/issues'
const ZWSP = '\u200B'

/** The body of `specs/0002-b.md`, with `adr/0001-a.md` (#12) and itself (#13) on the board. */
const body = (text: string, over: Partial<BodySource> = {}): string =>
  issueBody({
    path: 'specs/0002-b.md',
    text,
    org: 'acme',
    numbers: new Map([
      ['adr/0001-a.md', 12],
      ['specs/0002-b.md', 13],
    ]),
    files: new Set([
      'adr/0001-a.md',
      'specs/0002-b.md',
      'README.md',
      'CONVENTIONS.md',
      'standards/web/seo.md',
      'docs/img/board.png',
    ]),
    ...over,
  })

/** What lies between the first line and the digest line. */
const content = (b: string): string => b.split('\n\n').slice(1, -1).join('\n\n')

test('the first line is the path and its file; front matter and first heading dropped; the digest ends it', () => {
  const b = body(
    '---\nstatus: Draft\ndate: 2026-09-30\n---\n\n# 0002 — B\n\nThe text.\n'
  )
  const lines = b.split('\n')
  assert.equal(
    lines[0],
    '`specs/0002-b.md` · [on GitHub](https://github.com/acme/.rness/blob/main/specs/0002-b.md)'
  )
  assert.equal(lines[0], headerOf('specs/0002-b.md', 'acme'))
  assert.equal(content(b), 'The text.')
  assert.match(lines.at(-1)!, /^<!-- rness [0-9a-f]{12} -->$/)
  assert.equal(lines.length, 5)
})

test('a document with nothing but its title: the first line and the digest', () => {
  assert.equal(
    body('---\nstatus: Draft\n---\n\n# 0002 — B\n').split('\n\n').length,
    2
  )
})

test('the first heading is dropped where it is; a # line inside a fence is not it', () => {
  assert.equal(
    content(
      body(
        '---\nstatus: Draft\n---\n\n> Moved from plans/.\n\n# 0002 — B\n\nText.\n'
      )
    ),
    '> Moved from plans/.\n\nText.'
  )
  assert.equal(
    content(body('```sh\n# install\n```\n\n# 0002 — B\n\n## Part\n')),
    '```sh\n# install\n```\n\n## Part'
  )
})

test('a document on the board links to its issue, anchor dropped; another file of .rness to its blob at main, anchor kept; an image raw', () => {
  const b = body(
    [
      '# B',
      '',
      'See [ADR 1](../adr/0001-a.md#context), [itself](./0002-b.md), [rules](../CONVENTIONS.md#metadata),',
      '[SEO](../standards/web/seo.md), [readme](/README.md) and ![board](../docs/img/board.png).',
    ].join('\n')
  )
  assert.equal(
    content(b),
    [
      `See [ADR 1](${ISSUES}/12), [itself](${ISSUES}/13), [rules](${BLOB}/CONVENTIONS.md#metadata),`,
      `[SEO](${BLOB}/standards/web/seo.md), [readme](${BLOB}/README.md) and ![board](${BLOB}/docs/img/board.png?raw=true).`,
    ].join('\n')
  )
})

test('a document without an issue yet is linked as a file', () => {
  assert.equal(
    content(body('# B\n\n[A](../adr/0001-a.md)\n', { numbers: new Map() })),
    `[A](${BLOB}/adr/0001-a.md)`
  )
})

test('absolute URLs, same-page anchors, paths out of .rness and paths to no file stay as written', () => {
  const kept =
    '[a](https://example.com/x.md) [b](#summary) [c](../../org/rness/README.md) [d](./NNNN-title.md) <https://example.com> [e](mailto:a@b.c)'
  assert.equal(content(body(`# B\n\n${kept}\n`)), kept)
})

test('a title is kept; a reference definition is rewritten; an angle-bracketed destination too', () => {
  const b = body(
    [
      '# B',
      '',
      '[ADR](../adr/0001-a.md "The ADR") and [the rules][rules], [again][adr].',
      '',
      '[rules]: ../CONVENTIONS.md "Conventions"',
      '[adr]: <../adr/0001-a.md>',
    ].join('\n')
  )
  assert.equal(
    content(b),
    [
      `[ADR](${ISSUES}/12 "The ADR") and [the rules][rules], [again][adr].`,
      '',
      `[rules]: ${BLOB}/CONVENTIONS.md "Conventions"`,
      `[adr]: ${ISSUES}/12`,
    ].join('\n')
  )
})

test('code is left alone: fences (``` and ~~~, indented, a longer one around a shorter one) and code spans, even across a line', () => {
  const code = [
    '```ts',
    'import x from "@rness/cli" // #12 [a](../adr/0001-a.md)',
    '```',
    '',
    '  ~~~',
    '  @octocat #4',
    '  ~~~',
    '',
    '````markdown',
    '```',
    '@octocat #5 [a](../adr/0001-a.md)',
    '```',
    '````',
    '',
    'Run `rness pulse sync` or `@octocat #6',
    '[a](../adr/0001-a.md)` here.',
  ].join('\n')
  assert.equal(content(body(`# B\n\n${code}\n`)), code)
})

test('a fence indented with a tab, as in a list item, is a fence: nothing inside is escaped, a blank line included, and it closes', () => {
  const fence = [
    '-\titem',
    '',
    '\t```sh',
    '\techo @user',
    '',
    '\techo #4',
    '\t```',
  ].join('\n')
  assert.equal(
    content(body(`# B\n\n${fence}\n\nAsk @octocat.\n`)),
    `${fence}\n\nAsk \\@octocat.`
  )
})

test('outside code, @name is escaped and a bare #digits broken by a zero-width space; emails, URLs, anchors and entities are not', () => {
  const b = body(
    [
      '# B',
      '',
      'Ask @octocat, (@rness-dev/core) and @rness/cli; see #12, (#4) and #7.',
      'Not: a@b.c, \\@done, &#35;4, C#8, https://www.npmjs.com/package/@rness/cli#12, [x](#12).',
    ].join('\n')
  )
  assert.equal(
    content(b),
    [
      `Ask \\@octocat, (\\@rness-dev/core) and \\@rness/cli; see #${ZWSP}12, (#${ZWSP}4) and #${ZWSP}7.`,
      'Not: a@b.c, \\@done, &#35;4, C#8, https://www.npmjs.com/package/@rness/cli#12, [x](#12).',
    ].join('\n')
  )
})

test('a body past the limit is cut at the last blank line that fits and ends with The rest', () => {
  const paras = Array.from(
    { length: 80 },
    (_, n) => `Paragraph ${n} ${'x'.repeat(990)}`
  )
  const b = body(`# B\n\n${paras.join('\n\n')}\n`)
  assert.ok(b.length <= BODY_LIMIT, `${b.length}`)
  const blocks = b.split('\n\n')
  assert.equal(blocks.at(-2), `The rest: ${BLOB}/specs/0002-b.md`)
  const kept = blocks.slice(1, -2)
  assert.deepEqual(
    kept,
    paras.slice(0, kept.length),
    'whole paragraphs, in order'
  )
  assert.ok(
    b.length + 2 + (paras[kept.length]?.length ?? 0) > BODY_LIMIT,
    'no room for one more'
  )
  assert.notEqual(digestOf(b), null)
})

test('a blank line inside a fenced block is no place to cut', () => {
  const before = 'y'.repeat(60_000)
  const fence = [
    '```',
    ...Array.from({ length: 20 }, () => `${'z'.repeat(500)}\n`),
    '```',
  ].join('\n')
  const b = body(`# B\n\n${before}\n\n${fence}\n\nAfter.\n`)
  assert.ok(b.length <= BODY_LIMIT)
  assert.deepEqual(
    b.split('\n\n').slice(1, -2),
    [before],
    'cut before the fence, not inside it'
  )
})

test('the digest: same document, same body; a change, another digest; a hand edit or a lost line reads as none; CRLF is no change', () => {
  const text = '# B\n\nSome text.\n'
  const b = body(text)
  assert.equal(body(text), b, 'deterministic')
  assert.equal(
    body(text.replaceAll('\n', '\r\n')),
    b,
    'a CRLF checkout gives the same body'
  )
  const d = digestOf(b)
  assert.match(d ?? '', /^[0-9a-f]{12}$/)
  assert.ok(b.endsWith(`\n\n<!-- rness ${d} -->`))
  assert.notEqual(digestOf(body('# B\n\nSome text!\n')), d)
  assert.equal(
    digestOf(b.replace('Some text.', 'Edited by hand.')),
    null,
    'the text no longer matches its digest'
  )
  assert.equal(
    digestOf(b.split('\n').slice(0, -1).join('\n')),
    null,
    'no digest line'
  )
  assert.equal(digestOf(b.replaceAll('\n', '\r\n')), d, 'GitHub may store CRLF')
  assert.equal(digestOf(''), null)
})

test('the digest settles whatever the line endings and the text', () => {
  assert.notEqual(digestOf(body('# B\r\n\r\nA\r\r\nB\r\n')), null)
  assert.ok(
    !body('# B\r\n\r\nA\r\r\nB\r\n').includes('\r'),
    'no CR in the body'
  )
  for (const text of [
    '# B\n\nA\rB\n',
    '# B\n\nA\r\r\nB\n',
    '# B\n\nA \n',
    '# B\n\nno trailing newline',
    '# B\n\nemoji 🎉 and é\n',
  ])
    assert.notEqual(digestOf(body(text)), null, JSON.stringify(text))
})

test('a mention or a reference wrapped in emphasis is neutralized; an email and C#8 are not', () => {
  assert.equal(
    content(
      body('# B\n\n_@octocat_ __@octocat__ __#12__ *@a* **#13** a@b.c C#8\n')
    ),
    `_\\@octocat_ __\\@octocat__ __#${ZWSP}12__ *\\@a* **#${ZWSP}13** a@b.c C#8`
  )
})
