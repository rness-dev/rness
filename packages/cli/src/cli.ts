import { Command, CommanderError, Option } from 'commander'

import { type AddOptions, addCommand } from './commands/add.ts'
import { type ContextOptions, contextCommand } from './commands/context.ts'
import { type CreateOptions, createCommand } from './commands/create.ts'
import { docNewCommand } from './commands/doc.ts'
import { gitCredentialCommand } from './commands/git-credential.ts'
import { hookCommand } from './commands/hook.ts'
import { type LoginOptions, loginCommand } from './commands/login.ts'
import { logoutCommand } from './commands/logout.ts'
import { type McpOptions, mcpCommand } from './commands/mcp.ts'
import {
  type PulseOptions,
  pulseCreateCommand,
  pulseMarkCommand,
  pulseRunCommand,
  pulseSyncCommand,
} from './commands/pulse.ts'
import { type StatusOptions, statusCommand } from './commands/status.ts'
import { type SyncOptions, syncCommand } from './commands/sync.ts'
import { type UpgradeOptions, upgradeCommand } from './commands/upgrade.ts'
import { type ValidateOptions, validateCommand } from './commands/validate.ts'
import { writtenFilesCommand } from './commands/written-files.ts'
import { PACKAGE_MANAGERS } from './core/pm.ts'
import { banner, bold, paint } from './core/style.ts'
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
      outputError: (s, write) => {
        write(paint('error', s, process.stderr))
      },
    })
    // Before any sub-command is created: they inherit it. The painters answer
    // plain text off a terminal, so a piped help is what it always was.
    .configureHelp({
      styleTitle: (s) => bold(s),
      styleUsage: (s) => paint('done', s),
      styleCommandText: (s) => paint('info', s),
      styleSubcommandText: (s) => paint('info', s),
      styleArgumentText: (s) => paint('info', s),
      styleOptionText: (s) => paint('warn', s),
      styleDescriptionText: (s) => paint('idle', s),
    })
    // The root help only: a sub-command's help stays short.
    .addHelpText('before', () => banner(VERSION))

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
    .command('status')
    .description(
      'Show the status of every decision, specification and plan, a tab per directory'
    )
    .argument('[tab]', 'open on this tab: adr, specs, plans, …')
    .option('--json', 'print JSON instead: what the Claude Code plugin draws')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (tab: string | undefined, opts: StatusOptions) => {
      state.code = await statusCommand(tab, opts)
    })

  // What the lifecycle skills allocate a number with (spec 0028 §9).
  const doc = program
    .command('doc')
    .description('Documents of the workspace: doc new <collection>')
  doc
    .command('new')
    .description(
      'Write the next numbered document of a collection (adr, specs, plans) and print its path'
    )
    .argument('<collection>', 'adr, specs or plans')
    .option('--title <text>', 'the title; the file name takes its slug')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(
      async (collection: string, opts: { title?: string; cwd?: string }) => {
        state.code = await docNewCommand(collection, opts)
      }
    )

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
    .option(
      '--agent <name>',
      'declare an agent in rness.json, then write its files (repeatable; supported: claude)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: SyncOptions) => {
      state.code = await syncCommand(opts)
    })

  const pulse = program
    .command('pulse')
    .description("Show the agent's work on the organization's board")
  pulse
    .command('create')
    .description(
      "Create the organization's Agent Pulse board, or a collection's own project, and sync"
    )
    .argument(
      '[collection]',
      'a directory of .rness/ whose documents get a project of their own'
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (collection: string | undefined, opts: PulseOptions) => {
      state.code = await pulseCreateCommand(
        collection === undefined ? opts : { ...opts, collection }
      )
    })
  pulse
    .command('sync')
    .description(
      'Bring every declared project up to date with the documents of .rness/'
    )
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: PulseOptions) => {
      state.code = await pulseSyncCommand(opts)
    })
  // What the hooks run, detached (spec 0017 §5).
  pulse
    .command('mark', { hidden: true })
    .requiredOption('--session <id>')
    .option(
      '--path <path>',
      'a document of .rness/ (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('--end', 'clear the marks of the session, then sync')
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(
      async (opts: {
        session: string
        path?: string[]
        end?: boolean
        cwd?: string
        githubApi?: string
      }) => {
        const { path, ...rest } = opts
        state.code = await pulseMarkCommand({ ...rest, paths: path ?? [] })
      }
    )
  // The agent's journal (spec 0030 §4): loaded only when a note is written.
  pulse
    .command('note [text]')
    .description(
      'a note on the plan in progress: an approach, a deviation, a blocker, done (the text, or stdin)'
    )
    .option('--plan <path>', 'the plan, when several are in progress')
    .option('--kind <kind>', 'approach, deviation, blocker or done')
    .option(
      '--session <session>',
      'the session, when CLAUDE_CODE_SESSION_ID is not set'
    )
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(
      async (
        text: string | undefined,
        opts: {
          plan?: string
          kind?: string
          session?: string
          cwd?: string
          githubApi?: string
        }
      ) => {
        const { pulseNoteCommand } = await import('./pulse/note.ts')
        state.code = await pulseNoteCommand({
          ...opts,
          ...(text === undefined ? {} : { text }),
        })
      }
    )
  // What the hooks run, detached: what each board declares (spec 0032 §4).
  pulse
    .command('run <event>', { hidden: true })
    .requiredOption('--session <id>')
    .option(
      '--path <path>',
      'the document edited (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('--scope <scope>', "the session's scope; absent, the root's")
    .option('--clone <name>', 'the clone the session worked in')
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(
      async (
        event: string,
        opts: {
          session: string
          path?: string[]
          scope?: string
          clone?: string
          cwd?: string
          githubApi?: string
        }
      ) => {
        const { path, ...rest } = opts
        state.code = await pulseRunCommand({
          ...rest,
          event,
          paths: path ?? [],
        })
      }
    )

  program
    .command('mcp')
    .description(
      'Serve the workspace context to agents over MCP (stdio, read-only)'
    )
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: McpOptions) => {
      state.code = await mcpCommand(opts)
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
    .command('login')
    .description('Log in to GitHub, to list and clone private repositories')
    .option('--setup-git', "make rness git's credential helper for github.com")
    .option('--no-setup-git', 'do not ask about git')
    .addOption(new Option('--github-api <base>').hideHelp())
    .action(async (opts: LoginOptions) => {
      state.code = await loginCommand(opts)
    })

  program
    .command('logout')
    .description('Forget the GitHub login of this machine')
    .action(async () => {
      state.code = await logoutCommand()
    })

  // What git runs once `rness login` made rness its credential helper.
  program
    .command('git-credential', { hidden: true })
    .argument('<operation>')
    .action(async (operation: string) => {
      state.code = await gitCredentialCommand(operation)
    })

  // What `upgrade` asks of the copy it installed: the files its sync writes.
  program
    .command('written-files', { hidden: true })
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (opts: { cwd?: string }) => {
      state.code = await writtenFilesCommand(opts)
    })

  // What Claude Code runs for the hooks the Claude target writes (spec 0015).
  program
    .command('hook', { hidden: true })
    .argument(
      '<event>',
      'session-start, pre-tool-use, post-tool-use or session-end'
    )
    .action(async (event: string) => {
      state.code = await hookCommand(event)
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
      "Create or join a GitHub organization's workspace, or a blank one with --blank"
    )
    .argument(
      '[name]',
      'the GitHub organization, same as --org; with --blank, the workspace directory'
    )
    .option(
      '--org <name>',
      'the GitHub organization, exact name (github.com/<name>)'
    )
    .option(
      '--repos <list>',
      'comma-separated repositories for your workspace (catalogue entries are cloned, others added)'
    )
    .option(
      '--provider <name>',
      'where the organization lives: github (gitlab, atlassian later)'
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
    .option(
      '--blank',
      'a local workspace with no GitHub organization: .rness/, an empty org/, the root files'
    )
    .option(
      '--agent <name>',
      "a new workspace's agent, declared in rness.json (repeatable; supported: claude)",
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .option('--skip-install', 'do not install .rness/ dependencies')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--template <name>', 'reserved')
    .addOption(new Option('--host <base>').hideHelp())
    .addOption(new Option('--github-api <base>').hideHelp())
    .addOption(new Option('--cwd <dir>').hideHelp())
    .action(async (orgArg: string | undefined, opts: CreateOptions) => {
      // Blank, the positional names the directory; --org is refused there.
      if (opts.blank === true) {
        state.code = await createCommand(
          orgArg === undefined ? opts : { ...opts, name: orgArg }
        )
        return
      }
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
    process.stdout.write(banner(VERSION) + program.helpInformation())
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
