import { agentTargets } from '../core/agent-targets.ts'
import { unsupportedAgents, unsupportedMessage } from '../core/agents.ts'
import { checkBlocks } from '../core/blocks.ts'
import { checkContract } from '../core/contract.ts'
import type { CommandDeps } from '../core/deps.ts'
import { loadManifest, workspaceName } from '../core/manifest.ts'
import { EXACT_VERSION, readPin } from '../core/pinned.ts'
import { rnessCommand } from '../core/pm.ts'
import {
  findScaffoldBase,
  isRepository,
  isShallow,
} from '../core/scaffold-git.ts'
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
    const org = workspaceName(manifest, ws.root)
    const problems = await checkContract(ws.rnessDir)
    const blocks = await checkBlocks({
      root: ws.root,
      rnessDir: ws.rnessDir,
      manifest,
      org,
    })
    problems.push(...blocks.problems)
    // The team's agents (spec 0011 §3): a name this copy cannot compile, and
    // a value a declared target guarantees but a clone lacks.
    for (const name of unsupportedAgents(manifest.agents ?? []))
      problems.push(unsupportedMessage(name))
    const targets = await agentTargets(ws.root, manifest, { check: true })
    for (const o of targets)
      if (o.status === 'stale')
        problems.push(
          `${o.label}: ${o.detail ?? ''} (run ${rnessCommand()} sync)`
        )
      else if (o.status === 'invalid')
        problems.push(`${o.label}: ${o.detail ?? 'unreadable'}`)

    // The scaffold (spec 0013 §4): a warning, never a problem — and nothing
    // in a one-commit CI checkout, whose history is not there to read.
    const scaffoldWarnings: string[] = []
    if ((await isRepository(ws.rnessDir)) && !(await isShallow(ws.rnessDir))) {
      const pin = await readPin(ws.rnessDir)
      const base = await findScaffoldBase(ws.rnessDir)
      if (base === null || base.version === null)
        scaffoldWarnings.push(
          `the scaffold is not tracked in .rness yet: run ${rnessCommand()} upgrade`
        )
      else if (
        pin !== null &&
        EXACT_VERSION.test(pin.spec) &&
        pin.spec !== base.version
      )
        scaffoldWarnings.push(
          `the @rness/cli ${pin.spec} scaffold is not merged here: run ${rnessCommand()} upgrade`
        )
    }

    const ui = await makeUi(deps.terminal ?? defaultTerminal)
    if (!ui.session) {
      for (const p of problems) process.stderr.write(`${p}\n`)
      for (const w of [...blocks.warnings, ...scaffoldWarnings])
        process.stderr.write(`${warn(w)}\n`)
      if (problems.length > 0) return 1
      process.stdout.write('context ok\n')
      return 0
    }

    ui.intro(`Validate ${org}`)
    // One line per target, as `sync` reports one per file it walked: the two
    // commands cross the same targets, so they read the same (spec 0007 §5c).
    // A conforming block is grey — green means something was written, and on a
    // large organization that is what must stand out (spec 0007 §4).
    // The root CLAUDE.md follows the root AGENTS.md, as in `sync`: its line
    // is said only when its status differs.
    const rootStatus = blocks.checks.find(
      (c) => c.label === 'AGENTS.md'
    )?.status
    const shown = blocks.checks.filter(
      (c) => !(c.label === 'CLAUDE.md' && c.status === rootStatus)
    )
    for (const c of shown)
      if (c.message === null) ui.line('current', c.label)
      else if (c.status === 'stale' || c.status === 'malformed')
        ui.error(c.message)
      else ui.warn(c.message)
    for (const o of targets)
      if (o.status === 'unchanged') ui.line('current', o.label)
    for (const p of problems) if (!blocks.problems.includes(p)) ui.error(p)
    for (const w of scaffoldWarnings) ui.warn(w)
    ui.outro(
      problems.length > 0 ? 'Context mismatch' : 'Context OK',
      problems.length > 0 ? 'error' : 'done'
    )
    return problems.length > 0 ? 1 : 0
  } catch (e) {
    return reportError(e)
  }
}
