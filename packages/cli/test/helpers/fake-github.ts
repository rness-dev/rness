import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'node:test'

export interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  /** Form fields of a POST body. */
  form: Record<string, string>
}

export type Reply = { status?: number; json: unknown }
export type Route = (request: Recorded) => Reply

/**
 * github.com and api.github.com on 127.0.0.1. `route` answers every request;
 * each one is recorded. `RNESS_GITHUB_WEB` points at it for the test.
 */
export async function fakeGithub(
  t: TestContext,
  route: Route
): Promise<{ base: string; requests: Recorded[] }> {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        form: Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        ),
      }
      requests.push(recorded)
      const reply = route(recorded)
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  const saved = process.env['RNESS_GITHUB_WEB']
  process.env['RNESS_GITHUB_WEB'] = base
  t.after(() => {
    if (saved === undefined) delete process.env['RNESS_GITHUB_WEB']
    else process.env['RNESS_GITHUB_WEB'] = saved
  })
  return { base, requests }
}

/** Set environment variables for the test; `undefined` removes one. */
export function withEnv(
  t: TestContext,
  vars: Record<string, string | undefined>
): void {
  for (const [key, value] of Object.entries(vars)) {
    const original = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    t.after(() => {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    })
  }
}
