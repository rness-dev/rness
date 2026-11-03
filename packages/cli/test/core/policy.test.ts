import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { assembleContext } from '../../src/core/context.ts'
import { checkContract } from '../../src/core/contract.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import {
  POLICY_CHECKS,
  POLICY_KEYS,
  POLICY_STATUSES,
  RULE_KEYS,
  policiesFor,
  policiesNotApplied,
  policiesOf,
  readPolicy,
} from '../../src/core/policy.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// The three policies of spec 0040 §2.1, as a workspace writes them. The em
// dash is named by its escape: `\u2014` in the YAML, compiled with `u`.
const NO_TRAILERS = `---
status: Enabled
rules:
  - check: commit-message
    deny: '^co-authored-by: .*(claude|codex|cursor)'
    fix: Remove the agent's Co-Authored-By trailer, then commit again.
  - check: commit-message
    deny: '^claude-session:'
    fix: Remove the Claude-Session trailer, then commit again.
---

# No agent trailers

Commits are attributed to the developer who reviews them. Agents add their
own trailer by default; this workspace does not keep it.
`

const NO_EM_DASH = `---
status: Enabled
standard: standards/documentation.md
rules:
  - check: commit-message
    deny: '\\u2014'
    fix: Write " - ", a comma, a colon or a period instead of the em dash.
  - check: added-lines
    deny: '\\u2014'
    fix: Write " - ", a comma, a colon or a period instead of the em dash.
---

# No em dash
`

const NO_FORCE_PUSH = `---
status: Disabled
rules:
  - check: push
    deny: non-fast-forward
    fix: Rebase on the remote branch and push again, or push a new branch.
---

# No force push

Rewriting a shared branch breaks the clones of everyone who pulled it.
`

/** A policy file: its front matter from line 2, then its title. */
const policy = (front: string, title = 'A policy', body = '') =>
  `---\n${front}---\n\n# ${title}\n${body}`

const RULE = 'rules:\n  - check: commit-message\n    deny: x\n    fix: Do y.\n'

/** The problems of one file read alone (the workspace checks aside). */
const problemsOf = (rel: string, text: string) => readPolicy(rel, text).problems

// --- reading one policy -----------------------------------------------------

test('a policy: its name, path, scope, title, status, standard, rules and the body after its heading', () => {
  const read = readPolicy('policy/no-agent-trailers.md', NO_TRAILERS)
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.policy, {
    name: 'no-agent-trailers',
    rel: 'policy/no-agent-trailers.md',
    scope: null,
    title: 'No agent trailers',
    status: 'Enabled',
    standard: null,
    rules: [
      {
        check: 'commit-message',
        deny: '^co-authored-by: .*(claude|codex|cursor)',
        fix: "Remove the agent's Co-Authored-By trailer, then commit again.",
      },
      {
        check: 'commit-message',
        deny: '^claude-session:',
        fix: 'Remove the Claude-Session trailer, then commit again.',
      },
    ],
    body: 'Commits are attributed to the developer who reviews them. Agents add their\nown trailer by default; this workspace does not keep it.',
  })
  const scoped = readPolicy('policy/web/no-em-dash.md', NO_EM_DASH).policy
  assert.equal(scoped?.scope, 'web')
  assert.equal(scoped?.standard, 'standards/documentation.md')
  assert.equal(scoped?.body, '')
})

test('a pattern compiles with the flags iu: \\u2014 names the em dash, and case is ignored', () => {
  const [rule] =
    readPolicy('policy/no-em-dash.md', NO_EM_DASH).policy?.rules ?? []
  assert.ok(rule !== undefined)
  assert.match('a \u2014 b', new RegExp(rule.deny, 'iu'))
  const [trailer] =
    readPolicy('policy/no-agent-trailers.md', NO_TRAILERS).policy?.rules ?? []
  assert.ok(trailer !== undefined)
  assert.match(
    'Co-authored-by: Claude <noreply@anthropic.com>',
    new RegExp(trailer.deny, 'iu')
  )
})

test('a disabled policy is valid too: the scaffold example passes', () => {
  const read = readPolicy('policy/no-force-push.md', NO_FORCE_PUSH)
  assert.deepEqual(read.problems, [])
  assert.equal(read.policy?.status, 'Disabled')
})

test('a policy with any problem of its own is not read: no policy, its problems', () => {
  const read = readPolicy('policy/x.md', policy(`status: On\n${RULE}`))
  assert.equal(read.policy, null)
  assert.deepEqual(read.problems, [
    'policy/x.md:2: unknown status "On" (expected Enabled, Disabled)',
  ])
})

// --- validate: each refusal of spec 0040 §7, with its line -----------------

test('refused: a key outside the format, a missing status or rules, a status other than Enabled or Disabled', () => {
  assert.deepEqual(
    problemsOf(
      'policy/x.md',
      policy(`status: Enabled\ntitle: X\n${RULE}scopes: web\n`)
    ),
    [
      'policy/x.md:3: unknown key "title" (expected status, rules, standard, date, updated)',
      'policy/x.md:8: unknown key "scopes" (expected status, rules, standard, date, updated)',
    ]
  )
  assert.deepEqual(problemsOf('policy/x.md', policy('date: 2026-11-03\n')), [
    'policy/x.md:1: missing "status" (Enabled or Disabled)',
    'policy/x.md:1: missing "rules", a list of one rule or more',
  ])
  assert.deepEqual(
    problemsOf('policy/x.md', policy(`status: enabled\n${RULE}`)),
    ['policy/x.md:2: unknown status "enabled" (expected Enabled, Disabled)']
  )
  assert.deepEqual(problemsOf('policy/x.md', policy('status:\nrules: []\n')), [
    'policy/x.md:1: missing "status" (Enabled or Disabled)',
    'policy/x.md:3: "rules" must be a list of one rule or more',
  ])
  assert.deepEqual(
    problemsOf('policy/x.md', policy('status: Enabled\nrules: none\n')),
    ['policy/x.md:3: "rules" must be a list of one rule or more']
  )
})

test('refused: a rule without check, deny or fix, an unknown rule key, a rule that is no mapping', () => {
  const text = policy(
    [
      'status: Enabled',
      'rules:',
      '  - deny: x',
      '    fix: Do y.',
      '  - check: added-lines',
      "    deny: ''",
      '    fix: Do y.',
      '  - check: added-lines',
      '    deny: x',
      '  - check: added-lines',
      '    deny: x',
      '    fix: Do y.',
      '    when: always',
      '  - commit-message',
      '',
    ].join('\n')
  )
  assert.deepEqual(problemsOf('policy/x.md', text), [
    'policy/x.md:4: a rule without "check"',
    'policy/x.md:6: a rule without "deny"',
    'policy/x.md:9: a rule without "fix"',
    'policy/x.md:14: unknown rule key "when" (expected check, deny, fix)',
    'policy/x.md:15: a rule is a mapping of check, deny and fix',
  ])
})

test('refused: a check outside the three, a push rule other than non-fast-forward, values that are not strings', () => {
  const text = policy(
    [
      'status: Enabled',
      'rules:',
      '  - check: commit',
      '    deny: x',
      '    fix: Do y.',
      '  - check: push',
      '    deny: force',
      '    fix: Do y.',
      '  - check: added-lines',
      '    deny: 3.10',
      '    fix: no',
      '',
    ].join('\n')
  )
  assert.deepEqual(problemsOf('policy/x.md', text), [
    'policy/x.md:4: unknown check "commit" (expected commit-message, added-lines, push)',
    'policy/x.md:8: a push rule denies non-fast-forward, nothing else (not "force")',
    'policy/x.md:11: "deny" must be a string: quote it',
  ])
})

test('refused: a pattern that does not compile with iu, one valid only without u among them', () => {
  const text = policy(
    [
      'status: Enabled',
      'rules:',
      '  - check: added-lines',
      "    deny: '('",
      '    fix: Do y.',
      '  - check: commit-message',
      "    deny: 'a{'",
      '    fix: Do y.',
      '',
    ].join('\n')
  )
  assert.doesNotThrow(() => new RegExp('a{'), 'valid without u')
  const problems = problemsOf('policy/x.md', text)
  assert.equal(problems.length, 2, problems.join('\n'))
  assert.match(
    problems[0] ?? '',
    /^policy\/x\.md:5: "deny" does not compile with the flags iu \(Invalid regular expression: .+\)$/
  )
  assert.match(
    problems[1] ?? '',
    /^policy\/x\.md:8: "deny" does not compile with the flags iu \(/
  )
})

test('refused: a fix on more than one line', () => {
  const text = policy(
    [
      'status: Enabled',
      'rules:',
      '  - check: added-lines',
      '    deny: x',
      '    fix: |',
      '      Do y,',
      '      then z.',
      '',
    ].join('\n')
  )
  assert.deepEqual(problemsOf('policy/x.md', text), [
    'policy/x.md:6: "fix" must be one line: it is what the agent reads',
  ])
})

test('refused: a standard outside standards/, a date that is not ISO', () => {
  assert.deepEqual(
    problemsOf(
      'policy/x.md',
      policy(
        `status: Enabled\nstandard: specs/0001-a.md\ndate: 3 November\nupdated: 2026-11-03\n${RULE}`
      )
    ),
    [
      'policy/x.md:3: "standard" must be the path of a standard of .rness, as standards/<name>.md',
      'policy/x.md:4: "date" must be an ISO date (YYYY-MM-DD)',
    ]
  )
})

test('refused: a file name that is not lowercase words joined by hyphens, a policy deeper than its scope', () => {
  const text = policy(`status: Enabled\n${RULE}`)
  for (const name of ['NoEmDash', 'no_em_dash', 'no-em-dash-', 'no--dash'])
    assert.deepEqual(problemsOf(`policy/${name}.md`, text), [
      `policy/${name}.md: "${name}" is no policy name: lowercase words joined by hyphens, as no-force-push`,
    ])
  assert.deepEqual(problemsOf('policy/web/old/no-em-dash.md', text), [
    'policy/web/old/no-em-dash.md: a policy is policy/<name>.md or policy/<scope>/<name>.md',
  ])
  assert.deepEqual(problemsOf('policy/utf8-only.md', text), [])
})

test('refused: no front matter, no title', () => {
  assert.deepEqual(problemsOf('policy/x.md', '# X\n'), [
    'policy/x.md: missing a front-matter block',
  ])
  // A YAML comment is no title: the heading is the body's.
  assert.deepEqual(
    problemsOf(
      'policy/x.md',
      `---\n# X\nstatus: Enabled\n${RULE}---\n\nNo heading.\n`
    ),
    ['policy/x.md: missing a "# " title']
  )
})

// --- the YAML fence (ADR 0011): 1.2 core, nothing more ---------------------

test('refused, each on its line: anchors, aliases, custom tags, merge keys, duplicate keys', () => {
  const text = policy(
    [
      'status: Enabled',
      'rules:',
      '  - &rule',
      '    check: added-lines',
      '    deny: x',
      '    fix: !shout Do y.',
      '  - *rule',
      '  - <<: {check: push}',
      '    deny: non-fast-forward',
      '    fix: Do y.',
      'status: Disabled',
      '',
    ].join('\n')
  )
  assert.deepEqual(problemsOf('policy/x.md', text), [
    "policy/x.md:4: an anchor (&rule) is refused: a policy's front matter is YAML 1.2 core, nothing more",
    "policy/x.md:7: a custom tag (!shout) is refused: a policy's front matter is YAML 1.2 core, nothing more",
    "policy/x.md:8: an alias (*rule) is refused: a policy's front matter is YAML 1.2 core, nothing more",
    "policy/x.md:9: a merge key (<<) is refused: a policy's front matter is YAML 1.2 core, nothing more",
    'policy/x.md:12: a duplicate key ("status") is refused: a policy\'s front matter is YAML 1.2 core, nothing more',
  ])
})

test('a core tag is YAML 1.2 core: !!str 3.10 is a string', () => {
  const read = readPolicy(
    'policy/x.md',
    policy(
      'status: Enabled\nrules:\n  - check: added-lines\n    deny: !!str 3.10\n    fix: Do y.\n'
    )
  )
  assert.deepEqual(read.problems, [])
  assert.equal(read.policy?.rules[0]?.deny, '3.10')
})

test('refused: YAML that does not parse, with its line', () => {
  const problems = problemsOf(
    'policy/x.md',
    policy('status: Enabled\nrules: [\n')
  )
  assert.ok(problems.length > 0)
  for (const p of problems)
    assert.match(p, /^policy\/x\.md:\d+: invalid front matter \(.+\)$/)
  assert.deepEqual(problemsOf('policy/x.md', policy('- status\n- rules\n')), [
    'policy/x.md:2: the front matter must be a mapping of keys to values',
  ])
})

// --- in the contract: validate and the guard see it ------------------------

const STANDARD = '# Documentation\n\nNo em dash.\n'

test('checkContract: the three policies of spec 0040 pass, and a policy is never "not numbered"', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'standards/documentation.md': STANDARD,
      'policy/no-agent-trailers.md': NO_TRAILERS,
      'policy/no-em-dash.md': NO_EM_DASH,
      'policy/no-force-push.md': NO_FORCE_PUSH,
      'policy/0001-numbered.md': NO_FORCE_PUSH,
    },
  })
  assert.deepEqual(await checkContract(join(root, '.rness')), [])
})

test('checkContract: a standard that is not there, a name both global and scoped, the problems of a file', async (t) => {
  const root = await makeWorkspace(t, {
    scopes: { web: { path: 'org/web' }, api: { path: 'org/api' } },
    files: {
      'policy/no-em-dash.md': NO_EM_DASH,
      'policy/web/no-em-dash.md': NO_TRAILERS,
      // Two scopes may each have their own: only a scoped one beside a global one is refused.
      'policy/web/no-agent-trailers-web.md': NO_TRAILERS,
      'policy/api/no-agent-trailers-web.md': NO_TRAILERS,
      'policy/web/bad.md': policy(`status: On\n${RULE}`),
    },
  })
  assert.deepEqual(await checkContract(join(root, '.rness')), [
    'policy/no-em-dash.md:3: "standard" names standards/documentation.md, which is not there',
    'policy/no-em-dash.md: the name no-em-dash is also that of policy/web/no-em-dash.md: a policy is global or scoped, never both',
    'policy/web/bad.md:2: unknown status "On" (expected Enabled, Disabled)',
    'policy/web/no-em-dash.md: the name no-em-dash is also that of policy/no-em-dash.md: a policy is global or scoped, never both',
  ])
})

test('checkContract: a policy read from an override, as the guard checks an edit', async (t) => {
  const root = await makeWorkspace(t, {
    files: { 'policy/no-force-push.md': NO_FORCE_PUSH },
  })
  const rnessDir = join(root, '.rness')
  assert.deepEqual(
    await checkContract(rnessDir, {
      rel: 'policy/no-force-push.md',
      text: NO_FORCE_PUSH.replace('deny: non-fast-forward', 'deny: force'),
    }),
    [
      'policy/no-force-push.md:5: a push rule denies non-fast-forward, nothing else (not "force")',
    ]
  )
  assert.deepEqual(await checkContract(rnessDir), [])
})

// --- resolution: as the other collections -----------------------------------

const enabled = (title: string) => policy(`status: Enabled\n${RULE}`, title)
const disabled = (title: string) => policy(`status: Disabled\n${RULE}`, title)

async function scoped(t: TestContext) {
  const root = await makeWorkspace(t, {
    scopes: {
      platform: { path: 'org/platform' },
      web: { path: 'org/platform/web', extends: ['platform'] },
      api: { path: 'org/api' },
    },
    files: {
      'policy/global-on.md': enabled('Global on'),
      'policy/global-off.md': disabled('Global off'),
      'policy/platform/platform-on.md': enabled('Platform on'),
      'policy/web/web-on.md': enabled('Web on'),
      'policy/web/web-off.md': disabled('Web off'),
      'policy/api/api-on.md': enabled('Api on'),
      'policy/web/broken.md': policy(`status: Enabled\n${RULE}x: &a 1\n`),
      // A directory that is no scope belongs nowhere.
      'policy/misc/misc-on.md': enabled('Misc on'),
    },
  })
  const rnessDir = join(root, '.rness')
  return { rnessDir, manifest: await loadManifest(rnessDir) }
}

test('policiesFor: the enabled policies of a scope, what it extends and the global ones, nearest first', async (t) => {
  const ws = await scoped(t)
  assert.deepEqual(
    (await policiesFor(ws, ['web'])).map((p) => [p.rel, p.scope]),
    [
      ['policy/web/web-on.md', 'web'],
      ['policy/platform/platform-on.md', 'platform'],
      ['policy/global-on.md', null],
    ]
  )
  assert.deepEqual(
    (await policiesFor(ws, [])).map((p) => p.rel),
    ['policy/global-on.md']
  )
})

test('policiesFor: several scopes at once, each policy once; the disabled ones on request', async (t) => {
  const ws = await scoped(t)
  assert.deepEqual(
    (await policiesFor(ws, ['web', 'api', 'platform'])).map((p) => p.name),
    ['web-on', 'platform-on', 'api-on', 'global-on']
  )
  assert.deepEqual(
    (await policiesFor(ws, ['web'], { withDisabled: true })).map((p) => [
      p.name,
      p.status,
    ]),
    [
      ['web-off', 'Disabled'],
      ['web-on', 'Enabled'],
      ['platform-on', 'Enabled'],
      ['global-off', 'Disabled'],
      ['global-on', 'Enabled'],
    ]
  )
})

test('policiesNotApplied: the invalid files of the scopes, but those that say Disabled', async (t) => {
  const ws = await scoped(t)
  await writeFile(
    join(ws.rnessDir, 'policy', 'web', 'broken-off.md'),
    policy(`status: Disabled\n${RULE}x: 1\n`)
  )
  await writeFile(
    join(ws.rnessDir, 'policy', 'unreadable.md'),
    '---\nstatus: [\n---\n\n# Unreadable\n'
  )
  assert.deepEqual(await policiesNotApplied(ws, ['web']), [
    'policy/web/broken.md',
    'policy/unreadable.md',
  ])
  assert.deepEqual(await policiesNotApplied(ws, ['api']), [
    'policy/unreadable.md',
  ])
  // The valid ones still apply.
  assert.ok((await policiesFor(ws, ['web'])).some((p) => p.name === 'web-on'))
})

test('policiesOf: the policies of a context already assembled, as the block gets it', async (t) => {
  const ws = await scoped(t)
  const context = await assembleContext({ ...ws, scope: 'api' })
  assert.deepEqual(
    policiesOf(context).map((p) => p.rel),
    ['policy/api/api-on.md', 'policy/global-on.md']
  )
  assert.deepEqual(
    policiesOf(context, { withDisabled: true }).map((p) => p.name),
    ['api-on', 'global-off', 'global-on']
  )
})

// --- the JSON Schema: the published contract says what the code checks ----

const packageDir = new URL('../../', import.meta.url)

test('the JSON Schema of the front matter ships with the package and names what validate checks', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('package.json', packageDir), 'utf8')
  ) as { files: string[] }
  assert.ok(pkg.files.includes('schema'), pkg.files.join(', '))
  const schema = JSON.parse(
    await readFile(new URL('schema/policy.schema.json', packageDir), 'utf8')
  )
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['status', 'rules'])
  assert.deepEqual(Object.keys(schema.properties), [...POLICY_KEYS])
  assert.deepEqual(schema.properties.status.enum, [...POLICY_STATUSES])
  const rule = schema.$defs.rule
  assert.equal(rule.additionalProperties, false)
  assert.deepEqual(rule.required, [...RULE_KEYS])
  assert.deepEqual(Object.keys(rule.properties), [...RULE_KEYS])
  assert.deepEqual(rule.properties.check.enum, [...POLICY_CHECKS])
  assert.deepEqual(rule.then.properties.deny.const, 'non-fast-forward')
})
