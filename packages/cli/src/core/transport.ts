import { spawn } from 'node:child_process'

import { DEFAULT_HOST, SSH_HOST } from './remote.ts'
import { status } from './style.ts'

/** The two bases a github.com URL can be written with (spec 0005). */
export interface Hosts {
  ssh: string
  https: string
}

export const GITHUB_HOSTS: Hosts = { ssh: SSH_HOST, https: DEFAULT_HOST }

export type SshAccess =
  { ok: true; login: string } | { ok: false; reason: string }

export type DetectSsh = (opts: { interactive: boolean }) => Promise<SshAccess>

/** What a command needs to choose between SSH and HTTPS; tests replace it. */
export interface Transport {
  hosts: Hosts
  detect: DetectSsh
}

const GREETING = /^Hi ([^!\s]+)! You've successfully authenticated/m

/** The login in GitHub's `Hi <login>! You've successfully authenticated…`, or null. */
export function parseSshGreeting(stderr: string): string | null {
  return GREETING.exec(stderr)?.[1] ?? null
}

function firstLine(text: string): string | null {
  return (
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? null
  )
}

/** As in `probeRemote`: what the pipe may still deliver after `'exit'`. */
const STDERR_FLUSH_MS = 200

/**
 * `ssh -T git@github.com`: does github.com accept one of the user's keys?
 * GitHub greets an accepted key and exits 1, so the greeting — not the exit
 * code — is the answer.
 *
 * In a terminal `ssh` may ask for a key's passphrase or confirm github.com's
 * host key; it asks on `/dev/tty`, not on stderr, so stderr stays piped and
 * the greeting is still read. Without a terminal `BatchMode=yes` forbids
 * every prompt. Never throws and never hangs: the child is killed at the
 * deadline, and the answer never waits on `'close'`.
 */
export async function detectGithubSsh(opts: {
  interactive: boolean
  /** Tests: a fake executable, called by path. */
  command?: string
  timeoutMs?: number
}): Promise<SshAccess> {
  const timeoutMs = opts.timeoutMs ?? (opts.interactive ? 120_000 : 10_000)
  const args = [
    '-T',
    '-o',
    'ConnectTimeout=5',
    ...(opts.interactive ? [] : ['-o', 'BatchMode=yes']),
    'git@github.com',
  ]
  return new Promise<SshAccess>((resolve) => {
    const child = spawn(opts.command ?? 'ssh', args, {
      stdio: [opts.interactive ? 'inherit' : 'ignore', 'ignore', 'pipe'],
    })
    const chunks: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => chunks.push(chunk))

    let settled = false
    const settle = (access: SshAccess): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stderr?.destroy()
      resolve(access)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, reason: `timed out after ${timeoutMs / 1000}s` })
    }, timeoutMs)

    child.on('error', (e: Error) => settle({ ok: false, reason: e.message }))
    child.on('exit', (code) => {
      const finish = (): void => {
        const stderr = chunks.join('')
        const login = parseSshGreeting(stderr)
        settle(
          login !== null
            ? { ok: true, login }
            : {
                ok: false,
                reason:
                  firstLine(stderr) ?? `ssh exited with code ${code ?? '?'}`,
              }
        )
      }
      const stderr = child.stderr
      if (stderr === null || stderr.readableEnded || stderr.destroyed)
        return finish()
      const flush = setTimeout(finish, STDERR_FLUSH_MS)
      const done = (): void => {
        clearTimeout(flush)
        finish()
      }
      stderr.once('end', done)
      stderr.once('error', done)
    })
  })
}

export const defaultTransport: Transport = {
  hosts: GITHUB_HOSTS,
  detect: detectGithubSsh,
}

export interface SshTest {
  access: SshAccess
  /** SSH works without asking anything: git over SSH will not prompt either. */
  unattended: boolean
}

/**
 * The SSH test, unattended first (`BatchMode=yes`): when that passes, ssh
 * never asks anything and a progress line may animate while git runs. Only
 * when it fails, and in a terminal, the test runs again letting ssh ask for a
 * passphrase — `announce` says so first.
 */
export async function testGithubSsh(
  transport: Transport,
  interactive: boolean,
  announce: () => void
): Promise<SshTest> {
  const batch = await transport.detect({ interactive: false })
  if (batch.ok || !interactive) return { access: batch, unattended: batch.ok }
  announce()
  return {
    access: await transport.detect({ interactive: true }),
    unattended: false,
  }
}

const loggedInAs = (login?: string | null): string =>
  login === undefined || login === null ? '' : `, logged in as ${login}`

/** The outcome of the SSH test as a sentence, for the session look. */
export function usingSentence(
  access: SshAccess,
  login?: string | null
): string {
  return access.ok
    ? `SSH works for github.com (as ${access.login}) — repositories are cloned over SSH`
    : `No SSH access to github.com (${access.reason}) — repositories are cloned over HTTPS${loggedInAs(login)}`
}

/** Is `url` written with the SSH base? */
export function isSshUrl(url: string, hosts: Hosts): boolean {
  return url.startsWith(hosts.ssh)
}

/** Printed in a terminal before the test, which may ask for a passphrase. */
export const CHECKING_LINE = status('checking', 'ssh access to github.com…')
/** The same as `[verb, rest, sentence]`, for a `Ui`. */
export const CHECKING = [
  'checking',
  'ssh access to github.com…',
  'Checking SSH access to github.com — ssh may ask for your passphrase',
] as const

/** `login`: who rness is logged in as, which is what makes HTTPS reach private repositories. */
export function usingRest(access: SshAccess, login?: string | null): string {
  return access.ok
    ? `ssh (github.com as ${access.login})`
    : `https (ssh to github.com unavailable: ${access.reason}${loggedInAs(login)})`
}

export function usingLine(access: SshAccess, login?: string | null): string {
  return status('using', usingRest(access, login))
}

/** Why an SSH workspace cannot be served, and how to fix it. */
export function sshWorkspaceLines(reason: string): [string, string] {
  return [
    `this workspace clones over SSH (rness.json) but ssh to github.com fails: ${reason}`,
    'set up an SSH key: https://docs.github.com/authentication/connecting-to-github-with-ssh',
  ]
}

/** The user-side escape hatch where `rness.json` is not negotiable. */
export const INSTEAD_OF_LINES: [string, string] = [
  'or make git use HTTPS for github.com on this machine:',
  '  git config --global url."https://github.com/".insteadOf git@github.com:',
]

export function httpsFlagLine(spec: string): string {
  return `or clone this repository over HTTPS: rness add ${spec} --https`
}
