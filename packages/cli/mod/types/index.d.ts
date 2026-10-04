// The values the rness mod keeps in `$.state` (spec 0029 §3.2). The
// snapshot is what `rness status --json` prints: `StatusSnapshot` in
// `src/commands/snapshot.ts`, read here as data.

export type RnessRow = {
  id: string
  title: string
  status: string | null
  path: string
}

export type RnessTab = { name: string; label: string; rows: RnessRow[] }

export type RnessSnapshot = {
  version: string
  workspace: string
  scope: string | null
  banner: string
  statusLine: string
  inProgress: string[]
  notes: string[]
  tabs: RnessTab[]
}

declare module 'claude-code' {
  interface PluginState {
    rness: {
      /** The last snapshot; null while none could be read. */
      snapshot: RnessSnapshot | null
      /** Whether the developer has sent a prompt: the band then waits for a note. */
      prompted: boolean
      /** The pane's tab, by its index in the snapshot. */
      tab: number
      /** Whether someone watches the session: no pane for `claude -p`. */
      interactive: boolean
    }
  }
}
