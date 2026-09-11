/**
 * Shared CLI error contract: one line on stderr, and — only under
 * `RNESS_DEBUG=1` — the stack trace instead of the plain message (the stack
 * already starts with `Error: <message>`, so printing both would repeat it).
 */
export function reportError(e: unknown): number {
  const debug = process.env['RNESS_DEBUG'] === '1'
  if (debug && e instanceof Error && e.stack) {
    process.stderr.write(`${e.stack}\n`)
  } else {
    const message = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${message}\n`)
  }
  return 1
}
