import { findWorkspace } from '../core/workspace.ts'
import { loadManifest } from '../core/manifest.ts'
import { scopeChain } from '../core/scope.ts'
import { checkContract } from '../core/contract.ts'
import { usage } from './index.mjs'

function parse(args) {
  const opts = { cwd: process.cwd() }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--cwd') {
      // --cwd is an internal flag for tests; not part of the public interface.
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) return { ok: false }
      opts.cwd = value
      i += 1
    } else {
      return { ok: false }
    }
  }
  return { ok: true, opts }
}

export async function validateCommand(args) {
  const parsed = parse(args)
  if (!parsed.ok) {
    process.stderr.write(usage())
    return 2
  }
  const opts = parsed.opts
  let ws
  try {
    ws = await findWorkspace(opts.cwd)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }
  try {
    const manifest = await loadManifest(ws.rnessDir)
    // loadManifest only checks that extends targets exist; walk every scope so
    // an extends cycle is reported here rather than silently breaking `context`.
    for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }
  const problems = await checkContract(ws.rnessDir)
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`${p}\n`)
    return 1
  }
  process.stdout.write('context ok\n')
  return 0
}
