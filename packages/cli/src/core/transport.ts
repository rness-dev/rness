import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

import { HOSTS, type HostSpec } from './hosts.ts'
import { rnessCommand } from './pm.ts'
import { status } from './style.ts'

/** The two bases a repository URL can be written with (spec 0005). */
export interface Hosts {
  ssh: string
  https: string
}

/** The bases of a host's row. */
export function hostsOf(spec: HostSpec): Hosts {
  return { ssh: spec.ssh, https: spec.https }
}

export const GITHUB_HOSTS: Hosts = hostsOf(HOSTS.github)

/** `login`: the account the greeting names; null where it names none (Bitbucket). */
export type SshAccess =
  { ok: true; login: string | null } | { ok: false; reason: string }

export type DetectSsh = (opts: { interactive: boolean }) => Promise<SshAccess>

/** What a command needs to choose between SSH and HTTPS; tests replace it. */
export interface Transport {
  hosts: Hosts
  detect: DetectSsh
}

/**
 * The login in the host's greeting, or null: GitHub's `Hi <login>! You've
 * successfully authenticated…`, GitLab's `Welcome to GitLab, @<login>!`.
 */
export function parseSshGreeting(
  stderr: string,
  host: HostSpec = HOSTS.github
): string | null {
  return host.greeting.exec(stderr)?.[1] ?? null
}

/** The host's greeting in `text`: the login it names, null when it names none; undefined when it is not there. */
function greeted(text: string, host: HostSpec): string | null | undefined {
  const match = host.greeting.exec(text)
  return match === null ? undefined : (match[1] ?? null)
}

/**
 * The host ssh is run against: the one the row's SSH base names
 * (`git@ssh.bitbucket.org:` gives `ssh.bitbucket.org`), which is not always
 * the host the API and HTTPS go to (spec 0039 §5.2).
 */
export function sshHostOf(host: HostSpec): string {
  return host.ssh.replace(/^[^@]*@/, '').replace(/:$/, '')
}

function firstLine(text: string): string | null {
  return (
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? null
  )
}

/** As in `probeRemote`: what the pipes may still deliver after `'exit'`. */
const FLUSH_MS = 200

/**
 * `ssh -T git@<host>`: does the host accept one of the user's keys? GitHub
 * greets an accepted key on stderr and exits 1, GitLab on stdout and exits 0,
 * so the greeting, read on both, not the exit code, is the answer.
 *
 * In a terminal `ssh` may ask for a key's passphrase or confirm the host's
 * key; it asks on `/dev/tty`, not on stdout or stderr, so both stay piped and
 * the greeting is still read. Without a terminal `BatchMode=yes` forbids
 * every prompt. Never throws and never hangs: the child is killed at the
 * deadline, and the answer never waits on `'close'`.
 */
export interface DetectOptions {
  interactive: boolean
  /** Tests: a fake executable, called by path. */
  command?: string
  timeoutMs?: number
}

export async function detectSsh(
  host: HostSpec,
  opts: DetectOptions
): Promise<SshAccess> {
  const timeoutMs = opts.timeoutMs ?? (opts.interactive ? 120_000 : 10_000)
  const args = [
    '-T',
    '-o',
    'ConnectTimeout=5',
    ...(opts.interactive ? [] : ['-o', 'BatchMode=yes']),
    `git@${sshHostOf(host)}`,
  ]
  return new Promise<SshAccess>((resolve) => {
    const child = spawn(opts.command ?? 'ssh', args, {
      stdio: [opts.interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'],
    })
    const read = (stream: Readable): (() => string) => {
      const chunks: string[] = []
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => chunks.push(chunk))
      return () => chunks.join('')
    }
    const stdout = read(child.stdout)
    const stderr = read(child.stderr)

    let settled = false
    const settle = (access: SshAccess): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(access)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, reason: `timed out after ${timeoutMs / 1000}s` })
    }, timeoutMs)

    child.on('error', (e: Error) => settle({ ok: false, reason: e.message }))
    child.on('exit', (code) => {
      const finish = (): void => {
        const err = greeted(stderr(), host)
        const login = err === undefined ? greeted(stdout(), host) : err
        settle(
          login !== undefined
            ? { ok: true, login }
            : {
                ok: false,
                reason:
                  firstLine(stderr()) ??
                  firstLine(stdout()) ??
                  `ssh exited with code ${code ?? '?'}`,
              }
        )
      }
      const open = [child.stdout, child.stderr].filter(
        (s) => !s.readableEnded && !s.destroyed
      )
      if (open.length === 0) return finish()
      const flush = setTimeout(finish, FLUSH_MS)
      let pending = open.length
      for (const stream of open) {
        let ended = false
        const done = (): void => {
          if (ended) return
          ended = true
          if (--pending > 0) return
          clearTimeout(flush)
          finish()
        }
        stream.once('end', done)
        stream.once('error', done)
      }
    })
  })
}

/** `ssh -T git@github.com`, as `detectSsh` runs it. */
export function detectGithubSsh(opts: DetectOptions): Promise<SshAccess> {
  return detectSsh(HOSTS.github, opts)
}

/** The bases and the SSH test of a host. */
export function transportFor(spec: HostSpec): Transport {
  return { hosts: hostsOf(spec), detect: (o) => detectSsh(spec, o) }
}

export const defaultTransport: Transport = transportFor(HOSTS.github)

export interface SshTest {
  access: SshAccess
  /** SSH works without asking anything: git over SSH will not prompt either. */
  unattended: boolean
}

/**
 * The SSH test, unattended first (`BatchMode=yes`): when that passes, ssh
 * never asks anything and a progress line may animate while git runs. Only
 * when it fails, and in a terminal, the test runs again letting ssh ask for a
 * passphrase; `announce` says so first.
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
  login?: string | null,
  host: HostSpec = HOSTS.github
): string {
  const ssh = sshHostOf(host)
  return access.ok
    ? `SSH works for ${ssh}${access.login === null ? '' : ` (as ${access.login})`}: repositories are cloned over SSH`
    : `No SSH access to ${ssh} (${access.reason}): repositories are cloned over HTTPS${loggedInAs(login)}`
}

/** Is `url` written with the SSH base? */
export function isSshUrl(url: string, hosts: Hosts): boolean {
  return url.startsWith(hosts.ssh)
}

/** `[verb, rest, sentence]` for a `Ui`, before the test, which may ask for a passphrase. */
export function checking(host: HostSpec): readonly [string, string, string] {
  return [
    'checking',
    `ssh access to ${sshHostOf(host)}…`,
    `Checking SSH access to ${sshHostOf(host)}: ssh may ask for your passphrase`,
  ]
}
/** GitHub's `checking` lines. */
export const CHECKING = checking(HOSTS.github)
/** Printed in a terminal before GitHub's test. */
export const CHECKING_LINE = status(CHECKING[0], CHECKING[1])

/** `login`: who rness is logged in as, which is what makes HTTPS reach private repositories. */
export function usingRest(
  access: SshAccess,
  login?: string | null,
  host: HostSpec = HOSTS.github
): string {
  const ssh = sshHostOf(host)
  return access.ok
    ? `ssh (${ssh}${access.login === null ? '' : ` as ${access.login}`})`
    : `https (ssh to ${ssh} unavailable: ${access.reason}${loggedInAs(login)})`
}

export function usingLine(
  access: SshAccess,
  login?: string | null,
  host: HostSpec = HOSTS.github
): string {
  return status('using', usingRest(access, login, host))
}

/** Why an SSH workspace cannot be served, and how to fix it. */
/**
 * A child's `git clone` failed on publickey although the parent's own SSH test
 * passed: the key works but no agent holds it, so git's `ssh` asks again in
 * every child (spec 0008 §2.1).
 */
export function agentHintLines(
  platform: NodeJS.Platform = process.platform
): string[] {
  const mac = platform === 'darwin'
  return [
    'your key works but is not loaded; ssh asks again in every child:',
    `  ssh-add ${mac ? '--apple-use-keychain ' : ''}~/.ssh/id_ed25519`,
    `  ~/.ssh/config: AddKeysToAgent yes${mac ? ', UseKeychain yes' : ''}`,
  ]
}

/**
 * The SSH test passed only once ssh could ask (a passphrase, and no agent
 * holding the key): every clone over SSH asks again. Said once, before them.
 */
export function passphraseHint(
  platform: NodeJS.Platform = process.platform
): string {
  return [
    'ssh asked for your passphrase, and asks again for every repository unless an agent holds the key:',
    ...agentHintLines(platform).slice(1),
  ].join('\n')
}

export function sshWorkspaceLines(
  reason: string,
  host: HostSpec = HOSTS.github
): [string, string] {
  return [
    `this workspace clones over SSH (rness.json) but ssh to ${sshHostOf(host)} fails: ${reason}`,
    `set up an SSH key: ${host.sshDocs}`,
  ]
}

/** The user-side escape hatch where `rness.json` is not negotiable. */
export function insteadOfLines(host: HostSpec): [string, string] {
  return [
    `or make git use HTTPS for ${host.host} on this machine:`,
    `  git config --global url."${host.https}".insteadOf ${host.ssh}`,
  ]
}
/** GitHub's escape hatch. */
export const INSTEAD_OF_LINES = insteadOfLines(HOSTS.github)

export function httpsFlagLine(spec: string): string {
  return `or clone this repository over HTTPS: ${rnessCommand()} add ${spec} --https`
}
