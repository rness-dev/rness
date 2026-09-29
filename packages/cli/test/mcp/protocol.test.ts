import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type McpTool, createProtocol } from '../../src/mcp/protocol.ts'

const echo: McpTool = {
  name: 'echo',
  title: 'Echo',
  description: 'Says back what it is given.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  async call(args) {
    if (typeof args['text'] !== 'string')
      return { text: 'text is required', isError: true }
    if (args['text'] === 'boom') throw new Error('it broke')
    return { text: `echo: ${args['text']}` }
  },
}

const MODERN = '2026-07-28'
const meta = (version = MODERN, capabilities: unknown = {}) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientCapabilities': capabilities,
})

// Arbitrary JSON replies, read loosely: the assertions check their shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only reader
type Reply = Record<string, any>

function server() {
  const p = createProtocol({ name: 'rness', version: '9.9.9', tools: [echo] })
  return async (message: unknown) => {
    const line = typeof message === 'string' ? message : JSON.stringify(message)
    const out = await p.handle(line)
    return out === null ? null : (JSON.parse(out) as Reply)
  }
}

test('not JSON is -32700 with a null id; JSON that is not a request is -32600', async () => {
  const send = server()
  assert.deepEqual(await send('{ nope'), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  })
  const r = await send({ jsonrpc: '2.0', id: 1 })
  assert.equal(r?.['error'].code, -32600)
  assert.equal(r?.['id'], 1)
})

test('modern: server/discover and tools/list carry resultType and serverInfo', async () => {
  const send = server()
  const d = await send({
    jsonrpc: '2.0',
    id: 'd',
    method: 'server/discover',
    params: { _meta: meta() },
  })
  assert.deepEqual(d?.['result'], {
    resultType: 'complete',
    supportedVersions: [
      MODERN,
      '2025-11-25',
      '2025-06-18',
      '2025-03-26',
      '2024-11-05',
    ],
    capabilities: { tools: {} },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'rness', version: '9.9.9' },
    },
  })
  const l = await send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: { _meta: meta() },
  })
  assert.equal(l?.['result'].resultType, 'complete')
  assert.deepEqual(l?.['result'].tools, [
    {
      name: 'echo',
      title: 'Echo',
      description: 'Says back what it is given.',
      inputSchema: echo.inputSchema,
    },
  ])
})

test('modern: an unsupported version is -32022; missing capabilities is -32602', async () => {
  const send = server()
  const r = await send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    params: { _meta: meta('1900-01-01') },
  })
  assert.equal(r?.['error'].code, -32022)
  assert.deepEqual(r?.['error'].data, {
    supported: [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
    requested: '1900-01-01',
  })
  const m = await send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
  })
  assert.equal(m?.['error'].code, -32602)
})

test('legacy: initialize echoes a supported revision, else the latest; results have no resultType', async () => {
  const send = server()
  const init = await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    },
  })
  assert.deepEqual(init?.['result'], {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'rness', version: '9.9.9' },
  })
  const other = await send({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2031-01-01' },
  })
  assert.equal(other?.['result'].protocolVersion, '2025-11-25')
  assert.equal(
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    null
  )
  const l = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.equal(l?.['result'].resultType, undefined)
  assert.equal(l?.['result'].tools.length, 1)
})

test('tools/call: a result, a refusal the model can act on, a throw, an unknown tool', async () => {
  const send = server()
  const call = (id: number, name: string, args: unknown) =>
    send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args, _meta: meta() },
    })
  assert.deepEqual((await call(1, 'echo', { text: 'hi' }))?.['result'], {
    resultType: 'complete',
    content: [{ type: 'text', text: 'echo: hi' }],
    isError: false,
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'rness', version: '9.9.9' },
    },
  })
  const refused = (await call(2, 'echo', {}))?.['result']
  assert.equal(refused.isError, true)
  assert.equal(refused.content[0].text, 'text is required')
  const broke = (await call(3, 'echo', { text: 'boom' }))?.['result']
  assert.equal(broke.isError, true)
  assert.match(broke.content[0].text, /it broke/)
  assert.equal((await call(4, 'nope', {}))?.['error'].code, -32602)
})

test('ping, notifications and unknown methods', async () => {
  const send = server()
  assert.deepEqual(
    (await send({ jsonrpc: '2.0', id: 1, method: 'ping' }))?.['result'],
    {}
  )
  assert.equal(
    await send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    }),
    null
  )
  assert.equal(
    (await send({ jsonrpc: '2.0', id: 2, method: 'resources/list' }))?.['error']
      .code,
    -32601
  )
})
