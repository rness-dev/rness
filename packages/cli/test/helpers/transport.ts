import type { TestContext } from 'node:test'

import type { SshAccess, Transport } from '../../src/core/transport.ts'
import { type RemoteOrg, makeRemoteOrg } from './remote-org.ts'

export const SSH_OK: SshAccess = { ok: true, login: 'octo' }
export const SSH_DENIED: SshAccess = {
  ok: false,
  reason: 'git@github.com: Permission denied (publickey).',
}

/**
 * github.com as two fake organisations — what is reachable over SSH and what
 * is reachable over HTTPS — and a scripted answer to the SSH test (one, or
 * one per run). `calls` records every run of the test.
 */
export async function fakeTransport(
  t: TestContext,
  org: string,
  access: SshAccess | SshAccess[]
): Promise<{
  transport: Transport
  ssh: RemoteOrg
  https: RemoteOrg
  calls: { interactive: boolean }[]
}> {
  const ssh = await makeRemoteOrg(t, org)
  const https = await makeRemoteOrg(t, org)
  const calls: { interactive: boolean }[] = []
  return {
    transport: {
      hosts: { ssh: ssh.host, https: https.host },
      detect: async (opts) => {
        calls.push(opts)
        // A list answers call by call (the last one repeats): the unattended
        // test, then the one that may have asked for a passphrase.
        if (!Array.isArray(access)) return access
        const next = access[Math.min(calls.length, access.length) - 1]
        if (next === undefined) throw new Error('no scripted SSH answer')
        return next
      },
    },
    ssh,
    https,
    calls,
  }
}
