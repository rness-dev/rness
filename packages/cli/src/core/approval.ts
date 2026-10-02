import { canOpenBrowser, openInBrowser } from './browser.ts'
import { rnessCommand } from './pm.ts'
import type { OrganizationAccess, Provider } from './provider.ts'
import type { Prompts } from './terminal.ts'
import type { Ui } from './ui.ts'

/** How often the membership is asked while the approval is awaited. */
export const APPROVAL_INTERVAL_MS = 5_000
/** How long the wait lasts; the device flow's code lasts 15 minutes. */
export const APPROVAL_WAIT_MS = 10 * 60_000

export function approvalQuestion(org: string): string {
  return `Open github.com to approve rness for ${org} now?`
}

/** The clock and the browser, injected so a test drives the wait. */
export interface ApprovalDeps {
  open?: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** `cancelled` is the user's: nothing is written after it. */
export type AccessOutcome = OrganizationAccess | 'cancelled'

/**
 * Access to the organization, before anything reads it (spec 0028 §3): a
 * member is said as whom; an organization that restricts OAuth apps and has
 * not approved rness is offered the approval page in the browser, and the
 * membership is polled until it answers or ten minutes pass. The order
 * matters: the probe of `<org>/.rness` and the listing come after, so a
 * private `.rness` is never read as absent through a token that cannot see
 * it yet.
 */
export async function checkAccess(input: {
  org: string
  provider: Provider
  ui: Ui
  interactive: boolean
  prompts: () => Promise<Prompts>
  /** The identity's role, when the listing knew it; null: the provider would not say. */
  canGrant: boolean | null
  deps?: ApprovalDeps
}): Promise<AccessOutcome> {
  const { org, provider, ui } = input
  if (!provider.authenticated) return 'unknown'
  const login = (await provider.identity())?.login
  const as = login === undefined ? '' : ` (as ${login})`
  const member = (): void =>
    ui.line('member', `${org}${as}`, `You are a member of ${org}${as}`)
  const access = await provider.organizationAccess(org)
  if (access === 'member') {
    member()
    return access
  }
  if (access !== 'restricted') return access

  const url = provider.approvalUrl()
  ui.warn(
    `${org} has not approved rness, so its private repositories are hidden`
  )
  if (!input.interactive || url === null) {
    ui.hint(
      url === null
        ? `an owner of ${org} has to approve the app your token belongs to`
        : `an owner approves it at ${url}`,
      'stderr'
    )
    return 'restricted'
  }
  const p = await input.prompts()
  const ok = await p.confirm({
    message: approvalQuestion(org),
    initialValue: true,
  })
  if (p.isCancel(ok)) return 'cancelled'
  if (ok !== true) {
    ui.hint(`approve it later: ${url}`, 'stderr')
    return 'restricted'
  }

  ui.line('open', url, `Open ${url} and approve rness for ${org}`)
  if (canOpenBrowser()) (input.deps?.open ?? openInBrowser)(url)
  const sleep =
    input.deps?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = input.deps?.now ?? Date.now
  // An owner approves it themself on the page; a member can only ask there,
  // and so can anyone whose role the provider would not say: waiting for an
  // owner is true of them all.
  const who = input.canGrant === true ? org : `an owner of ${org}`
  const waiting = `for ${who} to approve rness on github.com`
  if (!ui.session) ui.line('waiting', `${waiting}…`)
  // Ctrl+C while waiting is a cancel, as at any question: nothing written,
  // exit 0, not the 130 of a killed process. The session look's spinner
  // already treats it so; the plain look listens for the time of the wait.
  let interrupted = false
  let wake = (): void => undefined
  const interrupt = (): void => {
    interrupted = true
    wake()
  }
  if (!ui.session) process.once('SIGINT', interrupt)
  let outcome: OrganizationAccess | 'timeout' | 'cancelled'
  try {
    outcome = await ui.step(
      {
        doing: `waiting  ${waiting}`,
        sentence: `Waiting ${waiting}`,
        quiet: true,
      },
      async (): Promise<OrganizationAccess | 'timeout' | 'cancelled'> => {
        const deadline = now() + APPROVAL_WAIT_MS
        for (;;) {
          await Promise.race([
            sleep(APPROVAL_INTERVAL_MS),
            new Promise<void>((resolve) => {
              wake = resolve
            }),
          ])
          if (interrupted) return 'cancelled'
          const again = await provider.organizationAccess(org)
          // `unknown` is a request that failed: asked again until the deadline.
          if (again === 'member' || again === 'not-member') return again
          if (now() >= deadline) return 'timeout'
        }
      },
      (r) => (r === 'member' ? ['member', `${org}${as}`] : null)
    )
  } finally {
    process.off('SIGINT', interrupt)
  }
  if (outcome === 'cancelled') return outcome
  if (outcome === 'member') {
    if (!ui.session) member()
    return outcome
  }
  if (outcome === 'not-member') return outcome
  ui.warn(
    `${org} still has not approved rness; its private repositories stay hidden this time`
  )
  // The run goes on and makes the workspace: what is missing afterwards is
  // its private repositories, which `add` brings in.
  ui.hint(
    `once an owner approves it, add its private repositories with ${rnessCommand()} add <repo>`,
    'stderr'
  )
  return 'restricted'
}
