import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'
import { exists } from './fs.ts'
import { commitAll, init } from './git.ts'
import { writeManifest } from './manifest.ts'
import { hasLockfile } from './pinned.ts'
import {
  type PackageManager,
  installDependencies,
  packageManagerVersion,
  rnessCommand,
} from './pm.ts'
import { copyScaffold } from './scaffold-copy.ts'
import { CREATE_SUBJECT, scaffoldMessage } from './scaffold-git.ts'
import type { Manifest } from './types.ts'
import type { Ui } from './ui.ts'
import { findWorkspace } from './workspace.ts'

/**
 * The steps `create` takes to bring a workspace into being, shared by the
 * organization path and the blank one (spec 0012): where it may go, the
 * context scaffolded and installed, then committed.
 */

export async function isEmptyDir(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0
}

export async function insideWorkspace(dir: string): Promise<boolean> {
  try {
    await findWorkspace(dir)
    return true
  } catch {
    return false
  }
}

/**
 * Why `root` cannot receive a new workspace, as the one-line message the
 * guards print; `null` when it can. Both ends of the operation count: the
 * directory create runs in, and the parent of the target — either one inside
 * a workspace would nest a second `.rness` under the first.
 */
export async function targetProblem(
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
      return `${shown} holds an rness workspace whose dependencies are not installed; cd ${shown}/.rness && ${pm} install, then ${rnessCommand()} sync`
    return `${shown} already holds an rness workspace (.rness/); run ${rnessCommand()} add inside it to add repositories`
  }
  if (!(await stat(root)).isDirectory()) return `${shown} is not a directory`
  if (!(await isEmptyDir(root))) return `${shown} is not empty`
  return null
}

/** Install the dependencies of `.rness/`, or say how to when `skip`. */
export async function installContext(input: {
  ui: Ui
  pm: PackageManager
  rnessDir: string
  skip: boolean
}): Promise<void> {
  const { ui, pm, rnessDir } = input
  if (input.skip) {
    // Naming the manager says what to run by hand — and, on a join, which
    // one the workspace declared (spec 0009 §5).
    ui.line('skipped', `install with ${pm} (--skip-install)`)
    return
  }
  // A joined workspace carries the lockfile its clone brought, so the
  // install is frozen and leaves the working tree clean (spec 0008 §2). A
  // new workspace has no lockfile yet and resolves freely.
  const frozen = await hasLockfile(rnessDir, pm)
  await ui.step(
    { doing: `installing dependencies with ${pm}` },
    () => installDependencies(pm, rnessDir, { frozen }),
    () => ['installed', `dependencies with ${pm}`]
  )
}

/**
 * Create `root` and a new `.rness/` in it: the scaffold, `manifest`, the
 * install. False when a step failed: the error is reported and everything
 * this call wrote is removed, so the retry the message asks for is not
 * refused.
 */
export async function buildContext(input: {
  ui: Ui
  root: string
  shown: string
  manifest: Manifest
  pm: PackageManager
  skipInstall: boolean
  /** What the `created` line calls it: `new workspace`, `blank workspace`. */
  kind: string
}): Promise<boolean> {
  const { ui, root, shown, pm } = input
  const rnessDir = join(root, '.rness')
  // Resolved before anything touches the filesystem: a missing package
  // manager binary must not leave an empty `<shown>/` behind.
  const pmVersion = await packageManagerVersion(pm)
  await mkdir(root, { recursive: true })
  try {
    await copyScaffold(rnessDir, {
      version: VERSION,
      packageManager: `${pm}@${pmVersion}`,
    })
    await writeManifest(rnessDir, input.manifest)
    ui.line('created', `${shown}/.rness (${input.kind})`)
    await installContext({ ui, pm, rnessDir, skip: input.skipInstall })
    return true
  } catch (e) {
    // Report the cause before the consequence: the original error first,
    // then the rollback note. Everything under `rnessDir` was written by
    // this call, so removing it is safe; `root` goes too when it is left
    // empty (this call created it, or found it empty), or the retry the
    // message asks for would be refused with "<shown> is not empty". A
    // failing `rm` is swallowed rather than thrown, since it must never
    // mask the original error.
    reportError(e)
    await rm(rnessDir, { recursive: true, force: true }).catch(() => undefined)
    if (await isEmptyDir(root).catch(() => false))
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    process.stderr.write(
      `removed ${shown}/.rness after the failure; fix it and retry\n`
    )
    return false
  }
}

/** Make `.rness/` a repository with one commit; a failure is a warning. */
export async function commitContext(input: {
  ui: Ui
  rnessDir: string
  shown: string
}): Promise<void> {
  const { ui, rnessDir, shown } = input
  await init(rnessDir)
  try {
    // The first scaffold commit: the base of every later scaffold merge
    // (spec 0013 §1).
    await commitAll(rnessDir, scaffoldMessage(CREATE_SUBJECT, VERSION))
    ui.line('committed', `${shown}/.rness`)
  } catch (e) {
    ui.warn(
      `${e instanceof Error ? e.message : String(e)} — commit ${shown}/.rness yourself`
    )
  }
}
