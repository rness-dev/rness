import { realpath } from 'node:fs/promises'

import { envToken, readAuth, resolveToken, writeAuth } from '../core/auth.ts'
import { canOpenBrowser, openInBrowser } from '../core/browser.ts'
import {
  LoginError,
  PULSE_SCOPE,
  type PollDeps,
  SCOPES,
  pollForToken,
  requestDeviceCode,
} from '../core/device-flow.ts'
import { DEFAULT_GITHUB_API, getUser } from '../core/github.ts'
import { loadManifest } from '../core/manifest.ts'
import { rnessCommand } from '../core/pm.ts'
import { PROVIDERS, unsupportedProviderMessage } from '../core/providers.ts'
import { isStableInstall, setupGit } from '../core/setup-git.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

export interface LoginOptions {
  /** `--setup-git` / `--no-setup-git`; undefined asks in a terminal. */
  setupGit?: boolean
  /** Internal (tests): GitHub REST API base. */
  githubApi?: string
  /** Ask for the `project` scope even where no pulse is declared (`pulse create`). */
  project?: boolean
}

export interface LoginDeps extends PollDeps {
  terminal?: Terminal
  /** The caller's reporter: `create` logs in from inside its own session. */
  ui?: Ui
  /** Open a URL in the browser; failures are nobody's problem. */
  open?: (url: string) => void
  /** This rness's launcher, as git will have to find it. */
  bin?: string
  /** Where to look for the workspace; the current directory by default. */
  cwd?: string
}

/** The question of spec 0004 §5, or the line that replaces it under npx. */
async function offerSetupGit(
  opts: LoginOptions,
  terminal: Terminal,
  bin: string,
  ui: Ui
): Promise<void> {
  if (opts.setupGit === false) return
  if (!isStableInstall(bin)) {
    ui.hint(
      'install rness globally to let git use your login: npm i -g @rness/cli'
    )
    return
  }
  if (opts.setupGit !== true) {
    if (!terminal.isTty()) return
    const p = await terminal.prompts()
    const ok = await p.confirm({
      message: 'Use rness to authenticate git over HTTPS for github.com?',
      initialValue: true,
    })
    if (p.isCancel(ok) || ok !== true) return
  }
  const changed = await setupGit(process.execPath, bin)
  ui.line(
    changed ? 'updated' : 'unchanged',
    `git: rness answers for https://github.com (${rnessCommand()} logout undoes it)`,
    `git now asks rness for your github.com login over HTTPS (${rnessCommand()} logout undoes it)`
  )
}

/** The manifest of the workspace around `cwd`; null outside one (or when it is unreadable: login concerns the machine). */
async function manifestAround(cwd: string): Promise<Manifest | null> {
  try {
    return await loadManifest((await findWorkspace(cwd)).rnessDir)
  } catch {
    return null
  }
}

/** Scopes as GitHub words them: separated by commas, spaces, or both. */
function splitScopes(scopes: string): string[] {
  return scopes.split(/[\s,]+/).filter((s) => s !== '')
}

/**
 * `rness login`: GitHub's device flow (spec 0004 §2). Concerns the machine,
 * not a workspace: never delegated to a pinned copy.
 */
export async function loginCommand(
  opts: LoginOptions,
  deps: LoginDeps = {}
): Promise<number> {
  const terminal = deps.terminal ?? defaultTerminal
  // On its own `login` is a session of its own; inside `create` it is a part.
  const own = deps.ui === undefined
  const ui = deps.ui ?? (await makeUi(terminal))
  if (own) ui.intro('Log in to GitHub')
  try {
    const manifest = await manifestAround(deps.cwd ?? process.cwd())
    if (manifest?.provider != null && !PROVIDERS[manifest.provider].available) {
      ui.error(unsupportedProviderMessage(manifest.provider))
      return 1
    }
    const needsProject = opts.project === true || manifest?.boards != null
    const bin =
      deps.bin ?? (await realpath(process.argv[1] ?? '').catch(() => ''))
    const env = envToken()
    if (env !== null)
      ui.hint(`${env.source} is set and wins over a stored login`)
    const stored = await readAuth()
    const resolved = stored === null ? null : await resolveToken()
    const lacksProject =
      needsProject &&
      resolved?.source === 'login' &&
      !splitScopes(stored?.tokens.scopes ?? '').includes(PULSE_SCOPE)
    if (stored !== null && resolved !== null && !lacksProject) {
      ui.line(
        'logged in',
        `as ${stored.login} (github.com); ${rnessCommand()} logout to switch`
      )
      await offerSetupGit(opts, terminal, bin, ui)
      if (own) ui.outro('Nothing to do', 'idle')
      return 0
    }

    if (lacksProject) ui.line('login', 'logging in again for the project scope')
    const code = await requestDeviceCode(
      needsProject ? `${SCOPES} ${PULSE_SCOPE}` : SCOPES
    )
    if (ui.session)
      ui.line(
        'open',
        code.verificationUri,
        `Open ${code.verificationUri} and enter the code ${code.userCode}`
      )
    else {
      ui.line('open', code.verificationUri)
      ui.line('code', code.userCode)
    }
    if (terminal.isTty() && canOpenBrowser())
      (deps.open ?? openInBrowser)(code.verificationUri)
    // The plain look says it is waiting, then who logged in; the session
    // look spins, and the spinner ends as that second line.
    if (!ui.session)
      ui.line('waiting', 'for you to approve rness on github.com…')
    const login = await ui.step(
      {
        doing: 'waiting  for you to approve rness on github.com',
        sentence: 'Waiting for your approval on github.com',
        quiet: true,
      },
      async () => {
        const tokens = await pollForToken(code, deps)
        const user = await getUser({
          token: tokens.accessToken,
          apiBase: opts.githubApi ?? DEFAULT_GITHUB_API,
        })
        await writeAuth({ login: user.login, tokens })
        return user.login
      },
      (name) => ['logged in', `as ${name} (github.com)`]
    )
    if (!ui.session) ui.line('logged in', `as ${login} (github.com)`)
    await offerSetupGit(opts, terminal, bin, ui)
    if (own) ui.outro(`You are logged in as ${login}`)
    return 0
  } catch (e) {
    if (e instanceof LoginError) {
      ui.error(e.message)
      return 1
    }
    return reportError(e)
  }
}
