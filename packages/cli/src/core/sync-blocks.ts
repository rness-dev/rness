import {
  runPinnedSync,
  summariseSync,
  syncOutcome,
  syncPinned,
} from './pinned.ts'
import type { Ui } from './ui.ts'

/**
 * `sync --yes` through the copy installed in `.rness/` (spec 0003 §2.2), said
 * the way `ui` speaks. The plain look passes the child's lines through, as it
 * always did. The session look keeps them to itself and says them in one —
 * `Synced 3 blocks: 2 updated, 1 unchanged` — since the child, whose stdout
 * is a pipe, can only print the plain look. `inPlace` runs when nothing is
 * installed (`create --skip-install`).
 */
export async function syncBlocks(
  ui: Ui,
  root: string,
  shown: string,
  inPlace?: () => Promise<number>,
  sshWorks?: boolean
): Promise<number> {
  if (!ui.session)
    return ui.step({ doing: 'syncing  the blocks', git: true }, () =>
      syncPinned(root, shown, inPlace)
    )
  const result = await ui.step(
    {
      doing: 'syncing  the blocks',
      sentence: 'Writing the rness block into every AGENTS.md',
    },
    () => runPinnedSync(root),
    (r) =>
      r === null || r.code !== 0
        ? null
        : ['synced', summariseSync(r.stdout).summary]
  )
  if (result === null) {
    if (inPlace !== undefined) return inPlace()
    ui.error(
      `@rness/cli is not installed in ${shown}/.rness; install in .rness/, then rness sync`
    )
    return 1
  }
  const outcome = syncOutcome(result, { sshWorks: sshWorks === true })
  for (const line of outcome.hints) ui.hint(line)
  for (const line of outcome.errors) ui.error(line)
  return outcome.code
}
