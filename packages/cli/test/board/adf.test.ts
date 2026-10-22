import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  type AdfNode,
  adfTextLength,
  footerAdf,
  keepSoftBreaks,
  readFooter,
  toAdf,
} from '../../src/board/adf.ts'

// Markdown to Atlassian Document Format for Jira (spec 0039 §6; plan 0053
// task 5), through marklassian 1.2.1, with what task 1 and this task saw it
// get wrong set right.

const types = (nodes: readonly AdfNode[] | undefined): string[] =>
  (nodes ?? []).flatMap((n) => [n.type, ...types(n.content)])

const text = (nodes: readonly AdfNode[] | undefined): string =>
  (nodes ?? []).map((n) => (n.text ?? '') + text(n.content)).join('')

test('tables, code blocks and links come through; the digest comment does not', async () => {
  const doc = await toAdf(
    [
      '`specs/0016-cli-status.md` · [on Bitbucket](https://bitbucket.org/acme/.rness/src/main/specs/0016-cli-status.md)',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '<!-- rness 1a2b3c4d5e6f -->',
      '',
    ].join('\n')
  )
  assert.equal(doc.type, 'doc')
  assert.equal(doc.version, 1)
  const all = types(doc.content)
  for (const t of ['table', 'tableHeader', 'tableCell', 'codeBlock'])
    assert.ok(all.includes(t), t)
  assert.equal(JSON.stringify(doc).includes('rness 1a2b3c4d5e6f'), false)
  assert.match(
    JSON.stringify(doc),
    /"href":"https:\/\/bitbucket\.org\/acme\/\.rness\/src\/main\/specs\/0016-cli-status\.md"/
  )
})

test('a line break before code, bold, a link or emphasis stays a space', async () => {
  const doc = await toAdf(
    'one\n`code` two\n**bold** three\n[link](https://x.io) four\n_em_ five\n'
  )
  assert.equal(text(doc.content), 'one code two bold three link four em five')
})

test('keepSoftBreaks: a space ends each prose line followed by another; fences, hard breaks and last lines untouched', () => {
  assert.equal(
    keepSoftBreaks(
      ['a', 'b', '', 'c  ', 'd', '```', 'code', 'more', '```', 'e', 'f'].join(
        '\n'
      )
    ),
    ['a ', 'b', '', 'c  ', 'd', '```', 'code', 'more', '```', 'e ', 'f'].join(
      '\n'
    )
  )
})

test('a task item holding a list: the list leaves the task list, which goes on after it', async () => {
  const doc = await toAdf('- [ ] a\n  - b\n  - c\n- [x] d\n')
  assert.deepEqual(
    doc.content.map((n) => n.type),
    ['taskList', 'bulletList', 'taskList']
  )
  // No task item holds anything but inline content.
  const items = (nodes: readonly AdfNode[]): AdfNode[] =>
    nodes.flatMap((n) => [
      ...(n.type === 'taskItem' ? [n] : []),
      ...items(n.content ?? []),
    ])
  for (const item of items(doc.content))
    assert.deepEqual(
      (item.content ?? []).filter((c) => c.content !== undefined),
      []
    )
  assert.equal(text(doc.content), 'abcd')
  const ids = doc.content.map((n) => n.attrs?.['localId'])
  assert.notEqual(ids[0], ids[2])
})

test("the footer: a rule, one paragraph per field, its name strong; read back off the description's last rule", () => {
  const footer = footerAdf(
    { Agent: 'claude', 'Working session': 'claude · 1a2b3c4d', Empty: '' },
    ['Working session']
  )
  assert.deepEqual(footer, [
    { type: 'rule' },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Working session', marks: [{ type: 'strong' }] },
        { type: 'text', text: ': claude · 1a2b3c4d' },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Agent', marks: [{ type: 'strong' }] },
        { type: 'text', text: ': claude' },
      ],
    },
  ])
  const body: AdfNode[] = [
    { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
    { type: 'rule' },
    { type: 'paragraph', content: [{ type: 'text', text: 'not a footer' }] },
  ]
  assert.deepEqual(readFooter({ version: 1, type: 'doc', content: body }), {
    body,
    values: {},
  })
  assert.deepEqual(
    readFooter({ version: 1, type: 'doc', content: [...body, ...footer] }),
    {
      body,
      values: { 'Working session': 'claude · 1a2b3c4d', Agent: 'claude' },
    }
  )
})

test("adfTextLength counts the document's text, as Jira's 32,767 limit does (plan 0053 task 1)", async () => {
  const doc = await toAdf('# Title\n\nSome **bold** text.\n')
  assert.equal(adfTextLength(doc), 'TitleSome bold text.'.length)
})

test('marklassian is reached by import() in board/adf.ts alone: context and validate never load it', async () => {
  const src = join(import.meta.dirname, '..', '..', 'src')
  const files = (await readdir(src, { recursive: true })).filter((f) =>
    f.endsWith('.ts')
  )
  const naming: string[] = []
  for (const f of files)
    if ((await readFile(join(src, f), 'utf8')).includes('marklassian'))
      naming.push(f.split('\\').join('/'))
  assert.deepEqual(naming, ['board/adf.ts'])
  const adf = await readFile(join(src, 'board', 'adf.ts'), 'utf8')
  assert.match(adf, /await import\('marklassian'\)/)
  // Only inside a function: importing board/adf.ts loads nothing more.
  assert.doesNotMatch(adf, /^import [^;]*marklassian/m)
})
