// Publish every workspace package whose version is not on npm yet, in
// dependency order: the shims pin @rness/cli exactly, so it goes first.
// A version already on the registry (published by hand, or by an earlier run
// that failed half-way) is skipped instead of failing the release.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ORDER = ['cli', 'create', 'create-rness']
const dryRun = process.argv.includes('--dry-run')

function firstLine(text) {
  return (
    String(text)
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? 'unknown error'
  )
}

/** true when name@version is on the registry, false on a 404; any other failure stops the release. */
function isPublished(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() === version
  } catch (e) {
    if (/\bE404\b/.test(String(e.stderr))) return false
    throw new Error(
      `npm view ${name}@${version} failed: ${firstLine(e.stderr ?? e.message)}`,
      { cause: e }
    )
  }
}

try {
  const unlisted = readdirSync('packages').filter((d) => !ORDER.includes(d))
  if (unlisted.length > 0)
    throw new Error(
      `packages not in the publish order: ${unlisted.join(', ')} (edit scripts/publish.mjs)`
    )
  for (const dir of ORDER) {
    const { name, version } = JSON.parse(
      readFileSync(join('packages', dir, 'package.json'), 'utf8')
    )
    if (isPublished(name, version)) {
      console.log(`skip     ${name}@${version} (already on npm)`)
      continue
    }
    console.log(`publish  ${name}@${version}`)
    execFileSync(
      'npm',
      ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])],
      { cwd: join('packages', dir), stdio: 'inherit' }
    )
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
