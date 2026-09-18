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
import { status } from '../core/style.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import { reportError } from '../report.ts'

export interface LoginOptions {
  /** `--setup-git` / `--no-setup-git`; undefined asks in a terminal. */
  setupGit?: boolean
  /** Internal (tests): GitHub REST API base. */
  githubApi?: string
}

export interface LoginDeps extends PollDeps {
  terminal?: Terminal
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
  bin: string
): Promise<void> {
  if (opts.setupGit === false) return
  if (!isStableInstall(bin)) {
    process.stdout.write(
      'install rness globally to let git use your login: npm i -g @rness/cli\n'
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
  process.stdout.write(
    `${status(changed ? 'updated' : 'unchanged', 'git: rness answers for https://github.com (rness logout undoes it)')}\n`
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
  try {
    const bin =
      deps.bin ?? (await realpath(process.argv[1] ?? '').catch(() => ''))
    const env = envToken()
    if (env !== null)
      process.stdout.write(
        `${env.source} is set and wins over a stored login\n`
      )
    const stored = await readAuth()
    if (stored !== null && (await resolveToken()) !== null) {
      process.stdout.write(
        `${status('logged in', `as ${stored.login} (github.com); rness logout to switch`)}\n`
      )
      await offerSetupGit(opts, terminal, bin)
      return 0
    }

    const code = await requestDeviceCode()
    process.stdout.write(
      `${status('open', code.verificationUri)}\n${status('code', code.userCode)}\n`
    )
    if (terminal.isTty() && process.env['SSH_CONNECTION'] === undefined)
      (deps.open ?? openInBrowser)(code.verificationUri)
    process.stdout.write(
      `${status('waiting', 'for you to approve rness on github.com…')}\n`
    )
    const tokens = await pollForToken(code, deps)
    const { login } = await getUser({
      token: tokens.accessToken,
      apiBase: opts.githubApi ?? DEFAULT_GITHUB_API,
    })
    await writeAuth({ login, tokens })
    process.stdout.write(`${status('logged in', `as ${login} (github.com)`)}\n`)
    await offerSetupGit(opts, terminal, bin)
    return 0
  } catch (e) {
    if (e instanceof LoginError) {
      process.stderr.write(`${e.message}\n`)
      return 1
    }
    return reportError(e)
  }
}

/** Where a user revokes what `rness login` was granted; doing it by API needs the client secret. */
export function revokeUrl(): string {
  return `https://github.com/settings/connections/applications/${clientId()}`
}
