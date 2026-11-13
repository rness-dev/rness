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
    '`../../.rness/`: start at its `AGENTS.md`, then task-relevant `adr/`, `specs/`, `plans/`;',
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
    /^This is the root of rness workspace `acme`\. Full context lives in `\.rness\/`:/
  )
  assert.match(body, /Every `org\/<repo>\/` carries its own block/)
  assert.match(body, /start at its `AGENTS\.md`, then task-relevant/)
  assert.doesNotMatch(body, /\.\.\//)
})

test('no intro names STATUS.md: neither the scaffold nor the CLI writes one', () => {
  for (const scope of ['web', null]) {
    const block = renderBlock({
      scope,
      org: 'acme',
      depth: scope === null ? 0 : 2,
      context: twoStandards,
    })
    assert.doesNotMatch(block.text, /STATUS\.md/)
  }
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

// --- the Policies section (spec 0040 4.1) ------------------------------------

function withPolicies(
  base: Context,
  files: Array<{ rel: string; body: string }>
): Context {
  return {
    ...base,
    collections: [
      ...base.collections,
      {
        name: 'policy',
        files: files.map((f) => ({
          rel: f.rel,
          scope: null,
          title: null,
          body: f.body,
          content: f.body,
        })),
      },
    ],
  }
}

const NO_EM_DASH = `---
status: Enabled
standard: standards/coding.md
rules:
  - check: added-lines
    deny: '\\u2014'
    fix: Replace the em dash with a hyphen, a comma or a colon.
  - check: commit-message
    deny: '\\u2014'
    fix: Reword the message without an em dash.
---

# No em dash

It reads as AI-generated.
`

const NO_FORCE_PUSH = `---
status: Enabled
rules:
  - check: push
    deny: non-fast-forward
    fix: Push a new commit instead of rewriting history.
---

# No force push
`

const DISABLED = NO_FORCE_PUSH.replace('Enabled', 'Disabled').replace(
  'No force push',
  'Dormant'
)

const render = (context: Context) =>
  renderBlock({ scope: 'web', org: 'acme', depth: 2, context })

test('no enabled policy: no Policies section, the same bytes and hash as before', () => {
  const before = render(twoStandards)
  const none = render(withPolicies(twoStandards, []))
  const off = render(
    withPolicies(twoStandards, [{ rel: 'dormant.md', body: DISABLED }])
  )
  assert.doesNotMatch(before.text, /## Policies/)
  assert.equal(none.text, before.text)
  assert.equal(off.text, before.text)
  assert.equal(off.hash, before.hash)
})

test('the Policies section follows Rules: marker, title, one line per rule, the standard, the reason', () => {
  const block = render(
    withPolicies(twoStandards, [{ rel: 'no-em-dash.md', body: NO_EM_DASH }])
  )
  const body = bodyOf(block.text.split('\n'))
  assert.ok(
    body.endsWith(
      [
        '## Policies',
        '<!-- rness: policy/no-em-dash.md -->',
        '# No em dash',
        '- Refused at commit and on edit (added lines): Replace the em dash with a hyphen, a comma or a colon.',
        '- Refused at commit (the message): Reword the message without an em dash.',
        '- Standard: `standards/coding.md`',
        '',
        'It reads as AI-generated.',
      ].join('\n')
    ),
    body
  )
  assert.ok(body.indexOf('## Rules') < body.indexOf('## Policies'))
  assert.equal(block.hash, blockHash(body))
  assert.ok(!block.text.includes('\u2014'))
})

test('only the enabled policies are listed, in the order the context gives; a push rule names its refusal', () => {
  const block = render(
    withPolicies(twoStandards, [
      { rel: 'no-force-push.md', body: NO_FORCE_PUSH },
      { rel: 'dormant.md', body: DISABLED },
      { rel: 'no-em-dash.md', body: NO_EM_DASH },
    ])
  )
  assert.match(
    block.text,
    /<!-- rness: policy\/no-force-push\.md -->\n# No force push\n- Refused at push \(non-fast-forward\): Push a new commit instead of rewriting history\.\n\n<!-- rness: policy\/no-em-dash\.md -->/
  )
  assert.doesNotMatch(block.text, /Dormant|dormant/)
  assert.notEqual(block.hash, render(twoStandards).hash)
})

// --- the Team skills section (spec 0041 §7) -----------------------------------

const skillsOf = (...names: string[]) =>
  names.map((name) => ({ name, description: `Does ${name}.` }))

test('team skills: no skill, the same bytes and hash as before', () => {
  const base = { scope: 'web', org: 'acme', depth: 2, context: twoStandards }
  const before = renderBlock(base)
  for (const skills of [undefined, []] as const) {
    const again = renderBlock({ ...base, ...(skills ? { skills } : {}) })
    assert.equal(again.text, before.text)
    assert.equal(again.hash, before.hash)
  }
  assert.doesNotMatch(before.text, /Team skills/)
})

test('team skills: the section follows Policies, one line per skill, then the install line', () => {
  const policy = `---\nstatus: Enabled\nrules:\n  - check: push\n    deny: non-fast-forward\n    fix: Push a new commit.\n---\n\n# No force push\n`
  const context: Context = {
    ...twoStandards,
    collections: [
      ...twoStandards.collections.filter((c) => c.name !== 'policy'),
      {
        name: 'policy',
        files: [
          {
            rel: 'p.md',
            scope: null,
            body: policy,
            title: null,
            content: policy,
          },
        ],
      },
    ],
  }
  const withSkills = renderBlock({
    scope: 'web',
    org: 'acme',
    depth: 2,
    context,
    skills: skillsOf('deploy', 'release'),
  })
  const body = bodyOf(withSkills.text.split('\n'))
  assert.ok(body.indexOf('## Policies') < body.indexOf('## Team skills'))
  assert.ok(
    body.endsWith(
      [
        '## Team skills',
        '- deploy: Does deploy.',
        '- release: Does release.',
        "Installed with each developer's consent: `rness skill install`.",
      ].join('\n')
    ),
    body
  )
  assert.equal(withSkills.hash, blockHash(body))
})

test('team skills: the root block carries the section too', () => {
  const root = renderBlock({
    scope: null,
    org: 'acme',
    depth: 0,
    context: twoStandards,
    skills: skillsOf('deploy'),
  })
  assert.match(root.text, /\n## Team skills\n- deploy: Does deploy\.\n/)
})

test('team skills: an @ that would load a file is escaped, a description without @ is unchanged', () => {
  const base = { scope: 'web', org: 'acme', depth: 2, context: twoStandards }
  const line = (description: string): string =>
    (
      renderBlock({ ...base, skills: [{ name: 'deploy', description }] })
        .text.split('\n')
        .find((l) => l.startsWith('- deploy: ')) ?? ''
    ).slice('- deploy: '.length)
  // Claude Code loads `@path` at the start or after whitespace (ruling R28).
  assert.equal(line('@.env first'), '\\@.env first')
  assert.equal(
    line('Reads @.env for the target'),
    'Reads \\@.env for the target'
  )
  assert.equal(line('x @y and\u00a0@z'), 'x \\@y and\u00a0\\@z')
  // Not a reference: mid-word, already escaped, or no @ at all.
  assert.equal(line('mail me@example.com'), 'mail me@example.com')
  assert.equal(line('Deploys the app.'), 'Deploys the app.')
  const plain = renderBlock({
    ...base,
    skills: [{ name: 'deploy', description: 'Deploys the app.' }],
  })
  assert.match(plain.text, /\n- deploy: Deploys the app\.\n/)
})
