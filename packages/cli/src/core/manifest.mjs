import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const NAME = /^[a-z0-9][a-z0-9-]*$/

function fail(msg) {
  throw new Error(`rness.json: ${msg}`)
}

function checkPath(scope, path) {
  if (typeof path !== 'string' || path === '') fail(`scope "${scope}" needs a string "path"`)
  if (path.startsWith('/')) fail(`scope "${scope}" path must be relative`)
  if (path.split('/').includes('..')) fail(`scope "${scope}" path must not contain ".."`)
}

export async function loadManifest(rnessDir) {
  let raw
  try {
    raw = await readFile(join(rnessDir, 'rness.json'), 'utf8')
  } catch {
    fail('not found')
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    fail(`invalid JSON (${e.message})`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('must be a JSON object')
  if (data.contract !== 1) fail(`unsupported contract: ${JSON.stringify(data.contract)} (expected 1)`)

  const repos = data.repos ?? {}
  if (typeof repos !== 'object' || Array.isArray(repos)) fail('"repos" must be an object')
  for (const [name, entry] of Object.entries(repos)) {
    if (!NAME.test(name)) fail(`repo name "${name}" is not [a-z0-9-]`)
    if (!entry || typeof entry.url !== 'string') fail(`repo "${name}" needs a string "url"`)
  }

  const scopes = data.scopes ?? {}
  if (typeof scopes !== 'object' || Array.isArray(scopes)) fail('"scopes" must be an object')
  const normalised = {}
  for (const [name, entry] of Object.entries(scopes)) {
    if (!NAME.test(name)) fail(`scope name "${name}" is not [a-z0-9-]`)
    if (!entry || typeof entry !== 'object') fail(`scope "${name}" must be an object`)
    checkPath(name, entry.path)
    const ext = entry.extends ?? []
    if (!Array.isArray(ext)) fail(`scope "${name}" extends must be an array`)
    normalised[name] = { path: entry.path, extends: ext }
  }
  for (const [name, entry] of Object.entries(normalised)) {
    for (const target of entry.extends) {
      if (!Object.hasOwn(normalised, target)) fail(`scope "${name}" extends unknown scope "${target}"`)
    }
  }

  return { contract: 1, repos, scopes: normalised }
}
