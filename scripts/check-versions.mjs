// Every package in the workspace ships the same version, and the shims pin @rness/cli to it.
import { glob, readFile } from 'node:fs/promises'

const manifests = []
for await (const p of glob('packages/*/package.json'))
  manifests.push({ path: p, pkg: JSON.parse(await readFile(p, 'utf8')) })
const versions = new Set(manifests.map((m) => m.pkg.version))
let ok = versions.size === 1
if (!ok)
  console.error(
    `versions differ: ${manifests.map((m) => `${m.pkg.name}@${m.pkg.version}`).join(', ')}`
  )
const [version] = versions
for (const m of manifests) {
  const pinned = m.pkg.dependencies?.['@rness/cli']
  if (pinned !== undefined && pinned !== version) {
    ok = false
    console.error(
      `${m.pkg.name} pins @rness/cli@${pinned}, expected ${version}`
    )
  }
}
process.exitCode = ok ? 0 : 1
if (ok) console.log(`all packages at ${version}`)
