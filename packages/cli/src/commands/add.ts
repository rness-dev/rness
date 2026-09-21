import { basename, join } from 'node:path'

import type { CommandDeps } from '../core/deps.ts'
import { exists } from '../core/fs.ts'
import { githubProvider } from '../core/github-oauth-provider.ts'
import {
  CONTEXT_REPO,
  loadManifest,
  parseRepoSpec,
  resolveOrg,
} from '../core/manifest.ts'
import type { GitCredentials } from '../core/provider.ts'
import {
  type AddRepositoryResult,
  addRepository,
  workspaceDirs,
} from '../core/repos.ts'
import { warn } from '../core/style.ts'
import { defaultTerminal } from '../core/terminal.ts'
import {
  CHECKING,
  defaultTransport,
  httpsFlagLine,
  isSshUrl,
  sshWorkspaceLines,
  testGithubSsh,
  usingRest,
  usingSentence,
} from '../core/transport.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { syncCommand } from './sync.ts'

export interface AddOptions {
  /** Comma-separated sub-directories to declare as scopes extending the repository scope. */
  scopes?: string
  /** Force `git@github.com:` without the SSH test. */
  ssh?: boolean
  /** Force `https://github.com/` without the SSH test. */
  https?: boolean
  /** Internal: remote base (`file:///…/`, another host); wins over both flags and skips the SSH test. */
  host?: string
  yes?: boolean
  /** Internal (tests): directory to resolve from. */
  cwd?: string
}

/** One `declared scope …` line per scope of `result` not named in `already`. */
function printDeclared(
  ui: Ui,
  result: AddRepositoryResult,
  already: ReadonlySet<string>
): void {
  for (const name of result.declared) {
    if (already.has(name)) continue
    const entry = result.manifest.scopes[name]
    if (entry === undefined) continue
    const ext =
      entry.extends.length === 0 ? '' : `, extends ${entry.extends.join(', ')}`
    ui.line('declared', `scope ${name} (${entry.path}${ext})`)
  }
}

const FULL_URL = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/

/**
 * `rness add <repo>`: clone or adopt, declare, sync (spec 0003 §3). A name is
 * written over SSH when github.com accepts the user's key, over HTTPS
 * otherwise — except in a workspace that clones over SSH, which never falls
 * back silently (spec 0005). Returns the exit code.
 */
export async function addCommand(
  spec: string,
  opts: AddOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  const terminal = deps.terminal ?? defaultTerminal
  const transport = deps.transport ?? defaultTransport
  let provider = deps.provider
  const credentialsFor = async (url: string): Promise<GitCredentials | null> =>
    (provider ??= await githubProvider()).credentialsFor(url)
  const cwd = opts.cwd ?? process.cwd()
  if (opts.ssh === true && opts.https === true) {
    process.stderr.write('--ssh and --https cannot be combined\n')
    return 2
  }
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const { org, warning } = resolveOrg(manifest, ws.root)
    if (warning !== null) process.stderr.write(`${warn(warning)}\n`)

    // The name is checked before anything else runs; the host comes later.
    let parsed: { name: string; url: string }
    try {
      parsed = parseRepoSpec(spec, org, transport.hosts.https)
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      return 2
    }
    // The context repository holds the catalogue and is already cloned as
    // `<root>/.rness`. Adding it would put a second, diverging copy under
    // `org/`, list the catalogue inside itself, and give `.rness/AGENTS.md` a
    // generated member block next to the shared one (spec 0009). The name
    // decides, whatever organization it came from: every spelling lands on
    // the same directory and the same catalogue key.
    if (parsed.name === CONTEXT_REPO) {
      process.stderr.write(
        `${CONTEXT_REPO} is the workspace context, not a member repository — it is already cloned at ${basename(ws.root)}/${CONTEXT_REPO}\n`
      )
      return 2
    }
    const interactive = opts.yes !== true
    const ownUi = deps.ui === undefined
    if (interactive && !terminal.isTty()) {
      process.stderr.write(
        'rness add clones and writes files; pass --yes to run without a prompt\n'
      )
      return 2
    }

    const ui: Ui =
      deps.ui ?? (interactive ? await makeUi(terminal) : { ...plainUi })
    if (ownUi) ui.intro(`Add ${parsed.name} to workspace ${org}`)
    // Only SSH can make git ask something on the terminal (a passphrase).
    if (opts.host !== undefined || opts.https === true) ui.gitIsSilent = true
    let host = opts.host
    if (host === undefined && opts.ssh === true) host = transport.hosts.ssh
    if (host === undefined && opts.https === true) host = transport.hosts.https
    if (host === undefined && FULL_URL.test(spec)) host = transport.hosts.https
    if (host === undefined) {
      const { access, unattended } = await testGithubSsh(
        transport,
        interactive,
        () => ui.line(...CHECKING)
      )
      if (unattended || !access.ok) ui.gitIsSilent = true
      const overSsh = Object.values(manifest.repos).some((r) =>
        isSshUrl(r.url, transport.hosts)
      )
      if (access.ok || !overSsh) {
        ui.line('using', usingRest(access), usingSentence(access))
        host = access.ok ? transport.hosts.ssh : transport.hosts.https
      } else {
        // An SSH workspace never falls back silently: say why, then let the
        // user choose HTTPS for this one repository.
        const lines = sshWorkspaceLines(access.reason)
        if (!interactive) {
          process.stderr.write(
            `${[...lines, httpsFlagLine(spec)].join('\n')}\n`
          )
          return 1
        }
        ui.error(lines[0])
        ui.hint(lines[1], 'stderr')
        const p = await terminal.prompts()
        const https = await p.confirm({
          message: `Clone ${parsed.name} over HTTPS instead?`,
          initialValue: false,
        })
        if (p.isCancel(https) || https !== true) return 1
        host = transport.hosts.https
      }
    }
    parsed = parseRepoSpec(spec, org, host)

    const scopes = (opts.scopes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const dir = join(ws.root, 'org', parsed.name)
    const present = await exists(dir)

    if (interactive) {
      const { confirm, isCancel } = await terminal.prompts()
      const plan = present
        ? `adopt org/${parsed.name}`
        : `clone ${parsed.url} into org/${parsed.name}`
      const ok = await confirm({
        message: `${plan}, declare scope "${parsed.name}" in rness.json, then sync?`,
      })
      if (isCancel(ok) || ok !== true) {
        ui.cancelled()
        return 1
      }
    }

    const credentials = await credentialsFor(parsed.url)
    const chosenHost = host
    let result = await ui.step(
      {
        doing: `${present ? 'adopting' : 'cloning '} org/${parsed.name}`,
        git: true,
      },
      () =>
        addRepository({
          root: ws.root,
          rnessDir: ws.rnessDir,
          manifest,
          spec,
          org,
          host: chosenHost,
          scopes,
          credentialsFor: () => credentials,
        }),
      (r) => [r.action, `org/${r.name}`]
    )
    const announced = new Set<string>()
    printDeclared(ui, result, announced)
    for (const name of result.declared) announced.add(name)

    // A monorepo's workspace packages are only knowable once the clone is on
    // disk, so the offer comes after it and adds to what is already declared.
    if (opts.yes !== true && scopes.length === 0) {
      const candidates = await workspaceDirs(dir)
      if (candidates.length > 0) {
        const { isCancel, multiselect } = await terminal.prompts()
        const picked = await multiselect({
          message: 'Declare these workspace packages as scopes?',
          options: candidates.map((c) => ({ value: c, label: c })),
          required: false,
        })
        if (isCancel(picked)) {
          ui.cancelled()
          return 1
        }
        // `isCancel` narrows only the unique cancel symbol, not the broader
        // `symbol` half of clack's `Value[] | symbol` return type, so an array
        // check is what narrows the rest.
        if (Array.isArray(picked) && picked.length > 0) {
          result = await addRepository({
            root: ws.root,
            rnessDir: ws.rnessDir,
            manifest: result.manifest,
            spec,
            org,
            host,
            scopes: picked,
            credentialsFor: () => credentials,
          })
          printDeclared(ui, result, announced)
        }
      }
    }
    const code = await syncCommand({ yes: true, cwd: ws.root }, { ui })
    if (ownUi)
      ui.outro(
        code === 0
          ? `${result.name} is in your workspace`
          : 'Done, with problems',
        code === 0 ? 'done' : 'warn'
      )
    return code
  } catch (e) {
    return reportError(e)
  }
}
