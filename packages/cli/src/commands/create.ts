import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { readPinnedCli } from '../core/delegate.ts'
import { exists } from '../core/fs.ts'
import { clone, commitAll, init } from '../core/git.ts'
import {
  DEFAULT_GITHUB_API,
  MAX_PAGES,
  PER_PAGE,
  listRepositories,
} from '../core/github.ts'
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
import { DEFAULT_HOST, SSH_HOST, probeRemote, repoUrl } from '../core/remote.ts'
import { addRepository } from '../core/repos.ts'
import { copyScaffold } from '../core/scaffold-copy.ts'
import {
  type Prompts,
  type Terminal,
  defaultTerminal,
} from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'
import { syncCommand } from './sync.ts'

const execFileP = promisify(execFile)

export interface CreateOptions {
  /** The GitHub organization, exact name (`github.com/<org>`); prompted for when absent. */
  org?: string
  /** Comma-separated repositories for the workspace (`<repo>` or `<owner>/<repo>`): catalogue entries are cloned, others added. */
  repos?: string
  pm?: string
  ssh?: boolean
  /** Internal: remote base. */
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

const defaultDeps: CreateDeps = defaultTerminal

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
function cancelled(): number {
  process.stderr.write('cancelled\n')
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
  apiBase: string
  prompts: Prompts
  catalogue: Readonly<Record<string, unknown>>
}): Promise<{ picked: string[]; prompted: boolean } | null> {
  const { org, prompts } = input
  const token =
    process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'] || undefined
  process.stdout.write(`listing  ${org} repositories…\n`)
  let listed: { name: string; private: boolean; archived: boolean }[] = []
  let failed = false
  try {
    const listing = await listRepositories(org, {
      token,
      apiBase: input.apiBase,
    })
    listed = listing.repositories
    if (listing.owner === 'user')
      process.stdout.write(
        `only public repositories of ${org} are listed; add private ones later with rness add <repo>\n`
      )
    else if (token === undefined)
      process.stdout.write(
        'only public repositories are listed; set GITHUB_TOKEN to include private ones, or add them later with rness add <repo>\n'
      )
    if (listing.truncated)
      process.stdout.write(
        `listed the first ${MAX_PAGES * PER_PAGE} repositories of ${org}\n`
      )
  } catch (e) {
    failed = true
    process.stderr.write(
      `warning: ${firstLine(e instanceof Error ? e.message : String(e))}\n`
    )
  }
  const inCatalogue = (name: string): boolean =>
    Object.hasOwn(input.catalogue, name)
  // Archived repositories and the context repository itself are never
  // candidates. GitHub names are case-insensitive, so a name that differs
  // from `NAME` only by case is offered — and declared — in lowercase, as
  // `rness add` would; any other name is shown but cannot be picked yet.
  const byLabel = (a: { label: string }, b: { label: string }): number =>
    a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })
  const candidates = listed.filter(
    (r) => !r.archived && r.name.toLowerCase() !== '.rness'
  )
  const hint = (isPrivate: boolean, catalogued: boolean): string | null =>
    [isPrivate ? 'private' : null, catalogued ? 'in .rness' : null]
      .filter((h) => h !== null)
      .join(' · ') || null
  const declarable = candidates
    .filter((r) => NAME.test(r.name.toLowerCase()))
    .map((r) => {
      const value = r.name.toLowerCase()
      const h = hint(r.private, inCatalogue(value))
      return { value, label: r.name, ...(h === null ? {} : { hint: h }) }
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
    process.stdout.write(
      `names rness cannot declare yet (struck through): ${names.join(', ')}${more}\n`
    )
  }
  if (declarable.length === 0) {
    // After a failed listing its own warning already says why.
    if (!failed)
      process.stderr.write(`warning: no repositories to list for ${org}\n`)
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
}): Promise<Failure[]> {
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
        await clone(entry.url, join(input.root, 'org', name))
        process.stdout.write(`cloned   org/${name}\n`)
        continue
      }
      const result = await addRepository({
        root: input.root,
        rnessDir: input.rnessDir,
        manifest,
        spec,
        org: input.org,
        host: input.host,
        scopes: [],
      })
      manifest = result.manifest
      process.stdout.write(
        `${result.action === 'cloned' ? 'cloned  ' : 'adopted '} org/${result.name}\ndeclared scope ${result.name} (org/${result.name})\n`
      )
    } catch (e) {
      const message = firstLine(e instanceof Error ? e.message : String(e))
      process.stderr.write(`${spec}: ${message}\n`)
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
  url: string
): Promise<void> {
  try {
    await rename(staged, rnessDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await clone(url, rnessDir)
  }
}

/** Run `sync --yes` through the copy installed in `.rness/` when there is one, else in place. */
async function syncPinned(root: string, shown: string): Promise<number> {
  const rnessDir = join(root, '.rness')
  const installed = await readPinnedCli(rnessDir)
  if (installed === null) return syncCommand({ yes: true, cwd: root })
  // Installed but unusable: the launcher's own code must never stand in for a
  // pinned copy (spec 0003 §2.2), so say what is missing and stop.
  const pinned = join(installed.dir, ...installed.bin.split('/'))
  if (!(await exists(pinned))) {
    process.stderr.write(
      `@rness/cli in ${shown}/.rness is not installed correctly (missing ${installed.bin}); reinstall in .rness/\n`
    )
    return 1
  }
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [pinned, 'sync', '--yes'],
      {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      }
    )
    process.stdout.write(stdout)
    if (stderr !== '') process.stderr.write(stderr)
    return 0
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    if (err.stdout !== undefined && err.stdout !== '')
      process.stdout.write(err.stdout)
    if (err.stderr !== undefined && err.stderr !== '')
      process.stderr.write(err.stderr)
    return typeof err.code === 'number' ? err.code : 1
  }
}

/**
 * `rness create`: join the organization's `.rness` or start a new one in
 * `./<org>` (spec 0003 §2.1). `rness.json` is the organization's catalogue;
 * the workspace is the selection of it cloned into `org/`. Every prompt comes
 * before the first write, so a cancel leaves nothing behind.
 */
export async function createCommand(
  opts: CreateOptions,
  deps: CreateDeps = defaultDeps
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  if (opts.template !== undefined) {
    process.stderr.write('--template is reserved for a later version\n')
    return 2
  }
  if (opts.pm !== undefined && !isPackageManager(opts.pm)) {
    process.stderr.write(`--pm must be one of ${PACKAGE_MANAGERS.join(', ')}\n`)
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
  const host = opts.host ?? (opts.ssh === true ? SSH_HOST : DEFAULT_HOST)
  const interactive = opts.yes !== true && deps.isTty()
  let loaded: Prompts | undefined
  const prompts = async (): Promise<Prompts> =>
    (loaded ??= await deps.prompts())
  let staging: string | undefined
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
    if (org === undefined) {
      if (!interactive) {
        process.stderr.write(
          'rness create needs --org <name> without a prompt\n'
        )
        return 2
      }
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
      if (p.isCancel(answer) || typeof answer !== 'string') return cancelled()
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
    if (opts.yes !== true && !deps.isTty()) {
      process.stderr.write(
        'rness create writes files; pass --yes to run without a prompt\n'
      )
      return 2
    }

    const contextUrl = repoUrl(host, org, '.rness')
    const probe = await probeRemote(contextUrl)
    if (probe.kind === 'error') {
      process.stderr.write(`${probe.message}\n`)
      return 1
    }
    const joining = probe.kind === 'found'
    process.stdout.write(
      joining
        ? `found    ${org}/.rness — joining\n`
        : `not found ${org}/.rness (or not visible to you) — starting a new workspace\n`
    )

    // Joining: the catalogue is read from a clone staged outside the target,
    // so the picker can offer it before anything is written there.
    let catalogue: Manifest = { contract: 1, org, repos: {}, scopes: {} }
    const staged = async (): Promise<string> => {
      staging ??= await mkdtemp(join(tmpdir(), 'rness-join-'))
      return join(staging, '.rness')
    }
    if (joining) {
      await clone(contextUrl, await staged())
      // Validates that the clone is a workspace context: throws on a
      // malformed or absent rness.json.
      catalogue = await loadManifest(await staged())
    }

    let specs: string[]
    if (opts.repos !== undefined) specs = splitSpecs(opts.repos)
    else if (interactive) {
      const result = await pickRepositories({
        org,
        apiBase: opts.githubApi ?? DEFAULT_GITHUB_API,
        prompts: await prompts(),
        catalogue: catalogue.repos,
      })
      if (result === null) return cancelled()
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
      if (p.isCancel(ok) || ok !== true) return cancelled()
    }

    const rnessDir = join(root, '.rness')

    if (joining) {
      await mkdir(root, { recursive: true })
      await placeContext(await staged(), rnessDir, contextUrl)
      process.stdout.write(`cloned   ${shown}/.rness (joined ${org})\n`)
      if (opts.skipInstall === true)
        process.stdout.write('skipped  install (--skip-install)\n')
      else {
        await installDependencies(pm, rnessDir)
        process.stdout.write(`installed dependencies with ${pm}\n`)
      }
      await mkdir(join(root, 'org'), { recursive: true })
      const failures = await cloneSelection({
        root,
        rnessDir,
        manifest: catalogue,
        org,
        host,
        specs,
      })
      const code = await syncPinned(root, shown)
      if (code !== 0) return code
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
      process.stdout.write(`created  ${shown}/.rness (new workspace)\n`)
      if (opts.skipInstall === true)
        process.stdout.write('skipped  install (--skip-install)\n')
      else {
        await installDependencies(pm, rnessDir)
        process.stdout.write(`installed dependencies with ${pm}\n`)
      }
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
    })

    await init(rnessDir)
    try {
      await commitAll(rnessDir, 'chore: rness workspace context')
      process.stdout.write(`committed ${shown}/.rness\n`)
    } catch (e) {
      process.stderr.write(
        `warning: ${e instanceof Error ? e.message : String(e)} — commit ${shown}/.rness yourself\n`
      )
    }

    const code = await syncPinned(root, shown)
    if (code !== 0) return code

    const gh = await ghAvailable()
    process.stdout.write(
      [
        '',
        `Workspace for \`${org}\` is ready in ${shown}/.`,
        '',
        'Next:',
        `  cd ${shown}/.rness`,
        // What was asked for and did not happen, as the command that retries
        // it — the workspace is complete otherwise.
        ...failures.map(
          (f) => `  rness add ${f.spec}   # failed: ${f.message}`
        ),
        gh
          ? `  gh repo create ${org}/.rness --private --source . --push`
          : `  git remote add origin ${contextUrl} && git push -u origin main`,
        `  # then, for every teammate: npm create rness -- --org ${org}`,
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
