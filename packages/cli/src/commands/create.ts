import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { CommandDeps } from '../core/deps.ts'
import { exists } from '../core/fs.ts'
import { clone, commitAll, init } from '../core/git.ts'
import { githubProvider } from '../core/github-oauth-provider.ts'
import { MAX_PAGES, PER_PAGE } from '../core/github.ts'
import {
  NAME,
  ORG_NAME,
  loadManifest,
  parseRepoSpec,
  writeManifest,
} from '../core/manifest.ts'
import {
  PACKAGE_MANAGERS,
  type PackageManager,
  detectPackageManager,
  installDependencies,
  isPackageManager,
  packageManagerVersion,
} from '../core/pm.ts'
import type { GitCredentials, GitProvider } from '../core/provider.ts'
import { probeRemote, repoUrl } from '../core/remote.ts'
import { addRepository } from '../core/repos.ts'
import { copyScaffold } from '../core/scaffold-copy.ts'
import { PRIVATE_MARK, banner, unicode } from '../core/style.ts'
import { syncBlocks } from '../core/sync-blocks.ts'
import {
  type Prompts,
  type Terminal,
  defaultTerminal,
} from '../core/terminal.ts'
import {
  CHECKING,
  INSTEAD_OF_LINES,
  type SshAccess,
  type SshTest,
  defaultTransport,
  isSshUrl,
  sshWorkspaceLines,
  testGithubSsh,
  usingRest,
  usingSentence,
} from '../core/transport.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'
import { loginCommand, revokeUrl } from './login.ts'
import { syncCommand } from './sync.ts'

const execFileP = promisify(execFile)

export interface CreateOptions {
  /** The GitHub organization, exact name (`github.com/<org>`); prompted for when absent. */
  org?: string
  /** Comma-separated repositories for the workspace (`<repo>` or `<owner>/<repo>`): catalogue entries are cloned, others added. */
  repos?: string
  pm?: string
  /** Force `git@github.com:` without the SSH test. */
  ssh?: boolean
  /** Force `https://github.com/` without the SSH test. */
  https?: boolean
  /** Internal: remote base; wins over both flags and skips the SSH test. */
  host?: string
  yes?: boolean
  skipInstall?: boolean
  /** Reserved; rejected. */
  template?: string
  /** Internal (tests): directory to resolve from. */
  cwd?: string
  /** Internal (tests): GitHub REST API base. */
  githubApi?: string
}

export type { Prompts }

/** What create needs from the terminal; tests replace it with scripted answers. */
export type CreateDeps = Terminal

async function isEmptyDir(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0
}

async function ghAvailable(): Promise<boolean> {
  try {
    await execFileP('gh', ['--version'])
    return true
  } catch {
    return false
  }
}

async function insideWorkspace(dir: string): Promise<boolean> {
  try {
    await findWorkspace(dir)
    return true
  } catch {
    return false
  }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? 'unknown error'
  )
}

function splitSpecs(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * Why `root` cannot receive a new workspace, as the one-line message the
 * guards print; `null` when it can. Both ends of the operation count: the
 * directory create runs in, and the parent of the target — either one inside
 * a workspace would nest a second `.rness` under the first.
 */
async function targetProblem(
  cwd: string,
  root: string,
  pm: PackageManager
): Promise<string | null> {
  const shown = relative(cwd, root) || '.'
  if ((await insideWorkspace(cwd)) || (await insideWorkspace(dirname(root))))
    return 'already inside an rness workspace; create runs from outside one'
  if (!(await exists(root))) return null
  if (await exists(join(root, '.rness', 'rness.json'))) {
    // A join whose install failed leaves exactly this: a context clone and
    // no dependencies. Re-running create cannot help — point at the install
    // that finishes the job instead of at `rness add`.
    if (!(await exists(join(root, '.rness', 'node_modules'))))
      return `${shown} holds an rness workspace whose dependencies are not installed; cd ${shown}/.rness && ${pm} install, then rness sync`
    return `${shown} already holds an rness workspace (.rness/); run rness add inside it to add repositories`
  }
  if (!(await stat(root)).isDirectory()) return `${shown} is not a directory`
  if (!(await isEmptyDir(root))) return `${shown} is not empty`
  return null
}

// A cancelled or declined prompt is the user's choice, not a failure: exit 0
// so `npm create rness` does not wrap it in npm's error report.
function cancelled(ui: Ui): number {
  ui.cancelled()
  return 0
}

/**
 * The repositories to offer: the organization's, listed from the GitHub API,
 * plus every catalogue repository the API did not return (a private one
 * listed anonymously). Catalogue repositories are pre-selected. A listing that
 * fails is a warning: the catalogue is still offered, and `rness add` adds
 * repositories later. `null` when the user cancels; `prompted` tells whether
 * the picker was shown at all.
 */
async function pickRepositories(input: {
  org: string
  provider: GitProvider
  prompts: Prompts
  ui: Ui
  catalogue: Readonly<Record<string, unknown>>
}): Promise<{ picked: string[]; prompted: boolean } | null> {
  const { org, prompts, provider, ui } = input
  // Logged in: say as whom rness looks at the organization, and when the
  // organization hides its private repositories from OAuth apps (spec 0004 §3).
  if (provider.authenticated) {
    const access = await provider.organizationAccess(org)
    const login = (await provider.identity())?.login
    if (access === 'member')
      ui.line(
        'member',
        `${org}${login === undefined ? '' : ` (as ${login})`}`,
        `You are a member of ${org}${login === undefined ? '' : ` (as ${login})`}`
      )
    else if (access === 'restricted') {
      ui.warn(
        `${org} restricts OAuth apps, so its private repositories are hidden from rness`
      )
      ui.hint(`ask an owner to approve it: ${revokeUrl()}`, 'stderr')
    }
  }
  let listed: { name: string; private: boolean; archived: boolean }[] = []
  let failed = false
  // The plain look announces the listing; the session look spins on it.
  if (!ui.session) ui.line('listing', `${org} repositories…`)
  try {
    const listing = await ui.step(
      {
        doing: `listing  ${org} repositories`,
        sentence: `Listing the repositories of ${org}`,
        quiet: true,
      },
      () => provider.listRepositories(org),
      (l) => ['listed', `${l.repositories.length} repositories of ${org}`]
    )
    listed = listing.repositories
    if (listing.owner === 'user')
      ui.hint(
        `only public repositories of ${org} are listed; add private ones later with rness add <repo>`
      )
    else if (!provider.authenticated)
      ui.hint(
        'only public repositories are listed; rness login lists the private ones you can access'
      )
    if (listing.truncated)
      ui.hint(`listed the first ${MAX_PAGES * PER_PAGE} repositories of ${org}`)
  } catch (e) {
    failed = true
    ui.warn(firstLine(e instanceof Error ? e.message : String(e)))
  }
  const inCatalogue = (name: string): boolean =>
    Object.hasOwn(input.catalogue, name)
  // Archived repositories and hidden ones (a leading dot: .github, the
  // context repository .rness, …) are never candidates. GitHub names are
  // case-insensitive, so a name that differs from `NAME` only by case is
  // offered — and declared — in lowercase, as `rness add` would; any other
  // name is shown but cannot be picked yet.
  const byLabel = (a: { label: string }, b: { label: string }): number =>
    a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })
  const candidates = listed.filter(
    (r) => !r.archived && !r.name.startsWith('.')
  )
  // A private repository wears a padlock next to its name — visible on every
  // line, where a hint shows on the focused one only. A terminal that cannot
  // draw it falls back to the word, as a hint.
  const padlock = unicode()
  const hint = (isPrivate: boolean, catalogued: boolean): string | null =>
    [isPrivate && !padlock ? 'private' : null, catalogued ? 'in .rness' : null]
      .filter((h) => h !== null)
      .join(' · ') || null
  const declarable = candidates
    .filter((r) => NAME.test(r.name.toLowerCase()))
    .map((r) => {
      const value = r.name.toLowerCase()
      const h = hint(r.private, inCatalogue(value))
      const label = r.private && padlock ? `${r.name} ${PRIVATE_MARK}` : r.name
      return { value, label, ...(h === null ? {} : { hint: h }) }
    })
  const offered = new Set(declarable.map((o) => o.value))
  for (const name of Object.keys(input.catalogue)) {
    if (!offered.has(name))
      declarable.push({ value: name, label: name, hint: 'in .rness' })
  }
  declarable.sort(byLabel)
  const unsupported = candidates
    .filter((r) => !NAME.test(r.name.toLowerCase()))
    .map((r) => ({
      value: r.name,
      label: r.name,
      hint: 'name not supported yet',
      disabled: true,
    }))
    .sort(byLabel)
  // clack renders a disabled option struck through but never its hint, so
  // the reason is printed here.
  if (unsupported.length > 0) {
    const names = unsupported.slice(0, 5).map((o) => o.label)
    const more =
      unsupported.length > names.length
        ? ` and ${unsupported.length - names.length} more`
        : ''
    ui.hint(
      `names rness cannot declare yet (struck through): ${names.join(', ')}${more}`
    )
  }
  if (declarable.length === 0) {
    // After a failed listing its own warning already says why.
    if (!failed) ui.warn(`no repositories to list for ${org}`)
    return { picked: [], prompted: false }
  }
  const initialValues = Object.keys(input.catalogue)
  // Disabled options go last: clack focuses the first option before any key
  // is pressed, and Tab would select it even when it is disabled.
  const answer = await prompts.autocompleteMultiselect<string>({
    message: 'Which repositories do you want in your workspace?',
    options: [...declarable, ...unsupported],
    ...(initialValues.length > 0 ? { initialValues } : {}),
    required: false,
    placeholder: 'Type to filter',
  })
  if (prompts.isCancel(answer)) return null
  const allowed = new Set(declarable.map((o) => o.value))
  return {
    picked: Array.isArray(answer) ? answer.filter((v) => allowed.has(v)) : [],
    prompted: true,
  }
}

interface Failure {
  spec: string
  message: string
}

/**
 * Bring each selected repository into `org/`, in order. A catalogue
 * repository is cloned from its catalogue URL and `rness.json` is left alone;
 * any other goes through `addRepository` (declared, then cloned), as
 * `rness add` would. A failure is reported on one line and the next entry
 * still runs: a typo in `--repos` must not cost the workspace the
 * repositories that do exist, nor the commit and sync that follow.
 */
async function cloneSelection(input: {
  root: string
  rnessDir: string
  manifest: Manifest
  org: string
  host: string
  specs: readonly string[]
  provider: GitProvider
  ui: Ui
}): Promise<Failure[]> {
  const { ui } = input
  let manifest = input.manifest
  const failures: Failure[] = []
  for (const spec of new Set(input.specs)) {
    try {
      let name: string | null = null
      try {
        name = parseRepoSpec(spec, input.org, input.host).name
      } catch {
        // `addRepository` reports the malformed spec below.
      }
      const entry = name === null ? undefined : manifest.repos[name]
      if (name !== null && entry !== undefined) {
        const repo = name
        await ui.step(
          { doing: `cloning  org/${repo}`, git: true },
          () =>
            clone(
              entry.url,
              join(input.root, 'org', repo),
              input.provider.credentialsFor(entry.url)
            ),
          () => ['cloned', `org/${repo}`]
        )
        continue
      }
      const current = manifest
      const result = await ui.step(
        { doing: `cloning  ${spec}`, git: true },
        () =>
          addRepository({
            root: input.root,
            rnessDir: input.rnessDir,
            manifest: current,
            spec,
            org: input.org,
            host: input.host,
            scopes: [],
            credentialsFor: (url) => input.provider.credentialsFor(url),
          }),
        (r) => [r.action, `org/${r.name}`]
      )
      manifest = result.manifest
      ui.line('declared', `scope ${result.name} (org/${result.name})`)
    } catch (e) {
      const message = firstLine(e instanceof Error ? e.message : String(e))
      ui.error(`${spec}: ${message}`)
      failures.push({ spec, message })
    }
  }
  return failures
}

/**
 * Move the staged `.rness` clone into the workspace. A rename is atomic and
 * keeps the clone's origin; across filesystems (`EXDEV`: the temporary
 * directory on another volume) the context is cloned a second time instead.
 */
async function placeContext(
  staged: string,
  rnessDir: string,
  url: string,
  credentials: GitCredentials | null
): Promise<void> {
  try {
    await rename(staged, rnessDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await clone(url, rnessDir, credentials)
  }
}

const OTHER = Symbol('another organization')

/**
 * Logged in, the organization is picked from the user's own and their
 * account rather than typed. `OTHER` leads to the text prompt — as does
 * having nothing to offer; null is a cancel.
 */
async function chooseOrganization(
  provider: GitProvider,
  prompts: Prompts
): Promise<string | typeof OTHER | null> {
  if (!provider.authenticated) return OTHER
  let names: string[]
  try {
    const self = (await provider.identity())?.login
    names = (await provider.listOrganizations()).map((o) => o.login)
    if (self !== undefined) names.push(self)
  } catch {
    return OTHER
  }
  if (names.length === 0) return OTHER
  const answer = await prompts.select<string>({
    message: 'Which GitHub organization?',
    options: [
      ...names.map((name) => ({ value: name, label: name })),
      { value: '', label: 'another one…' },
    ],
  })
  if (prompts.isCancel(answer)) return null
  if (typeof answer !== 'string' || answer === '') return OTHER
  return answer
}

/**
 * `rness create`: join the organization's `.rness` or start a new one in
 * `./<org>` (spec 0003 §2.1). `rness.json` is the organization's catalogue;
 * the workspace is the selection of it cloned into `org/`. Every prompt comes
 * before the first write, so a cancel leaves nothing behind. URLs are written
 * over SSH when github.com accepts the user's key, over HTTPS otherwise
 * (spec 0005); a catalogue URL is cloned as written.
 */
export async function createCommand(
  opts: CreateOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  const terminal = deps.terminal ?? defaultTerminal
  const transport = deps.transport ?? defaultTransport
  // Built on first use: it reads the stored login, which most paths never need.
  let provider = deps.provider
  const getProvider = async (): Promise<GitProvider> =>
    (provider ??= await githubProvider(opts.githubApi))
  const cwd = opts.cwd ?? process.cwd()
  if (opts.template !== undefined) {
    process.stderr.write('--template is reserved for a later version\n')
    return 2
  }
  if (opts.pm !== undefined && !isPackageManager(opts.pm)) {
    process.stderr.write(`--pm must be one of ${PACKAGE_MANAGERS.join(', ')}\n`)
    return 2
  }
  if (opts.ssh === true && opts.https === true) {
    process.stderr.write('--ssh and --https cannot be combined\n')
    return 2
  }
  // A malformed flag is refused before any question is asked about the rest.
  if (opts.org !== undefined && !ORG_NAME.test(opts.org)) {
    process.stderr.write(
      `organization name "${opts.org}" is not a valid GitHub organization name\n`
    )
    return 2
  }
  const pm: PackageManager =
    opts.pm !== undefined && isPackageManager(opts.pm)
      ? opts.pm
      : detectPackageManager()
  const interactive = opts.yes !== true && terminal.isTty()
  // The plain look unless this is a wizard in a real terminal (spec 0007 §5b).
  const ui = interactive ? await makeUi(terminal) : { ...plainUi }
  // The SSH test runs at most once, and only when its answer is needed.
  let sshTest: SshTest | undefined
  const testSsh = async (): Promise<SshAccess> => {
    if (sshTest === undefined) {
      sshTest = await testGithubSsh(transport, interactive, () =>
        ui.line(...CHECKING)
      )
      // Unattended SSH never asks anything: git steps may animate.
      if (sshTest.unattended) ui.gitIsSilent = true
    }
    return sshTest.access
  }
  const chooseHost = async (): Promise<string> => {
    // Only SSH can make git ask something on the terminal (a passphrase).
    if (opts.host !== undefined || opts.https === true) ui.gitIsSilent = true
    if (opts.host !== undefined) return opts.host
    if (opts.ssh === true) return transport.hosts.ssh
    if (opts.https === true) return transport.hosts.https
    const access = await testSsh()
    const github = access.ok ? null : await getProvider()
    const login = github?.authenticated
      ? (await github.identity())?.login
      : undefined
    ui.line('using', usingRest(access, login), usingSentence(access, login))
    if (!access.ok) ui.gitIsSilent = true
    return access.ok ? transport.hosts.ssh : transport.hosts.https
  }
  let loaded: Prompts | undefined
  const prompts = async (): Promise<Prompts> =>
    (loaded ??= await terminal.prompts())
  let staging: string | undefined
  // '' off a terminal, so scripts and tests see nothing of it.
  if (interactive) process.stdout.write(banner(VERSION))
  ui.intro('Create a workspace')
  try {
    // In a terminal, before the first question: no answer could fix it.
    if (interactive && (await insideWorkspace(cwd))) {
      process.stderr.write(
        'already inside an rness workspace; create runs from outside one\n'
      )
      return 1
    }

    let prompted = false
    let org = opts.org
    if (org === undefined && !interactive) {
      process.stderr.write('rness create needs --org <name> without a prompt\n')
      return 2
    }
    // Anonymous, and about to list repositories: offer the login first — it is
    // what lists the private ones, and the user's organizations to pick from.
    if (
      interactive &&
      opts.repos === undefined &&
      !(await getProvider()).authenticated
    ) {
      const p = await prompts()
      const login = await p.confirm({
        message: 'Log in to GitHub to list private repositories?',
        initialValue: true,
      })
      if (p.isCancel(login)) return cancelled(ui)
      if (login === true) {
        const code = await loginCommand(
          opts.githubApi === undefined ? {} : { githubApi: opts.githubApi },
          { terminal, ui }
        )
        if (code !== 0) return code
        provider = await githubProvider(opts.githubApi)
      }
    }
    if (org === undefined) {
      const chosen = await chooseOrganization(
        await getProvider(),
        await prompts()
      )
      if (chosen === null) return cancelled(ui)
      if (chosen !== OTHER) {
        org = chosen
        prompted = true
      }
    }
    if (org === undefined) {
      const p = await prompts()
      const answer = await p.text({
        message: 'What is your GitHub organization named?',
        placeholder: 'acme',
        validate: (value) => {
          const v = value?.trim() ?? ''
          return ORG_NAME.test(v)
            ? undefined
            : `"${v}" is not a valid GitHub organization name`
        },
      })
      if (p.isCancel(answer) || typeof answer !== 'string') return cancelled(ui)
      org = answer.trim()
      prompted = true
    }

    // The organization is the workspace: its directory carries the exact name.
    const root = resolve(cwd, org)
    const shown = relative(cwd, root) || '.'
    const problem = await targetProblem(cwd, root, pm)
    if (problem !== null) {
      process.stderr.write(`${problem}\n`)
      return 1
    }
    if (opts.yes !== true && !terminal.isTty()) {
      process.stderr.write(
        'rness create writes files; pass --yes to run without a prompt\n'
      )
      return 2
    }

    const host = await chooseHost()
    const contextUrl = repoUrl(host, org, '.rness')
    const gitProvider = await getProvider()
    const probe = await probeRemote(
      contextUrl,
      undefined,
      gitProvider.credentialsFor(contextUrl)
    )
    if (probe.kind === 'error') {
      process.stderr.write(`${probe.message}\n`)
      return 1
    }
    const joining = probe.kind === 'found'
    if (joining)
      ui.line(
        'found',
        `${org}/.rness — joining`,
        `${org} has a workspace — joining it`
      )
    else
      ui.line(
        'not found',
        `${org}/.rness (or not visible to you) — starting a new workspace`,
        `${org} has no workspace yet (or none you can see) — starting one`
      )

    // Joining: the catalogue is read from a clone staged outside the target,
    // so the picker can offer it before anything is written there.
    let catalogue: Manifest = { contract: 1, org, repos: {}, scopes: {} }
    const staged = async (): Promise<string> => {
      staging ??= await mkdtemp(join(tmpdir(), 'rness-join-'))
      return join(staging, '.rness')
    }
    if (joining) {
      const stagedDir = await staged()
      await ui.step(
        {
          doing: `cloning  ${org}/.rness`,
          sentence: `Reading the catalogue of ${org}`,
          git: true,
        },
        () =>
          clone(contextUrl, stagedDir, gitProvider.credentialsFor(contextUrl))
      )
      // Validates that the clone is a workspace context: throws on a
      // malformed or absent rness.json.
      catalogue = await loadManifest(await staged())
      // An SSH workspace is not negotiable: without SSH access its
      // repositories cannot be cloned, so stop before any question or write.
      // `--ssh` is the user's word that SSH works; git reports otherwise.
      const overSsh = Object.values(catalogue.repos).some((r) =>
        isSshUrl(r.url, transport.hosts)
      )
      if (overSsh && opts.ssh !== true && opts.host === undefined) {
        const access = await testSsh()
        if (!access.ok) {
          process.stderr.write(
            `${[...sshWorkspaceLines(access.reason), ...INSTEAD_OF_LINES].join('\n')}\n`
          )
          return 1
        }
      }
    }

    let specs: string[]
    if (opts.repos !== undefined) specs = splitSpecs(opts.repos)
    else if (interactive) {
      const result = await pickRepositories({
        org,
        provider: gitProvider,
        ui,
        prompts: await prompts(),
        catalogue: catalogue.repos,
      })
      if (result === null) return cancelled(ui)
      specs = result.picked
      prompted ||= result.prompted
    } else {
      // Scripts and CI: a join takes the whole catalogue, a new workspace nothing.
      specs = Object.keys(catalogue.repos)
    }
    if (interactive && !prompted) {
      const p = await prompts()
      const ok = await p.confirm({
        message: `Create workspace ${org} in ./${shown}?`,
      })
      if (p.isCancel(ok) || ok !== true) return cancelled(ui)
    }

    const rnessDir = join(root, '.rness')
    const install = async (): Promise<void> => {
      if (opts.skipInstall === true) {
        ui.line('skipped', 'install (--skip-install)')
        return
      }
      await ui.step(
        { doing: `installing dependencies with ${pm}` },
        () => installDependencies(pm, rnessDir),
        () => ['installed', `dependencies with ${pm}`]
      )
    }

    if (joining) {
      await mkdir(root, { recursive: true })
      await placeContext(
        await staged(),
        rnessDir,
        contextUrl,
        gitProvider.credentialsFor(contextUrl)
      )
      ui.line('cloned', `${shown}/.rness (joined ${org})`)
      await install()
      await mkdir(join(root, 'org'), { recursive: true })
      const failures = await cloneSelection({
        root,
        rnessDir,
        manifest: catalogue,
        org,
        host,
        specs,
        provider: gitProvider,
        ui,
      })
      const code = await syncBlocks(ui, root, shown, () =>
        syncCommand({ yes: true, cwd: root })
      )
      if (code !== 0) return code
      if (failures.length > 0)
        ui.note(
          'Next steps',
          failures.map((f) => `rness add ${f.spec}   # failed: ${f.message}`)
        )
      ui.outro(`You joined ${org} — your workspace is in ${shown}/`)
      return failures.length > 0 ? 1 : 0
    }

    // Resolved before anything touches the filesystem: a missing package
    // manager binary must not leave an empty `<shown>/` behind.
    const pmVersion = await packageManagerVersion(pm)
    await mkdir(root, { recursive: true })
    // Phase 1 — creating the workspace itself. Only these steps are rolled
    // back: past them the workspace exists and is worth keeping, whatever a
    // repository does next.
    try {
      await copyScaffold(rnessDir, {
        version: VERSION,
        packageManager: `${pm}@${pmVersion}`,
      })
      await writeManifest(rnessDir, catalogue)
      ui.line('created', `${shown}/.rness (new workspace)`)
      await install()
    } catch (e) {
      // Report the cause before the consequence: the original error first,
      // then the rollback note. Everything under `rnessDir` was written by
      // this call, so removing it is safe; `root` goes too when it is left
      // empty (this call created it, or found it empty), or the retry the
      // message asks for would be refused with "<shown> is not empty". A
      // failing `rm` is swallowed rather than thrown, since it must never
      // mask the original error.
      reportError(e)
      await rm(rnessDir, { recursive: true, force: true }).catch(
        () => undefined
      )
      if (await isEmptyDir(root).catch(() => false))
        await rm(root, { recursive: true, force: true }).catch(() => undefined)
      process.stderr.write(
        `removed ${shown}/.rness after the failure; fix it and retry\n`
      )
      return 1
    }

    // Phase 2 — the repositories. Nothing here is rolled back.
    await mkdir(join(root, 'org'), { recursive: true })
    const failures = await cloneSelection({
      root,
      rnessDir,
      manifest: catalogue,
      org,
      host,
      specs,
      provider: gitProvider,
      ui,
    })

    await init(rnessDir)
    try {
      await commitAll(rnessDir, 'chore: rness workspace context')
      ui.line('committed', `${shown}/.rness`)
    } catch (e) {
      ui.warn(
        `${e instanceof Error ? e.message : String(e)} — commit ${shown}/.rness yourself`
      )
    }

    const code = await syncBlocks(ui, root, shown, () =>
      syncCommand({ yes: true, cwd: root })
    )
    if (code !== 0) return code

    const gh = await ghAvailable()
    const next = [
      `cd ${shown}/.rness`,
      // What was asked for and did not happen, as the command that retries
      // it — the workspace is complete otherwise.
      ...failures.map((f) => `rness add ${f.spec}   # failed: ${f.message}`),
      gh
        ? `gh repo create ${org}/.rness --private --source . --push`
        : `git remote add origin ${contextUrl} && git push -u origin main`,
      `# then, for every teammate: npm create rness ${org}`,
    ]
    if (ui.session) {
      ui.note('Next steps', next)
      ui.outro(`Workspace for ${org} is ready in ${shown}/`)
    } else
      process.stdout.write(
        [
          '',
          `Workspace for \`${org}\` is ready in ${shown}/.`,
          '',
          'Next:',
          ...next.map((line) => `  ${line}`),
          '',
        ].join('\n')
      )
    return failures.length > 0 ? 1 : 0
  } catch (e) {
    return reportError(e)
  } finally {
    // The staged context is either moved into place or no longer needed.
    if (staging !== undefined)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
