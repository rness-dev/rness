import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SCAFFOLD_FILES, scaffoldDir } from './scaffold.ts'

export interface ScaffoldTokens {
  version: string
  packageManager: string
}

/** One file a scaffold version writes into `.rness/`, as it lands there. */
export interface ScaffoldFile {
  /** POSIX, relative to `.rness/`. */
  path: string
  content: string
  executable: boolean
}

// The CI workflow reads the pinned version from package.json (spec 0006 §2).
const TOKENISED = new Set(['package.json'])

/**
 * The files the scaffold in `source` writes, rendered: `_gitignore` as
 * `.gitignore`, the tokens of `package.json` filled. `rness.json` is the
 * team's catalogue, never part of it (spec 0013 §1).
 */
export async function renderScaffold(
  source: string,
  tokens: ScaffoldTokens
): Promise<ScaffoldFile[]> {
  const files: ScaffoldFile[] = []
  for (const rel of SCAFFOLD_FILES) {
    if (rel === 'rness.json') continue
    const from = join(source, ...rel.split('/'))
    let content = await readFile(from, 'utf8')
    if (TOKENISED.has(rel)) {
      content = content
        .replaceAll('__RNESS_VERSION__', tokens.version)
        .replaceAll('__RNESS_PM__', tokens.packageManager)
    }
    files.push({
      path: rel === '_gitignore' ? '.gitignore' : rel,
      content,
      executable: ((await stat(from)).mode & 0o111) !== 0,
    })
  }
  return files
}

/** Materialise the shipped skeleton into `dest` (spec 0003 §2.1 step 3); `rness.json` is the caller's. */
export async function copyScaffold(
  dest: string,
  tokens: ScaffoldTokens
): Promise<void> {
  for (const file of await renderScaffold(scaffoldDir(), tokens)) {
    const to = join(dest, ...file.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, file.content, 'utf8')
    if (file.executable) await chmod(to, 0o755)
  }
}
