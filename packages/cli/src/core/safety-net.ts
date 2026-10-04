import { checkWorkspace } from './check-workspace.ts'
import type { loadManifest } from './manifest.ts'
import { pinDrift, workspacePackageManager } from './pinned.ts'
import { count } from './style.ts'
import type { Workspace } from './types.ts'

/** How many of `validate`'s problems the safety net spells out. */
export const SHOWN_PROBLEMS = 3

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

/**
 * Why the context may be wrong (spec 0015 §3): the installed copy, then
 * validate's problems, the first few spelled out on indented lines. What the
 * session-start hook says, and what the Claude Code mod shows (spec 0029).
 */
export async function safetyNet(
  ws: Workspace,
  manifest: Awaited<ReturnType<typeof loadManifest>>
): Promise<string[]> {
  const notes: string[] = []
  const drift = await pinDrift(ws.rnessDir)
  if (drift !== null)
    notes.push(
      `.rness pins @rness/cli ${drift.pin} but ${drift.installed ?? 'nothing'} is installed — run ${await workspacePackageManager(ws.rnessDir)} install in .rness`
    )
  try {
    const { problems } = await checkWorkspace(ws, manifest)
    if (problems.length > 0)
      notes.push(
        `${count(problems.length, ['problem', 'problems'])} in the workspace context — run rness validate`,
        ...problems.slice(0, SHOWN_PROBLEMS).map((p) => `  ${p}`)
      )
  } catch (e) {
    notes.push(message(e))
  }
  return notes
}
