// A local npm registry (verdaccio) to try a release before it reaches npmjs:
//
//   pnpm verdaccio start    start the registry in the background
//   pnpm verdaccio deploy   build and publish every package to it
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
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

async function deploy() {
  if (!(await isUp())) {
    throw new Error(`verdaccio is not running; run: pnpm verdaccio start`)
  }
  if (!existsSync(FILES.npmrc)) writeConfig()
  const unlisted = readdirSync(join(ROOT, 'packages')).filter(
    (d) => !PACKAGES.includes(d)
  )
  if (unlisted.length > 0) {
    throw new Error(
      `packages not in the deploy order: ${unlisted.join(', ')} (edit scripts/verdaccio.mjs)`
    )
  }
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
    console.log(`deployed ${name}@${version}`)
  }
  console.log(usageHint())
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
