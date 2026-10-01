import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/**
 * The one skill published for skills.sh (spec 0027 §5): `skills/rness/SKILL.md`
 * at the repository root, where `npx skills add rness-dev/rness` looks. It
 * says when to use Rness and how to install and run it; the Agent Skills
 * rules bound its name and description.
 */
const SKILL = new URL('../../../skills/rness/SKILL.md', import.meta.url)

async function skill(): Promise<{
  fields: Record<string, string>
  body: string
}> {
  const text = await readFile(SKILL, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  assert.ok(match, 'SKILL.md starts with front matter')
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const at = line.indexOf(':')
    assert.ok(at > 0, `a front matter line is "key: value": ${line}`)
    fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return { fields, body: match[2]! }
}

test('the rness skill has the name and description Agent Skills require', async () => {
  const { fields } = await skill()
  assert.equal(fields['name'], 'rness')
  assert.match(fields['name']!, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  const description = fields['description']!
  assert.ok(description.length > 0 && description.length <= 1024)
  assert.match(description, /Use when /)
  assert.deepEqual(Object.keys(fields), ['name', 'description'])
})

test('the rness skill says when to use Rness and how to install and run it', async () => {
  const { body } = await skill()
  assert.match(body, /^# Rness$/m)
  assert.match(body, /^## When to use$/m)
  assert.match(body, /^## How$/m)
  assert.match(body, /npm create rness/)
  assert.match(body, /rness sync/)
  assert.match(body, /https:\/\/rness\.dev\/docs/)
})
