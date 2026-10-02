import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'

import {
  APPROVAL_INTERVAL_MS,
  APPROVAL_WAIT_MS,
  checkAccess,
} from '../../src/core/approval.ts'
import type { OrganizationAccess } from '../../src/core/provider.ts'
import type { Prompts } from '../../src/core/terminal.ts'
import { plainUi } from '../../src/core/ui.ts'
import { capture } from '../helpers/capture.ts'
import { fakeProvider } from '../helpers/provider.ts'

const CANCEL = Symbol('cancel')
const URL = 'https://github.test/settings/connections/applications/rness'

/** A terminal that answers the one question of the step; `asked` records it. */
function prompts(answer: boolean | typeof CANCEL) {
  const asked: string[] = []
  const p = {
    confirm: async (opts: { message: string }) => {
      asked.push(opts.message)
      return answer
    },
    isCancel: (v: unknown) => v === CANCEL,
  } as unknown as Prompts
  return { prompts: async () => p, asked }
}

/** A clock that advances by what was slept, and the record of both. */
function clock() {
  let t = 1_000_000
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms)
      t += ms
    },
    slept,
  }
}

async function run(
  t: TestContext,
  input: {
    login?: string | null
    access: OrganizationAccess | OrganizationAccess[]
    answer?: boolean | typeof CANCEL
    interactive?: boolean
    canGrant?: boolean | null
    approvalUrl?: string | null
  }
) {
  const gh = fakeProvider({
    login: input.login === undefined ? 'octo' : input.login,
    access: input.access,
    ...(input.approvalUrl === undefined
      ? {}
      : { approvalUrl: input.approvalUrl }),
  })
  const term = prompts(input.answer ?? true)
  const opened: string[] = []
  const time = clock()
  const c = capture()
  try {
    const outcome = await checkAccess({
      org: 'acme',
      provider: gh.provider,
      ui: plainUi,
      interactive: input.interactive ?? true,
      prompts: term.prompts,
      canGrant: input.canGrant ?? null,
      deps: { open: (u) => opened.push(u), sleep: time.sleep, now: time.now },
    })
    return {
      outcome,
      out: c.out(),
      err: c.err(),
      opened,
      asked: term.asked,
      polls: gh.accessCalls.length,
      slept: time.slept,
    }
  } finally {
    c.restore()
  }
}

test('anonymous: nothing asked, nothing printed', async (t) => {
  const r = await run(t, { login: null, access: 'restricted' })
  assert.equal(r.outcome, 'unknown')
  assert.equal(r.polls, 0)
  assert.equal(r.out + r.err, '')
})

test('a member is said as whom; not a member and unknown pass silently', async (t) => {
  const m = await run(t, { access: 'member' })
  assert.equal(m.outcome, 'member')
  assert.match(m.out, /^member\s+acme \(as octo\)\n$/)
  const n = await run(t, { access: 'not-member' })
  assert.equal(n.outcome, 'not-member')
  assert.equal(n.out + n.err, '')
  assert.equal(n.asked.length, 0)
})

test('restricted, yes: the page opens, the membership is polled every 5 s until it answers', async (t) => {
  const r = await run(t, {
    access: ['restricted', 'restricted', 'restricted', 'member'],
  })
  assert.equal(r.outcome, 'member')
  assert.deepEqual(r.asked, ['Open github.com to approve rness for acme now?'])
  assert.deepEqual(r.opened, [URL])
  assert.match(
    r.err,
    /acme has not approved rness, so its private repositories are hidden/
  )
  assert.match(r.out, /open\s+https:\/\/github\.test\/settings/)
  assert.match(r.out, /waiting\s+for acme to approve rness on github\.com/)
  assert.match(r.out, /member\s+acme \(as octo\)\n$/)
  // One access check before the question, then one per poll.
  assert.equal(r.polls, 4)
  assert.deepEqual(r.slept, [
    APPROVAL_INTERVAL_MS,
    APPROVAL_INTERVAL_MS,
    APPROVAL_INTERVAL_MS,
  ])
})

test('a member waits for an owner; an owner, or an unknown role, waits for the organization', async (t) => {
  const member = await run(t, {
    access: ['restricted', 'member'],
    canGrant: false,
  })
  assert.match(member.out, /waiting\s+for an owner of acme to approve rness/)
  const owner = await run(t, {
    access: ['restricted', 'member'],
    canGrant: true,
  })
  assert.match(owner.out, /waiting\s+for acme to approve rness/)
})

test('approved but not a member: the wait ends there, silently', async (t) => {
  const r = await run(t, { access: ['restricted', 'not-member'] })
  assert.equal(r.outcome, 'not-member')
  assert.doesNotMatch(r.out, /member\s+acme/)
})

test('restricted, yes, nobody approves: the wait ends after 10 minutes with a warning and the retry', async (t) => {
  const r = await run(t, { access: 'restricted' })
  assert.equal(r.outcome, 'restricted')
  assert.equal(r.slept.length, APPROVAL_WAIT_MS / APPROVAL_INTERVAL_MS)
  assert.match(
    r.err,
    /acme still has not approved rness; its private repositories stay hidden this time/
  )
  assert.match(r.err, /once an owner approves it, run .*create acme again/)
})

test('restricted, no: the page is named for later, nothing opens', async (t) => {
  const r = await run(t, { access: 'restricted', answer: false })
  assert.equal(r.outcome, 'restricted')
  assert.deepEqual(r.opened, [])
  assert.equal(r.polls, 1)
  assert.match(r.err, /approve it later: https:\/\/github\.test\/settings/)
})

test('restricted, cancel: cancelled, nothing opens', async (t) => {
  const r = await run(t, { access: 'restricted', answer: CANCEL })
  assert.equal(r.outcome, 'cancelled')
  assert.deepEqual(r.opened, [])
})

test('restricted off a terminal: the warning, the page for an owner, no question', async (t) => {
  const r = await run(t, { access: 'restricted', interactive: false })
  assert.equal(r.outcome, 'restricted')
  assert.equal(r.asked.length, 0)
  assert.deepEqual(r.opened, [])
  assert.match(
    r.err,
    /an owner approves it at https:\/\/github\.test\/settings/
  )
})

test('over SSH the URL is printed and no browser is opened', async (t) => {
  const before = process.env['SSH_CONNECTION']
  process.env['SSH_CONNECTION'] = '10.0.0.1 22 10.0.0.2 22'
  t.after(() => {
    if (before === undefined) delete process.env['SSH_CONNECTION']
    else process.env['SSH_CONNECTION'] = before
  })
  const r = await run(t, { access: ['restricted', 'member'] })
  assert.equal(r.outcome, 'member')
  assert.deepEqual(r.opened, [])
  assert.match(r.out, /open\s+https:\/\/github\.test\/settings/)
})
