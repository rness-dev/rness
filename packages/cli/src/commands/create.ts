import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { SUPPORTED_AGENTS, unsupportedAgents } from '../core/agents.ts'
import { checkAccess } from '../core/approval.ts'
import { askAgents } from '../core/ask-agents.ts'
import { BLANK, askProvider } from '../core/ask-provider.ts'
import type { CommandDeps } from '../core/deps.ts'
import { clone, publish } from '../core/git.ts'
import { githubProvider } from '../core/github-oauth-provider.ts'
import { MAX_PAGES, type OrgRepository, PER_PAGE } from '../core/github.ts'
import { gitlabProvider } from '../core/gitlab-oauth-provider.ts'
import { HOSTS, type HostSpec, hostFor, providerFlag } from '../core/hosts.ts'
import {
  GITLAB_CONTEXT_NAME,
  NAME,
  contextRepo,
  isMemberRepo,
  loadManifest,
  orgNameRule,
  parseRepoSpec,
} from '../core/manifest.ts'
import {
  buildContext,
  commitContext,
  insideWorkspace,
  installContext,
  targetProblem,
} from '../core/new-workspace.ts'
import { workspacePackageManager } from '../core/pinned.ts'
import {
  PACKAGE_MANAGERS,
  type PackageManager,
  detectPackageManager,
  isPackageManager,
  rnessCommand,
} from '../core/pm.ts'
import type {
  GitCredentials,
  Organization,
  Provider,
} from '../core/provider.ts'
import { PROVIDERS, isProviderName, openProvider } from '../core/providers.ts'
import { probeRemote, repoUrl } from '../core/remote.ts'
import { addRepository } from '../core/repos.ts'
import { PRIVATE_MARK, banner, count, unicode } from '../core/style.ts'
import { syncBlocks } from '../core/sync-blocks.ts'
import {
  type Prompts,
  type Terminal,
  defaultTerminal,
} from '../core/terminal.ts'
import {
  type SshAccess,
  type SshTest,
  type Transport,
  checking,
  defaultTransport,
  insteadOfLines,
  isSshUrl,
  passphraseHint,
  sshWorkspaceLines,
  testGithubSsh,
  transportFor,
  usingRest,
  usingSentence,
} from '../core/transport.ts'
import type { Manifest, ProviderName } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { clonesIn } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'
import {
  WORKSPACE_NAME,
  createBlank,
  workspaceNameError,
} from './create-blank.ts'
import { loginCommand } from './login.ts'
import { syncCommand } from './sync.ts'

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
  /** A workspace with no GitHub organization (spec 0012). */
  blank?: boolean
  /** With `blank`: the workspace directory; prompted for when absent. */
  name?: string
  /** Where the organization lives (`github`, later `gitlab`, `atlassian`); asked when absent in a terminal, `github` otherwise. */
  provider?: string
  /** A new workspace's agents, declared in rness.json (spec 0011 §3.2). */
  agent?: string[]
  /** Internal (tests): directory to resolve from. */
  cwd?: string
  /** Internal (tests): GitHub REST API base. */
  githubApi?: string
  /** Internal (tests): GitLab REST API base. */
  gitlabApi?: string
}

/** What the wizard says and makes, per provider (spec 0037 §4, §5.4). */
interface Words {
  /** `GitHub`, as the lines name the provider. */
  label: string
  /** The organization's word: `organization`, `group`. */
  org: string
  repos: readonly [string, string]
  login: string
  otherLabel: string
  otherHint: string
}

const WORDS: Readonly<Record<'github' | 'gitlab', Words>> = {
  github: {
    label: 'GitHub',
    org: 'organization',
    repos: ['repository', 'repositories'],
    login:
      'Log in to GitHub to list your organizations and private repositories?',
    otherLabel: 'an organization not listed here…',
    otherHint: 'not a member, or it has not approved rness yet',
  },
  gitlab: {
    label: 'GitLab',
    org: 'group',
    repos: ['project', 'projects'],
    login: 'Log in to GitLab to list your groups and private projects?',
    otherLabel: 'a group not listed here…',
    otherHint: 'not a member',
  },
}

const wordsOf = (provider: ProviderName): Words =>
  provider === 'gitlab' ? WORDS.gitlab : WORDS.github

/**
 * What to type when the context repository is not published: git first,
 * everyone has it; the provider's CLI second, for those who do (spec 0004
 * §3b, spec 0037 §5.4).
 */
function manualSteps(
  provider: ProviderName,
  org: string,
  context: string,
  url: string
): string[] {
  if (provider === 'gitlab')
    return [
      `# create the empty private project ${org}/${context}, named ${GITLAB_CONTEXT_NAME}, on gitlab.com, then:`,
      `git remote add origin ${url} && git push -u origin main`,
      '# or, with the GitLab CLI (glab) installed:',
      `glab repo create ${org}/${context} --name ${GITLAB_CONTEXT_NAME} --private --skipGitInit && git push -u origin main`,
    ]
  return [
    `# create the empty private repository ${org}/${context} on github.com, then:`,
    `git remote add origin ${url} && git push -u origin main`,
    // git first: everyone has it. The GitHub CLI second, for those who do: it
    // creates the repository and pushes in one step.
    '# or, with the GitHub CLI (gh) installed, in one step:',
    `gh repo create ${org}/${context} --private --source . --push`,
  ]
}

/** How a teammate joins: `--provider` past GitHub, behind npm's `--`. */
function joinCommand(provider: ProviderName, org: string): string {
  const pm = detectPackageManager()
  if (provider === 'github') return `${pm} create rness ${org}`
  return `${pm} create rness ${pm === 'npm' ? '-- ' : ''}${org} --provider ${provider}`
}

export type { Prompts }

/** What create needs from the terminal; tests replace it with scripted answers. */
export type CreateDeps = Terminal

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
  provider: Provider
  providerName: ProviderName
  prompts: Prompts
  ui: Ui
  catalogue: Readonly<Record<string, unknown>>
}): Promise<{ picked: string[]; prompted: boolean } | null> {
  const { org, prompts, provider, providerName, ui } = input
  const words = wordsOf(providerName)
  const [one, many] = words.repos
  const member = (r: { name: string; archived: boolean }): boolean =>
    isMemberRepo(r, providerName)
  let listed: OrgRepository[] = []
  let failed = false
  // The plain look announces the listing; the session look spins on it.
  if (!ui.session) ui.line('listing', `${org} ${many}…`)
  try {
    const listing = await ui.step(
      {
        doing: `listing  ${org} ${many}`,
        sentence: `Listing the ${many} of ${org}`,
        quiet: true,
      },
      () => provider.listRepositories(org),
      // What the listing offers, not what the provider returned: the count
      // and the list below it must agree (spec 0009).
      (l) => [
        'listed',
        `${count(l.repositories.filter(member).length, [one, many])} of ${org}`,
      ]
    )
    listed = listing.repositories
    for (const note of listing.notes ?? []) ui.hint(note)
    const login = `${rnessCommand()} login${providerFlag(hostFor(providerName) ?? HOSTS.github)}`
    if (listing.owner === 'user')
      ui.hint(
        `only public ${many} of ${org} are listed; add private ones later with ${rnessCommand()} add <repo>`
      )
    else if (!provider.authenticated)
      ui.hint(
        `only public ${many} are listed; ${login} lists the private ones you can access`
      )
    if (listing.truncated)
      ui.hint(`listed the first ${MAX_PAGES * PER_PAGE} ${many} of ${org}`)
  } catch (e) {
    failed = true
    ui.warn(firstLine(e instanceof Error ? e.message : String(e)))
  }
  const inCatalogue = (name: string): boolean =>
    Object.hasOwn(input.catalogue, name)
  // Every active repository of the organization is a candidate but its context
  // repository, which is already cloned as `<root>/.rness` and is not a member
  // of the workspace it defines (spec 0009). A name beginning with a dot is an
  // ordinary repository: `.github` carries an organization's profile, its
  // issue templates and its shared workflows, and a member works on it like
  // any other. Archived repositories stay out: GitHub makes them read-only, so
  // a block written into one could never be pushed back.
  // GitHub names are case-insensitive, so a name that differs from `NAME` only
  // by case is offered — and declared — in lowercase, as `rness add` would;
  // any other name is shown but cannot be picked yet.
  const byLabel = (a: { label: string }, b: { label: string }): number =>
    a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })
  const candidates = listed.filter(member)
  // A private repository wears a padlock next to its name — visible on every
  // line, where a hint shows on the focused one only. A terminal that cannot
  // draw it falls back to the word, as a hint. The provider's own hint (a
  // GitLab subgroup, `internal`) comes first.
  const padlock = unicode()
  const hint = (
    own: string | undefined,
    isPrivate: boolean,
    catalogued: boolean
  ): string | null =>
    [
      own ?? null,
      isPrivate && !padlock ? 'private' : null,
      catalogued ? 'in .rness' : null,
    ]
      .filter((h) => h !== null)
      .join(' · ') || null
  // A project of a GitLab subgroup is cloned from its full path; the picker
  // offers it by its name, the key it gets.
  const specOf = new Map<string, string>()
  const declarable = candidates
    .filter((r) => NAME.test(r.name.toLowerCase()))
    .map((r) => {
      const value = r.name.toLowerCase()
      if (r.path !== undefined && r.path !== `${org}/${r.name}`)
        specOf.set(value, r.path)
      const h = hint(r.hint, r.private, inCatalogue(value))
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
    if (!failed) ui.warn(`no ${many} to list for ${org}`)
    return { picked: [], prompted: false }
  }
  const initialValues = Object.keys(input.catalogue)
  // Disabled options go last: clack focuses the first option before any key
  // is pressed, and Tab would select it even when it is disabled.
  const answer = await prompts.autocompleteMultiselect<string>({
    message: `Which ${many} do you want in your workspace?`,
    options: [...declarable, ...unsupported],
    ...(initialValues.length > 0 ? { initialValues } : {}),
    required: false,
    placeholder: 'Type to filter',
  })
  if (prompts.isCancel(answer)) return null
  const allowed = new Set(declarable.map((o) => o.value))
  return {
    picked: Array.isArray(answer)
      ? answer.filter((v) => allowed.has(v)).map((v) => specOf.get(v) ?? v)
      : [],
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
  provider: Provider
  ui: Ui
}): Promise<Failure[]> {
  const providerName = input.manifest.provider
  const { ui } = input
  let manifest = input.manifest
  const failures: Failure[] = []
  for (const spec of new Set(input.specs)) {
    try {
      let name: string | null = null
      try {
        name = parseRepoSpec(spec, input.org, input.host, providerName).name
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

/** The flags that name a GitHub workspace, which a blank one has none of. */
function blankConflict(opts: CreateOptions): string | null {
  if (opts.org !== undefined) return '--org'
  if (opts.repos !== undefined) return '--repos'
  if (opts.ssh === true) return '--ssh'
  if (opts.https === true) return '--https'
  if (opts.host !== undefined) return '--host'
  if (opts.provider !== undefined) return '--provider'
  return null
}

/** Refuses a `--provider` value that names no provider, or one not yet available. */
function providerFlagError(value: string): string | null {
  if (!isProviderName(value))
    return `unknown provider "${value}" (${Object.keys(PROVIDERS).join(', ')})`
  if (PROVIDERS[value].available) return null
  const available = Object.values(PROVIDERS)
    .filter((p) => p.available)
    .map((p) => p.name)
  return `provider "${value}" is not available yet (available: ${available.join(', ')})`
}

const OTHER = Symbol('another organization')
export const OTHER_LABEL = WORDS.github.otherLabel
/** Why one may be missing: the list is the approved organizations of the login (plan 0037, task 1). */
export const OTHER_HINT = WORDS.github.otherHint
export const NOT_APPROVED = 'rness not approved'

/**
 * Logged in, the organization is picked from the login's own and their
 * account rather than typed (spec 0028 §2). An organization the provider
 * does not let rness read wears the padlock of spec 0009's picker, with the
 * hint that tells it from a private repository. `OTHER` leads to the text
 * prompt — the organization of an outside collaborator, a public one the
 * user does not belong to, or a listing that failed — as does having
 * nothing to offer; null is a cancel.
 */
async function chooseOrganization(
  provider: Provider,
  prompts: Prompts,
  providerName: ProviderName
): Promise<{ org: string; canGrant: boolean | null } | typeof OTHER | null> {
  const words = wordsOf(providerName)
  if (!provider.authenticated) return OTHER
  let organizations: Organization[]
  let self: string | undefined
  try {
    self = (await provider.identity())?.login
    organizations = await provider.listOrganizations()
  } catch {
    return OTHER
  }
  if (organizations.length === 0 && self === undefined) return OTHER
  const padlock = unicode()
  const options: { value: string; label: string; hint?: string }[] =
    organizations.map((o) => ({
      value: o.login,
      label: !o.approved && padlock ? `${o.login} ${PRIVATE_MARK}` : o.login,
      ...(o.approved ? {} : { hint: NOT_APPROVED }),
    }))
  if (self !== undefined)
    options.push({ value: self, label: self, hint: 'your account' })
  options.push({ value: '', label: words.otherLabel, hint: words.otherHint })
  const answer = await prompts.select<string>({
    message: `Which ${words.label} ${words.org}?`,
    options,
  })
  if (prompts.isCancel(answer)) return null
  if (typeof answer !== 'string' || answer === '') return OTHER
  const picked = organizations.find((o) => o.login === answer)
  return { org: answer, canGrant: picked?.canGrant ?? null }
}

/**
 * Offer to create `<org>/.rness` on GitHub and push the new context to it.
 * True when it is published, false when it is left to the user (anonymous,
 * declined, refused by GitHub — said in one warning), null on a cancel.
 */
async function publishContext(input: {
  ui: Ui
  prompts: Prompts
  provider: Provider
  host: HostSpec
  org: string
  /** The context repository's name there: `.rness`, `rness` on GitLab. */
  context: string
  rnessDir: string
  url: string
}): Promise<boolean | null> {
  const { ui, prompts, provider, org, host } = input
  const where = `${org}/${input.context}`
  if (!provider.authenticated) return false
  const ok = await prompts.confirm({
    message: `Create ${where} on ${host.label} (private) and push it?`,
    initialValue: true,
  })
  if (prompts.isCancel(ok)) return null
  if (ok !== true) return false
  try {
    const result = await ui.step(
      { doing: `creating ${where} on ${host.label}` },
      () => provider.createRepository(org, input.context)
    )
    if (result.kind === 'exists') {
      ui.warn(`${where} already exists on ${host.label}; nothing was pushed`)
      return false
    }
    if (result.kind === 'refused') {
      ui.warn(`${host.label} did not create ${where}: ${result.reason}`)
      return false
    }
    ui.line('created', `${host.host}/${where} (private)`)
    await ui.step(
      { doing: `pushing  ${where}`, git: true },
      () =>
        publish(input.rnessDir, input.url, provider.credentialsFor(input.url)),
      () => ['pushed', where]
    )
    return true
  } catch (e) {
    ui.warn(firstLine(e instanceof Error ? e.message : String(e)))
    return false
  }
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
  // GitHub's until the provider is known (the wizard's first question).
  let transport: Transport = deps.transport ?? defaultTransport
  let chosenProvider: ProviderName = 'github'
  let hostSpec: HostSpec = HOSTS.github
  const clock = {
    ...(deps.open === undefined ? {} : { open: deps.open }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }
  // Built on first use: it reads the stored login, which most paths never need.
  let provider = deps.provider
  const open = (): Promise<Provider> =>
    chosenProvider === 'gitlab'
      ? gitlabProvider(opts.gitlabApi)
      : githubProvider(opts.githubApi)
  const getProvider = async (): Promise<Provider> => (provider ??= await open())
  const cwd = opts.cwd ?? process.cwd()
  if (opts.template !== undefined) {
    process.stderr.write('--template is reserved for a later version\n')
    return 2
  }
  if (opts.pm !== undefined && !isPackageManager(opts.pm)) {
    process.stderr.write(`--pm must be one of ${PACKAGE_MANAGERS.join(', ')}\n`)
    return 2
  }
  const agentFlags = [...new Set(opts.agent ?? [])]
  const unknownAgent = unsupportedAgents(agentFlags)[0]
  if (unknownAgent !== undefined) {
    process.stderr.write(
      `unknown agent "${unknownAgent}" (supported: ${SUPPORTED_AGENTS.join(', ')})\n`
    )
    return 2
  }
  if (opts.provider !== undefined) {
    const named = providerFlagError(opts.provider)
    if (named !== null) {
      process.stderr.write(`${named}\n`)
      return 2
    }
  }
  if (opts.ssh === true && opts.https === true) {
    process.stderr.write('--ssh and --https cannot be combined\n')
    return 2
  }
  if (opts.blank === true) {
    const clash = blankConflict(opts)
    if (clash !== null) {
      process.stderr.write(`--blank cannot be combined with ${clash}\n`)
      return 2
    }
    if (opts.name !== undefined && !WORKSPACE_NAME.test(opts.name)) {
      process.stderr.write(`${workspaceNameError(opts.name)}\n`)
      return 2
    }
  }
  // A malformed flag is refused before any question is asked about the rest;
  // an organization on the command line means no question names the provider.
  const flagged =
    opts.provider !== undefined && isProviderName(opts.provider)
      ? opts.provider
      : 'github'
  if (opts.org !== undefined && !orgNameRule(flagged).pattern.test(opts.org)) {
    process.stderr.write(
      `organization name "${opts.org}" is not a valid ${orgNameRule(flagged).noun}\n`
    )
    return 2
  }
  let pm: PackageManager =
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
        ui.line(...checking(hostSpec))
      )
      // Unattended SSH never asks anything: git steps may animate.
      if (sshTest.unattended) ui.gitIsSilent = true
      else if (sshTest.access.ok) ui.hint(passphraseHint(), 'stderr')
    }
    return sshTest.access
  }
  // Whether this machine's SSH access to github.com was proved. A delegated
  // child that then fails on publickey is missing an agent, not a key
  // (spec 0008 §2.1).
  const sshWorks = (): boolean => sshTest?.access.ok === true
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
    ui.line(
      'using',
      usingRest(access, login, hostSpec),
      usingSentence(access, login, hostSpec)
    )
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

    // Where the organization lives, or nowhere: the blank workspace is the
    // last answer of the first question (spec 0028 §2). The flag, an
    // organization or repositories on the command line settle it unasked.
    let blank = opts.blank === true
    if (opts.provider !== undefined && isProviderName(opts.provider))
      chosenProvider = opts.provider
    else if (
      !blank &&
      interactive &&
      opts.org === undefined &&
      opts.repos === undefined
    ) {
      const answer = await askProvider(await prompts())
      if (typeof answer !== 'string') return cancelled(ui)
      if (answer === BLANK) blank = true
      else chosenProvider = answer
    }
    // The host, its SSH test and its words follow the provider.
    hostSpec = hostFor(chosenProvider) ?? HOSTS.github
    if (deps.transport === undefined) transport = transportFor(hostSpec)
    const words = wordsOf(chosenProvider)
    const context = contextRepo(chosenProvider)
    const rule = orgNameRule(chosenProvider)
    if (blank)
      return await createBlank({
        name: opts.name,
        agents: agentFlags,
        cwd,
        pm,
        interactive,
        mayWrite: opts.yes === true || terminal.isTty(),
        skipInstall: opts.skipInstall === true,
        ui,
        prompts,
      })

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
        message: words.login,
        initialValue: true,
      })
      if (p.isCancel(login)) return cancelled(ui)
      if (login === true) {
        const code = await loginCommand(
          {
            provider: chosenProvider,
            ...(opts.githubApi === undefined
              ? {}
              : { githubApi: opts.githubApi }),
            ...(opts.gitlabApi === undefined
              ? {}
              : { gitlabApi: opts.gitlabApi }),
          },
          { terminal, ui, ...clock }
        )
        if (code !== 0) return code
        provider = await open()
      }
    }
    // What the listing knew of the identity's role there (spec 0028 §3).
    let canGrant: boolean | null = null
    if (org === undefined) {
      const chosen = await chooseOrganization(
        await getProvider(),
        await prompts(),
        chosenProvider
      )
      if (chosen === null) return cancelled(ui)
      if (chosen !== OTHER) {
        org = chosen.org
        canGrant = chosen.canGrant
        prompted = true
      }
    }
    if (org === undefined) {
      const p = await prompts()
      const answer = await p.text({
        message: `What is your ${words.label} ${words.org} named?`,
        placeholder: 'acme',
        validate: (value) => {
          const v = value?.trim() ?? ''
          return rule.pattern.test(v)
            ? undefined
            : `"${v}" is not a valid ${rule.noun}`
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

    // Access to the organization before anything reads it (spec 0028 §3):
    // the probe below must see a private `.rness` through a token the
    // organization has approved, or it would start a second one.
    const outcome = await checkAccess({
      org,
      provider: await getProvider(),
      ui,
      interactive,
      prompts,
      canGrant,
      deps: clock,
    })
    if (outcome === 'cancelled') return cancelled(ui)

    const host = await chooseHost()
    const contextUrl = repoUrl(host, org, context)
    let gitProvider = await getProvider()
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
    // A join takes the organization's agents; declaring one is a change to
    // its rness.json, made from inside the workspace (spec 0011 §3.2).
    if (joining && agentFlags.length > 0) {
      process.stderr.write(
        `${org}/${context} exists: --agent only applies to a new workspace; after joining, run ${rnessCommand()} sync${agentFlags.map((a) => ` --agent ${a}`).join('')}\n`
      )
      return 2
    }
    if (joining)
      ui.line(
        'found',
        `${org}/${context} - joining`,
        `${org} has a workspace - joining it`
      )
    else
      ui.line(
        'not found',
        `${org}/${context} (or not visible to you) - starting a new workspace`,
        `${org} has no workspace yet (or none you can see) - starting one`
      )

    // Joining: the catalogue is read from a clone staged outside the target,
    // so the picker can offer it before anything is written there.
    let catalogue: Manifest = {
      contract: 1,
      provider: chosenProvider,
      org,
      agents: null,
      boards: null,
      repos: {},
      scopes: {},
    }
    const staged = async (): Promise<string> => {
      staging ??= await mkdtemp(join(tmpdir(), 'rness-join-'))
      return join(staging, '.rness')
    }
    if (joining) {
      const stagedDir = await staged()
      await ui.step(
        {
          doing: `cloning  ${org}/${context}`,
          sentence: `Reading the catalogue of ${org}`,
          git: true,
        },
        () =>
          clone(contextUrl, stagedDir, gitProvider.credentialsFor(contextUrl))
      )
      // Validates that the clone is a workspace context: throws on a
      // malformed or absent rness.json.
      catalogue = await loadManifest(await staged())
      // The catalogue names the provider; the clone above had only GitHub.
      if (deps.provider === undefined)
        gitProvider = await openProvider(catalogue, {
          ...(opts.githubApi === undefined ? {} : { apiBase: opts.githubApi }),
          ...(opts.gitlabApi === undefined
            ? {}
            : { gitlabApi: opts.gitlabApi }),
        })
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
            `${[...sshWorkspaceLines(access.reason, hostSpec), ...insteadOfLines(hostSpec)].join('\n')}\n`
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
        providerName: chosenProvider,
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
    // A new workspace's agents: named, or asked with the other questions,
    // before the first write. They do not count as the confirmation.
    if (!joining) {
      if (agentFlags.length > 0) catalogue.agents = agentFlags
      else if (interactive) {
        const answer = await askAgents(await prompts())
        if (answer === null) return cancelled(ui)
        catalogue.agents = answer
      }
    }
    if (interactive && !prompted) {
      const p = await prompts()
      const ok = await p.confirm({
        message: `Create workspace ${org} in ./${shown}?`,
      })
      if (p.isCancel(ok) || ok !== true) return cancelled(ui)
    }

    const rnessDir = join(root, '.rness')
    const install = (): Promise<void> =>
      installContext({ ui, pm, rnessDir, skip: opts.skipInstall === true })

    if (joining) {
      await mkdir(root, { recursive: true })
      await placeContext(
        await staged(),
        rnessDir,
        contextUrl,
        gitProvider.credentialsFor(contextUrl)
      )
      ui.line('cloned', `${shown}/.rness (joined ${org})`)
      // The workspace declares the manager it installs with (`packageManager`,
      // else the lockfile it committed). Joining adopts it: installing with
      // the one that happened to launch `create` would drop a second lockfile
      // beside the committed one (spec 0009 §5). `--pm` still wins.
      if (opts.pm === undefined) pm = await workspacePackageManager(rnessDir)
      // The pin is the team's, in the repository just cloned. Joining aligns
      // on it and says nothing: moving an organization's version is a
      // maintainer's act, not something asked of whoever arrives
      // (spec 0008 §2).
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
      const code = await syncBlocks(
        ui,
        root,
        shown,
        () => syncCommand({ yes: true, cwd: root }),
        sshWorks()
      )
      if (code !== 0) return code
      // What is left to do, never what just scrolled past: the `cloned` lines
      // are right above (spec 0009 §6).
      const cloned = await clonesIn(root, chosenProvider)
      const remaining = Object.keys(catalogue.repos).filter(
        (name) => !cloned.has(name)
      )
      const rness = rnessCommand()
      const next = [
        `cd ${shown}`,
        // The comment above its command, as the new-workspace note does: a
        // line that wraps in a narrow terminal is a line nobody reads.
        ...(remaining.length > 0
          ? [
              `# clone the catalogue repositories you did not pick: ${remaining.join(', ')}`,
              `${rness} sync --all`,
            ]
          : []),
        ...failures.map(
          (f) => `${rness} add ${f.spec}   # failed: ${f.message}`
        ),
      ]
      if (ui.session) ui.note('Next steps', next)
      else process.stdout.write(`\n${next.map((l) => `  ${l}`).join('\n')}\n`)
      ui.outro(`You joined ${org}: your workspace is in ${shown}/`)
      return failures.length > 0 ? 1 : 0
    }

    // Phase 1 — creating the workspace itself; a failure is rolled back. Past
    // it the workspace exists and is worth keeping, whatever a repository
    // does next.
    const built = await buildContext({
      ui,
      root,
      shown,
      manifest: catalogue,
      pm,
      skipInstall: opts.skipInstall === true,
      kind: 'new workspace',
    })
    if (!built) return 1

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

    await commitContext({ ui, rnessDir, shown })

    const code = await syncBlocks(
      ui,
      root,
      shown,
      () => syncCommand({ yes: true, cwd: root }),
      sshWorks()
    )
    if (code !== 0) return code

    // Teammates join once <org>/.rness is on GitHub. Logged in, in a
    // terminal, rness offers to put it there; otherwise it says how, with
    // nothing but git (spec 0004 §3b).
    const name = org
    const published = interactive
      ? await publishContext({
          ui,
          prompts: await prompts(),
          provider: gitProvider,
          host: hostSpec,
          org: name,
          context,
          rnessDir,
          url: contextUrl,
        })
      : false
    if (published === null) return cancelled(ui)
    const rness = rnessCommand()
    const next = [
      `cd ${shown}/.rness`,
      // What was asked for and did not happen, as the command that retries
      // it — the workspace is complete otherwise.
      ...failures.map((f) => `${rness} add ${f.spec}   # failed: ${f.message}`),
      ...(published
        ? []
        : manualSteps(chosenProvider, org, context, contextUrl)),
      // How this command was launched (npm when rness was typed directly),
      // whatever --pm installed with.
      `# then, for every teammate: ${joinCommand(chosenProvider, org)}`,
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
