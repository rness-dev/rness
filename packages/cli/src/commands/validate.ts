import { checkBlocks } from '../core/blocks.ts'
import { checkContract } from '../core/contract.ts'
import type { CommandDeps } from '../core/deps.ts'
import { loadManifest, resolveOrg } from '../core/manifest.ts'
import { scopeChain } from '../core/scope.ts'
import { warn } from '../core/style.ts'
import { defaultTerminal } from '../core/terminal.ts'
import { makeUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

export interface ValidateOptions {
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

/**
 * `rness validate`: manifest, extends cycles, front-matter contract, stale
 * blocks. Returns the exit code.
 *
 * Off a terminal — CI, a git hook, an agent, a pipe — it writes the bytes it
 * always has (spec 0007 rule 1), and never loads a prompt library: that path
 * is ADR 0004's trust anchor. In a real terminal it speaks through the same
 * reporter as the interactive commands (spec 0007 §5c): a count of the blocks
 * that are current, a line for each that is not, and the verdict as the outro.
 */
export async function validateCommand(
  opts: ValidateOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
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

    const ui = await makeUi(deps.terminal ?? defaultTerminal)
    if (!ui.session) {
      for (const p of problems) process.stderr.write(`${p}\n`)
      for (const w of warnings) process.stderr.write(`${warn(w)}\n`)
      if (problems.length > 0) return 1
      process.stdout.write('context ok\n')
      return 0
    }

    ui.intro(`Validate ${org}`)
    // One line per target, as `sync` reports one per file it walked: the two
    // commands cross the same targets, so they read the same (spec 0007 §5c).
    // A conforming block is grey — green means something was written, and on a
    // large organization that is what must stand out (spec 0007 §4).
    for (const c of blocks.checks)
      if (c.message === null) ui.line('current', c.label)
      else if (c.status === 'stale' || c.status === 'malformed')
        ui.error(c.message)
      else ui.warn(c.message)
    for (const p of problems) if (!blocks.problems.includes(p)) ui.error(p)
    for (const w of warnings) if (!blocks.warnings.includes(w)) ui.warn(w)
    ui.outro(
      problems.length > 0 ? 'Context mismatch' : 'Context OK',
      problems.length > 0 ? 'error' : 'done'
    )
    return problems.length > 0 ? 1 : 0
  } catch (e) {
    return reportError(e)
  }
}
