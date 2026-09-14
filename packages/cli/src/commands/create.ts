import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

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

/** Run `sync --yes` through the copy just installed in `.rness/` when there is one, else in place. */
async function syncPinned(root: string): Promise<number> {
  const pinned = join(
    root,
    '.rness',
    'node_modules',
    '@rness',
    'cli',
    'dist',
    'bin',
    'rness.js'
  )
  if (!(await exists(pinned))) return syncCommand({ yes: true, cwd: root })
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [pinned, 'sync', '--yes'],
      {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      }
    )
    process.stdout.write(stdout)
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
    try {
      await findWorkspace(cwd)
      process.stderr.write(
        'already inside an rness workspace; create runs from outside one\n'
      )
      return 1
    } catch {
      // not inside a workspace: expected
    }
    const root = resolve(cwd, opts.dir ?? org)
    const shown = relative(cwd, root) || '.'
    if ((await exists(root)) && !(await isEmptyDir(root))) {
      process.stderr.write(`${shown} is not empty\n`)
      return 1
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

    await mkdir(root, { recursive: true })
    const rnessDir = join(root, '.rness')

    if (joining) {
      await clone(contextUrl, rnessDir)
      await loadManifest(rnessDir)
      process.stdout.write(`cloned   ${shown}/.rness (joined ${org})\n`)
      if (opts.skipInstall === true)
        process.stdout.write('skipped  install (--skip-install)\n')
      else {
        await installDependencies(pm, rnessDir)
        process.stdout.write(`installed dependencies with ${pm}\n`)
      }
      await mkdir(join(root, 'org'), { recursive: true })
      return syncPinned(root)
    }

    const pmVersion = await packageManagerVersion(pm)
    await copyScaffold(rnessDir, {
      version: VERSION,
      packageManager: `${pm}@${pmVersion}`,
    })
    let manifest: Manifest = { contract: 1, org, repos: {}, scopes: {} }
    await writeManifest(rnessDir, manifest)
    process.stdout.write(`created  ${shown}/.rness (new workspace)\n`)
    if (opts.skipInstall === true)
      process.stdout.write('skipped  install (--skip-install)\n')
    else {
      await installDependencies(pm, rnessDir)
      process.stdout.write(`installed dependencies with ${pm}\n`)
    }
    await init(rnessDir)
    try {
      await commitAll(rnessDir, 'chore: rness workspace context')
      process.stdout.write(`committed ${shown}/.rness\n`)
    } catch (e) {
      process.stderr.write(
        `warning: ${e instanceof Error ? e.message : String(e)} — commit ${shown}/.rness yourself\n`
      )
    }
    await mkdir(join(root, 'org'), { recursive: true })

    let repos = (opts.repos ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (opts.repos === undefined && opts.yes !== true) {
      const { text } = await import('@clack/prompts')
      const answer = await text({
        message:
          'Repositories to add now (owner/repo, comma-separated; empty for none)',
        defaultValue: '',
      })
      // clack's `isCancel` narrows only the unique cancel symbol, not the
      // broader `symbol` half of `text()`'s `string | symbol` return type, so
      // a `typeof` check is what actually narrows here.
      if (typeof answer === 'string')
        repos = answer
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
    }
    for (const spec of repos) {
      const result = await addRepository({
        root,
        rnessDir,
        manifest,
        spec,
        org,
        host,
        scopes: [],
      })
      manifest = result.manifest
      process.stdout.write(
        `${result.action === 'cloned' ? 'cloned  ' : 'adopted '} org/${result.name}\ndeclared scope ${result.name} (org/${result.name})\n`
      )
    }

    const code = await syncPinned(root)
    if (code !== 0) return code

    const gh = await ghAvailable()
    process.stdout.write(
      [
        '',
        `Workspace \`${org}\` is ready in ${shown}/.`,
        '',
        'Next:',
        `  cd ${shown}/.rness`,
        gh
          ? `  gh repo create ${org}/.rness --private --source . --push`
          : `  git remote add origin ${contextUrl} && git push -u origin main`,
        `  # then, for every teammate: npm create rness ${org}`,
        '',
      ].join('\n')
    )
    return 0
  } catch (e) {
    return reportError(e)
  }
}
