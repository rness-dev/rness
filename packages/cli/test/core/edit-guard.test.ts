import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addedLines,
  installedSkillAt,
  replayEdit,
  skillCopyAt,
  skillHome,
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

// The lines an edit adds (spec 0040 §4.3), as a commit shows them: each
// line of the file after whose whole text the file before does not have,
// numbered in the file after.

test('addedLines: the lines of the file after that the file before does not have, each copy counted', () => {
  assert.deepEqual(addedLines(null, 'a\nb\n'), [
    { line: 1, text: 'a' },
    { line: 2, text: 'b' },
  ])
  assert.deepEqual(addedLines('a\nb\n', 'b\na\nc\n'), [{ line: 3, text: 'c' }])
  assert.deepEqual(addedLines('a\n', 'a\na\n'), [{ line: 2, text: 'a' }])
  assert.deepEqual(addedLines('a\r\nb', 'a\nb\n'), [])
  assert.deepEqual(addedLines('a\n', ''), [])
  // A copy put above the line it copies is the added one.
  assert.deepEqual(addedLines('x\ny\nz\n', 'x\nz\ny\nz\n'), [
    { line: 2, text: 'z' },
  ])
})

test('addedLines after an Edit: whole lines, wherever old_string started and ended', () => {
  const at = (text: string, o: string, n: string, all = false) => {
    const r = replayEdit(text, o, n, all)
    assert.ok(r !== null)
    return addedLines(text, r.after)
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
  // new_string and old_string hold the same lines, the file's are new: the
  // fragments alone would say nothing was added.
  assert.deepEqual(at('p X\nY s\n', 'X\nY', 'Y\nX'), [
    { line: 1, text: 'p Y' },
    { line: 2, text: 'X s' },
  ])
  // A line split in two: both halves are new lines.
  assert.deepEqual(at('keep this and that\n', ' and ', '\n'), [
    { line: 1, text: 'keep this' },
    { line: 2, text: 'that' },
  ])
})

test('installedSkillAt: a skill directory of a clone or of the root, nothing deeper than a name', () => {
  assert.deepEqual(installedSkillAt('org/web/.claude/skills/a/SKILL.md'), {
    repo: 'web',
    dir: '.claude/skills/a',
  })
  assert.deepEqual(installedSkillAt('org/web/.agents/skills/a'), {
    repo: 'web',
    dir: '.agents/skills/a',
  })
  assert.deepEqual(installedSkillAt('.claude/skills/a/x/y.md'), {
    repo: null,
    dir: '.claude/skills/a',
  })
  for (const no of [
    '.claude/skills',
    'org/web/src/.claude/skills/a/SKILL.md',
    'org/web/claude/skills/a/SKILL.md',
    '.claude/settings.json',
  ])
    assert.equal(installedSkillAt(no), null, no)
})

test('skillCopyAt: the skill of a path of .rness; `scopes` is no skill name', () => {
  assert.deepEqual(skillCopyAt('skills/a/SKILL.md'), { scope: null, name: 'a' })
  assert.deepEqual(skillCopyAt('skills/scopes/web/a/x.md'), {
    scope: 'web',
    name: 'a',
  })
  for (const no of [
    'skills/scopes/web',
    'skills/scopes',
    'skills',
    'specs/a.md',
  ])
    assert.equal(skillCopyAt(no), null, no)
  assert.equal(skillHome('a', null), '.rness/skills/a')
  assert.equal(skillHome('a', 'web'), '.rness/skills/scopes/web/a')
})

test('installedSkillAt: a team skill inside the plugin is its own directory, not the plugin', () => {
  assert.deepEqual(
    installedSkillAt('org/web/.claude/skills/rness/skills/release/SKILL.md'),
    { repo: 'web', dir: '.claude/skills/rness/skills/release' }
  )
  assert.deepEqual(installedSkillAt('.claude/skills/rness/skills/release'), {
    repo: null,
    dir: '.claude/skills/rness/skills/release',
  })
  assert.deepEqual(installedSkillAt('.claude/skills/deploy/SKILL.md'), {
    repo: null,
    dir: '.claude/skills/deploy',
  })
})
