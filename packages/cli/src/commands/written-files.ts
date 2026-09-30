import { writtenFiles } from '../core/agent-targets.ts'
import { loadManifest } from '../core/manifest.ts'
import { findWorkspace } from '../core/workspace.ts'

/**
 * Hidden, for `upgrade` (a fix to spec 0013 §8): the files this copy's sync
 * writes in a clone, as a JSON array. The copy that runs an upgrade asks the
 * one it just installed, whose release may write files it does not know.
 */
export async function writtenFilesCommand(opts: {
  cwd?: string
}): Promise<number> {
  try {
    const ws = await findWorkspace(opts.cwd ?? process.cwd())
    const manifest = await loadManifest(ws.rnessDir)
    process.stdout.write(`${JSON.stringify(writtenFiles(manifest))}\n`)
    return 0
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}
