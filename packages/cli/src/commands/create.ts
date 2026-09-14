import { execFile } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { readPinnedCli } from '../core/delegate.ts'
import { exists } from '../core/fs.ts'
import { clone, commitAll, init } from '../core/git.ts'
import { NAME, loadManifest, writeManifest } from '../core/manifest.ts'
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
import type { Manifest } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'
import { syncCommand } from './sync.ts'

const execFileP = promisify(execFile)

export interface CreateOptions {
  dir?: string
  /** Comma-separated repositories to add right away (`<repo>` or `<owner>/<repo>`). */
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
}

function isTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

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

interface Failure {
  spec: string
  message: string
}

/**
 * Add each repository, in order. A failure is reported on one line and the
 * next entry still runs: a typo in `--repos` must not cost the workspace the
 * repositories that do exist, nor the commit and sync that follow.
 */
async function addRepositories(input: {
  root: string
  rnessDir: string
  manifest: Manifest
  org: string
  host: string
  specs: readonly string[]
}): Promise<Failure[]> {
  let manifest = input.manifest
  const failures: Failure[] = []
  for (const spec of input.specs) {
    try {
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

/** `rness create <org>`: join the organisation's `.rness` or start a new one (spec 0003 §2.1). */
export async function createCommand(
  org: string,
  opts: CreateOptions
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  if (opts.template !== undefined) {
    process.stderr.write('--template is reserved for a later version\n')
    return 2
  }
  if (!NAME.test(org)) {
    process.stderr.write(`organisation name "${org}" is not [a-z0-9-]\n`)
    return 2
  }
  if (opts.pm !== undefined && !isPackageManager(opts.pm)) {
    process.stderr.write(`--pm must be one of ${PACKAGE_MANAGERS.join(', ')}\n`)
    return 2
  }
  const pm: PackageManager =
    opts.pm !== undefined && isPackageManager(opts.pm)
      ? opts.pm
      : detectPackageManager()
  const host = opts.host ?? (opts.ssh === true ? SSH_HOST : DEFAULT_HOST)
  try {
    const root = resolve(cwd, opts.dir ?? org)
    const shown = relative(cwd, root) || '.'
    // Both ends of the operation: the directory create runs in, and the parent
    // of the target `--dir` points at. Either one inside a workspace would
    // nest a second `.rness` under the first.
    if (
      (await insideWorkspace(cwd)) ||
      (await insideWorkspace(dirname(root)))
    ) {
      process.stderr.write(
        'already inside an rness workspace; create runs from outside one\n'
      )
      return 1
    }
    if (await exists(root)) {
      if (await exists(join(root, '.rness', 'rness.json'))) {
        // A join whose install failed leaves exactly this: a context clone and
        // no dependencies. Re-running create cannot help — point at the
        // install that finishes the job instead of at `rness add`.
        if (!(await exists(join(root, '.rness', 'node_modules')))) {
          process.stderr.write(
            `${shown} holds an rness workspace whose dependencies are not installed; cd ${shown}/.rness && ${pm} install, then rness sync\n`
          )
          return 1
        }
        process.stderr.write(
          `${shown} already holds an rness workspace (.rness/); run rness add inside it to add repositories\n`
        )
        return 1
      }
      if (!(await isEmptyDir(root))) {
        process.stderr.write(`${shown} is not empty\n`)
        return 1
      }
    }
    if (opts.yes !== true && !isTty()) {
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

    if (opts.yes !== true) {
      const { confirm, isCancel } = await import('@clack/prompts')
      const message = joining
        ? `Join organisation \`${org}\`: clone ${contextUrl} into ${shown}/.rness and sync its repositories?`
        : `No ${contextUrl} found (or no access to it). Start a new workspace \`${org}\` in ${shown}/?`
      const ok = await confirm({ message })
      if (isCancel(ok) || ok !== true) {
        process.stderr.write('cancelled\n')
        return 1
      }
    }

    const rnessDir = join(root, '.rness')

    if (joining) {
      await mkdir(root, { recursive: true })
      await clone(contextUrl, rnessDir)
      // Validates that the clone is a workspace context: throws on a
      // malformed or absent rness.json.
      const manifest = await loadManifest(rnessDir)
      process.stdout.write(`cloned   ${shown}/.rness (joined ${org})\n`)
      if (opts.skipInstall === true)
        process.stdout.write('skipped  install (--skip-install)\n')
      else {
        await installDependencies(pm, rnessDir)
        process.stdout.write(`installed dependencies with ${pm}\n`)
      }
      await mkdir(join(root, 'org'), { recursive: true })
      // `--repos` only: the organisation's manifest is what a join follows, so
      // nothing is prompted for here. Each addition edits the cloned
      // `rness.json`, exactly as `rness add` would leave it.
      const failures = await addRepositories({
        root,
        rnessDir,
        manifest,
        org,
        host,
        specs: splitSpecs(opts.repos ?? ''),
      })
      const code = await syncPinned(root, shown)
      if (code !== 0) return code
      return failures.length > 0 ? 1 : 0
    }

    // Resolved before anything touches the filesystem: a missing package
    // manager binary must not leave an empty `<shown>/` behind.
    const pmVersion = await packageManagerVersion(pm)
    await mkdir(root, { recursive: true })
    const manifest: Manifest = { contract: 1, org, repos: {}, scopes: {} }
    // Phase 1 — creating the workspace itself. Only these steps are rolled
    // back: past them the workspace exists and is worth keeping, whatever a
    // repository does next.
    try {
      await copyScaffold(rnessDir, {
        version: VERSION,
        packageManager: `${pm}@${pmVersion}`,
      })
      await writeManifest(rnessDir, manifest)
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
      // message asks for would be refused with "<shown> is not empty" — but
      // never the directory the command was run from (`--dir .`), whose
      // removal would pull the ground from under the user's shell. A failing
      // `rm` is swallowed rather than thrown, since it must never mask the
      // original error.
      reportError(e)
      await rm(rnessDir, { recursive: true, force: true }).catch(
        () => undefined
      )
      if (root !== resolve(cwd) && (await isEmptyDir(root).catch(() => false)))
        await rm(root, { recursive: true, force: true }).catch(() => undefined)
      process.stderr.write(
        `removed ${shown}/.rness after the failure; fix it and retry\n`
      )
      return 1
    }

    // Phase 2 — the repositories. Nothing here is rolled back.
    await mkdir(join(root, 'org'), { recursive: true })
    let specs = splitSpecs(opts.repos ?? '')
    if (opts.repos === undefined && opts.yes !== true) {
      const { isCancel, text } = await import('@clack/prompts')
      const answer = await text({
        message:
          'Repositories to add now (owner/repo, comma-separated; empty for none)',
        defaultValue: '',
      })
      if (isCancel(answer)) {
        process.stderr.write('cancelled\n')
        return 1
      }
      // `isCancel` narrows only the unique cancel symbol, not the broader
      // `symbol` half of `text()`'s `string | symbol` return type, so a
      // `typeof` check is what narrows the rest.
      if (typeof answer === 'string') specs = splitSpecs(answer)
    }
    const failures = await addRepositories({
      root,
      rnessDir,
      manifest,
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
        `Workspace \`${org}\` is ready in ${shown}/.`,
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
        `  # then, for every teammate: npm create rness ${org}`,
        '',
      ].join('\n')
    )
    return failures.length > 0 ? 1 : 0
  } catch (e) {
    return reportError(e)
  }
}
