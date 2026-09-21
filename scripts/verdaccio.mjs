// A local npm registry (verdaccio) to try a release before it reaches npmjs:
//
//   pnpm verdaccio start    start the registry in the background
//   pnpm verdaccio deploy   build and publish every package to it (starts it if needed)
//   pnpm verdaccio stop     stop the registry
//   pnpm verdaccio clean    stop it and delete everything it stored
//
// Its state lives in .verdaccio/ (git-ignored). The shims (`create-rness`,
// `@rness/create`) are served only from the local storage: `npm create rness`
// asks for their `latest`, so a forgotten deploy must be a 404, never the
// version published on npmjs. `@rness/cli` is proxied as well as deployed: a
// workspace pinned to a published version (0.4.0) installs as it would for a
// user, and the shims pin the version under test exactly, which only exists
// here. Every other package is proxied from npmjs. Publishing always names
// the local registry explicitly, so a deploy can never reach npmjs.
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  globSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const VERDACCIO = 'verdaccio@6.10.3'
const PORT = Number(process.env['VERDACCIO_PORT'] ?? 4873)
const URL_BASE = `http://127.0.0.1:${PORT}/`
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, '.verdaccio')
const FILES = {
  config: join(DIR, 'config.yaml'),
  storage: join(DIR, 'storage'),
  npmrc: join(DIR, 'npmrc'),
  pid: join(DIR, 'verdaccio.pid'),
  log: join(DIR, 'verdaccio.log'),
}
// Dependency order: the shims pin @rness/cli exactly.
const PACKAGES = ['cli', 'create', 'create-rness']

/** The environment for child processes, without any registry override the shell may carry. */
function cleanEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^npm_config_(registry|userconfig)$/i.test(key)) delete env[key]
  }
  return env
}

async function isUp() {
  try {
    const res = await fetch(`${URL_BASE}-/ping`, {
      signal: AbortSignal.timeout(1000),
    })
    return res.ok
  } catch {
    return false
  }
}

function readPid() {
  try {
    const pid = Number(readFileSync(FILES.pid, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writeConfig() {
  mkdirSync(FILES.storage, { recursive: true })
  writeFileSync(
    FILES.config,
    [
      `storage: ${JSON.stringify(FILES.storage)}`,
      'uplinks:',
      '  npmjs:',
      '    url: https://registry.npmjs.org/',
      'packages:',
      // The first matching pattern wins: the exact name before the scope.
      "  '@rness/cli':",
      '    access: $all',
      '    publish: $all',
      '    unpublish: $all',
      '    proxy: npmjs',
      "  '@rness/*':",
      '    access: $all',
      '    publish: $all',
      '    unpublish: $all',
      "  'create-rness':",
      '    access: $all',
      '    publish: $all',
      '    unpublish: $all',
      "  '**':",
      '    access: $all',
      '    publish: $all',
      '    proxy: npmjs',
      'log: { type: stdout, format: pretty, level: warn }',
      `listen: 127.0.0.1:${PORT}`,
      '',
    ].join('\n')
  )
  writeFileSync(
    FILES.npmrc,
    `registry=${URL_BASE}\n//127.0.0.1:${PORT}/:_authToken=local\n`
  )
}

function usageHint() {
  return [
    '',
    'Use it from another shell:',
    `  export npm_config_userconfig=${FILES.npmrc}`,
    '  cd "$(mktemp -d /tmp/rness-XXXX)" && npm create rness   # or: npm create rness <org>',
    'and `unset npm_config_userconfig` when you are done.',
  ].join('\n')
}

async function start() {
  const pid = readPid()
  if (pid !== null && isAlive(pid) && (await isUp())) {
    console.log(`verdaccio already running at ${URL_BASE} (pid ${pid})`)
    return
  }
  if (await isUp()) {
    throw new Error(
      `something else already answers on ${URL_BASE}; stop it or set VERDACCIO_PORT`
    )
  }
  writeConfig()
  const log = openSync(FILES.log, 'a')
  const child = spawn('npx', ['--yes', VERDACCIO, '--config', FILES.config], {
    cwd: DIR,
    env: cleanEnv(),
    detached: true,
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  child.unref()
  writeFileSync(FILES.pid, `${child.pid}\n`)
  for (let i = 0; i < 120; i += 1) {
    if (await isUp()) {
      console.log(`verdaccio running at ${URL_BASE} (pid ${child.pid})`)
      console.log(`storage and log in ${DIR}`)
      console.log(usageHint())
      return
    }
    if (!isAlive(child.pid)) break
    await sleep(500)
  }
  throw new Error(`verdaccio did not start; see ${FILES.log}`)
}

async function stop() {
  const pid = readPid()
  if (pid === null || !isAlive(pid)) {
    rmSync(FILES.pid, { force: true })
    console.log('verdaccio is not running')
    return
  }
  // The pid is npx's; it leads its own process group (detached), so the
  // registry it started stops with it.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
  for (let i = 0; i < 40 && (await isUp()); i += 1) await sleep(250)
  rmSync(FILES.pid, { force: true })
  console.log('verdaccio stopped')
}

async function clean() {
  await stop()
  rmSync(DIR, { recursive: true, force: true })
  console.log(`removed ${DIR}`)
}

function npm(args, cwd) {
  return execFileSync(
    'npm',
    [...args, '--registry', URL_BASE, '--userconfig', FILES.npmrc],
    {
      cwd,
      env: cleanEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
}

/**
 * pnpm's default cache directory, which it does not expose through
 * `pnpm config get`. Its own defaults, per platform.
 */
function pnpmCacheDir() {
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    return local === undefined ? null : join(local, 'pnpm-cache')
  }
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Caches', 'pnpm')
  const xdg = process.env['XDG_CACHE_HOME']
  return join(xdg === undefined ? join(homedir(), '.cache') : xdg, 'pnpm')
}

/**
 * Forget every copy pnpm keeps of this repository's own packages — the same
 * problem the npx cache has, for the same reason: a version number is a
 * contract, so redeploying one under the same number would go on serving the
 * old code. Two places hold it, and clearing either alone is not enough
 * (measured): the content store under `links/`, and the registry metadata
 * that names the tarball and its integrity. Nothing else in the store is
 * touched — only the names this repository publishes.
 */
function clearPnpmCopies(names) {
  const cleared = []
  const drop = (path) => {
    if (!existsSync(path)) return
    rmSync(path, { recursive: true, force: true })
    cleared.push(path)
  }
  let store = null
  try {
    store = execFileSync('pnpm', ['store', 'path'], {
      env: cleanEnv(),
      encoding: 'utf8',
    }).trim()
  } catch {
    // pnpm is not on PATH: nothing of its to clear.
  }
  if (store !== null && store !== '')
    for (const name of names) drop(join(store, 'links', ...name.split('/')))
  const cache = pnpmCacheDir()
  if (cache !== null && existsSync(cache)) {
    // `pnpm create rness` runs through pnpm's own dlx, which keeps the copy it
    // first installed — npm's `_npx` twin, and just as stale after a redeploy.
    // Only the entries holding one of these packages are dropped.
    const dlx = join(cache, 'dlx')
    if (existsSync(dlx))
      for (const entry of readdirSync(dlx)) {
        const modules = join(dlx, entry, 'pkg', 'node_modules')
        if (!existsSync(modules)) continue
        const held = readdirSync(modules)
        const ours = names.some((name) => {
          const [scope, bare] = name.startsWith('@')
            ? name.split('/')
            : [null, name]
          return scope === null
            ? held.includes(bare)
            : held.includes(scope) &&
                existsSync(join(modules, scope, bare ?? ''))
        })
        if (ours) drop(join(dlx, entry))
      }
    // The `v<n>` layer is pnpm's own store version, so it is matched rather
    // than named: this keeps working across pnpm releases.
    for (const dir of globSync(
      join(cache, '*', 'metadata', `127.0.0.1+${PORT}`)
    ))
      for (const name of names) {
        drop(join(dir, ...name.split('/')))
        drop(join(dir, `${name}.jsonl`))
      }
  }
  return cleared
}

async function deploy() {
  // Deploying is what you want the registry for: start it rather than send the
  // user back to another command. start() is idempotent and raises its own
  // error when something else already answers on the port.
  if (!(await isUp())) await start()
  if (!existsSync(FILES.npmrc)) writeConfig()
  const unlisted = readdirSync(join(ROOT, 'packages')).filter(
    (d) => !PACKAGES.includes(d)
  )
  if (unlisted.length > 0) {
    throw new Error(
      `packages not in the deploy order: ${unlisted.join(', ')} (edit scripts/verdaccio.mjs)`
    )
  }
  const published = []
  console.log('building…')
  execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' })
  for (const dir of PACKAGES) {
    const cwd = join(ROOT, 'packages', dir)
    const { name, version } = JSON.parse(
      readFileSync(join(cwd, 'package.json'), 'utf8')
    )
    // Redeploying the same version after a code change: drop the local copy.
    try {
      npm(['view', `${name}@${version}`, 'version'])
      npm(['unpublish', `${name}@${version}`, '--force'])
    } catch {
      // not deployed yet
    }
    // The build ran above; prepublishOnly (typecheck, tests, build) is skipped.
    npm(['publish', '--ignore-scripts'], cwd)
    published.push(name)
    console.log(`deployed ${name}@${version}`)
  }
  // `npm create rness` runs through npx, which keeps the first copy of a
  // version it installed and never looks again: redeploying the same version
  // would go on testing the old code. npx rebuilds the cache on demand.
  let cache = join(homedir(), '.npm')
  try {
    cache = execFileSync('npm', ['config', 'get', 'cache'], {
      env: cleanEnv(),
      encoding: 'utf8',
    }).trim()
  } catch {
    // npm's default location
  }
  const npx = join(cache, '_npx')
  if (existsSync(npx)) {
    rmSync(npx, { recursive: true, force: true })
    console.log(`cleared the npx cache (${npx})`)
  }
  const pnpmCleared = clearPnpmCopies(published)
  for (const path of pnpmCleared) console.log(`cleared ${path}`)
  console.log(usageHint())
  // A workspace that already installed holds the third copy, in its own
  // lockfile: the integrity recorded there is the old tarball's, and pnpm
  // trusts it. Only its owner can drop it (measured: clearing the store and
  // the metadata alone is not enough).
  console.log(
    [
      '',
      'A workspace that already installed this version must forget it too:',
      '  rm -rf <workspace>/.rness/node_modules <workspace>/.rness/pnpm-lock.yaml',
      `  npm_config_userconfig=${FILES.npmrc} pnpm install --dir <workspace>/.rness`,
    ].join('\n')
  )
}

const COMMANDS = { start, stop, clean, deploy }
const command = process.argv[2]
if (command === undefined || !(command in COMMANDS)) {
  console.error('usage: pnpm verdaccio <start|stop|clean|deploy>')
  process.exitCode = 2
} else {
  try {
    await COMMANDS[command]()
  } catch (e) {
    const stderr = e && typeof e === 'object' && 'stderr' in e ? e.stderr : ''
    console.error(e instanceof Error ? e.message : String(e))
    if (stderr)
      console.error(String(stderr).trim().split('\n').slice(-3).join('\n'))
    process.exitCode = 1
  }
}
