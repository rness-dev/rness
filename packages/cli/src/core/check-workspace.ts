import { type TargetOutcome, agentTargets } from './agent-targets.ts'
import { unsupportedAgents, unsupportedMessage } from './agents.ts'
import { type CheckBlocksResult, checkBlocks } from './blocks.ts'
import { checkBoards } from './board-checks.ts'
import { checkContract } from './contract.ts'
import { workspaceName } from './manifest.ts'
import { rnessCommand } from './pm.ts'
import { PROVIDERS, unsupportedProviderMessage } from './providers.ts'
import { scopeChain } from './scope.ts'
import { checkSkillCopies, skillConflicts, teamSkills } from './skills.ts'
import type { Manifest, Workspace } from './types.ts'

export interface WorkspaceCheck {
  /** One line each, as `validate` prints them off a terminal. */
  problems: string[]
  /** Said, never refused: `validate` prints them as warnings. */
  reported: string[]
  blocks: CheckBlocksResult
  targets: TargetOutcome[]
}

/**
 * The problems `rness validate` reports: extends cycles (thrown), the
 * front-matter contract, stale or malformed blocks, agents this copy cannot
 * compile, and values a declared target guarantees but a file lacks (spec
 * 0011 §3). Read-only. Shared with the session-start hook (spec 0015 §3).
 * `skillTrees` false (the safety net of every turn, ruling R30): no team
 * skill's tree is built, so the checks of a copy are those of its
 * `SKILL.md` alone and no copy is compared to its `tree`.
 */
export async function checkWorkspace(
  ws: Workspace,
  manifest: Manifest,
  opts: { skillTrees: boolean } = { skillTrees: true }
): Promise<WorkspaceCheck> {
  // loadManifest only checks that extends targets exist; walk every scope so
  // an extends cycle is reported here rather than breaking `context` later.
  for (const s of Object.keys(manifest.scopes)) scopeChain(manifest, s)
  const problems = await checkContract(ws.rnessDir)
  problems.push(...(await checkBoards(ws.rnessDir, manifest)))
  problems.push(
    ...skillConflicts(
      ws.rnessDir,
      manifest,
      await teamSkills(ws.rnessDir, manifest)
    )
  )
  const copies = await checkSkillCopies(ws.rnessDir, manifest, {
    trees: opts.skillTrees,
  })
  problems.push(...copies.problems)
  const blocks = await checkBlocks({
    root: ws.root,
    rnessDir: ws.rnessDir,
    manifest,
    org: workspaceName(manifest, ws.root),
  })
  problems.push(...blocks.problems)
  for (const name of unsupportedAgents(manifest.agents ?? []))
    problems.push(unsupportedMessage(name))
  if (manifest.provider !== null && !PROVIDERS[manifest.provider].available)
    problems.push(unsupportedProviderMessage(manifest.provider))
  const targets = await agentTargets(ws.root, manifest, { check: true })
  for (const o of targets)
    if (o.status === 'stale')
      problems.push(
        `${o.label}: ${o.detail ?? ''} (run ${rnessCommand()} sync)`
      )
    else if (o.status === 'invalid')
      problems.push(`${o.label}: ${o.detail ?? 'unreadable'}`)
  return { problems, reported: copies.reported, blocks, targets }
}
