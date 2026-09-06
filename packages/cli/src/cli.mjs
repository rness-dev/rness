#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
