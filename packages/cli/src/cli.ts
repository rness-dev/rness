import { Command, CommanderError, Option } from 'commander'

import { type ContextOptions, contextCommand } from './commands/context.ts'
import { type SyncOptions, syncCommand } from './commands/sync.ts'
import { type ValidateOptions, validateCommand } from './commands/validate.ts'
import { VERSION } from './version.ts'

interface RunState {
  code: number
}

function buildProgram(state: RunState): Command {
  const program = new Command()
    .name('rness')
    .description('Configuration-plane CLI for rness workspaces')
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => {
        process.stdout.write(s)
      },
      writeErr: (s) => {
        process.stderr.write(s)
      },
    })

  program
    .command('context')
    .description('Resolve and print the context for a scope')
    .option(
      '--scope <name>',
      'scope to resolve (default: the scope owning the current directory)'
    )
    .option('--json', 'print JSON instead of Markdown')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: ContextOptions) => {
      state.code = await contextCommand(opts)
    })

  program
    .command('validate')
    .description(
      'Check the .rness/ tree against the contract and every generated block'
    )
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: ValidateOptions) => {
      state.code = await validateCommand(opts)
    })

  program
    .command('sync')
    .description(
      'Clone missing repositories and write the rness block into every AGENTS.md'
    )
    .option('--scope <name>', 'only this scope (the root block is skipped)')
    .option(
      '--check',
      'render and compare only; exit 1 when a block is out of date'
    )
    .option('--pull', 'git pull --ff-only in every clean clone')
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: SyncOptions) => {
      state.code = await syncCommand(opts)
    })

  return program
}

/**
 * Parse user arguments and run the matching command. Returns the exit code
 * and never calls process.exit: 0 success, 1 handled error, 2 bad usage.
 */
export async function run(argv: string[]): Promise<number> {
  const state: RunState = { code: 0 }
  const program = buildProgram(state)
  if (argv.length === 0) {
    process.stdout.write(program.helpInformation())
    return 0
  }
  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (e) {
    if (e instanceof CommanderError) {
      // Commander 15 reuses `commander.help`'s code for both the successful
      // `--help` path and error paths (e.g. `help wat`, a lone `--`), so the
      // exit code it already computed is the only reliable signal here.
      return e.exitCode === 0 ? 0 : 2
    }
    throw e
  }
  return state.code
}
