import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SCAFFOLD_FILES, scaffoldDir } from './scaffold.ts'

export interface ScaffoldTokens {
  version: string
  packageManager: string
}

const TOKENISED = new Set(['package.json', '.github/workflows/validate.yml'])

/** Materialise the shipped skeleton into `dest` (spec 0003 §2.1 step 3); `rness.json` is the caller's. */
export async function copyScaffold(
  dest: string,
  tokens: ScaffoldTokens
): Promise<void> {
  const source = scaffoldDir()
  for (const rel of SCAFFOLD_FILES) {
    if (rel === 'rness.json') continue
    const from = join(source, ...rel.split('/'))
    const targetRel = rel === '_gitignore' ? '.gitignore' : rel
    const to = join(dest, ...targetRel.split('/'))
    await mkdir(dirname(to), { recursive: true })
    let content = await readFile(from, 'utf8')
    if (TOKENISED.has(rel)) {
      content = content
        .replaceAll('__RNESS_VERSION__', tokens.version)
        .replaceAll('__RNESS_PM__', tokens.packageManager)
    }
    await writeFile(to, content, 'utf8')
    const mode = (await stat(from)).mode & 0o777
    if (mode & 0o111) await chmod(to, mode)
  }
}
