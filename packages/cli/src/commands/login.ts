import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'

import { envToken, readAuth, resolveToken, writeAuth } from '../core/auth.ts'
import {
  LoginError,
  type PollDeps,
  clientId,
  pollForToken,
  requestDeviceCode,
} from '../core/device-flow.ts'
import { DEFAULT_GITHUB_API, getUser } from '../core/github.ts'
import { isStableInstall, setupGit } from '../core/setup-git.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import { type Ui, makeUi } from '../core/ui.ts'
import { reportError } from '../report.ts'

export interface LoginOptions {
  /** `--setup-git` / `--no-setup-git`; undefined asks in a terminal. */
  setupGit?: boolean
  /** Internal (tests): GitHub REST API base. */
  githubApi?: string
}

export interface LoginDeps extends PollDeps {
  terminal?: Terminal
  /** The caller's reporter: `create` logs in from inside its own session. */
  ui?: Ui
  /** Open a URL in the browser; failures are nobody's problem. */
  open?: (url: string) => void
  /** This rness's launcher, as git will have to find it. */
  bin?: string
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // no browser here: the URL is on the screen
  }
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
    'git: rness answers for https://github.com (rness logout undoes it)',
    'git now asks rness for your github.com login over HTTPS (rness logout undoes it)'
  )
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
    const bin =
      deps.bin ?? (await realpath(process.argv[1] ?? '').catch(() => ''))
    const env = envToken()
    if (env !== null)
      ui.hint(`${env.source} is set and wins over a stored login`)
    const stored = await readAuth()
    if (stored !== null && (await resolveToken()) !== null) {
      ui.line(
        'logged in',
        `as ${stored.login} (github.com); rness logout to switch`
      )
      await offerSetupGit(opts, terminal, bin, ui)
      if (own) ui.outro('Nothing to do', 'idle')
      return 0
    }

    const code = await requestDeviceCode()
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
    if (terminal.isTty() && process.env['SSH_CONNECTION'] === undefined)
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

/** Where a user revokes what `rness login` was granted; doing it by API needs the client secret. */
export function revokeUrl(): string {
  return `https://github.com/settings/connections/applications/${clientId()}`
}
