import { posix, relative, sep } from 'node:path'
import { emitKeypressEvents } from 'node:readline'

import { loadManifest, workspaceName } from '../core/manifest.ts'
import { resolveScope } from '../core/scope.ts'
import {
  type Key,
  type Look,
  type View,
  clampView,
  pageSize,
  press,
  renderView,
} from '../core/status-view.ts'
import {
  type StatusTab,
  findTab,
  statusMarkdown,
  statusTabs,
} from '../core/status.ts'
import { bold, grey, inverse, paint } from '../core/style.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { statusSnapshot } from './snapshot.ts'

export interface StatusOptions {
  /** Internal (tests, the Claude skill): directory to resolve from; default `process.cwd()`. */
  cwd?: string
  /** One JSON object, what the Claude Code mod draws (spec 0029 §3.2), terminal or not. */
  json?: boolean
}

/** The terminal the view takes: the process's own, a fake one in tests. */
export interface StatusTerminal {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

const ENTER = '\x1b[?1049h\x1b[?25l' // alternate screen, cursor hidden
const LEAVE = '\x1b[?25h\x1b[?1049l' // cursor shown, the screen as it was

function lookFor(output: NodeJS.WriteStream): Look {
  return {
    bold: (text) => bold(text, output),
    dim: (text) => grey(text, output),
    inverse: (text) => inverse(text, output),
    tone: (tone, text) =>
      tone === 'done'
        ? paint('done', text, output)
        : tone === 'dropped'
          ? grey(text, output)
          : tone === 'missing'
            ? paint('error', text, output)
            : paint('warn', text, output),
  }
}

interface Keypress {
  name?: string
  ctrl?: boolean
  shift?: boolean
}

const MOVES: ReadonlySet<string> = new Set([
  'left',
  'right',
  'up',
  'down',
  'pageup',
  'pagedown',
  'home',
  'end',
])

/** A keypress as the view reads it, `close`, or nothing it knows. */
function keyOf(key: Keypress | undefined): Key | 'close' | null {
  const name = key?.name
  if (name === undefined) return null
  if (name === 'q' || name === 'escape' || (key?.ctrl === true && name === 'c'))
    return 'close'
  if (name === 'tab') return key?.shift === true ? 'backtab' : 'tab'
  return MOVES.has(name) ? (name as Key) : null
}

/**
 * The view (spec 0016 §2.2): the alternate screen, raw keys, a redraw on
 * each key and each resize. Resolves when closed, the terminal restored —
 * also when drawing throws.
 */
function showView(
  tabs: readonly StatusTab[],
  workspace: string,
  start: number,
  { input, output }: StatusTerminal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const look = lookFor(output)
    let view: View = { tab: start, top: 0 }
    const rows = (): number => output.rows || 24
    const draw = (): void => {
      view = clampView(view, tabs, pageSize(rows()))
      const lines = renderView(
        view,
        tabs,
        workspace,
        output.columns || 80,
        rows(),
        look
      )
      output.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\r\n')}\x1b[J`)
    }
    const restore = (): void => {
      output.write(LEAVE)
    }
    const close = (error?: unknown): void => {
      input.off('keypress', onKey)
      output.off('resize', onResize)
      process.off('exit', restore)
      input.setRawMode(false)
      input.pause()
      restore()
      if (error === undefined) resolve()
      else reject(error)
    }
    const guarded = (step: () => void): void => {
      try {
        step()
      } catch (e) {
        close(e)
      }
    }
    const onKey = (_: string | undefined, key: Keypress | undefined): void => {
      const k = keyOf(key)
      if (k === 'close') close()
      else if (k !== null)
        guarded(() => {
          view = press(view, k, tabs, pageSize(rows()))
          draw()
        })
    }
    const onResize = (): void => {
      guarded(draw)
    }
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    output.write(ENTER)
    // Should the process end another way, the shell gets its screen back.
    process.on('exit', restore)
    input.on('keypress', onKey)
    output.on('resize', onResize)
    guarded(draw)
  })
}

/**
 * `rness status [tab]`: every tracked document of `.rness/` and its status,
 * a tab per directory (spec 0016). In a terminal, a view to move around;
 * off one, Markdown. Read-only.
 */
export async function statusCommand(
  tab: string | undefined,
  opts: StatusOptions,
  terminal: StatusTerminal = { input: process.stdin, output: process.stdout }
): Promise<number> {
  try {
    const cwd = opts.cwd ?? process.cwd()
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const workspace = workspaceName(manifest, ws.root)
    const tabs = await statusTabs(ws.rnessDir)
    const wanted = tab === undefined ? undefined : findTab(tabs, tab)
    if (tab !== undefined && wanted === undefined) {
      process.stderr.write(
        `unknown tab "${tab}" (tabs: ${tabs.map((t) => t.name).join(', ')})\n`
      )
      return 2
    }
    const shown = wanted === undefined ? tabs : [wanted]
    if (opts.json === true) {
      const scope = resolveScope(
        manifest,
        relative(ws.root, cwd).split(sep).join(posix.sep)
      )
      terminal.output.write(
        `${JSON.stringify(await statusSnapshot(ws, manifest, scope, shown))}\n`
      )
      return 0
    }
    if (terminal.input.isTTY === true && terminal.output.isTTY === true) {
      await showView(
        tabs,
        workspace,
        wanted === undefined ? 0 : tabs.indexOf(wanted),
        terminal
      )
      return 0
    }
    terminal.output.write(statusMarkdown(workspace, shown))
    return 0
  } catch (e) {
    return reportError(e)
  }
}
