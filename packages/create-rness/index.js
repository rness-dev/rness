#!/usr/bin/env node
// Thin shim: `npm create rness [-- <options>]` is `rness create [<options>]` from the pinned @rness/cli.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const cliRoot = dirname(require.resolve('@rness/cli/package.json'))
const bin = join(cliRoot, 'dist', 'bin', 'rness.js')

const child = spawn(
  process.execPath,
  [bin, 'create', ...process.argv.slice(2)],
  { stdio: 'inherit' }
)
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
child.on('error', (e) => {
  process.stderr.write(`${e.message}\n`)
  process.exitCode = 1
})
