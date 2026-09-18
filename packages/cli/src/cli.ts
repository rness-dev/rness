import { Command, CommanderError, Option } from 'commander'

import { type AddOptions, addCommand } from './commands/add.ts'
import { type ContextOptions, contextCommand } from './commands/context.ts'
import { type CreateOptions, createCommand } from './commands/create.ts'
import { type SyncOptions, syncCommand } from './commands/sync.ts'
import { type UpgradeOptions, upgradeCommand } from './commands/upgrade.ts'
import { type ValidateOptions, validateCommand } from './commands/validate.ts'
import { PACKAGE_MANAGERS } from './core/pm.ts'
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
      'Write the rness block into every AGENTS.md of the cloned repositories'
    )
    .option('--scope <name>', 'only this scope (the root block is skipped)')
    .option(
      '--check',
      'render and compare only; exit 1 when a block is out of date'
    )
    .option('--pull', 'git pull --ff-only in every clean clone')
    .option('--all', 'clone every rness.json repository missing from org/')
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: SyncOptions) => {
      state.code = await syncCommand(opts)
    })

  program
    .command('add')
    .description(
      'Clone (or adopt) a repository under org/ and declare it in rness.json'
    )
    .argument('<repo>', '<repo>, <owner>/<repo>, or a clone URL')
    .option(
      '--scopes <list>',
      'comma-separated sub-directories to declare as scopes extending the repository'
    )
    .option(
      '--ssh',
      'force git@github.com: (default: SSH when it works, else HTTPS)'
    )
    .option('--https', 'force https://github.com/')
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(new Option('--host <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (repo: string, opts: AddOptions) => {
      state.code = await addCommand(repo, opts)
    })

  program
    .command('upgrade')
    .alias('update')
    .description(
      'Move this workspace to another @rness/cli: pin it in .rness/package.json, install, sync'
    )
    .argument('[version]', 'an exact version (default: the latest release)')
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (version: string | undefined, opts: UpgradeOptions) => {
      state.code = await upgradeCommand(version, opts)
    })

  program
    .command('create')
    .description(
      'Create a workspace for a GitHub organization, or join its existing .rness'
    )
    .argument('[org]', 'the GitHub organization, same as --org')
    .option(
      '--org <name>',
      'the GitHub organization, exact name (github.com/<name>)'
    )
    .option(
      '--repos <list>',
      'comma-separated repositories for your workspace (catalogue entries are cloned, others added)'
    )
    .option(
      '--pm <name>',
      `package manager for .rness/ (${PACKAGE_MANAGERS.join(', ')}; default: the one running this command)`
    )
    .option(
      '--ssh',
      'force git@github.com: (default: SSH when it works, else HTTPS)'
    )
    .option('--https', 'force https://github.com/')
    .option('--skip-install', 'do not install .rness/ dependencies')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--template <name>', 'reserved')
    .addOption(new Option('--host <base>').hideHelp())
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (orgArg: string | undefined, opts: CreateOptions) => {
      if (
        orgArg !== undefined &&
        opts.org !== undefined &&
        orgArg !== opts.org
      ) {
        process.stderr.write(
          `organization given twice: "${orgArg}" and --org "${opts.org}"\n`
        )
        state.code = 2
        return
      }
      const org = opts.org ?? orgArg
      state.code = await createCommand(
        org === undefined ? opts : { ...opts, org }
      )
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
