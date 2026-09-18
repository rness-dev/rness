import { checkBlocks } from '../core/blocks.ts'
import { checkContract } from '../core/contract.ts'
import { loadManifest, resolveOrg } from '../core/manifest.ts'
import { scopeChain } from '../core/scope.ts'
import { warn } from '../core/style.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

export interface ValidateOptions {
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

/** `rness validate`: manifest, extends cycles, front-matter contract, stale blocks. Returns the exit code. */
export async function validateCommand(opts: ValidateOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    // loadManifest only checks that extends targets exist; walk every scope so
    // an extends cycle is reported here rather than breaking `context` later.
    for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
    const { org, warning } = resolveOrg(manifest, ws.root)
    const warnings: string[] = warning === null ? [] : [warning]
    const problems = await checkContract(ws.rnessDir)
    const blocks = await checkBlocks({
      root: ws.root,
      rnessDir: ws.rnessDir,
      manifest,
      org,
    })
    problems.push(...blocks.problems)
    warnings.push(...blocks.warnings)
    for (const p of problems) process.stderr.write(`${p}\n`)
    for (const w of warnings) process.stderr.write(`${warn(w)}\n`)
    if (problems.length > 0) return 1
    process.stdout.write('context ok\n')
    return 0
  } catch (e) {
    return reportError(e)
  }
}
