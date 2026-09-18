import { resolveToken } from '../core/auth.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `rness git-credential <get|store|erase>`: git's credential-helper protocol
 * (spec 0004 §5). Only `get` for https://github.com is answered, with the
 * token of this machine; everything else is silence, which tells git to look
 * elsewhere. `input` is what git writes on stdin.
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
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com')
    return 0
  const resolved = await resolveToken().catch(() => null)
  if (resolved === null) return 0
  process.stdout.write(`username=x-access-token\npassword=${resolved.token}\n`)
  return 0
}
