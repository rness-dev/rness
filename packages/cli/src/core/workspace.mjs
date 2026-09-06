import { access } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function findWorkspace(startDir) {
  let dir = resolve(startDir)
  const { root: fsRoot } = parse(dir)
  while (true) {
    if (await exists(join(dir, '.rness', 'rness.json'))) {
      return { root: dir, rnessDir: join(dir, '.rness') }
    }
    if (dir === fsRoot) break
    dir = dirname(dir)
  }
  throw new Error(`no rness workspace found above ${startDir}`)
}
