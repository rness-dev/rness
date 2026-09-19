import { styleText } from 'node:util'

// The CLI's look (spec 0007). This module imports `node:util` only, so the
// lean commands (`context`, `validate`) can use it. Whether a stream gets
// colour is `util.styleText`'s decision: a terminal, unless NO_COLOR; any
// stream with FORCE_COLOR. Off a terminal every function returns plain text —
// the bytes scripts, CI and the tests have always read.

export type Tone = 'done' | 'idle' | 'info' | 'warn' | 'error'

type Format = Parameters<typeof styleText>[0]

const FORMAT: Record<Tone, Format> = {
  done: 'green',
  idle: 'dim',
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
}

/** https://no-color.org: any non-empty value; FORCE_COLOR, being explicit, wins. */
function noColor(): boolean {
  const off = process.env['NO_COLOR']
  return (
    off !== undefined && off !== '' && process.env['FORCE_COLOR'] === undefined
  )
}

export function paint(
  tone: Tone,
  text: string,
  stream: NodeJS.WriteStream = process.stdout
): string {
  if (noColor()) return text
  return styleText(FORMAT[tone], text, { stream, validateStream: true })
}

const IDLE = new Set(['unchanged', 'skipped', 'not cloned'])
const DONE = new Set([
  'created',
  'cloned',
  'adopted',
  'declared',
  'installed',
  'committed',
  'updated',
  'upgraded',
  'pulled',
  'pushed',
  'logged in',
  'logged out',
  'synced',
  'listed',
])

/** What a status verb says about the step: it changed something, it did not, or it is progress. */
export function toneOf(verb: string): Tone {
  if (DONE.has(verb)) return 'done'
  if (IDLE.has(verb)) return 'idle'
  if (verb === 'stale') return 'warn'
  return 'info'
}

/** The width verbs are padded to; a longer verb (`unchanged`) takes its own. */
const COLUMN = 8

/**
 * One status line: the verb painted by its tone and padded to the column,
 * then `rest`, untouched — a path stays readable on any background.
 */
export function status(
  verb: string,
  rest: string,
  stream: NodeJS.WriteStream = process.stdout
): string {
  const pad = ' '.repeat(Math.max(0, COLUMN - verb.length))
  return `${paint(toneOf(verb), verb, stream)}${pad} ${rest}`
}

export function bold(
  text: string,
  stream: NodeJS.WriteStream = process.stdout
): string {
  if (noColor()) return text
  return styleText('bold', text, { stream, validateStream: true })
}

/**
 * A title on a coloured background — the intro of a session. Without colour
 * it is the bare text: padding only makes sense around a background.
 */
export function badge(
  text: string,
  stream: NodeJS.WriteStream = process.stdout
): string {
  if (noColor()) return text
  const padded = ` ${text} `
  const painted = styleText(['bgCyan', 'black', 'bold'], padded, {
    stream,
    validateStream: true,
  })
  return painted === padded ? text : painted
}

/** Grey, for what is read after the rest: a box of next steps. */
export function grey(
  text: string,
  stream: NodeJS.WriteStream = process.stdout
): string {
  if (noColor()) return text
  return styleText('gray', text, { stream, validateStream: true })
}

/**
 * Can this terminal draw characters beyond ASCII? The rule `@clack/prompts`
 * follows for its own symbols: everywhere but the Linux console and the
 * legacy Windows console.
 */
export function unicode(): boolean {
  if (process.platform !== 'win32') return process.env['TERM'] !== 'linux'
  return (
    process.env['WT_SESSION'] !== undefined ||
    process.env['TERM_PROGRAM'] === 'vscode'
  )
}

/** A private repository, said with a padlock; a public one says nothing. */
export const PRIVATE_MARK = '🔒'

/** `warning: …` for stderr, the prefix painted. */
export function warn(text: string): string {
  return `${paint('warn', 'warning:', process.stderr)} ${text}`
}

// `rness`, rendered once with cfonts' "tiny" font and kept as a constant: one
// fixed word does not need a font engine at run time.
const WORD = [' █▀█ █▄ █ █▀▀ █▀▀ █▀▀', ' █▀▄ █ ▀█ ██▄ ▄▄█ ▄▄█']

const FROM = [63, 185, 80] as const // green
const TO = [57, 197, 207] as const // cyan

/**
 * The only hand-written escape sequences of the code base: `util.styleText`
 * has no 24-bit colour. A left-to-right gradient, one colour per column.
 */
function gradient(line: string): string {
  const chars = [...line]
  const last = Math.max(1, chars.length - 1)
  const painted = chars.map((ch, i) => {
    if (ch === ' ') return ch
    const [r, g, b] = FROM.map((from, c) =>
      Math.round(from + (((TO[c] ?? from) - from) * i) / last)
    )
    return `\x1b[38;2;${r};${g};${b}m${ch}`
  })
  return `${painted.join('')}\x1b[39m`
}

/**
 * The banner, or `''` where it has no place: a pipe, a file, CI. Shown on a
 * terminal (and with FORCE_COLOR); the gradient only where the terminal says
 * it has true colour, plain green otherwise, no colour under NO_COLOR.
 */
export function banner(
  version: string,
  stream: NodeJS.WriteStream = process.stdout
): string {
  const forced =
    process.env['FORCE_COLOR'] !== undefined &&
    process.env['FORCE_COLOR'] !== '0'
  if (stream.isTTY !== true && !forced) return ''
  const coloured = paint('done', 'x', stream) !== 'x'
  const trueColour =
    coloured &&
    typeof stream.hasColors === 'function' &&
    stream.hasColors(2 ** 24)
  const word = WORD.map((line) =>
    trueColour ? gradient(line) : paint('done', line, stream)
  )
  return [
    '',
    ...word,
    '',
    ` ${bold(`rness v${version}`, stream)}`,
    ` ${paint('idle', 'Context for AI coding agents, across an organization’s repositories', stream)}`,
    '',
    '',
  ].join('\n')
}
