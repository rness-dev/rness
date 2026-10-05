import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RnessRow, RnessSnapshot } from '../types'

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
const open = atom({ plugin: 'rness', key: 'open' } as const, null)

const PANE = 'rness'
const BIN = 'node_modules/@rness/cli/dist/bin/rness.js'
/** `.rness` from the project directory; `sync` writes `../../.rness` in a clone. */
const RNESS = '.rness'
const STATE = /[\\/]\.rness[\\/]/

/**
 * Agent Pulse's option colours, which the CLI names for each row (spec 0017
 * §3), as the surface names them: the board's purple and pink are the
 * terminal's magenta, its orange the terminal's yellow.
 */
const COLORS: Readonly<Record<string, string>> = {
  gray: 'gray',
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  orange: 'yellow',
  red: 'red',
  pink: 'magenta',
  purple: 'magenta',
}

/** What one `Markdown` draws at most (10000 on Claude Code 2.1.289), with room. */
const PIECE = 9000

/** The project directory: the plugin lives in its `.claude/skills/rness`. */
const projectOf = (root: string): string =>
  root.replace(/[\\/]\.claude[\\/]skills[\\/]rness[\\/]?$/, '')

/**
 * Reads the snapshot from the pinned CLI and keeps it; the status line
 * follows, and so does the document open in the pane, read again. No
 * pinned copy, or a run that fails: no snapshot, nothing drawn.
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
  const opened = (await $.state.get({ plugin: 'rness', key: 'open' })).value
  if (opened !== null && opened !== undefined) await show($, opened.path)
  return next
}

/** A refresh off the dispatch that asked for it: a turn never waits for node. */
const later = ($: EngineInterface): void => {
  $.clock.after(0, () => void refresh($))
}

/** The document at `path` in `.rness/`, read and shown in place of the list. */
async function show($: EngineInterface, path: string): Promise<void> {
  let text: string | null
  try {
    text = await $.fs.read(`${projectOf($.plugin.root)}/${RNESS}/${path}`)
  } catch {
    text = null
  }
  await update($, open, () => ({ path, text }))
}

/** The row of the document at `path`, whichever tab lists it. */
const rowOf = (shown: RnessSnapshot, path: string): RnessRow | undefined =>
  shown.tabs.flatMap((t) => t.rows).find((row) => row.path === path)

/** `text` cut to `max` cells with an ellipsis, as the full-screen view cuts a title. */
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`

/**
 * The document without its front matter, as its issue's body starts (spec
 * 0018 §3): the CLI's `stripFrontMatter`, the blank lines after it included.
 */
const bodyOf = (text: string): string =>
  text
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/, '')
    .replace(/^(?:[ \t]*\r?\n)+/, '')

/** A line opening or closing a code fence, in a paragraph. */
const FENCES = /^(`{3,}|~{3,})/gm

/**
 * `text` in pieces a `Markdown` can draw: cut at a blank line, a fenced block
 * kept whole; a paragraph or a block longer than a piece is cut as it is. A
 * control character other than tab and newline is dropped: a `Markdown`
 * refuses it.
 */
function pieces(text: string): string[] {
  const out: string[] = []
  let piece = ''
  const put = (unit: string): void => {
    if (piece !== '' && piece.length + 2 + unit.length > PIECE) {
      out.push(piece)
      piece = ''
    }
    piece = piece === '' ? unit : `${piece}\n\n${unit}`
    while (piece.length > PIECE) {
      out.push(piece.slice(0, PIECE))
      piece = piece.slice(PIECE)
    }
  }
  let block: string | null = null
  for (const para of text.replace(/[^\P{Cc}\t\n]/gu, '').split('\n\n')) {
    const opensOrCloses = (para.match(FENCES) ?? []).length % 2 === 1
    if (block !== null) {
      block = `${block}\n\n${para}`
      if (opensOrCloses) {
        put(block)
        block = null
      }
    } else if (opensOrCloses) block = para
    else put(para)
  }
  if (block !== null) put(block)
  if (piece !== '') out.push(piece)
  return out
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
    // The command asks for the list, whatever the pane showed before.
    await update($, open, () => null)
    // The pane takes the keys (plan 0042): a digit or Tab then Enter shows a
    // tab, Enter on a row opens its document, ↑/↓ scroll as in the
    // full-screen `rness status`, Esc and `q` close. A pane binds no ←/→
    // (Claude Code 2.1.289).
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

  // The row the ring lands on is asked into view: Tab walks the rows of a
  // tab too long for the pane, while ↑/↓ scroll it. A scroll the engine
  // refuses, or cannot place (a test), changes nothing.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const ran = await next(e)
    if (e.origin.kind === 'person' && e.element !== undefined)
      void $.ui.scroll({ to: { key: e.element }, in: PANE }).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    const shown = await read($, snapshot)
    if (shown === null)
      return <Text dimColor>rness: the workspace status cannot be read.</Text>
    const opened = await read($, open)

    // One document, in place of the list: `q` brings the list back, Esc
    // still closes the pane. Its item on Agent Pulse is a link.
    if (opened !== null) {
      const row = rowOf(shown, opened.path)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {[
              <Button
                key="back"
                label="Back"
                plain
                hotkey="q"
                autoFocus
                onPress={() => update($, open, () => null)}
              />,
              ...(row?.link != null
                ? [<Link key="pulse" href={row.link} label="Agent Pulse" />]
                : []),
            ]}
          </Box>
          <Box key="head">
            {row === undefined ? (
              <Text bold wrap="truncate-end">
                {opened.path}
              </Text>
            ) : (
              <Text wrap="truncate-end">
                <Text bold>
                  {row.id} {row.title}
                </Text>{' '}
                <Text color={COLORS[row.color]}>{row.status ?? '?'}</Text>
              </Text>
            )}
          </Box>
          {opened.text === null ? (
            <Box key="unread">
              <Text dimColor>rness: {opened.path} cannot be read.</Text>
            </Box>
          ) : (
            pieces(bodyOf(opened.text)).map((piece, i) => (
              <Markdown key={`doc-${i}`} text={piece} />
            ))
          )}
        </Box>
      )
    }

    const at = Math.min(await read($, tab), Math.max(0, shown.tabs.length - 1))
    const current = shown.tabs[at]
    const width = e.props.bodyColumns ?? 80
    // The ring starts on the newest document, for Enter to open it; on the
    // tab's button when the tab is empty.
    const first = current !== undefined && current.rows.length > 0
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {[
            ...shown.tabs.map((t, i) => (
              <Button
                key={`tab-${t.name}`}
                // Where the body has nothing to scroll, ↑/↓ walk these buttons:
                // only a press (Enter, a digit, a click) changes the tab.
                label={`${i < 9 ? `${i + 1} ` : ''}${t.label} (${t.rows.length})`}
                {...(i < 9 ? { hotkey: String(i + 1) } : {})}
                variant={i === at ? 'primary' : 'secondary'}
                {...(i === at && !first ? { autoFocus: true as const } : {})}
                onPress={() => update($, tab, () => i)}
              />
            )),
            <Button
              key="close"
              label="Close"
              plain
              hotkey="q"
              role="dismiss"
              onPress={() => $.ui.close({ id: PANE })}
            />,
            ...(shown.pulse != null
              ? [<Link key="pulse" href={shown.pulse} label="Agent Pulse" />]
              : []),
          ]}
        </Box>
        {current === undefined || current.rows.length === 0 ? (
          <Box key="empty">
            <Text dimColor>Nothing here yet.</Text>
          </Box>
        ) : (
          // Every row: the engine scrolls the body (↑/↓, PgUp/PgDn, Home/End).
          // Enter, or a click, on a row opens its document. Keyed by path: two
          // documents of one date share an id.
          current.rows.map((row, i) => {
            const status = row.status ?? '?'
            return (
              <Box key={`row-${row.path}`} flexDirection="row" gap={1}>
                <Button
                  key={`open-${row.path}`}
                  plain
                  label={cut(
                    `${row.id} ${row.title}`,
                    width - status.length - 1
                  )}
                  {...(i === 0 ? { autoFocus: true as const } : {})}
                  onPress={() => void show($, row.path)}
                />
                <Text color={COLORS[row.color]}>{status}</Text>
              </Box>
            )
          })
        )}
      </Box>
    )
  })
}
