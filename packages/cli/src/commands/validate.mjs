import { findWorkspace } from '../core/workspace.mjs'
import { loadManifest } from '../core/manifest.mjs'
import { checkContract } from '../core/contract.mjs'

function parse(args) {
  const opts = { cwd: process.cwd() }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--cwd') opts.cwd = args[++i]
  }
  return opts
}

export async function validateCommand(args) {
  const opts = parse(args)
  let ws
  try {
    ws = await findWorkspace(opts.cwd)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }
  try {
    await loadManifest(ws.rnessDir)
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
