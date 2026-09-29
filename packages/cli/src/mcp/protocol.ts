/**
 * The part of MCP `rness mcp` speaks (spec 0014 §1): JSON-RPC 2.0, one
 * message per line, tools only. Both generations of the protocol: the
 * current revision, where every request carries its version and the client's
 * capabilities in `_meta`, and the earlier ones that open with `initialize`.
 * Knows nothing of rness: tools come in, lines go out.
 */

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** A refusal the model can act on is `isError: true`, not a throw. */
  call(
    args: Record<string, unknown>
  ): Promise<{ text: string; isError?: boolean }>
}

/** Checked against the MCP specification on 2026-09-29. */
const MODERN_VERSIONS: readonly string[] = ['2026-07-28']
const LEGACY_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]
const SUPPORTED = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

type Json = Record<string, unknown>
type Id = string | number | null

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorLine(
  id: Id,
  code: number,
  message: string,
  data?: unknown
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  })
}

export function createProtocol(opts: {
  name: string
  version: string
  tools: readonly McpTool[]
}): { handle(line: string): Promise<string | null> } {
  const serverInfo = { name: opts.name, version: opts.version }

  return {
    async handle(line: string): Promise<string | null> {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return errorLine(null, -32700, 'Parse error')
      }
      const rawId = isObject(message) ? message['id'] : undefined
      const id: Id =
        typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
      if (
        !isObject(message) ||
        message['jsonrpc'] !== '2.0' ||
        typeof message['method'] !== 'string'
      )
        return errorLine(id, -32600, 'Invalid Request')
      // A notification has no id and gets no answer, whatever it says.
      if (!('id' in message)) return null
      if (id === null) return errorLine(null, -32600, 'Invalid Request')

      const method = message['method']
      const params = isObject(message['params']) ? message['params'] : {}
      const meta = isObject(params['_meta']) ? params['_meta'] : null
      const modern = meta !== null && typeof meta[VERSION_KEY] === 'string'
      if (modern) {
        const requested = meta[VERSION_KEY] as string
        if (!MODERN_VERSIONS.includes(requested))
          return errorLine(id, -32022, 'Unsupported protocol version', {
            supported: SUPPORTED,
            requested,
          })
        if (!isObject(meta[CAPABILITIES_KEY]))
          return errorLine(
            id,
            -32602,
            `Invalid params: ${CAPABILITIES_KEY} is required`
          )
      }
      const answer = (result: Json): string =>
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: modern
            ? {
                resultType: 'complete',
                ...result,
                _meta: { [SERVER_INFO_KEY]: serverInfo },
              }
            : result,
        })

      switch (method) {
        case 'server/discover':
          return answer({
            supportedVersions: SUPPORTED,
            capabilities: { tools: {} },
          })
        case 'initialize': {
          const asked = params['protocolVersion']
          const protocolVersion =
            typeof asked === 'string' && LEGACY_VERSIONS.includes(asked)
              ? asked
              : (LEGACY_VERSIONS[0] as string)
          return JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo,
            },
          })
        }
        case 'ping':
          return answer({})
        case 'tools/list':
          return answer({
            tools: opts.tools.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
        case 'tools/call': {
          const name = params['name']
          const tool = opts.tools.find((t) => t.name === name)
          if (tool === undefined)
            return errorLine(id, -32602, `Unknown tool: ${String(name)}`)
          const args = isObject(params['arguments']) ? params['arguments'] : {}
          try {
            const r = await tool.call(args)
            return answer({
              content: [{ type: 'text', text: r.text }],
              isError: r.isError === true,
            })
          } catch (e) {
            return answer({
              content: [
                {
                  type: 'text',
                  text: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`,
                },
              ],
              isError: true,
            })
          }
        }
        default:
          return errorLine(id, -32601, 'Method not found')
      }
    },
  }
}
