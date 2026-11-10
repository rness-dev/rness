import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { promisify } from 'node:util'

import { writtenFiles } from '../core/agent-targets.ts'
import { migrateBoards } from '../core/board-migration.ts'
import { readPinnedCli } from '../core/delegate.ts'
import { exists, writeFileAtomic } from '../core/fs.ts'
import { changedPaths, isClean } from '../core/git.ts'
import {
  type Contract1,
  loadManifest,
  readContract1,
  repositories,
  writeManifest,
} from '../core/manifest.ts'
import {
  EXACT_VERSION,
  compareVersions,
  readPin,
  workspacePackageManager,
  writePin,
} from '../core/pinned.ts'
import {
  type PackageManager,
  installDependencies,
  packageManagerVersion,
  rnessCommand,
} from '../core/pm.ts'
import { renderScaffold } from '../core/scaffold-copy.ts'
import {
  buildScaffoldCommit,
  commitUpgrade,
  findScaffoldBase,
  isRepository,
  mergeInProgress,
  mergeScaffold,
  pendingScaffoldMerge,
  stageFile,
  withoutRedundantKeeps,
} from '../core/scaffold-git.ts'
import { scaffoldDir } from '../core/scaffold.ts'
import { status } from '../core/style.ts'
import { syncBlocks } from '../core/sync-blocks.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import type { Manifest } from '../core/types.ts'
import { type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { VERSION } from '../version.ts'

const execFileP = promisify(execFile)

export interface UpgradeOptions {
  yes?: boolean
  /** Internal (tests): directory to resolve from. */
  cwd?: string
}

const NOTES = 'https://github.com/rness-dev/rness/tree/main/packages/cli#readme'

/** `npm view`: npm ships with Node and follows the user's registry configuration. */
async function latestVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'npm',
      ['view', '@rness/cli@latest', 'version'],
      { timeout: 30_000 }
    )
    const version = stdout.trim()
    return EXACT_VERSION.test(version) ? version : null
  } catch {
    return null
  }
}

/** What upgrade takes from outside; tests replace where the scaffold comes from. */
export interface UpgradeDeps {
  /** The directory holding `version`'s scaffold, and how to clean it up. */
  scaffoldFor?: (
    version: string,
    rnessDir: string
  ) => Promise<{ dir: string; cleanup?: () => Promise<void> }>
  /** The first release reading contract 2 (default `CONTRACT_2_SINCE`). */
  contract2Since?: string
}

/**
 * The first @rness/cli reading `rness.json` contract 2 (ADR 0012), and
 * nothing else: `upgrade` rewrites a contract-1 file only toward it or a
 * later release, its pre-releases included.
 */
const CONTRACT_2_SINCE = '0.25.0'

/**
 * Where `version`'s scaffold is read from (spec 0013 §2): the running copy
 * when it is that version, the copy installed in `.rness` when it is (the
 * pin already moved by pull request), else the published package, through
 * `npm pack` — npm follows the user's registry configuration.
 */
async function scaffoldFor(
  version: string,
  rnessDir: string
): Promise<{ dir: string; cleanup?: () => Promise<void> }> {
  if (version === VERSION) return { dir: scaffoldDir() }
  const installed = await readPinnedCli(rnessDir)
  const inside = installed === null ? null : join(installed.dir, 'scaffold')
  if (
    installed?.version === version &&
    inside !== null &&
    (await exists(join(inside, 'package.json')))
  )
    return { dir: inside }
  const scratch = await mkdtemp(join(tmpdir(), 'rness-pack-'))
  const cleanup = () => rm(scratch, { recursive: true, force: true })
  try {
    const { stdout } = await execFileP(
      'npm',
      [
        'pack',
        `@rness/cli@${version}`,
        '--pack-destination',
        scratch,
        '--silent',
      ],
      { timeout: 60_000 }
    )
    const tarball = stdout.trim().split('\n').at(-1) ?? ''
    await execFileP('tar', ['-xzf', join(scratch, tarball), '-C', scratch])
    return { dir: join(scratch, 'package', 'scaffold'), cleanup }
  } catch (e) {
    await cleanup()
    throw new Error(
      `cannot get the @rness/cli ${version} scaffold (npm pack): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      { cause: e }
    )
  }
}

/** The `packageManager` line the workspace declares, kept through every merge. */
async function declaredManager(
  rnessDir: string,
  pm: PackageManager
): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(join(rnessDir, 'package.json'), 'utf8')
    ) as { packageManager?: unknown }
    if (typeof pkg.packageManager === 'string') return pkg.packageManager
  } catch {
    // the install below reports an unreadable package.json
  }
  return `${pm}@${await packageManagerVersion(pm)}`
}

/**
 * `rness.json` as text and the contract it names; null when it cannot be
 * read as JSON: the new copy's sync says what is wrong with it.
 */
async function readContractOf(
  rnessDir: string
): Promise<{ raw: string; contract: unknown } | null> {
  try {
    const raw = await readFile(join(rnessDir, 'rness.json'), 'utf8')
    const data = JSON.parse(raw) as { contract?: unknown } | null
    return { raw, contract: data?.contract }
  } catch {
    return null
  }
}

/**
 * A `rness.json` of contract 1, for this command alone (ADR 0012, spec 0038
 * §7, §11): read as 0.24.0 read it, shaped as contract 2, the README
 * declarations its boards would leave in two places found; every line that
 * stops the rewrite at once. A file 0.24.0 refused gives its line too, as
 * does a former key of boards beside another: the team's CLI refuses them
 * already. An error that is no line of `rness.json` is thrown.
 */
async function checkFormer(rnessDir: string, raw: string): Promise<Contract1> {
  const refused = (e: unknown): Contract1 => {
    if (e instanceof Error && e.message.startsWith('rness.json: '))
      return { manifest: null, refusals: [e.message], notes: [] }
    throw e
  }
  let read: Contract1
  try {
    read = readContract1(raw)
  } catch (e) {
    return refused(e)
  }
  if (read.manifest === null) return read
  let conflicts: string[]
  try {
    conflicts = (await migrateBoards(rnessDir, read.manifest)).conflicts
  } catch (e) {
    return refused(e)
  }
  return conflicts.length === 0
    ? read
    : { manifest: null, refusals: conflicts, notes: [] }
}

/** A contract-1 file shaped as `readContract1` shapes it; null when it cannot be. */
function formerShape(raw: string): Manifest | null {
  try {
    return readContract1(raw).manifest
  } catch {
    return null
  }
}

/** A clone whose files sync writes changed: its path from `cwd`, and those files. */
interface CloneChanges {
  dir: string
  paths: string[]
}

/**
 * The clones where the sync changed a file it writes — never the developer's
 * other files. Other repositories, other review flows: `upgrade` commits
 * none of them, the next steps say what to add (spec 0013 §8).
 */
async function clonesToCommit(
  root: string,
  cwd: string,
  manifest: Manifest,
  files: readonly string[]
): Promise<CloneChanges[]> {
  const clones: CloneChanges[] = []
  for (const repo of repositories(manifest)) {
    const dir = join(root, ...repo.dir.split('/'))
    if (!(await exists(dir))) continue
    try {
      const paths = await changedPaths(dir, files)
      if (paths.length > 0)
        clones.push({ dir: relative(cwd, dir) || '.', paths })
    } catch {
      // Not a repository: sync reported it already.
    }
  }
  return clones
}

/**
 * The files the sync writes in a clone. The sync ran in the copy just
 * installed, whose release may write files this copy does not know — 0.13.0
 * named two of the plugin's six files after syncing with 0.14.0. That copy is
 * asked (`rness written-files`); a copy too old to answer leaves this copy's
 * own list.
 */
async function filesTheSyncWrites(
  root: string,
  rnessDir: string,
  manifest: Manifest
): Promise<string[]> {
  const own = writtenFiles(manifest)
  const pinned = await readPinnedCli(rnessDir)
  if (pinned === null) return own
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [join(pinned.dir, pinned.bin), 'written-files', '--cwd', root],
      {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1', RNESS_NO_INSTALL: '1' },
        timeout: 10_000,
      }
    )
    const theirs: unknown = JSON.parse(stdout)
    if (Array.isArray(theirs) && theirs.every((f) => typeof f === 'string'))
      return [...new Set([...own, ...theirs])]
  } catch {
    // An older copy has no such command: this copy's list is what there is.
  }
  return own
}

/**
 * The next steps: what `upgrade` did not do. A refused commit is the
 * maintainer's to make, and the command's exit code.
 */
function finish(
  ui: Ui,
  cwd: string,
  rnessDir: string,
  label: string,
  target: string,
  ending: {
    commit: 'committed' | 'nothing' | 'refused'
    clones: readonly CloneChanges[]
  }
): number {
  const rel = relative(cwd, rnessDir) || '.'
  const message = `chore: rness ${target}`
  const next: string[] = []
  if (ending.commit === 'committed') next.push(`git -C ${rel} push`)
  if (ending.commit === 'refused')
    next.push(`git -C ${rel} commit -m "${message}"`)
  for (const c of ending.clones)
    next.push(
      `git -C ${c.dir} add ${c.paths.join(' ')} && git -C ${c.dir} commit -m "${message}"`
    )
  if (ending.commit !== 'nothing')
    next.push('# teammates: git pull - the next rness command installs it')
  if (ui.session) {
    if (next.length > 0) ui.note('Next steps', next)
    ui.outro(`${label} runs @rness/cli ${target}`)
  } else
    process.stdout.write(
      [
        '',
        status('upgraded', `${label} to @rness/cli ${target}`),
        '',
        ...(next.length > 0
          ? ['Next:', ...next.map((line) => `  ${line}`), '']
          : []),
      ].join('\n')
    )
  return ending.commit === 'refused' ? 1 : 0
}

/**
 * `rness upgrade [version]`: move a workspace to another `@rness/cli` — merge
 * its scaffold, pin it in `.rness/package.json` (the one place the version is
 * written), install with the workspace's package manager, sync through the
 * new copy (spec 0006 §3), commit `.rness` (spec 0013 §8). Never delegated:
 * the pinned copy is what is being replaced.
 */
export async function upgradeCommand(
  version: string | undefined,
  opts: UpgradeOptions,
  terminal: Terminal = defaultTerminal,
  deps: UpgradeDeps = {}
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  if (version !== undefined && !EXACT_VERSION.test(version)) {
    process.stderr.write(
      `version "${version}" is not an exact version (for example 0.5.0)\n`
    )
    return 2
  }
  try {
    const ws = await findWorkspace(cwd)
    const label = `${basename(ws.root)}/.rness`
    const pin = await readPin(ws.rnessDir)
    if (pin === null) {
      process.stderr.write(
        `no @rness/cli entry in ${label}/package.json; add it to devDependencies, then run ${rnessCommand()} upgrade\n`
      )
      return 1
    }
    const interactive = opts.yes !== true
    if (interactive && !terminal.isTty()) {
      process.stderr.write(
        'rness upgrade installs and writes files; pass --yes to run without a prompt\n'
      )
      return 2
    }

    const ui = interactive ? await makeUi(terminal) : { ...plainUi }
    ui.intro(`Upgrade workspace ${basename(ws.root)}`)
    const target =
      version ??
      (await ui.step(
        { doing: 'asking   the registry for the latest release', quiet: true },
        () => latestVersion(),
        (v) => (v === null ? null : ['latest', `@rness/cli ${v}`])
      ))
    if (target === null) {
      process.stderr.write(
        `cannot reach the registry; name the version: ${rnessCommand()} upgrade <version>\n`
      )
      return 1
    }
    const installed = (await readPinnedCli(ws.rnessDir))?.version ?? null
    // The scaffold is merged with git (spec 0013 §2): `.rness` must be a
    // repository with nothing uncommitted.
    if (!(await isRepository(ws.rnessDir))) {
      process.stderr.write(`${label} is not a git repository\n`)
      return 1
    }
    // The scaffold merge of this target, staged by an upgrade whose sync
    // failed (0.24.0's on a contract-1 file, spec 0038 §11), nothing
    // unmerged: concluded by this run. The install that followed it may have
    // written the lockfile, so its changes are not told apart from the
    // merge's. Any other merge stops.
    const resuming = await pendingScaffoldMerge(ws.rnessDir, target)
    if (!resuming && (await mergeInProgress(ws.rnessDir))) {
      process.stderr.write(
        `${label} has a merge in progress; commit it, or abort it with git -C ${relative(cwd, ws.rnessDir) || '.'} merge --abort, then ${rnessCommand()} upgrade\n`
      )
      return 1
    }
    if (!resuming && !(await isClean(ws.rnessDir))) {
      process.stderr.write(
        `${label} has uncommitted changes; commit or stash them, then ${rnessCommand()} upgrade\n`
      )
      return 1
    }
    // rness.json is checked against the target before anything changes
    // (spec 0038 §11): stopped here, the earlier CLI still reads it while
    // the team fixes it by hand. Below the first release reading contract 2,
    // a contract-1 file is the target's own; a contract-2 one it cannot read.
    const since = deps.contract2Since ?? CONTRACT_2_SINCE
    const readsContract2 = compareVersions(target, `${since}-0`) >= 0
    const file = await readContractOf(ws.rnessDir)
    if (!readsContract2 && file?.contract === 2) {
      ui.error(
        `rness.json is contract 2; @rness/cli ${target} reads contract 1 only: upgrade to ${since} or later, or rewrite rness.json by hand`
      )
      return 1
    }
    const former =
      readsContract2 && file?.contract === 1
        ? await checkFormer(ws.rnessDir, file.raw)
        : null
    if (former !== null && former.manifest === null) {
      for (const line of former.refusals) ui.error(line)
      ui.hint(
        `edit ${relative(cwd, join(ws.rnessDir, 'rness.json'))} by hand, then ${rnessCommand()} upgrade again`,
        'stderr'
      )
      return 1
    }
    const base = await findScaffoldBase(ws.rnessDir)
    // A merge being concluded holds the target's scaffold already.
    const scaffoldCurrent =
      resuming || (base !== null && base.version === target)
    const current = pin.spec === target && installed === target
    // At the target with a contract-1 file: the rewrite is what is left, as
    // after an upgrade begun by a copy that did not know contract 2; with a
    // merge to conclude, its commit.
    if (current && scaffoldCurrent && former === null && !resuming) {
      if (ui.session) ui.outro(`Already at ${target}`)
      else process.stdout.write(`already at ${target}\n`)
      return 0
    }
    const downgrading =
      EXACT_VERSION.test(pin.spec) && compareVersions(target, pin.spec) < 0
    if (downgrading && version === undefined) {
      process.stderr.write(
        `${label} pins @rness/cli ${pin.spec}, newer than the latest release ${target}; to downgrade: ${rnessCommand()} upgrade ${target}\n`
      )
      return 1
    }

    const pm = await workspacePackageManager(ws.rnessDir)
    if (resuming)
      ui.line(
        'resume',
        `the upgrade to @rness/cli ${target}: its scaffold merge is staged in ${label}`,
        `Resuming the upgrade to @rness/cli ${target}: its scaffold merge is staged in ${label}`
      )
    if (current && scaffoldCurrent) {
      if (former !== null)
        ui.line(
          'rewrite',
          `rness.json in ${label} as contract 2, for @rness/cli ${target} (ADR 0012)`,
          `Rewriting rness.json in ${label} as contract 2, for @rness/cli ${target}`
        )
    } else if (current)
      ui.line(
        'scaffold',
        `@rness/cli ${target}: merging it into ${label}`,
        `Merging the @rness/cli ${target} scaffold into ${label}`
      )
    else if (pin.spec === target)
      ui.line(
        'install',
        `@rness/cli ${target} in ${label} (${pm}): ${installed ?? 'nothing'} is installed`
      )
    else {
      ui.line(
        'upgrade',
        `@rness/cli ${pin.spec} → ${target} in ${label} (${pm})${downgrading ? ', downgrading' : ''}`
      )
      ui.line('notes', NOTES, `Release notes: ${NOTES}`)
    }
    if (interactive) {
      const p = await terminal.prompts()
      const ok = await p.confirm({
        message: resuming
          ? `Conclude the upgrade to @rness/cli ${target}?`
          : current && scaffoldCurrent
            ? 'Rewrite rness.json as contract 2?'
            : `Upgrade @rness/cli to ${target}?`,
      })
      if (p.isCancel(ok) || ok !== true) {
        ui.cancelled()
        return 1
      }
    }

    // 1. The scaffold of the target version, merged with git (spec 0013).
    // A merge being concluded counts as this run's: `git merge --abort`
    // undoes it.
    let merged = resuming
    if (!scaffoldCurrent) {
      const source = await (deps.scaffoldFor ?? scaffoldFor)(
        target,
        ws.rnessDir
      )
      try {
        const files = await renderScaffold(source.dir, {
          version: target,
          packageManager: await declaredManager(ws.rnessDir, pm),
        })
        if (base === null)
          ui.line(
            'adopting',
            `the @rness/cli ${target} scaffold (no scaffold commit in ${label} yet)`,
            `Adopting the @rness/cli ${target} scaffold: ${label} has no scaffold commit yet`
          )
        else
          ui.line(
            'merging',
            `the @rness/cli ${target} scaffold`,
            `Merging the @rness/cli ${target} scaffold`
          )
        const commit = await buildScaffoldCommit(
          ws.rnessDir,
          base?.commit ?? null,
          base === null
            ? await withoutRedundantKeeps(ws.rnessDir, files)
            : files,
          target
        )
        const result = await mergeScaffold(
          ws.rnessDir,
          commit,
          base?.commit ?? null
        )
        for (const [change, path] of result.changes) ui.line(change, path)
        if (result.conflicts.length > 0) {
          for (const path of result.conflicts) ui.error(`conflict ${path}`)
          const rel = relative(cwd, ws.rnessDir) || '.'
          ui.hint(
            `resolve them in ${rel} (git checkout --ours <file> keeps yours, --theirs takes the scaffold's, or edit), git add, git commit, then ${rnessCommand()} upgrade again`,
            'stderr'
          )
          return 1
        }
        merged = true
      } finally {
        await source.cleanup?.()
      }
    }

    // 2. The pin — a merge usually moved it already. Restored when the
    // install fails, unless a merge is in progress: `git merge --abort` then.
    const packageFile = join(ws.rnessDir, 'package.json')
    const restore = new Map<string, string>([
      [packageFile, await readFile(packageFile, 'utf8')],
    ])
    const moved = await readPin(ws.rnessDir)
    if (moved !== null && moved.spec !== target)
      await writePin(ws.rnessDir, moved.spec, target)

    // Only the scaffold was behind: the pinned copy is already installed.
    const mustInstall = !current
    if (mustInstall) {
      try {
        await ui.step(
          { doing: `installing dependencies with ${pm}` },
          () => installDependencies(pm, ws.rnessDir),
          () => ['installed', `dependencies with ${pm}`]
        )
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        ui.error(message)
        // After a merge, `git merge --abort` puts package.json back; rewriting
        // it here, even byte for byte, would make git refuse the abort.
        if (!merged) {
          for (const [file, text] of restore) await writeFileAtomic(file, text)
          ui.hint(
            `restored ${relative(cwd, packageFile) || packageFile}`,
            'stderr'
          )
        }
        if (merged)
          ui.hint(
            `the scaffold merge is still staged; undo it with: git -C ${relative(cwd, ws.rnessDir) || '.'} merge --abort`,
            'stderr'
          )
        if (/minimum.?release.?age|NO_MATURE/i.test(message))
          ui.hint(
            "pnpm refuses versions published less than 24 h ago: add '@rness/cli' under minimumReleaseAgeExclude in .rness/pnpm-workspace.yaml",
            'stderr'
          )
        return 1
      }
      const now = (await readPinnedCli(ws.rnessDir))?.version ?? null
      if (now !== target) {
        process.stderr.write(
          `${pm} install left @rness/cli ${now ?? 'not installed'} in ${label}, not ${target}\n`
        )
        return 1
      }
    }

    // rness.json of contract 1, read and checked before the merge: written as
    // contract 2 once the copy that reads it is installed, before its sync
    // reads it; the commit below holds it (spec 0038 §7). Staged into a
    // merge, so `git merge --abort` puts contract 1 back and a bare `git
    // commit` carries it. After the rewrite the sync no longer sees a former
    // key of boards: said here.
    if (former !== null) {
      await writeManifest(ws.rnessDir, former.manifest)
      if (merged) await stageFile(ws.rnessDir, 'rness.json')
      ui.line(
        'rewrote',
        'rness.json as contract 2 (ADR 0012)',
        'Rewrote rness.json as contract 2 (ADR 0012)'
      )
      if (former.manifest.formerKey !== undefined)
        ui.line(
          'renamed',
          `${former.manifest.formerKey} to boards in .rness/rness.json`
        )
      for (const note of former.notes) ui.hint(note)
    }

    // Whatever the upgrade had to do: a release may add to the agent files
    // as well as to the blocks (spec 0013 §8). The installed copy is a child
    // with plain output: never a prompt.
    ui.gitIsSilent = true
    const code = await syncBlocks(ui, ws.root, basename(ws.root))
    if (code !== 0) return code

    // 3. The commit, the end of the upgrade (spec 0013 §8): `.rness` was
    // clean, so everything in it now is the upgrade's.
    const message = `chore: rness ${target}`
    const committed = await commitUpgrade(ws.rnessDir, message)
    if (committed.kind === 'committed')
      ui.line(
        'committed',
        `${label}: ${message}`,
        `Committed ${label}: ${message}`
      )
    if (committed.kind === 'refused') {
      ui.error(
        `the commit of ${label} was refused; everything is staged: deal with what git said, then commit`
      )
      for (const line of committed.output.split('\n'))
        if (line.trim() !== '') ui.hint(line, 'stderr')
    }
    return finish(ui, cwd, ws.rnessDir, label, target, {
      commit: committed.kind,
      clones: await (async () => {
        // A contract-1 file left to a target below contract 2: its
        // repositories as it would be shaped; none when it cannot be.
        const manifest =
          file?.contract === 1 && !readsContract2
            ? formerShape(file.raw)
            : await loadManifest(ws.rnessDir)
        if (manifest === null) return []
        return clonesToCommit(
          ws.root,
          cwd,
          manifest,
          await filesTheSyncWrites(ws.root, ws.rnessDir, manifest)
        )
      })(),
    })
  } catch (e) {
    return reportError(e)
  }
}
