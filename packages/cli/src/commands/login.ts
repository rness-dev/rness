import { realpath } from 'node:fs/promises'

import { envToken, readAuth, resolveToken, writeAuth } from '../core/auth.ts'
import { canOpenBrowser, openInBrowser } from '../core/browser.ts'
import {
  BOARD_SCOPE,
  LoginError,
  type PollDeps,
  SCOPES,
  pollForToken,
  requestDeviceCode,
} from '../core/device-flow.ts'
import { DEFAULT_GITHUB_API, getUser } from '../core/github.ts'
import { defaultGitlabApi, getUser as getGitlabUser } from '../core/gitlab.ts'
import {
  HOSTS,
  type HostSpec,
  hostFor,
  httpsOrigin,
  providerFlag,
} from '../core/hosts.ts'
import { loadManifest, providerOf } from '../core/manifest.ts'
import { rnessCommand } from '../core/pm.ts'
import {
  PROVIDERS,
  isProviderName,
  unsupportedProviderMessage,
} from '../core/providers.ts'
import { isStableInstall, setupGit } from '../core/setup-git.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

export interface LoginOptions {
  /** `--setup-git` / `--no-setup-git`; undefined asks in a terminal. */
  setupGit?: boolean
  /** `--provider`: where to log in; else the workspace's provider, else GitHub. */
  provider?: string
  /** Internal (tests): GitHub REST API base. */
  githubApi?: string
  /** Internal (tests): GitLab REST API base. */
  gitlabApi?: string
  /** Ask for the `project` scope even where no board is declared (`board push` creating one). */
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
  ui: Ui,
  host: HostSpec
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
      message: `Use rness to authenticate git over HTTPS for ${host.host}?`,
      initialValue: true,
    })
    if (p.isCancel(ok) || ok !== true) return
  }
  const changed = await setupGit(process.execPath, bin, host)
  const undo = `${rnessCommand()} logout${providerFlag(host)}`
  ui.line(
    changed ? 'updated' : 'unchanged',
    `git: rness answers for ${httpsOrigin(host)} (${undo} undoes it)`,
    `git now asks rness for your ${host.host} login over HTTPS (${undo} undoes it)`
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

export type ChosenHost =
  | { host: HostSpec; manifest: Manifest | null }
  | { error: string; code: number }

/**
 * Where `login` and `logout` act (spec 0037 §3): `--provider`, else the
 * provider of the workspace around `cwd` (`rness.json`'s, else detected),
 * else GitHub. The flag wins over the workspace: login concerns the machine.
 */
export async function chooseHost(
  flag: string | undefined,
  cwd: string
): Promise<ChosenHost> {
  const manifest = await manifestAround(cwd)
  if (flag !== undefined) {
    if (!isProviderName(flag))
      return {
        error: `unknown provider "${flag}" (${Object.keys(PROVIDERS).join(', ')})`,
        code: 2,
      }
    const host = hostFor(flag)
    if (host === null)
      return {
        error: `rness cannot log in to ${flag} yet (${Object.keys(HOSTS).join(', ')})`,
        code: 2,
      }
    return { host, manifest }
  }
  const name = manifest === null ? 'github' : providerOf(manifest)
  const host = hostFor(name)
  if (host === null) return { error: unsupportedProviderMessage(name), code: 1 }
  return { host, manifest }
}

/** Scopes as GitHub words them: separated by commas, spaces, or both. */
function splitScopes(scopes: string): string[] {
  return scopes.split(/[\s,]+/).filter((s) => s !== '')
}

/**
 * `rness login`: the host's device flow (spec 0004 §2, spec 0037 §3).
 * Concerns the machine, not a workspace: never delegated to a pinned copy.
 */
export async function loginCommand(
  opts: LoginOptions,
  deps: LoginDeps = {}
): Promise<number> {
  const terminal = deps.terminal ?? defaultTerminal
  // On its own `login` is a session of its own; inside `create` it is a part.
  const own = deps.ui === undefined
  const ui = deps.ui ?? (await makeUi(terminal))
  try {
    const chosen = await chooseHost(opts.provider, deps.cwd ?? process.cwd())
    if ('error' in chosen) {
      ui.error(chosen.error)
      return chosen.code
    }
    const { host, manifest } = chosen
    if (own) ui.intro(`Log in to ${host.label}`)
    // GitHub's boards need the `project` scope; GitLab's `api` covers its
    // boards (spec 0037 §3).
    const needsProject =
      host === HOSTS.github &&
      (opts.project === true || manifest?.boards != null)
    const bin =
      deps.bin ?? (await realpath(process.argv[1] ?? '').catch(() => ''))
    const env = envToken(host)
    if (env !== null)
      ui.hint(`${env.source} is set and wins over a stored login`)
    const stored = await readAuth(host)
    const resolved = stored === null ? null : await resolveToken({}, host)
    const lacksProject =
      needsProject &&
      resolved?.source === 'login' &&
      !splitScopes(stored?.tokens.scopes ?? '').includes(BOARD_SCOPE)
    if (stored !== null && resolved !== null && !lacksProject) {
      ui.line(
        'logged in',
        `as ${stored.login} (${host.host}); ${rnessCommand()} logout${providerFlag(host)} to switch`
      )
      await offerSetupGit(opts, terminal, bin, ui, host)
      if (own) ui.outro('Nothing to do', 'idle')
      return 0
    }

    if (lacksProject) ui.line('login', 'logging in again for the project scope')
    const code = await requestDeviceCode(
      host,
      needsProject ? `${SCOPES} ${BOARD_SCOPE}` : host.scopes
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
    // The page with the code filled in, where the host gives one (GitLab).
    if (terminal.isTty() && canOpenBrowser())
      (deps.open ?? openInBrowser)(
        code.verificationUriComplete ?? code.verificationUri
      )
    // The plain look says it is waiting, then who logged in; the session
    // look spins, and the spinner ends as that second line.
    if (!ui.session)
      ui.line('waiting', `for you to approve rness on ${host.host}…`)
    const login = await ui.step(
      {
        doing: `waiting  for you to approve rness on ${host.host}`,
        sentence: `Waiting for your approval on ${host.host}`,
        quiet: true,
      },
      async () => {
        const tokens = await pollForToken(code, deps, host)
        const user =
          host === HOSTS.github
            ? await getUser({
                token: tokens.accessToken,
                apiBase: opts.githubApi ?? DEFAULT_GITHUB_API,
              })
            : await getGitlabUser({
                token: tokens.accessToken,
                apiBase: opts.gitlabApi ?? defaultGitlabApi(),
              })
        await writeAuth({ login: user.login, tokens }, host)
        return user.login
      },
      (name) => ['logged in', `as ${name} (${host.host})`]
    )
    if (!ui.session) ui.line('logged in', `as ${login} (${host.host})`)
    await offerSetupGit(opts, terminal, bin, ui, host)
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
