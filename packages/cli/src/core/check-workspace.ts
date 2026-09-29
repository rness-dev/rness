import { type TargetOutcome, agentTargets } from './agent-targets.ts'
import { unsupportedAgents, unsupportedMessage } from './agents.ts'
import { type CheckBlocksResult, checkBlocks } from './blocks.ts'
import { checkContract } from './contract.ts'
import { providerOf, workspaceName } from './manifest.ts'
import { rnessCommand } from './pm.ts'
import { PROVIDERS, unsupportedProviderMessage } from './providers.ts'
import { scopeChain } from './scope.ts'
import type { Manifest, Workspace } from './types.ts'

export interface WorkspaceCheck {
  /** One line each, as `validate` prints them off a terminal. */
  problems: string[]
  blocks: CheckBlocksResult
  targets: TargetOutcome[]
}

/**
 * The problems `rness validate` reports: extends cycles (thrown), the
 * front-matter contract, stale or malformed blocks, agents this copy cannot
 * compile, and values a declared target guarantees but a file lacks (spec
 * 0011 §3). Read-only. Shared with the session-start hook (spec 0015 §3).
 */
export async function checkWorkspace(
  ws: Workspace,
  manifest: Manifest
): Promise<WorkspaceCheck> {
  // loadManifest only checks that extends targets exist; walk every scope so
  // an extends cycle is reported here rather than breaking `context` later.
  for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
  const problems = await checkContract(ws.rnessDir)
  const blocks = await checkBlocks({
    root: ws.root,
    rnessDir: ws.rnessDir,
    manifest,
    org: workspaceName(manifest, ws.root),
  })
  problems.push(...blocks.problems)
  for (const name of unsupportedAgents(manifest.agents ?? []))
    problems.push(unsupportedMessage(name))
  const provider = providerOf(manifest)
  if (!PROVIDERS[provider].available)
    problems.push(unsupportedProviderMessage(provider))
  const targets = await agentTargets(ws.root, manifest, { check: true })
  for (const o of targets)
    if (o.status === 'stale')
      problems.push(
        `${o.label}: ${o.detail ?? ''} (run ${rnessCommand()} sync)`
      )
    else if (o.status === 'invalid')
      problems.push(`${o.label}: ${o.detail ?? 'unreadable'}`)
  return { problems, blocks, targets }
}
