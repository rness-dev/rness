import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summariseSync } from '../../src/core/pinned.ts'
import { testGithubSsh } from '../../src/core/transport.ts'
import { type Session, plainUi, sessionUi } from '../../src/core/ui.ts'
import { capture } from '../helpers/capture.ts'

/** clack, scripted: every call is recorded as `kind: text`. */
function clack(): { p: Session; said: string[] } {
  const said: string[] = []
  const log = (kind: string) => (text: string) => {
    said.push(`${kind}: ${text}`)
  }
  const p = {
    intro: log('intro'),
    outro: log('outro'),
    cancel: log('cancel'),
    note: (body: string, title: string) => {
      said.push(`note[${title}]: ${body}`)
    },
    log: {
      step: log('step'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      message: log('message'),
      success: log('success'),
    },
    spinner: () => ({
      start: log('spin'),
      stop: log('stop'),
      error: log('spin-error'),
      cancel: log('spin-cancel'),
      message: log('spin-message'),
      clear: () => undefined,
      isCancelled: false,
    }),
  } as unknown as Session
  return { p, said }
}

test('the session look: a sentence per line, by tone, from intro to outro', () => {
  const { p, said } = clack()
  const ui = sessionUi(p)
  ui.intro('Create a workspace')
  ui.line('cloned', 'org/api')
  ui.line('using', 'ssh (github.com as octo)', 'SSH works for github.com')
  ui.line('unchanged', 'AGENTS.md')
  ui.line('stale', 'org/api/AGENTS.md')
  ui.warn('careful')
  ui.error('api: git clone failed')
  ui.hint('a tip')
  ui.note('Next', ['cd acme/.rness', 'git push'])
  ui.cancelled()
  ui.outro('Workspace for acme is ready')
  assert.deepEqual(said, [
    'intro: Create a workspace',
    'step: Cloned org/api',
    'info: SSH works for github.com',
    'message: Unchanged AGENTS.md',
    'warn: Stale org/api/AGENTS.md',
    'warn: careful',
    'error: api: git clone failed',
    'message: a tip',
    'note[Next]: cd acme/.rness\ngit push',
    'cancel: Cancelled',
    'outro: Workspace for acme is ready',
  ])
})

test('a step spins — unless it runs git while git might still ask for a passphrase', async () => {
  const { p, said } = clack()
  const ui = sessionUi(p)
  const cloned = (): readonly [string, string] => ['cloned', 'org/api']

  await ui.step({ doing: 'installing dependencies with npm' }, async () => 1)
  await ui.step({ doing: 'cloning  org/api', git: true }, async () => 1, cloned)
  ui.gitIsSilent = true
  await ui.step({ doing: 'cloning  org/api', git: true }, async () => 1, cloned)
  await assert.rejects(
    ui.step({ doing: 'installing dependencies with npm' }, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  assert.deepEqual(said, [
    'spin: Installing dependencies with npm',
    'stop: Installing dependencies with npm',
    // git might prompt: the label once, then the outcome — nothing redrawn.
    'message: Cloning org/api…',
    'step: Cloned org/api',
    'spin: Cloning org/api',
    'stop: Cloned org/api',
    'spin: Installing dependencies with npm',
    'spin-error: Installing dependencies with npm — failed',
  ])
})

test('the plain look is the status column, and a quiet step adds nothing to it', async () => {
  const c = capture()
  try {
    const ui = { ...plainUi }
    ui.intro('ignored')
    ui.line('cloned', 'org/api', 'a sentence the plain look never says')
    await ui.step(
      { doing: 'listing  acme repositories', quiet: true },
      async () => 3,
      () => ['listed', '3 repositories']
    )
    await ui.step(
      { doing: 'installing dependencies with npm' },
      async () => 1,
      () => ['installed', 'dependencies with npm']
    )
    ui.hint('only public repositories are listed')
    ui.warn('careful')
    ui.cancelled()
    ui.outro('ignored')
    assert.equal(
      c.out(),
      'cloned   org/api\ninstalled dependencies with npm\nonly public repositories are listed\n'
    )
    assert.equal(c.err(), 'warning: careful\ncancelled\n')
  } finally {
    c.restore()
  }
})

test('a sync is summarised in one line; what is not about a block is kept', () => {
  assert.deepEqual(
    summariseSync(
      'cloned   org/api\nupdated  AGENTS.md\nupdated  org/api/AGENTS.md\nunchanged org/web/AGENTS.md\nnot cloned: docs (rness add <name>, or rness sync --all)\n'
    ),
    {
      summary: '3 blocks: 2 updated, 1 unchanged',
      others: [
        'cloned   org/api',
        'not cloned: docs (rness add <name>, or rness sync --all)',
      ],
    }
  )
  assert.equal(
    summariseSync('unchanged AGENTS.md\n').summary,
    '1 block: 1 unchanged'
  )
  assert.equal(summariseSync('').summary, '0 blocks')
})

test('the SSH test is unattended first; the one that may prompt runs only in a terminal, announced', async () => {
  const ok = { ok: true, login: 'octo' } as const
  const denied = { ok: false, reason: 'Permission denied.' } as const
  const script = (answers: (typeof ok | typeof denied)[]) => {
    const calls: boolean[] = []
    return {
      calls,
      transport: {
        hosts: { ssh: 'git@github.com:', https: 'https://github.com/' },
        detect: async (o: { interactive: boolean }) => {
          calls.push(o.interactive)
          const next = answers.shift()
          if (next === undefined) throw new Error('unexpected SSH test')
          return next
        },
      },
    }
  }
  let announced = 0
  const announce = (): void => {
    announced += 1
  }

  const agent = script([ok])
  assert.deepEqual(await testGithubSsh(agent.transport, true, announce), {
    access: ok,
    unattended: true,
  })
  assert.deepEqual(agent.calls, [false])
  assert.equal(announced, 0)

  const passphrase = script([denied, ok])
  assert.deepEqual(await testGithubSsh(passphrase.transport, true, announce), {
    access: ok,
    unattended: false,
  })
  assert.deepEqual(passphrase.calls, [false, true])
  assert.equal(announced, 1)

  const ci = script([denied])
  assert.deepEqual(await testGithubSsh(ci.transport, false, announce), {
    access: denied,
    unattended: false,
  })
  assert.deepEqual(ci.calls, [false], 'no second test without a terminal')
  assert.equal(announced, 1)
})
