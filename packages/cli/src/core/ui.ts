import { step as transientStep } from './progress.ts'
import { type Tone, badge, grey, paint, status, toneOf, warn } from './style.ts'
import type { Prompts, Terminal } from './terminal.ts'

// How an interactive command speaks (spec 0007 §5b). Two renderings of the
// same calls: `plain` — the status column, the bytes scripts and tests read —
// and `session`, clack's gutter from `intro` to `outro`, in a terminal.

/** A status line: the verb of the column, what follows it. */
export type Line = readonly [verb: string, rest: string]

export interface StepOptions {
  /** The transient label of the plain look: `cloning  org/api`. */
  doing: string
  /** What the session look shows while it runs; defaults to `doing`, tidied. */
  sentence?: string
  /** The step runs git: it animates only when git is known not to prompt. */
  git?: boolean
  /**
   * The plain look has already said what it needs (`listing  acme
   * repositories…`): only the session look prints the step's outcome.
   */
  quiet?: boolean
}

export interface Ui {
  /** True for the session look. */
  readonly session: boolean
  /**
   * Set once rness knows git will not ask anything on the terminal (SSH works
   * unattended, or the clones are not over SSH): git steps may then animate.
   */
  gitIsSilent: boolean
  intro(title: string): void
  /** The last word of a session: green for a success, the tone given otherwise. */
  outro(message: string, tone?: Tone): void
  /** `sentence` replaces `verb rest` in the session look. */
  line(verb: string, rest: string, sentence?: string): void
  warn(text: string): void
  /** A block of commands or facts under a title. */
  note(title: string, lines: readonly string[]): void
  /** An aside: a plain line in the plain look, dimmed in the session one. */
  hint(text: string, stream?: 'stdout' | 'stderr'): void
  /** A handled error the command goes on after. */
  error(text: string): void
  cancelled(): void
  /** Run `work`; then print `done(result)` unless it answers null. */
  step<T>(
    options: StepOptions,
    work: () => Promise<T>,
    done?: (result: T) => Line | null
  ): Promise<T>
}

const capitalise = (s: string): string =>
  s === '' ? s : `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`

/** `cloning  org/api` → `Cloning org/api`. */
const tidy = (label: string): string =>
  capitalise(label.replace(/\s+/g, ' ').trim())

export const plainUi: Ui = {
  session: false,
  gitIsSilent: false,
  intro: () => undefined,
  outro: () => undefined,
  line: (verb, rest) => {
    process.stdout.write(`${status(verb, rest)}\n`)
  },
  warn: (text) => {
    process.stderr.write(`${warn(text)}\n`)
  },
  note: (title, lines) => {
    process.stdout.write(
      ['', `${title}:`, ...lines.map((l) => `  ${l}`), ''].join('\n')
    )
  },
  hint: (text, stream = 'stdout') => {
    process[stream].write(`${text}\n`)
  },
  error: (text) => {
    process.stderr.write(`${text}\n`)
  },
  cancelled: () => {
    process.stderr.write('cancelled\n')
  },
  async step(options, work, done) {
    // Animation is the install's; git steps write their label once.
    const result = await transientStep(
      { label: options.doing, animate: options.git !== true },
      work
    )
    const line = options.quiet === true ? null : (done?.(result) ?? null)
    if (line !== null) this.line(line[0], line[1])
    return result
  },
}

export type Session = Required<
  Pick<Prompts, 'intro' | 'outro' | 'cancel' | 'note' | 'log' | 'spinner'>
>

/** The session look over clack's functions; exported for tests, which script them. */
export function sessionUi(p: Session): Ui {
  const say = (verb: string, text: string): void => {
    const tone = toneOf(verb)
    if (tone === 'done') p.log.step(text)
    else if (tone === 'warn') p.log.warn(text)
    else if (tone === 'idle') p.log.message(paint('idle', text))
    else p.log.info(text)
  }
  return {
    session: true,
    gitIsSilent: false,
    intro: (title) => {
      p.intro(badge(title))
    },
    outro: (message, tone = 'done') => {
      p.outro(paint(tone, message))
    },
    line: (verb, rest, sentence) => {
      say(verb, sentence ?? tidy(`${verb} ${rest}`))
    },
    warn: (text) => {
      p.log.warn(text)
    },
    note: (title, lines) => {
      p.note(lines.join('\n'), title, { format: (line) => grey(line) })
    },
    hint: (text) => {
      p.log.message(paint('idle', text))
    },
    error: (text) => {
      p.log.error(text)
    },
    cancelled: () => {
      p.cancel('Cancelled')
    },
    async step(options, work, done) {
      const label = options.sentence ?? tidy(options.doing)
      const finish = (
        result: Awaited<ReturnType<typeof work>>
      ): string | null => {
        const line = done?.(result) ?? null
        return line === null ? null : tidy(`${line[0]} ${line[1]}`)
      }
      // A spinner redraws its line: not while git's ssh may be asking for a
      // passphrase on the same terminal.
      if (options.git === true && !this.gitIsSilent) {
        p.log.message(paint('idle', `${label}…`))
        const result = await work()
        const text = finish(result)
        if (text !== null) p.log.step(text)
        return result
      }
      const spin = p.spinner()
      spin.start(label)
      try {
        const result = await work()
        spin.stop(finish(result) ?? label)
        return result
      } catch (e) {
        spin.error(`${label} — failed`)
        throw e
      }
    },
  }
}

/** The session look needs a real terminal; everything else gets the plain one. */
export async function makeUi(terminal: Terminal): Promise<Ui> {
  const live =
    terminal.isTty() &&
    process.stdout.isTTY === true &&
    process.env['CI'] === undefined &&
    process.env['TERM'] !== 'dumb'
  if (!live) return { ...plainUi }
  const p = await terminal.prompts()
  if (
    p.intro === undefined ||
    p.outro === undefined ||
    p.cancel === undefined ||
    p.note === undefined ||
    p.log === undefined ||
    p.spinner === undefined
  )
    return { ...plainUi }
  return sessionUi({
    intro: p.intro,
    outro: p.outro,
    cancel: p.cancel,
    note: p.note,
    log: p.log,
    spinner: p.spinner,
  })
}
