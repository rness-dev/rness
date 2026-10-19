import { resolveToken } from '../core/auth.ts'
import { hostNamed } from '../core/hosts.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `rness git-credential <get|store|erase>`: git's credential-helper protocol
 * (spec 0004 §5, spec 0037 §3). Only `get` for a host rness logs in to over
 * HTTPS (github.com, gitlab.com) is answered, with that host's token of this
 * machine and its username; everything else is silence, which tells git to
 * look elsewhere. `input` is what git writes on stdin.
 */
export async function gitCredentialCommand(
  operation: string,
  input?: string
): Promise<number> {
  if (operation !== 'get') return 0
  const fields = new Map<string, string>()
  for (const line of (input ?? (await readStdin())).split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trimEnd())
  }
  if (fields.get('protocol') !== 'https') return 0
  const host = hostNamed(fields.get('host') ?? '')
  if (host === null) return 0
  const resolved = await resolveToken({}, host).catch(() => null)
  if (resolved === null) return 0
  process.stdout.write(
    `username=${host.username}\npassword=${resolved.token}\n`
  )
  return 0
}
