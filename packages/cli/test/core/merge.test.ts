import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readOrNull, writeFileAtomic } from '../../src/core/fs.ts'
import { ensureClaudeMd, findBlock, mergeBlock } from '../../src/core/merge.ts'

const BLOCK = '<!-- BEGIN rness -->\nBLOCK\n<!-- END rness -->'
const fixtures = fileURLToPath(new URL('../fixtures/blocks/', import.meta.url))
const read = (name: string) => readFile(join(fixtures, name), 'utf8')

for (const name of ['h1', 'plain', 'foreign']) {
  test(`merge golden: ${name}`, async () => {
    const result = mergeBlock(await read(`${name}.input.md`), BLOCK)
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.equal(result.text, await read(`${name}.expected.md`))
    assert.equal(result.changed, true)
  })
}

test('a missing file becomes the block plus a trailing newline', () => {
  const result = mergeBlock(null, BLOCK)
  assert.deepEqual(result, { ok: true, text: `${BLOCK}\n`, changed: true })
})

test('merging is idempotent', async () => {
  const once = mergeBlock(await read('h1.input.md'), BLOCK)
  assert.ok(once.ok)
  const twice = mergeBlock(once.text, BLOCK)
  assert.ok(twice.ok)
  assert.equal(twice.text, once.text)
  assert.equal(twice.changed, false)
})

test('CRLF files keep CRLF, including inside the block', () => {
  const result = mergeBlock('# Title\r\n\r\nBody\r\n', BLOCK)
  assert.ok(result.ok)
  assert.equal(
    result.text,
    '# Title\r\n\r\n<!-- BEGIN rness -->\r\nBLOCK\r\n<!-- END rness -->\r\n\r\nBody\r\n'
  )
})

test('an H1 not followed by a blank line means insertion at the top', () => {
  const result = mergeBlock('# Title\nBody\n', BLOCK)
  assert.ok(result.ok)
  assert.equal(result.text, `${BLOCK}\n\n# Title\nBody\n`)
})

test('a lone H1 with no blank line after it gets the block on top, idempotently', () => {
  for (const existing of ['# Title', '# Title\n', '# Title\nBody\n']) {
    const once = mergeBlock(existing, BLOCK)
    assert.ok(once.ok, existing)
    assert.equal(once.text, `${BLOCK}\n\n${existing}`)
    const twice = mergeBlock(once.text, BLOCK)
    assert.ok(twice.ok)
    assert.equal(twice.changed, false)
  }
})

test('an H1 followed only by a blank line takes the block after it, idempotently', () => {
  const once = mergeBlock('# Title\n\n', BLOCK)
  assert.ok(once.ok)
  assert.equal(once.text, `# Title\n\n${BLOCK}\n\n`)
  const twice = mergeBlock(once.text, BLOCK)
  assert.ok(twice.ok)
  assert.equal(twice.changed, false)
})

test('malformed spans are errors and leave the text alone', () => {
  assert.deepEqual(findBlock(['<!-- BEGIN rness -->', 'x']), {
    kind: 'error',
    message:
      'expected exactly one <!-- BEGIN rness --> … <!-- END rness --> span, found 1 BEGIN and 0 END',
  })
  assert.equal(
    findBlock(['<!-- END rness -->', '<!-- BEGIN rness -->']).kind,
    'error'
  )
  assert.equal(findBlock([BLOCK, BLOCK].join('\n').split('\n')).kind, 'error')
  const result = mergeBlock('<!-- BEGIN rness -->\nno end\n', BLOCK)
  assert.equal(result.ok, false)
})

test('a file mixing LF and CRLF keeps every separator outside the span', () => {
  const mixed = '# Title\r\n\r\nline one\nline two\r\n'
  const inserted = mergeBlock(mixed, BLOCK)
  assert.ok(inserted.ok)
  assert.equal(
    inserted.text,
    `# Title\r\n\r\n${BLOCK.split('\n').join('\r\n')}\r\n\r\nline one\nline two\r\n`
  )
  const replaced = mergeBlock(
    'a\nb\r\n<!-- BEGIN rness -->\r\nold\r\n<!-- END rness -->\r\nc\nd\r\n',
    BLOCK
  )
  assert.ok(replaced.ok)
  assert.equal(
    replaced.text,
    `a\nb\r\n${BLOCK.split('\n').join('\r\n')}\r\nc\nd\r\n`
  )
})

test("ensureClaudeMd prepends with the file's own line ending", async (t) => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'rness-claude-crlf-'))
  )
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'CLAUDE.md'), '# Local\r\n\r\nNotes.\r\n')
  assert.equal(await ensureClaudeMd(dir), 'prepended')
  assert.equal(
    await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
    '@AGENTS.md\r\n# Local\r\n\r\nNotes.\r\n'
  )
})

test('ensureClaudeMd creates, prepends, or leaves alone', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-claude-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await ensureClaudeMd(dir), 'created')
  assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  assert.equal(await ensureClaudeMd(dir), 'unchanged')
  await writeFile(join(dir, 'CLAUDE.md'), '# Local\n\nNotes.\n')
  assert.equal(await ensureClaudeMd(dir), 'prepended')
  assert.equal(
    await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
    '@AGENTS.md\n# Local\n\nNotes.\n'
  )
  assert.equal(await ensureClaudeMd(dir), 'unchanged')
})

test('writeFileAtomic leaves no temp file behind; readOrNull is null only for ENOENT', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-atomic-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'AGENTS.md')
  assert.equal(await readOrNull(file), null)
  await writeFileAtomic(file, 'hello\n')
  assert.equal(await readOrNull(file), 'hello\n')
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(dir), ['AGENTS.md'])
})
