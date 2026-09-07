#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runCommand, usage } from './commands/index.mjs'

async function version() {
  const pkgUrl = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'))
  return pkg.version
}

export async function main(argv) {
  if (argv.includes('--version')) {
    process.stdout.write(`${await version()}\n`)
    return 0
  }
  if (argv.length === 0 || argv.includes('--help')) {
    process.stdout.write(usage())
    return 0
  }
  const [name, ...rest] = argv
  return runCommand(name, rest)
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  if (entry === self) return true
  try {
    return realpathSync(entry) === self
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  // Set process.exitCode rather than calling process.exit(): process.exit()
  // terminates before Node drains an async stdout pipe, truncating piped output
  // at the ~64 KiB pipe buffer (breaks `rness context --json | jq`, `$(...)`).
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      process.stderr.write(`${e.message}\n`)
      process.exitCode = 1
    })
}
