import { paint } from './style.ts'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const INTERVAL_MS = 80
/** Back to column 0, erase the line. */
const CLEAR_LINE = '\r\x1b[2K'

export interface StepOptions {
  /** What is happening, as a status line in the making: `cloning  org/api`. */
  label: string
  /**
   * Animate a spinner. Off for anything that runs git: over SSH, git's `ssh`
   * may ask for a passphrase on the terminal, and a line redrawn every 80 ms
   * would shred the question. The label is then written once and erased.
   */
  animate: boolean
  stream?: NodeJS.WriteStream
}

function isLive(stream: NodeJS.WriteStream): boolean {
  return (
    stream.isTTY === true &&
    process.env['TERM'] !== 'dumb' &&
    process.env['CI'] === undefined
  )
}

/**
 * Run `work` with a transient line saying what is going on (spec 0007 §5).
 * The line is erased when `work` settles, and the caller prints the step's
 * status line as it always did — so off a terminal, where nothing transient
 * is written, the output is byte for byte what it was.
 */
export async function step<T>(
  options: StepOptions,
  work: () => Promise<T>
): Promise<T> {
  const stream = options.stream ?? process.stdout
  if (!isLive(stream)) return work()
  const draw = (frame: string): void => {
    rawWrite(
      `${CLEAR_LINE}${paint('info', frame, stream)} ${paint('idle', options.label, stream)}`
    )
  }
  let timer: NodeJS.Timeout | undefined
  let shown = true
  // Erase the label, once: when the work ends, or as soon as the work itself
  // writes — its first line must not land behind `… syncing  the blocks`.
  const erase = (): void => {
    if (!shown) return
    shown = false
    if (timer !== undefined) clearInterval(timer)
    rawWrite(CLEAR_LINE)
  }
  // Both streams share the terminal's line, so a write to either erases it.
  const rawWrite = stream.write.bind(stream) as NodeJS.WriteStream['write']
  const rawErr = process.stderr.write.bind(
    process.stderr
  ) as NodeJS.WriteStream['write']
  type Write = NodeJS.WriteStream['write']
  // `write` is overloaded; the guard only forwards, whatever the overload.
  const guard = (raw: Write): Write =>
    ((...args: Parameters<Write>) => {
      erase()
      return raw(...args)
    }) as Write
  if (options.animate) {
    let i = 0
    draw(FRAMES[0] ?? '')
    timer = setInterval(() => {
      i = (i + 1) % FRAMES.length
      if (shown) draw(FRAMES[i] ?? '')
    }, INTERVAL_MS)
    // Never the reason the process stays alive.
    timer.unref()
  } else {
    draw('…')
  }
  stream.write = guard(rawWrite)
  if (process.stderr !== stream) process.stderr.write = guard(rawErr)
  try {
    return await work()
  } finally {
    stream.write = rawWrite
    if (process.stderr !== stream) process.stderr.write = rawErr
    erase()
  }
}
