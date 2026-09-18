import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { promisify } from 'node:util'

import { readPinnedCli } from '../core/delegate.ts'
import { readOrNull, writeFileAtomic } from '../core/fs.ts'
import {
  EXACT_VERSION,
  readPin,
  syncPinned,
  workspacePackageManager,
  writePin,
} from '../core/pinned.ts'
import { installDependencies } from '../core/pm.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

const execFileP = promisify(execFile)

export interface UpgradeOptions {
  yes?: boolean
  /** Internal (tests): directory to resolve from. */
  cwd?: string
}

const NOTES = 'https://github.com/rness-dev/rness/tree/main/packages/cli#readme'

/** The `run:` command the scaffold wrote up to 0.4.0, its version in group 1. */
const OLD_WORKFLOW_RUN =
  /npx --yes @rness\/cli@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) validate/
/** What the scaffold writes now: the version is read from package.json (spec 0006 §2). */
const WORKFLOW_RUN = `npx --yes "@rness/cli@$(node -p "require('./package.json').devDependencies['@rness/cli']")" validate`

/** Negative when `a` is the older version. A pre-release is older than its release. */
function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string | null] => {
    const dash = v.indexOf('-')
    const core = dash === -1 ? v : v.slice(0, dash)
    return [core.split('.').map(Number), dash === -1 ? null : v.slice(dash + 1)]
  }
  const [coreA, preA] = split(a)
  const [coreB, preB] = split(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (preA === preB) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  return preA.localeCompare(preB, 'en', { numeric: true })
}

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

/**
 * `rness upgrade [version]`: move a workspace to another `@rness/cli` — pin it
 * in `.rness/package.json` (the one place the version is written), install
 * with the workspace's package manager, sync through the new copy (spec 0006
 * §3). Never delegated: the pinned copy is what is being replaced.
 */
export async function upgradeCommand(
  version: string | undefined,
  opts: UpgradeOptions,
  terminal: Terminal = defaultTerminal
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
        `no @rness/cli entry in ${label}/package.json; add it to devDependencies, then run rness upgrade\n`
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

    const target = version ?? (await latestVersion())
    if (target === null) {
      process.stderr.write(
        'cannot reach the registry; name the version: rness upgrade <version>\n'
      )
      return 1
    }
    const installed = (await readPinnedCli(ws.rnessDir))?.version ?? null
    if (pin.spec === target && installed === target) {
      process.stdout.write(`already at ${target}\n`)
      return 0
    }
    const downgrading =
      EXACT_VERSION.test(pin.spec) && compareVersions(target, pin.spec) < 0
    if (downgrading && version === undefined) {
      process.stderr.write(
        `${label} pins @rness/cli ${pin.spec}, newer than the latest release ${target}; to downgrade: rness upgrade ${target}\n`
      )
      return 1
    }

    const pm = await workspacePackageManager(ws.rnessDir)
    process.stdout.write(
      pin.spec === target
        ? `install  @rness/cli ${target} in ${label} (${pm}) — ${installed ?? 'nothing'} is installed\n`
        : `upgrade  @rness/cli ${pin.spec} → ${target} in ${label} (${pm})${downgrading ? ' — downgrading' : ''}\nnotes    ${NOTES}\n`
    )
    if (interactive) {
      const p = await terminal.prompts()
      const ok = await p.confirm({
        message: `Upgrade @rness/cli to ${target}?`,
      })
      if (p.isCancel(ok) || ok !== true) {
        process.stderr.write('cancelled\n')
        return 1
      }
    }

    // Everything written before the install is restored when it fails.
    const packageFile = join(ws.rnessDir, 'package.json')
    const restore = new Map<string, string>([
      [packageFile, await readFile(packageFile, 'utf8')],
    ])
    if (pin.spec !== target) await writePin(ws.rnessDir, pin.spec, target)

    const workflows = join(ws.rnessDir, '.github', 'workflows')
    for (const name of await readdir(workflows).catch(() => [])) {
      if (!/\.ya?ml$/.test(name)) continue
      const file = join(workflows, name)
      const text = await readOrNull(file)
      if (text === null) continue
      const shown = `.github/workflows/${name}`
      if (name === 'validate.yml' && OLD_WORKFLOW_RUN.test(text)) {
        restore.set(file, text)
        await writeFileAtomic(
          file,
          text.replace(OLD_WORKFLOW_RUN, () => WORKFLOW_RUN)
        )
        process.stdout.write(
          `updated  ${shown} (it now reads the version from package.json)\n`
        )
      } else if (
        pin.spec !== target &&
        text.includes(`@rness/cli@${pin.spec}`)
      ) {
        process.stderr.write(
          `warning: ${shown} names @rness/cli@${pin.spec}; update it by hand\n`
        )
      }
    }

    try {
      await installDependencies(pm, ws.rnessDir)
    } catch (e) {
      for (const [file, text] of restore) await writeFileAtomic(file, text)
      const message = e instanceof Error ? e.message : String(e)
      process.stderr.write(
        `${message}\nrestored ${relative(cwd, packageFile) || packageFile}\n`
      )
      if (/minimum.?release.?age|NO_MATURE/i.test(message))
        process.stderr.write(
          "pnpm refuses versions published less than 24 h ago: add '@rness/cli' under minimumReleaseAgeExclude in .rness/pnpm-workspace.yaml\n"
        )
      return 1
    }
    process.stdout.write(`installed dependencies with ${pm}\n`)
    const now = (await readPinnedCli(ws.rnessDir))?.version ?? null
    if (now !== target) {
      process.stderr.write(
        `${pm} install left @rness/cli ${now ?? 'not installed'} in ${label}, not ${target}\n`
      )
      return 1
    }

    const code = await syncPinned(ws.root, basename(ws.root))
    if (code !== 0) return code

    const rel = relative(cwd, ws.rnessDir) || '.'
    process.stdout.write(
      [
        '',
        `upgraded ${label} to @rness/cli ${target}`,
        '',
        'Next:',
        `  git -C ${rel} add -A && git -C ${rel} commit -m "chore: rness ${target}"`,
        `  # teammates: git pull, then ${pm} install in .rness`,
        '',
      ].join('\n')
    )
    return 0
  } catch (e) {
    return reportError(e)
  }
}
