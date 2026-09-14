// Every package in the workspace ships the same version, and the shims pin
// @rness/cli to it. With `--tag vX.Y.Z` (the release workflow), the git tag
// must name that same version.
import { glob, readFile } from 'node:fs/promises'

function tagArgument(argv) {
  const at = argv.indexOf('--tag')
  if (at !== -1) return argv[at + 1] ?? ''
  const inline = argv.find((a) => a.startsWith('--tag='))
  return inline === undefined ? undefined : inline.slice('--tag='.length)
}

const tag = tagArgument(process.argv.slice(2))
const manifests = []
for await (const p of glob('packages/*/package.json'))
  manifests.push({ path: p, pkg: JSON.parse(await readFile(p, 'utf8')) })
if (manifests.length === 0) {
  console.error(
    'no packages/*/package.json found (run from the repository root)'
  )
  process.exit(1)
}
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
if (tag !== undefined) {
  const tagVersion = tag.replace(/^v/, '')
  if (tagVersion === '') {
    ok = false
    console.error('--tag needs a value, e.g. --tag v0.4.0')
  } else if (tagVersion !== version) {
    ok = false
    console.error(`tag ${tag} does not match the packages' version ${version}`)
  }
}
process.exitCode = ok ? 0 : 1
if (ok)
  console.log(
    `all packages at ${version}${tag === undefined ? '' : ` (tag ${tag})`}`
  )
