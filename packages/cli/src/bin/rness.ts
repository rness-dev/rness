#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import { run } from '../cli.ts'
import { findDelegate } from '../core/delegate.ts'
import { MIN_NODE_MAJOR, isSupportedNode } from '../core/node-version.ts'
import { driftWarning } from '../core/pinned.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'

// `rness context | head`: once the reader has its lines it closes the pipe and
// every further write emits EPIPE on stdout. Nothing is left to deliver, so end
// quietly with success. This is the one process.exit() in the code base — it
// runs only when there is no output left to drain (see main() below).
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0)
  throw e
})

// Set process.exitCode rather than calling process.exit(): process.exit()
// terminates before Node drains an async stdout pipe, truncating piped output
// at the ~64 KiB pipe buffer (breaks `rness context --json | jq`, `$(...)`).
async function main(): Promise<number> {
  if (!isSupportedNode(process.versions.node)) {
    process.stderr.write(
      `rness needs Node ${MIN_NODE_MAJOR} or newer (running ${process.version})\n`
    )
    return 1
  }
  const argv = process.argv.slice(2)
  // `create` makes a workspace and `upgrade` replaces the pinned copy: both
  // are served by the copy the user invoked (spec 0006 §3).
  const own = ['create', 'upgrade', 'update'].includes(argv[0] ?? '')
  const noDelegate = process.env['RNESS_NO_DELEGATE'] === '1'
  const skipDelegation = own || noDelegate
  const command = argv[0]
  if (
    command !== undefined &&
    !command.startsWith('-') &&
    !own &&
    !noDelegate
  ) {
    const warning = await driftWarning(process.cwd())
    if (warning !== null) process.stderr.write(`${warning}\n`)
  }
  const delegate = skipDelegation
    ? null
    : await findDelegate(process.cwd(), VERSION)
  if (delegate !== null) {
    const broken = (reason: string): Error =>
      new Error(
        `@rness/cli ${delegate.version} pinned in ${delegate.root}/.rness is not installed correctly (${reason}); reinstall in .rness/`
      )
    if (process.env['RNESS_DEBUG'] === '1') {
      process.stderr.write(
        `rness: delegating to @rness/cli ${delegate.version} (${delegate.entry})\n`
      )
    }
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(delegate.entry).href)) as Record<
        string,
        unknown
      >
    } catch (e) {
      throw broken(e instanceof Error ? e.message : String(e))
    }
    if (typeof mod['run'] !== 'function')
      throw broken('dist/index.js does not export run')
    const delegateRun = mod['run'] as (argv: string[]) => Promise<unknown>
    const code = await delegateRun(argv)
    return typeof code === 'number' ? code : 1
  }
  return run(argv)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e: unknown) => {
    process.exitCode = reportError(e)
  })
