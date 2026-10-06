import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  pulseCreateCommand,
  pulseRunCommand,
} from '../../src/commands/pulse.ts'
import type { Terminal } from '../../src/core/terminal.ts'
import { takeFailure } from '../../src/pulse/detached.ts'
import {
  recordStart,
  startOf,
  takeNotices,
} from '../../src/pulse/journal-state.ts'
import { pulseNoteCommand, sessionFrom } from '../../src/pulse/note.ts'
import { capture } from '../helpers/capture.ts'
import { type Reply, withEnv } from '../helpers/fake-github.ts'
import { board } from '../helpers/fake-project.ts'
import { commitDir, git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}
const asUser = (r: { method: string; path: string }): Reply | undefined =>
  r.method === 'GET' && r.path === '/user'
    ? {
        json: { login: 'octo' },
        headers: { 'X-OAuth-Scopes': 'repo, read:org, project' },
      }
    : undefined

const doc = (status: string, title: string, extra = '') =>
  `---\nstatus: ${status}\n${extra}---\n\n# ${title}\n`
const FILES = {
  'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
  'plans/0002-limits.md': doc(
    'In progress',
    '0002 — Limits',
    "spec: '[0001](../specs/0001-limits.md)'\n"
  ),
}
const PLAN = 'plans/0002-limits.md'
const SESSION = 'claude · 1a2b3c4d'

async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-note-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GITHUB_TOKEN: 'tok',
    GH_TOKEN: undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
  })
}

/**
 * Agent Pulse made and synced, its journal `to` as given, the clone `api`
 * on branch `feat/limits`; `.rness` a repository, for the count.
 */
async function journaled(
  t: TestContext,
  opts: {
    to?: 'plan' | 'repo'
    limit?: number
    url?: string
    repositories?: Record<string, { issues?: boolean; writable?: boolean }>
    subIssues?: boolean
    comments?: boolean
    pullRequests?: {
      repository: string
      head: string
      number: number
      state: string
    }[]
    files?: Record<string, string>
  } = {}
) {
  await machine(t)
  const g = await board(t, {
    other: asUser,
    memory: { label: false, linked: false },
    repositories: opts.repositories ?? { api: {} },
    ...(opts.subIssues === undefined ? {} : { subIssues: opts.subIssues }),
    ...(opts.comments === undefined ? {} : { comments: opts.comments }),
    ...(opts.pullRequests === undefined
      ? {}
      : { pullRequests: opts.pullRequests }),
  })
  const root = await makeWorkspace(t, {
    org: 'acme',
    // Written, as a team whose repository lives elsewhere writes it.
    provider: 'github',
    repos: { api: { url: opts.url ?? 'git@github.com:acme/api.git' } },
    scopes: { api: { path: 'org/api' } },
    files: opts.files ?? FILES,
    dirs: ['org/api'],
  })
  const c = capture()
  try {
    assert.equal(
      await pulseCreateCommand(
        { cwd: root, yes: true, githubApi: g.base },
        { terminal: NO_TTY }
      ),
      0
    )
  } finally {
    c.restore()
  }
  const file = join(root, '.rness', 'rness.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.projects.pulse.hooks = {
    ...manifest.projects.pulse.hooks,
    'session-start': [
      'mark-in-progress',
      {
        action: 'journal',
        to: opts.to ?? 'repo',
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      },
    ],
    'session-end': ['clear-marks', 'journal-summary'],
  }
  await writeFile(file, JSON.stringify(manifest, null, 2))
  await commitDir(join(root, '.rness'))
  const api = join(root, 'org', 'api')
  await writeFile(join(api, 'README.md'), '# api\n')
  await commitDir(api)
  await git(['checkout', '-q', '-b', 'feat/limits'], api)
  g.mutations.length = 0
  return { g, root, api }
}

async function note(
  g: { base: string },
  cwd: string,
  opts: { text?: string; kind?: string; plan?: string; stdin?: string } = {}
) {
  const c = capture()
  try {
    const code = await pulseNoteCommand({
      cwd,
      githubApi: g.base,
      session: SESSION,
      ...(opts.text === undefined && opts.stdin === undefined
        ? { text: 'Chose a token bucket over a fixed window.' }
        : {}),
      ...(opts.text === undefined ? {} : { text: opts.text }),
      ...(opts.kind === undefined ? {} : { kind: opts.kind }),
      ...(opts.plan === undefined ? {} : { plan: opts.plan }),
      ...(opts.stdin === undefined
        ? {}
        : { stdin: async () => opts.stdin ?? '' }),
    })
    return { code, out: c.out().trim(), err: c.err().trim() }
  } finally {
    c.restore()
  }
}

test('the session: as named, from a session id, else from CLAUDE_CODE_SESSION_ID; none without', () => {
  assert.equal(
    sessionFrom('claude · reviewer · 1a2b3c4d', {}),
    'claude · reviewer · 1a2b3c4d'
  )
  assert.equal(sessionFrom('1a2b3c4d-5e6f', {}), 'claude · 1a2b3c4d')
  assert.equal(
    sessionFrom(undefined, { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-…' }),
    'claude · 9f8e7d6c'
  )
  assert.equal(sessionFrom(undefined, {}), null)
})

test("to the repository: the implementation issue made once — labelled, its marker last, a sub-issue of the plan's — then found again; each note a comment, the reference printed", async (t) => {
  const { g, api } = await journaled(t)
  const first = await note(g, api)
  assert.equal(first.code, 0, first.err)
  const impl = g.issues.find((i) => i.repository === 'acme/api')
  assert.ok(impl !== undefined)
  assert.equal(first.out, `acme/api#${impl.number}`)
  assert.equal(impl.title, 'Implement 0002 — Limits')
  assert.deepEqual(impl.labels, ['rness:plan'])
  assert.match(impl.body, /^Plan \[`plans\/0002-limits\.md`\]\(/)
  assert.match(impl.body, /\nSpecification \[`specs\/0001-limits\.md`\]\(/)
  assert.match(impl.body, /\n<!-- rness journal plans\/0002-limits\.md -->\n$/)
  const plan = g.issues.find((i) => i.title === '0002 — Limits')
  assert.deepEqual(g.subIssues, [{ parent: plan?.id, child: impl.id }])
  assert.match(
    g.comments[0]?.body ?? '',
    /^\*\*Approach\*\* · claude · 1a2b3c4d · `feat\/limits` @ `[0-9a-f]{7}`\n\nChose a token bucket over a fixed window\.\n\n<!-- rness note 1a2b3c4d -->$/
  )
  const second = await note(g, api, {
    kind: 'deviation',
    stdin: 'Kept the old header.\n',
  })
  assert.equal(second.code, 0, second.err)
  assert.equal(second.out, first.out, 'the same issue')
  assert.equal(g.issues.filter((i) => i.repository === 'acme/api').length, 1)
  assert.match(g.comments[1]?.body ?? '', /^\*\*Deviation\*\* · /)
  assert.match(g.comments[1]?.body ?? '', /\n\nKept the old header\.\n\n/)
})

test("to the plan: the note on the plan's issue in .rness, nothing made elsewhere", async (t) => {
  const { g, api } = await journaled(t, { to: 'plan' })
  const r = await note(g, api, { kind: 'blocker' })
  assert.equal(r.code, 0, r.err)
  const plan = g.issues.find((i) => i.title === '0002 — Limits')
  assert.equal(r.out, `acme/.rness#${plan?.number}`)
  assert.equal(g.comments[0]?.subjectId, plan?.id)
  assert.equal(g.issues.filter((i) => i.repository === 'acme/api').length, 0)
})

test('a session in .rness or at the root has no repository: its note goes to the plan, with no line of why', async (t) => {
  const { g, root } = await journaled(t)
  const r = await note(g, root)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^acme\/\.rness#\d+$/)
  assert.doesNotMatch(g.comments[0]?.body ?? '', /^_/)
  assert.doesNotMatch(
    g.comments[0]?.body ?? '',
    /feat\/limits/,
    'no branch: the root is no repository'
  )
})

test("each fallback goes to the plan's issue, its first line naming why, and is said once at the next session start", async (t) => {
  for (const [opts, why] of [
    [{ repositories: { api: { issues: false } } }, 'acme/api takes no issues'],
    [
      { repositories: {} },
      'acme/api is not on GitHub, or this login cannot see it',
    ],
    [
      { repositories: { api: { writable: false } } },
      "acme/api refuses this login's write",
    ],
    [
      { url: 'git@gitlab.com:acme/api.git' },
      "api is not on the workspace's provider",
    ],
    [
      { url: 'git@github.com:other/api.git' },
      "api is not on the workspace's provider",
    ],
  ] as const) {
    const { g, api } = await journaled(t, opts)
    const r = await note(g, api)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^acme\/\.rness#\d+$/, why)
    assert.match(
      g.comments[0]?.body ?? '',
      new RegExp(
        `^_${why.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: this note goes to the plan's issue\\._\\n\\n\\*\\*Approach\\*\\*`
      )
    )
    assert.deepEqual(await takeNotices(), [
      `journal — ${why}, notes go to the plan's issue`,
    ])
  }
})

test('refusals, each in one line, nothing posted: the length, a credential, the kind, no plan, several, the limit', async (t) => {
  const { g, api, root } = await journaled(t, { to: 'plan', limit: 2 })
  for (const [opts, message] of [
    [{ text: '   ' }, 'rness: a note holds 1 to 4,000 characters (this one 0)'],
    [
      { text: 'x'.repeat(4001) },
      'rness: a note holds 1 to 4,000 characters (this one 4001)',
    ],
    [
      { kind: 'idea' },
      'rness: --kind is one of approach, deviation, blocker or done',
    ],
    [
      { plan: 'plans/0099-none.md' },
      'rness: plans/0099-none.md is no plan of .rness',
    ],
  ] as const) {
    const r = await note(g, api, opts)
    assert.equal(r.code, 1)
    assert.equal(r.err, message)
  }
  for (const secret of [
    'ghp_abc',
    'gho_abc',
    'github_pat_11ABC',
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'xoxb-123',
    'sk-abcdefghijklmnopqrstuvwx',
  ]) {
    const r = await note(g, api, { text: `the key is ${secret}` })
    assert.equal(
      r.err,
      'rness: the note looks like it holds a credential',
      secret
    )
  }
  assert.deepEqual(g.comments, [])
  // A near miss: words that are no credential.
  assert.equal(
    (await note(g, api, { text: 'Uses sk-learn and the ghp prefix rule.' }))
      .code,
    0
  )
  assert.equal((await note(g, api)).code, 0)
  const full = await note(g, api)
  assert.equal(full.code, 1)
  assert.equal(
    full.err,
    'rness: journal full for this session: put the rest in the pull request'
  )
  void root
})

test('no plan in progress, or several: refused, naming them', async (t) => {
  const none = await journaled(t, {
    to: 'plan',
    files: { 'plans/0002-limits.md': doc('Completed', '0002 — Limits') },
  })
  assert.equal(
    (await note(none.g, none.api)).err,
    'rness: no plan in progress in scope api: set one In progress first'
  )
  const two = await journaled(t, {
    to: 'plan',
    files: {
      'plans/0002-limits.md': doc('In progress', '0002 — Limits'),
      'plans/0003-more.md': doc('In progress', '0003 — More'),
    },
  })
  assert.equal(
    (await note(two.g, two.api)).err,
    'rness: several plans in progress: pass --plan, one of plans/0002-limits.md, plans/0003-more.md'
  )
  assert.equal((await note(two.g, two.api, { plan: PLAN })).code, 0)
})

test("a sub-issue GitHub refuses: the implementation issue kept, named on the plan's issue instead, the note posted", async (t) => {
  const { g, api } = await journaled(t, { subIssues: false })
  const r = await note(g, api)
  assert.equal(r.code, 0, r.err)
  const impl = g.issues.find((i) => i.repository === 'acme/api')
  const plan = g.issues.find((i) => i.title === '0002 — Limits')
  assert.equal(r.out, `acme/api#${impl?.number}`)
  assert.deepEqual(g.comments[0], {
    subjectId: plan?.id,
    body: `Implementation: acme/api#${impl?.number}`,
  })
  assert.equal(g.comments[1]?.subjectId, impl?.id)
})

// --- the session-end summary (spec 0030 §6) ---------------------------------

/** `pulse run session-end`, as the hook spawns it for a session in `api`. */
async function sessionEnd(g: { base: string }, root: string) {
  const c = capture()
  try {
    return await pulseRunCommand({
      cwd: root,
      githubApi: g.base,
      event: 'session-end',
      session: SESSION,
      paths: [],
      scope: 'api',
      clone: 'api',
    })
  } finally {
    c.restore()
  }
}

async function commitIn(dir: string, file: string): Promise<string> {
  await writeFile(join(dir, file), `${file}\n`)
  await git(['add', file], dir)
  await git(['commit', '-q', '-m', file], dir)
  return (await git(['rev-parse', '--short=7', 'HEAD'], dir)).trim()
}

test("summary with commits and a pull request, no note: on the one plan's issue, its duration, branch, commits and pull request; the start forgotten", async (t) => {
  const { g, root, api } = await journaled(t, {
    pullRequests: [
      {
        repository: 'acme/api',
        head: 'feat/limits',
        number: 91,
        state: 'OPEN',
      },
    ],
  })
  await recordStart(api, SESSION, Date.now() - 47 * 60_000)
  const shas = [await commitIn(api, 'a.ts'), await commitIn(api, 'b.ts')]
  assert.equal(await sessionEnd(g, root), 0)
  assert.equal(await takeFailure(), null)
  const plan = g.issues.find((i) => i.title === '0002 — Limits')
  const summaries = g.comments.filter((c) => c.body.includes('summary -->'))
  assert.deepEqual(summaries, [
    {
      subjectId: plan?.id,
      body: [
        '**Session summary** · claude · 1a2b3c4d · 47 min',
        '',
        `Branch \`feat/limits\` · 2 commits (\`${shas[0]}\`, \`${shas[1]}\`)`,
        'Pull request acme/api#91 (open)',
        '',
        '<!-- rness note 1a2b3c4d summary -->',
      ].join('\n'),
    },
  ])
  assert.equal(await startOf(api, SESSION), null)
})

test('summary with notes and no commit: on the issue the notes went to; it is no note of the limit', async (t) => {
  const { g, root, api } = await journaled(t, { limit: 1 })
  await recordStart(api, SESSION)
  const r = await note(g, api)
  assert.equal(r.code, 0, r.err)
  const impl = g.issues.find((i) => i.repository === 'acme/api')
  assert.equal(await sessionEnd(g, root), 0)
  assert.equal(await takeFailure(), null)
  const last = g.comments.at(-1)
  assert.equal(last?.subjectId, impl?.id)
  assert.match(
    last?.body ?? '',
    /^\*\*Session summary\*\* · claude · 1a2b3c4d · 1 min\n\nBranch `feat\/limits` · no commit\n\n<!-- rness note 1a2b3c4d summary -->$/
  )
  assert.equal(g.comments.length, 2)
})

test('summary skipped with neither a commit nor a note, or with several plans and no note; the start forgotten all the same', async (t) => {
  const { g, root, api } = await journaled(t)
  await recordStart(api, SESSION)
  assert.equal(await sessionEnd(g, root), 0)
  assert.deepEqual(g.comments, [])
  assert.equal(await startOf(api, SESSION), null)

  const several = await journaled(t, {
    files: {
      ...FILES,
      'plans/0003-more.md': doc('In progress', '0003 — More'),
    },
  })
  await recordStart(several.api, SESSION)
  await commitIn(several.api, 'c.ts')
  assert.equal(await sessionEnd(several.g, several.root), 0)
  assert.deepEqual(several.g.comments, [])
})

test('a summary GitHub refuses: recorded for the next session start, naming the board and the action', async (t) => {
  const { g, root, api } = await journaled(t, { comments: false })
  await recordStart(api, SESSION)
  await commitIn(api, 'a.ts')
  assert.equal(await sessionEnd(g, root), 0)
  assert.match(
    (await takeFailure()) ?? '',
    /^journal-summary on Agent Pulse failed: .*Resource not accessible by integration/
  )
})
