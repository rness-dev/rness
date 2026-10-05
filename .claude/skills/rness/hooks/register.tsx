import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RnessSnapshot } from '../types'

// The rness plugin's mod (spec 0029 §3): the workspace on screen, drawn from
// what the pinned CLI prints (`rness status --json`). Nothing is computed
// here: the CLI words every line, the module only draws and refreshes.
//
// `sync` writes this file whole into `.claude/skills/rness/hooks/`, at the
// workspace root and at the root of each clone, with `RNESS` set to the path
// of `.rness` from that place, as the settings hooks have it. One path, never
// a guess: a clone runs the workspace's pinned copy, never one its own tree
// could hold.

const snapshot = atom({ plugin: 'rness', key: 'snapshot' } as const, null)
const tab = atom({ plugin: 'rness', key: 'tab' } as const, 0)
const interactive = atom(
  { plugin: 'rness', key: 'interactive' } as const,
  false
)

const PANE = 'rness'
const BIN = 'node_modules/@rness/cli/dist/bin/rness.js'
/** `.rness` from the project directory; `sync` writes `../../.rness` in a clone. */
const RNESS = '../../.rness'
const STATE = /[\\/]\.rness[\\/]/

/** The project directory: the plugin lives in its `.claude/skills/rness`. */
const projectOf = (root: string): string =>
  root.replace(/[\\/]\.claude[\\/]skills[\\/]rness[\\/]?$/, '')

/**
 * Reads the snapshot from the pinned CLI and keeps it; the status line
 * follows. No pinned copy, or a run that fails: no snapshot, nothing drawn.
 */
async function refresh($: EngineInterface): Promise<RnessSnapshot | null> {
  let next: RnessSnapshot | null = null
  try {
    const project = projectOf($.plugin.root)
    const bin = `${project}/${RNESS}/${BIN}`
    if (await $.fs.exists(bin)) {
      const ran = await $.process.run(
        ['node', bin, 'status', '--json', '--cwd', project],
        { cwd: project, timeoutMs: 20_000 }
      )
      if (ran.exitCode === 0) next = JSON.parse(ran.stdout) as RnessSnapshot
    }
  } catch {
    next = null
  }
  await update($, snapshot, () => next)
  $.ui.status(next?.statusLine)
  return next
}

/** A refresh off the dispatch that asked for it: a turn never waits for node. */
const later = ($: EngineInterface): void => {
  $.clock.after(0, () => void refresh($))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await update($, interactive, () => e.isInteractive)
    later($)
    return next(e)
  })

  // An edit of `.rness/` changes what the band and the pane show.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (STATE.test(e.file_path)) later($)
    return ran
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (STATE.test(e.file_path)) later($)
    return ran
  })

  // What no tool shows: a `git pull`, a file written through Bash.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) later($)
    return next(e)
  })

  // The notes to act on, whenever there are some (plan 0042). The banner is
  // the session-start line's, said once in the transcript: drawn here too,
  // it said the same thing twice.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, snapshot)
    if (e.props.hasSurvey || shown === null || shown.notes.length === 0)
      return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {shown.notes.map((note, i) => (
          <Box key={`note-${i}`}>
            <Text color="yellow" wrap="truncate-end">
              {note}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })

  // `/rness:status` is the skill's name: answered here with the pane, it
  // runs no model turn; with no snapshot, or no one to see a pane, the
  // skill's tables answer it.
  on('command.run', { command: 'rness:status' }, async ($, e, next) => {
    // Nobody to see a pane (`claude -p`): the tables are the answer.
    if (!(await $.state.get({ plugin: 'rness', key: 'interactive' })).value)
      return next(e)
    const shown =
      (await $.state.get({ plugin: 'rness', key: 'snapshot' })).value ??
      (await refresh($))
    if (shown === null || shown === undefined) return next(e)
    const wanted = e.args.trim().toLowerCase()
    const index = shown.tabs.findIndex(
      (t) => t.name.toLowerCase() === wanted || t.label.toLowerCase() === wanted
    )
    await update($, tab, (i) => (index === -1 ? i : index))
    // The pane takes the keys (plan 0042): a digit or Tab then Enter shows a
    // tab, ↑/↓ scroll as in the full-screen `rness status`, Esc and `q`
    // close it. A pane binds no ←/→ (Claude Code 2.1.289).
    const opened = await $.ui.open({
      id: PANE,
      title: `${shown.workspace} · status`,
      focus: true,
      closeOnEscape: true,
    })
    // A surface that places no pane (an older desktop): the tables instead.
    if (!opened.isPlaced) return next(e)
    return {
      text: 'The status of the workspace is open beside the conversation.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, snapshot)
    if (shown === null)
      return <Text dimColor>rness: the workspace status cannot be read.</Text>
    const at = Math.min(await read($, tab), Math.max(0, shown.tabs.length - 1))
    const current = shown.tabs[at]
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {shown.tabs.map((t, i) => (
            <Button
              key={`tab-${t.name}`}
              // Where the body has nothing to scroll, ↑/↓ walk these buttons:
              // only a press (Enter, a digit, a click) changes the tab.
              label={`${i < 9 ? `${i + 1} ` : ''}${t.label} (${t.rows.length})`}
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              variant={i === at ? 'primary' : 'secondary'}
              {...(i === at ? { autoFocus: true as const } : {})}
              onPress={() => update($, tab, () => i)}
            />
          ))}
          <Button
            key="close"
            label="Close"
            plain
            hotkey="q"
            role="dismiss"
            onPress={() => $.ui.close({ id: PANE })}
          />
        </Box>
        {current === undefined || current.rows.length === 0 ? (
          <Box key="empty">
            <Text dimColor>Nothing here yet.</Text>
          </Box>
        ) : (
          // Every row: the engine scrolls the body (↑/↓, PgUp/PgDn, Home/End).
          current.rows.map((row) => (
            <Box key={`row-${row.id}`}>
              <Text wrap="truncate-end">
                {row.id} {row.title} <Text dimColor>{row.status ?? '?'}</Text>
              </Text>
            </Box>
          ))
        )}
      </Box>
    )
  })
}
