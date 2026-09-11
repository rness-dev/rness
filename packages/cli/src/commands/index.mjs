const USAGE = `Usage: rness <command> [options]

Commands:
  context    Resolve and print the context for a scope
  validate   Check the .rness/ tree against the contract

Options:
  --version  Print version
  --help     Show this help
`

export function usage() {
  return USAGE
}

const COMMANDS = {}

export function registerCommand(name, handler) {
  COMMANDS[name] = handler
}

export async function runCommand(name, args) {
  // Own properties only: `rness constructor` must not resolve Object.prototype.
  const handler = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!handler) {
    process.stderr.write(USAGE)
    return 2
  }
  return handler(args)
}

import { contextCommand } from './context.mjs'
registerCommand('context', contextCommand)

import { validateCommand } from './validate.mjs'
registerCommand('validate', validateCommand)
