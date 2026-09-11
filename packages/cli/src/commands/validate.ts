import { findWorkspace } from '../core/workspace.ts'
import { loadManifest } from '../core/manifest.ts'
import { scopeChain } from '../core/scope.ts'
import { checkContract } from '../core/contract.ts'

export interface ValidateOptions {
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

/** `rness validate`: manifest, extends cycles, and the front-matter contract. Returns the exit code. */
export async function validateCommand(opts: ValidateOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  let rnessDir: string
  try {
    const ws = await findWorkspace(cwd)
    rnessDir = ws.rnessDir
    const manifest = await loadManifest(rnessDir)
    // loadManifest only checks that extends targets exist; walk every scope so
    // an extends cycle is reported here rather than breaking `context` later.
    for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${message}\n`)
    if (process.env['RNESS_DEBUG'] && e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`)
    return 1
  }
  const problems = await checkContract(rnessDir)
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`${p}\n`)
    return 1
  }
  process.stdout.write('context ok\n')
  return 0
}
