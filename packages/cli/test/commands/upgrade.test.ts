import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { type UpgradeDeps, upgradeCommand } from '../../src/commands/upgrade.ts'
import { parseManifest } from '../../src/core/manifest.ts'
import { presetTemplate } from '../../src/core/presets.ts'
import { renderScaffold } from '../../src/core/scaffold-copy.ts'
import { scaffoldDir } from '../../src/core/scaffold.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

const execFileP = promisify(execFile)
const git = async (dir: string, ...args: string[]) =>
  (await execFileP('git', args, { cwd: dir })).stdout.trim()

const PM = 'npm@11.0.0'

/** package.json as the scaffold renders it for `pin`. */
async function scaffoldPackage(pin: string): Promise<string> {
  const files = await renderScaffold(scaffoldDir(), {
    version: pin,
    packageManager: PM,
  })
  return files.find((f) => f.path === 'package.json')?.content ?? ''
}

/**
 * `npm` first on PATH: `view` answers FAKE_NPM_LATEST (or fails), `install`
 * materialises the pinned @rness/cli — a bin that prints what it was asked,
 * or FAKE_NPM_BIN's script when set — or fails as npm does when FAKE_NPM_FAIL
 * is set; `pack` builds a tarball of FAKE_NPM_SCAFFOLD as the package's
 * scaffold.
 */
async function fakeNpm(
  t: TestContext,
  env: { latest?: string; fail?: boolean; scaffold?: string; bin?: string }
): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'rness-npm-'))
  t.after(() => rm(binDir, { recursive: true, force: true }))
  const file = join(binDir, 'npm')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  view)',
      '    [ -n "$FAKE_NPM_LATEST" ] || { echo "npm error code ENOTFOUND" >&2; exit 1; }',
      '    echo "$FAKE_NPM_LATEST" ;;',
      '  pack)',
      '    dest="$4"; stage=$(mktemp -d)',
      '    mkdir -p "$stage/package" && cp -R "$FAKE_NPM_SCAFFOLD" "$stage/package/scaffold"',
      '    tar -czf "$dest/rness-cli.tgz" -C "$stage" package && echo rness-cli.tgz ;;',
      '  install)',
      '    if [ -n "$FAKE_NPM_FAIL" ]; then',
      '      echo "npm error code ETARGET" >&2',
      '      echo "npm error notarget No matching version found for @rness/cli." >&2',
      '      exit 1',
      '    fi',
      `    v=$("${process.execPath}" -p "require('./package.json').devDependencies['@rness/cli']")`,
      '    mkdir -p node_modules/@rness/cli/dist/bin',
      '    echo "{\\"name\\":\\"@rness/cli\\",\\"version\\":\\"$v\\",\\"bin\\":{\\"rness\\":\\"dist/bin/rness.js\\"}}" > node_modules/@rness/cli/package.json',
      '    if [ -n "$FAKE_NPM_BIN" ]; then cp "$FAKE_NPM_BIN" node_modules/@rness/cli/dist/bin/rness.js; else',
      "    echo \"console.log('PINNED $v ' + process.argv.slice(2).join(' '))\" > node_modules/@rness/cli/dist/bin/rness.js; fi ;;",
      'esac',
      '',
    ].join('\n')
  )
  await chmod(file, 0o755)
  const saved = {
    PATH: process.env['PATH'],
    FAKE_NPM_LATEST: process.env['FAKE_NPM_LATEST'],
    FAKE_NPM_FAIL: process.env['FAKE_NPM_FAIL'],
    FAKE_NPM_SCAFFOLD: process.env['FAKE_NPM_SCAFFOLD'],
    FAKE_NPM_BIN: process.env['FAKE_NPM_BIN'],
  }
  process.env['PATH'] = `${binDir}:${saved.PATH ?? ''}`
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  set('FAKE_NPM_LATEST', env.latest)
  set('FAKE_NPM_FAIL', env.fail === true ? '1' : undefined)
  set('FAKE_NPM_SCAFFOLD', env.scaffold)
  set('FAKE_NPM_BIN', env.bin)
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) set(key, value)
  })
}

/**
 * A workspace as `create` leaves it: `.rness` a repository whose one commit
 * holds the scaffold rendered for `pin` — the base of the next merge. The
 * subject and trailer can be changed to model older or hand-made ones.
 */
async function workspace(
  t: TestContext,
  spec: {
    pin: string
    installed?: string
    subject?: string
    trailer?: string | null
    /** Scaffold files the base predates: left out of the first commit. */
    omit?: string[]
  }
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-up-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rnessDir = join(root, '.rness')
  await mkdir(join(root, 'org'), { recursive: true })
  await mkdir(rnessDir, { recursive: true })
  for (const f of await renderScaffold(scaffoldDir(), {
    version: spec.pin,
    packageManager: PM,
  })) {
    if (spec.omit?.includes(f.path)) continue
    const to = join(rnessDir, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, f.content, { mode: f.executable ? 0o755 : 0o644 })
  }
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({ contract: 2, org: 'acme', scopes: {} })
  )
  await git(rnessDir, 'init', '-q', '-b', 'main')
  await git(rnessDir, 'add', '-A')
  const trailer =
    spec.trailer === undefined ? `Rness-Scaffold: ${spec.pin}` : spec.trailer
  const subject = spec.subject ?? 'chore: rness workspace context'
  await git(
    rnessDir,
    'commit',
    '-q',
    '-m',
    trailer === null ? subject : `${subject}\n\n${trailer}`
  )
  if (spec.installed !== undefined) {
    const pkg = join(rnessDir, 'node_modules', '@rness', 'cli')
    await mkdir(join(pkg, 'dist', 'bin'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@rness/cli',
        version: spec.installed,
        bin: { rness: 'dist/bin/rness.js' },
      })
    )
    await writeFile(
      join(pkg, 'dist', 'bin', 'rness.js'),
      `console.log('PINNED ${spec.installed} ' + process.argv.slice(2).join(' '))\n`
    )
  }
  return root
}

/** A copy of the scaffold with one file changed, as a later version would ship it. */
async function changedScaffold(
  t: TestContext,
  path: string,
  change: (text: string) => string
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-next-scaffold-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(scaffoldDir(), dir, { recursive: true })
  const file = join(dir, ...path.split('/'))
  await writeFile(file, change(await readFile(file, 'utf8')))
  return dir
}

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

/** The scaffold of every target is the one in these sources, unless a test says otherwise. */
const SAME_SCAFFOLD: UpgradeDeps = {
  scaffoldFor: async () => ({ dir: scaffoldDir() }),
}

async function upgrade(
  version: string | undefined,
  opts: Parameters<typeof upgradeCommand>[1],
  terminal: Terminal = NO_TTY,
  deps: UpgradeDeps = SAME_SCAFFOLD
) {
  const c = capture()
  try {
    // The targets here are 0.x releases older than contract 2: every one
    // reads it unless a test says otherwise.
    const code = await upgradeCommand(version, opts, terminal, {
      contract2Since: '0.1.0',
      ...deps,
    })
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const read = (root: string, ...rel: string[]) =>
  readFile(join(root, '.rness', ...rel), 'utf8')

test('upgrade merges the target scaffold, pins, installs, syncs through the new copy, and commits', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const label = `${basename(root)}/.rness`
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.5.0'))
  assert.equal(
    r.out,
    [
      `upgrade  @rness/cli 0.4.0 → 0.5.0 in ${label} (npm)`,
      'notes    https://github.com/rness-dev/rness/tree/main/packages/cli#readme',
      'merging  the @rness/cli 0.5.0 scaffold',
      'updated  package.json',
      'installed dependencies with npm',
      'PINNED 0.5.0 sync --yes',
      `committed ${label}: chore: rness 0.5.0`,
      '',
      `upgraded ${label} to @rness/cli 0.5.0`,
      '',
      'Next:',
      '  git -C .rness push',
      '  # teammates: git pull, then any rness command (rness status) before opening Claude Code',
      '',
    ].join('\n')
  )
  // One commit records the merge, and the next base is 0.5.0.
  assert.equal(await git(join(root, '.rness'), 'status', '--porcelain'), '')
  assert.match(
    await git(join(root, '.rness'), 'log', '--topo-order', '--format=%s'),
    /^chore: rness 0\.5\.0\nchore: rness scaffold 0\.5\.0\nchore: rness workspace context$/
  )
})

test("a scaffold change reaches an untouched file; the team's edit of another stays", async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'README.md'),
    `Team intro.\n\n${await read(root, 'README.md')}`
  )
  await git(rnessDir, 'commit', '-qam', 'docs: our intro')
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    (s) => `${s}\nNew in 0.5.0.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {
    scaffoldFor: async () => ({ dir: next }),
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^updated {2}WORKSPACE\.md$/m)
  assert.match(await read(root, 'WORKSPACE.md'), /New in 0\.5\.0\.\n$/)
  assert.match(await read(root, 'README.md'), /^Team intro\./)
})

test("the scaffold's rness.json is not merged: a workspace's contract-1 file is left to the rewrite, no conflict", async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  // As 0.24.0 created it: the scaffold's one line, then the team's edit of it.
  await writeFile(
    join(rnessDir, 'rness.json'),
    '{ "contract": 1, "repos": {}, "scopes": {} }\n'
  )
  await git(rnessDir, 'commit', '-qa', '--amend', '--no-edit')
  const edited = `${JSON.stringify(
    {
      contract: 1,
      org: 'acme',
      repos: { api: { url: 'https://github.com/acme/api.git' } },
      scopes: { api: { path: 'org/api' } },
    },
    null,
    2
  )}\n`
  await writeFile(join(rnessDir, 'rness.json'), edited)
  await git(rnessDir, 'commit', '-qam', 'chore: our repositories')
  // The scaffold of this version is contract 2: rness.json is not among the
  // files the merge writes (spec 0013 §1), so git has nothing to conflict on;
  // the rewrite after the install is what changes it (spec 0038 §7).
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /conflict/)
  assert.match(r.out, /^merging {2}the @rness\/cli 0\.5\.0 scaffold$/m)
  assert.doesNotMatch(r.out, /^(added|updated|merged|removed) +rness\.json$/m)
  assert.equal(
    await read(root, 'rness.json'),
    '{\n  "contract": 2,\n  "org": "acme",\n  "scopes": {\n    "api": { "url": "https://github.com/acme/api.git" }\n  }\n}\n'
  )
})

/** `rness.json` replaced by `text` and committed, as a team's edit lands. */
async function commitManifest(
  root: string,
  text: string,
  files: Record<string, string> = {}
): Promise<void> {
  const rnessDir = join(root, '.rness')
  await writeFile(join(rnessDir, 'rness.json'), text)
  for (const [rel, content] of Object.entries(files)) {
    const to = join(rnessDir, ...rel.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, content)
  }
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-qm', 'chore: our rness.json')
}

/** A contract-1 file as 0.24.0 wrote it: two-space JSON. */
const contract1 = (data: Record<string, unknown>): string =>
  `${JSON.stringify({ contract: 1, ...data }, null, 2)}\n`

/** The version of the @rness/cli copy installed in `.rness`. */
const installedVersion = async (root: string): Promise<string> =>
  (
    JSON.parse(
      await read(root, 'node_modules', '@rness', 'cli', 'package.json')
    ) as { version: string }
  ).version

test('a contract-1 rness.json: checked first, rewritten as contract 2 after the install, the notes said, the commit holds it (spec 0038 §7)', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  const label = `${basename(root)}/.rness`
  await commitManifest(
    root,
    contract1({
      org: 'acme',
      projects: { pulse: 3 },
      repos: { platform: { url: 'https://github.com/acme/platform.git' } },
      scopes: {
        platform: { path: 'org/platform' },
        // A part that did not extend its repository: nesting gives it one.
        web: { path: 'org/platform/apps/web' },
      },
    })
  )
  const before = await git(rnessDir, 'rev-parse', 'HEAD')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.out,
    [
      `upgrade  @rness/cli 0.4.0 → 0.5.0 in ${label} (npm)`,
      'notes    https://github.com/rness-dev/rness/tree/main/packages/cli#readme',
      'merging  the @rness/cli 0.5.0 scaffold',
      'updated  package.json',
      'installed dependencies with npm',
      'rewrote  rness.json as contract 2 (ADR 0012)',
      'renamed  projects to boards in .rness/rness.json',
      'scope "web" now inherits platform (nested)',
      'PINNED 0.5.0 sync --yes',
      `committed ${label}: chore: rness 0.5.0`,
      '',
      `upgraded ${label} to @rness/cli 0.5.0`,
      '',
      'Next:',
      '  git -C .rness push',
      '  # teammates: git pull, then any rness command (rness status) before opening Claude Code',
      '',
    ].join('\n')
  )
  const after = `{
  "contract": 2,
  "org": "acme",
  "boards": { "pulse": 3 },
  "scopes": {
    "platform": {
      "url": "https://github.com/acme/platform.git",
      "scopes": {
        "web": { "path": "apps/web" }
      }
    }
  }
}
`
  assert.equal(await read(root, 'rness.json'), after)
  assert.equal(parseManifest(after).scopes['web']?.parent, 'platform')
  // The commit `chore: rness 0.5.0` holds it; nothing is left out of it.
  assert.equal(
    await git(rnessDir, 'log', '-1', '--format=%s'),
    'chore: rness 0.5.0'
  )
  assert.match(
    await git(rnessDir, 'diff', '--name-only', before, 'HEAD'),
    /^rness\.json$/m
  )
  assert.equal(await git(rnessDir, 'show', 'HEAD:rness.json'), after.trimEnd())
  assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
})

const MARKETING_README = '---\ndescription: The launch.\n---\n# L\n'

test('a contract-1 file contract 2 cannot hold stops upgrade before the merge: its lines, the fix, the pin, the files and the base unchanged', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const url = (name: string) => `https://github.com/acme/${name}.git`
  const marketing = {
    number: 8,
    ...presetTemplate('collection/1', { collection: 'marketing' }),
    description: 'Another.',
  }
  const cases: [string, Record<string, string>, string[]][] = [
    [
      contract1({ repos: { api: { url: url('api') } }, scopes: {} }),
      {},
      ['repo "api" has no scope at org/api'],
    ],
    [
      contract1({ repos: {}, scopes: { api: { path: 'org/api' } } }),
      {},
      ['scope "api" at org/api has no repository: add its url, or remove it'],
    ],
    [
      contract1({
        repos: {},
        scopes: { web: { path: 'org/platform/apps/web' } },
      }),
      {},
      [
        'scope "web" at org/platform/apps/web is inside no repository of rness.json',
      ],
    ],
    [
      contract1({
        repos: { web: { url: url('web') } },
        scopes: { frontend: { path: 'org/web' }, tools: { path: 'tools' } },
      }),
      {},
      // Every line at once.
      [
        'repo "web": its scope at org/web is named "frontend"; rename it web',
        'scope "tools" at tools/ is outside org/',
      ],
    ],
    // A boards conflict the reader sync uses refuses (spec 0038 §11).
    [
      contract1({ boards: { marketing }, repos: {}, scopes: {} }),
      { 'marketing/README.md': MARKETING_README },
      [
        'marketing/README.md declares description otherwise than boards.marketing: keep one, in rness.json',
      ],
    ],
    // A file 0.24.0 refused already: its line, the same fix.
    [
      contract1({ repos: { api: url('api') }, scopes: {} }),
      {},
      ['rness.json: repo "api" needs a string "url"'],
    ],
  ]
  for (const [text, files, lines] of cases) {
    const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
    const rnessDir = join(root, '.rness')
    await commitManifest(root, text, files)
    const head = await git(rnessDir, 'rev-parse', 'HEAD')
    const r = await upgrade(undefined, { yes: true, cwd: root })
    assert.equal(r.code, 1, text)
    assert.equal(
      r.err,
      [
        ...lines,
        'edit .rness/rness.json by hand, then rness upgrade again',
        '',
      ].join('\n'),
      text
    )
    // Nothing merged, nothing installed, nothing synced or written.
    assert.doesNotMatch(r.out, /merging|installed|PINNED|rewrote/, text)
    assert.equal(await git(rnessDir, 'rev-parse', 'HEAD'), head, text)
    assert.equal(await git(rnessDir, 'status', '--porcelain'), '', text)
    await assert.rejects(
      git(rnessDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    )
    assert.equal(await read(root, 'rness.json'), text)
    assert.equal(
      await read(root, 'package.json'),
      await scaffoldPackage('0.4.0')
    )
    assert.equal(await installedVersion(root), '0.4.0')
  }
})

test('at the target already, a contract-1 file is rewritten and committed: the second step of an upgrade an earlier copy began', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.5.0', installed: '0.5.0' })
  const rnessDir = join(root, '.rness')
  const label = `${basename(root)}/.rness`
  await commitManifest(
    root,
    contract1({
      org: 'acme',
      repos: { api: { url: 'https://github.com/acme/api.git' } },
      scopes: { api: { path: 'org/api' } },
    })
  )
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.out,
    [
      `rewrite  rness.json in ${label} as contract 2, for @rness/cli 0.5.0 (ADR 0012)`,
      'rewrote  rness.json as contract 2 (ADR 0012)',
      'PINNED 0.5.0 sync --yes',
      `committed ${label}: chore: rness 0.5.0`,
      '',
      `upgraded ${label} to @rness/cli 0.5.0`,
      '',
      'Next:',
      '  git -C .rness push',
      '  # teammates: git pull, then any rness command (rness status) before opening Claude Code',
      '',
    ].join('\n')
  )
  assert.equal(
    await git(rnessDir, 'diff', '--name-only', 'HEAD^', 'HEAD'),
    'rness.json'
  )
  assert.equal(parseManifest(await read(root, 'rness.json')).contract, 2)
  // Done: the next run is at the target, contract included.
  const again = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(again.code, 0, again.err)
  assert.equal(again.out, 'already at 0.5.0\n')
})

test('a contract-2 file is left alone: no rewrite, no line, at the target or not', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const text = `{
  "contract": 2,
  "org": "acme",
  "scopes": {
    "api": { "url": "https://github.com/acme/api.git" }
  }
}
`
  for (const pin of ['0.4.0', '0.5.0']) {
    const root = await workspace(t, { pin, installed: pin })
    await commitManifest(root, text)
    const r = await upgrade(undefined, { yes: true, cwd: root })
    assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.out, /rewrit|contract/, pin)
    assert.equal(await read(root, 'rness.json'), text, pin)
    if (pin === '0.5.0') assert.equal(r.out, 'already at 0.5.0\n')
  }
})

test("this workspace's own shape (three repositories with their scopes, boards declared whole, no jira): rewritten, the boards byte for byte", async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  // A copy of rness-dev's .rness/rness.json, 2026-11-10: frozen, since that
  // file moves to contract 2 once this release is out.
  const before = await readFile(
    fileURLToPath(
      new URL('../fixtures/upgrade/rness-dev.contract-1.json', import.meta.url)
    ),
    'utf8'
  )
  await commitManifest(root, before)
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^rewrote {2}rness\.json as contract 2 \(ADR 0012\)$/m)
  assert.doesNotMatch(r.out, /nested|renamed/)
  const after = await read(root, 'rness.json')
  assert.equal(
    after,
    before
      .replace('"contract": 1,', '"contract": 2,')
      .replace(
        / {2}"repos": \{[\s\S]*$/,
        [
          '  "scopes": {',
          '    "web": { "url": "git@github.com:rness-dev/web.git" },',
          '    "rness": { "url": "git@github.com:rness-dev/rness.git" },',
          '    "docs": { "url": "git@github.com:rness-dev/docs.git" }',
          '  }',
          '}',
          '',
        ].join('\n')
      )
  )
  const boards = (text: string) =>
    text.slice(
      text.indexOf('  "boards": {'),
      text.search(/^ {2}"(repos|scopes)"/m)
    )
  assert.ok(boards(before).length > 1000)
  assert.equal(boards(after), boards(before))
  const manifest = parseManifest(after)
  assert.equal(manifest.jira, undefined)
  assert.deepEqual(Object.keys(manifest.scopes), ['web', 'rness', 'docs'])
})

/**
 * A pinned copy whose sync fails while FAKE_SYNC_FAIL is set, as 0.25.0's
 * stops on a contract-1 file; otherwise it prints what it was asked.
 */
async function failingSyncBin(t: TestContext): Promise<string> {
  const stub = join(await mkdtemp(join(tmpdir(), 'rness-bin-')), 'rness.js')
  t.after(() => rm(dirname(stub), { recursive: true, force: true }))
  await writeFile(
    stub,
    [
      'const args = process.argv.slice(2)',
      "if (args[0] === 'sync' && process.env.FAKE_SYNC_FAIL === '1') {",
      "  console.error('rness.json is contract 1: run npx @rness/cli@latest upgrade (ADR 0012)')",
      '  process.exit(1)',
      '}',
      "console.log('PINNED 0.5.0 ' + args.join(' '))",
      '',
    ].join('\n')
  )
  const saved = process.env['FAKE_SYNC_FAIL']
  t.after(() => {
    if (saved === undefined) delete process.env['FAKE_SYNC_FAIL']
    else process.env['FAKE_SYNC_FAIL'] = saved
  })
  return stub
}

const API_CONTRACT_1 = contract1({
  org: 'acme',
  repos: { api: { url: 'https://github.com/acme/api.git' } },
  scopes: { api: { path: 'org/api' } },
})
const API_CONTRACT_2 =
  '{\n  "contract": 2,\n  "org": "acme",\n  "scopes": {\n    "api": { "url": "https://github.com/acme/api.git" }\n  }\n}\n'

test('a scaffold merge left staged by an upgrade whose sync failed is concluded by the next run: rewritten on contract 1, synced, one merge commit (spec 0038 §11)', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', bin: await failingSyncBin(t) })
  for (const [text, firstSince] of [
    // As 0.24.0 ran it: it knows no contract 2, the copy it installed does.
    [API_CONTRACT_1, '0.6.0'],
    [API_CONTRACT_2, '0.1.0'],
  ] as const) {
    const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
    const rnessDir = join(root, '.rness')
    const label = `${basename(root)}/.rness`
    await commitManifest(root, text)
    const head = await git(rnessDir, 'rev-parse', 'HEAD')
    process.env['FAKE_SYNC_FAIL'] = '1'
    const first = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {
      ...SAME_SCAFFOLD,
      contract2Since: firstSince,
    })
    delete process.env['FAKE_SYNC_FAIL']
    assert.equal(first.code, 1)
    assert.match(first.out, /^installed dependencies with npm$/m)
    assert.match(
      first.err,
      /rness\.json is contract 1: run npx @rness\/cli@latest upgrade/
    )
    await git(rnessDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    assert.equal(await read(root, 'rness.json'), text)

    // The scaffold merge of another target is not this run's to conclude.
    const other = await upgrade('0.6.0', { yes: true, cwd: root })
    assert.equal(other.code, 1)
    assert.match(other.err, /\.rness has a merge in progress; commit it/)

    const r = await upgrade(undefined, { yes: true, cwd: root })
    assert.equal(r.code, 0, r.err)
    assert.equal(
      r.out,
      [
        `resume   the upgrade to @rness/cli 0.5.0: its scaffold merge is staged in ${label}`,
        ...(text === API_CONTRACT_1
          ? [
              `rewrite  rness.json in ${label} as contract 2, for @rness/cli 0.5.0 (ADR 0012)`,
              'rewrote  rness.json as contract 2 (ADR 0012)',
            ]
          : []),
        'PINNED 0.5.0 sync --yes',
        `committed ${label}: chore: rness 0.5.0`,
        '',
        `upgraded ${label} to @rness/cli 0.5.0`,
        '',
        'Next:',
        '  git -C .rness push',
        '  # teammates: git pull, then any rness command (rness status) before opening Claude Code',
        '',
      ].join('\n')
    )
    // One commit: the merge, the scaffold's history and the rewrite in it.
    await assert.rejects(
      git(rnessDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    )
    assert.equal(
      await git(rnessDir, 'log', '-1', '--format=%s'),
      'chore: rness 0.5.0'
    )
    assert.equal(
      (await git(rnessDir, 'log', '-1', '--format=%P')).split(' ').length,
      2
    )
    assert.equal(await git(rnessDir, 'rev-parse', 'HEAD^1'), head)
    assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
    assert.equal(await read(root, 'rness.json'), API_CONTRACT_2)
    assert.equal(
      await read(root, 'package.json'),
      await scaffoldPackage('0.5.0')
    )
  }
})

test('concluding its merge, upgrade takes its own files only: an unrelated untracked or modified file stops it, nothing changed; the lockfile goes in', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', bin: await failingSyncBin(t) })
  /** A workspace whose upgrade to 0.5.0 stopped at the sync, its merge staged. */
  const staged = async (): Promise<string> => {
    const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
    await commitManifest(root, API_CONTRACT_2, {
      'notes.md': 'ours\n',
      'package-lock.json': '{}\n',
    })
    process.env['FAKE_SYNC_FAIL'] = '1'
    const first = await upgrade(undefined, { yes: true, cwd: root })
    delete process.env['FAKE_SYNC_FAIL']
    assert.equal(first.code, 1)
    await git(join(root, '.rness'), 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    return root
  }
  for (const [rel, content] of [
    ['draft.md', 'wip\n'],
    ['notes.md', 'ours, edited\n'],
  ] as const) {
    const root = await staged()
    const rnessDir = join(root, '.rness')
    await writeFile(join(rnessDir, rel), content)
    const head = await git(rnessDir, 'rev-parse', 'HEAD')
    const index = await git(rnessDir, 'write-tree')
    const r = await upgrade(undefined, { yes: true, cwd: root })
    assert.equal(r.code, 1, rel)
    assert.equal(
      r.err,
      `${basename(root)}/.rness has uncommitted changes; commit or stash them, then rness upgrade\n`,
      rel
    )
    assert.doesNotMatch(r.out, /resume|PINNED|committed/, rel)
    await git(rnessDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    assert.equal(await git(rnessDir, 'rev-parse', 'HEAD'), head, rel)
    assert.equal(await git(rnessDir, 'write-tree'), index, rel)
    assert.equal(await read(root, rel), content, rel)
  }

  // The lockfile, as the install rewrote it: concluded, the lockfile in.
  const root = await staged()
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'package-lock.json'),
    '{ "lockfileVersion": 3 }\n'
  )
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^resume {3}the upgrade to @rness\/cli 0\.5\.0/m)
  assert.match(r.out, /^committed .*: chore: rness 0\.5\.0$/m)
  assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
  assert.equal(
    await git(rnessDir, 'show', 'HEAD:package-lock.json'),
    '{ "lockfileVersion": 3 }'
  )
})

test('rewritten during a merge, rness.json is staged with it: after a failed sync, git merge --abort puts contract 1 back', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', bin: await failingSyncBin(t) })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await commitManifest(root, API_CONTRACT_1)
  process.env['FAKE_SYNC_FAIL'] = '1'
  const r = await upgrade(undefined, { yes: true, cwd: root })
  delete process.env['FAKE_SYNC_FAIL']
  assert.equal(r.code, 1)
  assert.match(r.out, /^rewrote {2}rness\.json as contract 2 \(ADR 0012\)$/m)
  assert.equal(await read(root, 'rness.json'), API_CONTRACT_2)
  assert.match(
    await git(rnessDir, 'diff', '--cached', '--name-only'),
    /^rness\.json$/m
  )
  assert.equal(await git(rnessDir, 'diff', '--name-only'), '')
  await git(rnessDir, 'merge', '--abort')
  assert.equal(await read(root, 'rness.json'), API_CONTRACT_1)
  assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
})

test('a failed install on a contract-1 file leaves rness.json as it was', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', fail: true })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await commitManifest(root, API_CONTRACT_1)
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(r.err, /npm install failed/)
  assert.doesNotMatch(r.out, /rewrote/)
  assert.equal(await read(root, 'rness.json'), API_CONTRACT_1)
  await git(rnessDir, 'merge', '--abort')
  assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
})

test('toward a release before contract 2: a contract-1 file left as it is, a contract-2 one refused before anything; from that release on, its pre-releases count', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const below: UpgradeDeps = { ...SAME_SCAFFOLD, contract2Since: '0.6.0' }

  // The target reads contract 1: today's flow, its repositories read from it.
  const old = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  await commitManifest(old, API_CONTRACT_1)
  const api = join(old, 'org', 'api')
  await mkdir(api, { recursive: true })
  await git(api, 'init', '-q', '-b', 'main')
  await git(api, 'commit', '-q', '--allow-empty', '-m', 'init')
  await writeFile(join(api, 'AGENTS.md'), 'block\n')
  const kept = await upgrade(undefined, { yes: true, cwd: old }, NO_TTY, below)
  assert.equal(kept.code, 0, kept.err)
  assert.doesNotMatch(kept.out, /rewrit/)
  assert.match(kept.out, /^PINNED 0\.5\.0 sync --yes$/m)
  assert.match(kept.out, /^committed .*: chore: rness 0\.5\.0$/m)
  assert.match(kept.out, /^ {2}git -C org\/api add AGENTS\.md && /m)
  assert.equal(await read(old, 'rness.json'), API_CONTRACT_1)

  // A contract-2 file the target cannot read: nothing merged or installed.
  const ahead = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  await commitManifest(ahead, API_CONTRACT_2)
  const head = await git(join(ahead, '.rness'), 'rev-parse', 'HEAD')
  const refused = await upgrade(
    undefined,
    { yes: true, cwd: ahead },
    NO_TTY,
    below
  )
  assert.equal(refused.code, 1)
  assert.equal(
    refused.err,
    'rness.json is contract 2; @rness/cli 0.5.0 reads contract 1 only: upgrade to 0.6.0 or later, or rewrite rness.json by hand\n'
  )
  assert.doesNotMatch(refused.out, /merging|installed|PINNED/)
  assert.equal(await git(join(ahead, '.rness'), 'rev-parse', 'HEAD'), head)
  assert.equal(await git(join(ahead, '.rness'), 'status', '--porcelain'), '')
  assert.equal(await read(ahead, 'rness.json'), API_CONTRACT_2)
  assert.equal(
    await read(ahead, 'package.json'),
    await scaffoldPackage('0.4.0')
  )
  assert.equal(await installedVersion(ahead), '0.4.0')

  // A pre-release of the first release reading contract 2 reads it too.
  const rc = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  await commitManifest(rc, API_CONTRACT_1)
  const rewritten = await upgrade(
    '0.6.0-rc.1',
    { yes: true, cwd: rc },
    NO_TTY,
    below
  )
  assert.equal(rewritten.code, 0, rewritten.err)
  assert.match(rewritten.out, /^rewrote {2}rness\.json as contract 2/m)
  assert.equal(await read(rc, 'rness.json'), API_CONTRACT_2)
})

const POLICY_FILES = [
  '.githooks/commit-msg',
  '.githooks/pre-push',
  'policy/no-force-push.md',
]

test('an existing workspace gets the policy example and the two hooks', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, {
    pin: '0.4.0',
    installed: '0.4.0',
    omit: POLICY_FILES,
  })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  for (const rel of POLICY_FILES) {
    assert.match(
      r.out,
      new RegExp(`^(added|updated)\\s+${rel.replace('.', '\\.')}$`, 'm'),
      rel
    )
    await access(join(root, '.rness', ...rel.split('/')))
  }
  for (const hook of ['commit-msg', 'pre-push'])
    assert.notEqual(
      (await stat(join(root, '.rness', '.githooks', hook))).mode & 0o111,
      0,
      hook
    )
})

test('a policy example turned on is kept when the scaffold changes another line of it', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  const file = join(rnessDir, 'policy', 'no-force-push.md')
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace(
      'status: Disabled',
      'status: Enabled'
    )
  )
  await git(rnessDir, 'commit', '-qam', 'docs: enable no-force-push')
  const next = await changedScaffold(
    t,
    'policy/no-force-push.md',
    (s) => `${s}\nA note from 0.5.0.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {
    scaffoldFor: async () => ({ dir: next }),
  })
  assert.equal(r.code, 0, r.err)
  const merged = await read(root, 'policy', 'no-force-push.md')
  assert.match(merged, /^status: Enabled$/m)
  assert.match(merged, /A note from 0\.5\.0\.\n$/)
})

test('overlapping edits conflict: nothing is installed; once resolved, a second run goes on', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(join(rnessDir, 'WORKSPACE.md'), 'Ours entirely.\n')
  await git(rnessDir, 'commit', '-qam', 'docs: ours')
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    () => 'Theirs entirely.\n'
  )
  const deps: UpgradeDeps = { scaffoldFor: async () => ({ dir: next }) }

  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, deps)
  assert.equal(r.code, 1)
  assert.match(r.err, /conflict WORKSPACE\.md/)
  assert.match(r.err, /git checkout --ours <file> keeps yours/)
  assert.doesNotMatch(r.out, /PINNED/)
  // The scaffold merge of the target, a path unmerged: not one to conclude.
  const unresolved = await upgrade(
    undefined,
    { yes: true, cwd: root },
    NO_TTY,
    deps
  )
  assert.equal(unresolved.code, 1)
  assert.match(unresolved.err, /\.rness has a merge in progress; commit it/)
  assert.doesNotMatch(unresolved.out, /resume|PINNED/)

  await git(rnessDir, 'checkout', '--ours', 'WORKSPACE.md')
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-q', '--no-edit')
  const again = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, deps)
  assert.equal(again.code, 0, again.err)
  assert.doesNotMatch(again.out, /merging/)
  assert.match(again.out, /^PINNED 0\.5\.0 sync --yes$/m)
  assert.equal(await read(root, 'WORKSPACE.md'), 'Ours entirely.\n')
})

test('adoption: no scaffold commit — identical files pass, a differing one conflicts once, a missing one is added', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, {
    pin: '0.5.0',
    installed: '0.5.0',
    subject: 'chore: baseline',
    trailer: null,
  })
  const rnessDir = join(root, '.rness')
  await rm(join(rnessDir, '.github', 'workflows', 'validate.yml'))
  await writeFile(join(rnessDir, 'CONVENTIONS.md'), 'Our conventions.\n')
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-qm', 'ours')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.out,
    /^adopting the @rness\/cli 0\.5\.0 scaffold \(no scaffold commit in .*\.rness yet\)$/m
  )
  assert.match(r.out, /^added {4}\.github\/workflows\/validate\.yml$/m)
  assert.match(r.err, /^.*conflict CONVENTIONS\.md$/m)
  assert.doesNotMatch(r.err, /README\.md/)
})

test('only the scaffold is behind (the pin moved by pull request): merged, synced, committed, nothing installed', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.5.0' })
  const rnessDir = join(root, '.rness')
  // What the Dependabot pull request does: the pin, nothing else.
  await writeFile(
    join(rnessDir, 'package.json'),
    await scaffoldPackage('0.5.0')
  )
  await git(
    rnessDir,
    'commit',
    '-qam',
    'chore(deps-dev): bump @rness/cli from 0.4.0 to 0.5.0'
  )
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    (s) => `${s}\nNew in 0.5.0.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {
    scaffoldFor: async () => ({ dir: next }),
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^scaffold @rness\/cli 0\.5\.0: merging it into /m)
  assert.match(r.out, /^updated {2}WORKSPACE\.md$/m)
  assert.doesNotMatch(r.out, /^installed|package\.json/m)
  // The sync runs all the same: a release may add to the agent files.
  assert.match(r.out, /^PINNED 0\.5\.0 sync --yes$/m)
  assert.match(r.out, /^committed .*\.rness: chore: rness 0\.5\.0$/m)
  // The merge commit: the pull request's history, and the scaffold's.
  assert.equal(
    await git(rnessDir, 'log', '-1', '--format=%s'),
    'chore: rness 0.5.0'
  )
  assert.equal(
    (await git(rnessDir, 'log', '-1', '--format=%P')).split(' ').length,
    2
  )
  assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
})

test('already at the target, scaffold included: nothing runs; a pin ahead of the installed copy is installed', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const done = await workspace(t, { pin: '0.5.0', installed: '0.5.0' })
  const r = await upgrade(undefined, { yes: true, cwd: done })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'already at 0.5.0\n')

  const drifted = await workspace(t, { pin: '0.5.0', installed: '0.4.0' })
  const r2 = await upgrade(undefined, { yes: true, cwd: drifted })
  assert.equal(r2.code, 0, r2.err)
  assert.match(
    r2.out,
    /^install {2}@rness\/cli 0\.5\.0 in .*\.rness \(npm\): 0\.4\.0 is installed\n/
  )
  assert.doesNotMatch(r2.out, /merging/)
  assert.match(r2.out, /^PINNED 0\.5\.0 sync --yes$/m)
})

test('a dirty .rness, or one that is not a repository, is refused before anything', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  await writeFile(join(root, '.rness', 'notes.md'), 'wip\n')
  const dirty = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(dirty.code, 1)
  assert.match(
    dirty.err,
    /\.rness has uncommitted changes; commit or stash them, then rness upgrade\n$/
  )
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))

  await rm(join(root, '.rness', '.git'), { recursive: true, force: true })
  const plain = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(plain.code, 1)
  assert.match(plain.err, /\.rness is not a git repository\n$/)
})

test('a failed install keeps the merge staged and says how to undo it', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', fail: true })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /npm install failed in .*: npm error notarget No matching version found for @rness\/cli\./
  )
  assert.match(r.err, /undo it with: git -C \.rness merge --abort/)
  await git(join(root, '.rness'), 'merge', '--abort')
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
})

test('npm pack is the source when neither the running nor the installed copy is the target', async (t) => {
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    (s) => `${s}\nFrom the registry.\n`
  )
  // Never the running version, whatever it is.
  await fakeNpm(t, { latest: '99.0.0', scaffold: next })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {})
  assert.equal(r.code, 0, r.err)
  assert.match(await read(root, 'WORKSPACE.md'), /From the registry\.\n$/)
  assert.equal(
    await read(root, 'package.json'),
    await scaffoldPackage('99.0.0')
  )
})

test('usage and refusals', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })

  const range = await upgrade('1.x', { yes: true, cwd: root })
  assert.equal(range.code, 2)
  assert.equal(
    range.err,
    'version "1.x" is not an exact version (for example 0.5.0)\n'
  )

  const noTty = await upgrade(undefined, { cwd: root })
  assert.equal(noTty.code, 2)
  assert.match(noTty.err, /pass --yes to run without a prompt/)

  const outside = await upgrade(undefined, { yes: true, cwd: '/' })
  assert.equal(outside.code, 1)
  assert.match(outside.err, /no rness workspace/)
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
})

test('the registry is asked only when no version is named; unreachable, it says what to type', async (t) => {
  await fakeNpm(t, {})
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.equal(
    r.err,
    'cannot reach the registry; name the version: rness upgrade <version>\n'
  )
  const named = await upgrade('0.6.0', { yes: true, cwd: root })
  assert.equal(named.code, 0, named.err)
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.6.0'))
})

test('a lower version is a downgrade only when it is named', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const ahead = await workspace(t, {
    pin: '0.6.0-rc.1',
    installed: '0.6.0-rc.1',
  })
  const r = await upgrade(undefined, { yes: true, cwd: ahead })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /pins @rness\/cli 0\.6\.0-rc\.1, newer than the latest release 0\.5\.0; to downgrade: rness upgrade 0\.5\.0\n$/
  )
  const named = await upgrade('0.5.0', { yes: true, cwd: ahead })
  assert.equal(named.code, 0, named.err)
  assert.match(
    named.out,
    /^upgrade {2}@rness\/cli 0\.6\.0-rc\.1 → 0\.5\.0 .*, downgrading\n/
  )
})

test('in a terminal one confirmation; declining writes nothing', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const asked: string[] = []
  const terminal = (answer: boolean): Terminal => ({
    isTty: () => true,
    prompts: async () =>
      ({
        async confirm(o: { message: string }) {
          asked.push(o.message)
          return answer
        },
        isCancel: () => false,
      }) as unknown as Prompts,
  })
  const no = await upgrade(undefined, { cwd: root }, terminal(false))
  assert.equal(no.code, 1)
  assert.equal(no.err, 'cancelled\n')
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
  assert.equal(await git(join(root, '.rness'), 'status', '--porcelain'), '')
  const yes = await upgrade(undefined, { cwd: root }, terminal(true))
  assert.equal(yes.code, 0, yes.err)
  assert.deepEqual(asked, [
    'Upgrade @rness/cli to 0.5.0?',
    'Upgrade @rness/cli to 0.5.0?',
  ])
})

test('a global older than the pin merges the scaffold of the copy installed in .rness', async (t) => {
  // The running copy (these sources) is not 0.5.0; the installed one is.
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.5.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'package.json'),
    await scaffoldPackage('0.5.0')
  )
  await git(
    rnessDir,
    'commit',
    '-qam',
    'chore(deps-dev): bump @rness/cli from 0.4.0 to 0.5.0'
  )
  const installed = join(rnessDir, 'node_modules', '@rness', 'cli', 'scaffold')
  await cp(scaffoldDir(), installed, { recursive: true })
  await writeFile(
    join(installed, 'WORKSPACE.md'),
    `${await readFile(join(installed, 'WORKSPACE.md'), 'utf8')}\nFrom the installed copy.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {})
  assert.equal(r.code, 0, r.err)
  assert.match(await read(root, 'WORKSPACE.md'), /From the installed copy\.\n$/)
  assert.doesNotMatch(r.out, /^installed/m, 'nothing to install')
  assert.match(r.out, /^PINNED 0\.5\.0 sync --yes$/m)
})

test('adoption adds no .gitkeep to a directory that already holds files', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, {
    pin: '0.5.0',
    installed: '0.5.0',
    subject: 'chore: baseline',
    trailer: null,
  })
  const rnessDir = join(root, '.rness')
  await rm(join(rnessDir, 'specs', '.gitkeep'))
  await writeFile(join(rnessDir, 'specs', '0001-first.md'), '# First\n')
  await rm(join(rnessDir, 'plans'), { recursive: true })
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-qm', 'ours')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.doesNotMatch(r.out, /specs\/\.gitkeep/)
  assert.match(r.out, /^added {4}plans\/\.gitkeep$/m)
})

test('a hook refusing the commit: exit 1, everything staged, what the hook said and the commit to make', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  // Inside .git: a hook that is no file of the tree.
  const hooks = join(rnessDir, '.git', 'test-hooks')
  await mkdir(hooks)
  await writeFile(
    join(hooks, 'pre-commit'),
    '#!/bin/sh\necho "org/api/.mcp.json: mcpServers.rness is missing (run rness sync)" >&2\nexit 1\n',
    { mode: 0o755 }
  )
  await git(rnessDir, 'config', 'core.hooksPath', hooks)
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /^org\/api\/\.mcp\.json: mcpServers\.rness is missing \(run rness sync\)$/m
  )
  assert.match(r.err, /the commit of .*\.rness was refused/)
  assert.match(r.out, /^ {2}git -C \.rness commit -m "chore: rness 0\.5\.0"$/m)
  assert.doesNotMatch(r.out, /git -C \.rness push/)
  // The merge waits, everything staged.
  await git(rnessDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
  assert.equal(await git(rnessDir, 'diff', '--name-only'), '')
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.5.0'))
})

test('a merge in progress in .rness is refused before anything', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await git(rnessDir, 'checkout', '-q', '-b', 'side')
  await git(rnessDir, 'commit', '-q', '--allow-empty', '-m', 'side')
  await git(rnessDir, 'checkout', '-q', 'main')
  await git(rnessDir, 'merge', '-q', '--no-commit', '--no-ff', 'side')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /\.rness has a merge in progress; commit it, or abort it with git -C \.rness merge --abort, then rness upgrade\n$/
  )
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
})

test('next steps name, per repository, the files sync writes that changed — nothing else', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({
      contract: 2,
      org: 'acme',
      agents: ['claude'],
      scopes: {
        api: { url: 'https://github.com/acme/api.git' },
        web: { url: 'https://github.com/acme/web.git' },
      },
    })
  )
  await git(rnessDir, 'commit', '-qam', 'chore: two repositories')
  for (const repo of ['api', 'web']) {
    const dir = join(root, 'org', repo)
    await mkdir(dir, { recursive: true })
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  // What a sync writes (the fake pinned copy writes nothing), and a
  // developer's own file, which is none of upgrade's business.
  const api = join(root, 'org', 'api')
  await writeFile(join(api, 'AGENTS.md'), 'block\n')
  await writeFile(join(api, '.mcp.json'), '{}\n')
  await writeFile(join(api, 'notes.md'), 'mine\n')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^ {2}git -C org\/api add \.mcp\.json AGENTS\.md && git -C org\/api commit -m "chore: rness 0\.5\.0"$/m
  )
  assert.doesNotMatch(r.out, /org\/web|notes\.md/)
})

test('next steps also name the files only the new copy writes: it is asked, this copy may not know them', async (t) => {
  // The installed copy answers `written-files` with a file this running copy
  // has never heard of — as 0.14.0's skills were to 0.13.0.
  const stub = join(await mkdtemp(join(tmpdir(), 'rness-bin-')), 'rness.js')
  t.after(() => rm(dirname(stub), { recursive: true, force: true }))
  await writeFile(
    stub,
    [
      'const args = process.argv.slice(2)',
      "if (args[0] === 'written-files') console.log(JSON.stringify(['AGENTS.md', '.claude/skills/rness/skills/new/SKILL.md']))",
      "else console.log('PINNED ' + args.join(' '))",
      '',
    ].join('\n')
  )
  await fakeNpm(t, { latest: '0.5.0', bin: stub })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({
      contract: 2,
      org: 'acme',
      agents: ['claude'],
      scopes: { api: { url: 'https://github.com/acme/api.git' } },
    })
  )
  await git(rnessDir, 'commit', '-qam', 'chore: a repository')
  const api = join(root, 'org', 'api')
  await mkdir(api, { recursive: true })
  await git(api, 'init', '-q', '-b', 'main')
  await git(api, 'commit', '-q', '--allow-empty', '-m', 'init')
  // What the new copy's sync wrote: a file of its own, and one both know.
  await mkdir(join(api, '.claude', 'skills', 'rness', 'skills', 'new'), {
    recursive: true,
  })
  await writeFile(
    join(api, '.claude', 'skills', 'rness', 'skills', 'new', 'SKILL.md'),
    'new\n'
  )
  await writeFile(join(api, '.mcp.json'), '{}\n')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^ {2}git -C org\/api add \.claude\/skills\/rness\/skills\/new\/SKILL\.md \.mcp\.json && git -C org\/api commit -m "chore: rness 0\.5\.0"$/m
  )
})
