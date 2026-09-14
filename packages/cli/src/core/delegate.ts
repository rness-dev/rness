import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { findWorkspace } from './workspace.ts'

export interface Delegate {
  /** Absolute path of the pinned copy's `dist/index.js`. */
  entry: string
  version: string
  /** Workspace root (the directory holding `.rness/`). */
  root: string
}

export interface PinnedCli {
  /** Absolute path of `<rnessDir>/node_modules/@rness/cli`. */
  dir: string
  /** `bin.rness` as the package declares it (package-relative, POSIX). */
  bin: string
  version: string | null
}

/** A published `@rness/cli` whose `package.json` has no usable `bin`. */
const DEFAULT_BIN = 'dist/bin/rness.js'

/**
 * The `@rness/cli` installed under `<rnessDir>/node_modules`, or null when
 * nothing is installed there. Reading the package's own `package.json` is what
 * makes the launcher and `create` agree on which copy owns a workspace.
 */
export async function readPinnedCli(
  rnessDir: string
): Promise<PinnedCli | null> {
  const dir = join(rnessDir, 'node_modules', '@rness', 'cli')
  let pkg: { version?: unknown; bin?: unknown }
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      version?: unknown
      bin?: unknown
    }
  } catch {
    return null
  }
  const declared = pkg.bin
  let bin = DEFAULT_BIN
  if (typeof declared === 'string') bin = declared
  else if (declared !== null && typeof declared === 'object') {
    const named = (declared as Record<string, unknown>)['rness']
    if (typeof named === 'string') bin = named
  }
  return {
    dir,
    bin,
    version: typeof pkg.version === 'string' ? pkg.version : null,
  }
}

/**
 * The `@rness/cli` pinned in `<workspace>/.rness/package.json` (installed under
 * `.rness/node_modules`), when it exists and is not the running version. The
 * pinned copy is the only one that should ever act on a workspace.
 */
export async function findDelegate(
  cwd: string,
  ownVersion: string
): Promise<Delegate | null> {
  let root: string
  let rnessDir: string
  try {
    const ws = await findWorkspace(cwd)
    root = ws.root
    rnessDir = ws.rnessDir
  } catch {
    return null
  }
  const pinned = await readPinnedCli(rnessDir)
  if (pinned === null) return null
  const { version } = pinned
  if (version === null || version === ownVersion) return null
  return { entry: join(pinned.dir, 'dist', 'index.js'), version, root }
}
