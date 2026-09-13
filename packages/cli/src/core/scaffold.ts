import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Files shipped in `scaffold/`, POSIX-relative. `_gitignore` is renamed to
 * `.gitignore` when copied (npm would rename a packed `.gitignore`).
 */
export const SCAFFOLD_FILES: readonly string[] = [
  'AGENTS.md',
  'CONVENTIONS.md',
  'README.md',
  'WORKSPACE.md',
  'rness.json',
  'package.json',
  '_gitignore',
  '.githooks/pre-commit',
  '.github/workflows/validate.yml',
  'pnpm-workspace.yaml',
  'adr/0000-template.md',
  'standards/.gitkeep',
  'specs/.gitkeep',
  'plans/.gitkeep',
  'skills/.gitkeep',
  'docs/.gitkeep',
]

/**
 * Absolute path of the shipped scaffold. Works from the sources
 * (`src/core/scaffold.ts` → `../../scaffold`) and from the bundle
 * (`dist/<chunk>.js` or `dist/index.js` → `../scaffold`): walk up from this
 * file until a directory containing `scaffold/rness.json` is the package root.
 */
export function scaffoldDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, 'scaffold')
    try {
      if (statSync(join(candidate, 'rness.json')).isFile()) return candidate
    } catch {
      // keep walking
    }
    dir = dirname(dir)
  }
  throw new Error('scaffold directory not found next to the @rness/cli package')
}
