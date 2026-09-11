#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { run } from '../cli.ts'
import { VERSION } from '../version.ts'
import { findDelegate } from '../core/delegate.ts'
import { isSupportedNode, MIN_NODE_MAJOR } from '../core/node-version.ts'
import { reportError } from '../report.ts'

// Set process.exitCode rather than calling process.exit(): process.exit()
// terminates before Node drains an async stdout pipe, truncating piped output
// at the ~64 KiB pipe buffer (breaks `rness context --json | jq`, `$(...)`).
async function main(): Promise<number> {
  if (!isSupportedNode(process.versions.node)) {
    process.stderr.write(`rness needs Node ${MIN_NODE_MAJOR} or newer (running ${process.version})\n`)
    return 1
  }
  const argv = process.argv.slice(2)
  const skipDelegation = argv[0] === 'create' || Boolean(process.env['RNESS_NO_DELEGATE'])
  const delegate = skipDelegation ? null : await findDelegate(process.cwd(), VERSION)
  if (delegate !== null) {
    const mod = (await import(pathToFileURL(delegate.entry).href)) as { run: (argv: string[]) => Promise<number> }
    return mod.run(argv)
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
