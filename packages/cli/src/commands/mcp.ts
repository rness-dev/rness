import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { createProtocol } from '../mcp/protocol.ts'
import { serverTools } from '../mcp/tools.ts'
import { VERSION } from '../version.ts'

export interface McpOptions {
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

/**
 * `rness mcp`: the workspace context for agents, over MCP on stdio
 * (spec 0014). One message per line in, one answer per line out; stdout
 * carries nothing else. Ends when stdin closes.
 */
export async function mcpCommand(
  opts: McpOptions,
  io: { input: Readable; output: Writable } = {
    input: process.stdin,
    output: process.stdout,
  }
): Promise<number> {
  const protocol = createProtocol({
    name: 'rness',
    version: VERSION,
    tools: await serverTools(opts.cwd ?? process.cwd()),
  })
  const lines = createInterface({ input: io.input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    const answer = await protocol.handle(line)
    if (answer !== null) io.output.write(`${answer}\n`)
  }
  return 0
}
