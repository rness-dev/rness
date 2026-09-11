export interface Captured {
  restore(): void
  out(): string
  err(): string
}

/**
 * Intercept string writes to stdout/stderr (the CLI's output). Buffer writes
 * and callback/encoding arguments pass through untouched so node --test's
 * process-isolation IPC on stdout is never swallowed.
 */
export function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  const w = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((...args: Parameters<typeof w>) =>
    typeof args[0] === 'string' ? (out.push(args[0]), true) : w(...args)) as typeof process.stdout.write
  process.stderr.write = ((...args: Parameters<typeof e>) =>
    typeof args[0] === 'string' ? (err.push(args[0]), true) : e(...args)) as typeof process.stderr.write
  return {
    restore: () => {
      process.stdout.write = w
      process.stderr.write = e
    },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}
