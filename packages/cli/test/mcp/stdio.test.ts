import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { makeWorkspace } from '../helpers/workspace.ts'

const BIN = fileURLToPath(new URL('../../src/bin/rness.ts', import.meta.url))

/** `rness mcp` from the sources, fed `lines`; what it wrote, once stdin closed. */
function serve(cwd: string, lines: unknown[]) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (done) => {
      const child = spawn(process.execPath, [BIN, 'mcp'], {
        cwd,
        env: { ...process.env, RNESS_NO_DELEGATE: '1' },
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (b) => (out += String(b)))
      child.stderr.on('data', (b) => (err += String(b)))
      child.on('close', (code) => done({ code, out, err }))
      child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    }
  )
}

test('rness mcp over stdio: both generations, only JSON on stdout, exit on end of input', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    files: {
      'adr/0006-workspace.md': '---\nstatus: Accepted\n---\n\n# A workspace\n',
    },
    dirs: ['org'],
  })
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  }
  const r = await serve(root, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: meta },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'rness_context', arguments: {}, _meta: meta },
    },
  ])
  assert.equal(r.code, 0, r.err)
  const replies = r.out
    .trimEnd()
    .split('\n')
    .map(
      (l) => JSON.parse(l) as { id: number; result: Record<string, unknown> }
    )
  assert.deepEqual(
    replies.map((x) => x.id),
    [1, 2, 3]
  )
  assert.equal(replies[1]?.result['protocolVersion'], '2025-06-18')
  const content = replies[2]?.result['content'] as { text: string }[]
  assert.match(
    content[0]?.text ?? '',
    /- 0006 Accepted — A workspace — adr\/0006-workspace\.md/
  )
})
