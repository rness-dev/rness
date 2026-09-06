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
  const handler = COMMANDS[name]
  if (!handler) {
    process.stderr.write(USAGE)
    return 2
  }
  return handler(args)
}
