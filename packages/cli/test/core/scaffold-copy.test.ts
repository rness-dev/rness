import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { copyScaffold, renderScaffold } from '../../src/core/scaffold-copy.ts'
import { SCAFFOLD_FILES, scaffoldDir } from '../../src/core/scaffold.ts'

test('copies every scaffold file, renames _gitignore, replaces the tokens, keeps the hook executable', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-scaffold-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dest = join(base, '.rness')
  await copyScaffold(dest, { version: '9.9.9', packageManager: 'pnpm@12.2.1' })
  for (const rel of SCAFFOLD_FILES) {
    if (rel === 'rness.json') continue
    await access(
      join(dest, ...(rel === '_gitignore' ? ['.gitignore'] : rel.split('/')))
    )
  }
  await assert.rejects(access(join(dest, '_gitignore')))
  await assert.rejects(access(join(dest, 'rness.json')))
  const pkg = JSON.parse(
    await readFile(join(dest, 'package.json'), 'utf8')
  ) as { packageManager: string; devDependencies: Record<string, string> }
  assert.equal(pkg.devDependencies['@rness/cli'], '9.9.9')
  assert.equal(pkg.packageManager, 'pnpm@12.2.1')
  // The workflow names no version: it reads the pin, the one place it is
  // written (spec 0006 §2). Its shell expression is run here as CI would.
  const workflow = await readFile(
    join(dest, '.github', 'workflows', 'validate.yml'),
    'utf8'
  )
  assert.doesNotMatch(workflow, /__RNESS_|9\.9\.9/)
  const line = /^ +- run: (npx --yes "@rness\/cli@\$\(.+\)" validate)$/m.exec(
    workflow
  )?.[1]
  assert.ok(line, workflow)
  const { stdout } = await promisify(execFile)(
    'sh',
    ['-c', line.replace(/^npx --yes/, 'echo').replace(/ validate$/, '')],
    { cwd: dest }
  )
  assert.equal(stdout.trim(), '@rness/cli@9.9.9')
  assert.doesNotMatch(
    await readFile(join(dest, 'package.json'), 'utf8'),
    /__RNESS_/
  )
  const mode = (await stat(join(dest, '.githooks', 'pre-commit'))).mode & 0o111
  assert.notEqual(mode, 0, 'pre-commit keeps its executable bit')
})

test('renderScaffold: the files a version writes, tokens filled, no rness.json (spec 0013 §1)', async () => {
  const files = await renderScaffold(scaffoldDir(), {
    version: '9.9.9',
    packageManager: 'pnpm@12.2.1',
  })
  const paths = files.map((f) => f.path)
  assert.deepEqual(
    paths,
    SCAFFOLD_FILES.filter((p) => p !== 'rness.json').map((p) =>
      p === '_gitignore' ? '.gitignore' : p
    )
  )
  const pkg = files.find((f) => f.path === 'package.json')
  assert.ok(pkg)
  assert.match(pkg.content, /"@rness\/cli": "9\.9\.9"/)
  assert.match(pkg.content, /"packageManager": "pnpm@12\.2\.1"/)
  assert.equal(
    files.find((f) => f.path === '.githooks/pre-commit')?.executable,
    true
  )
  assert.equal(files.find((f) => f.path === 'AGENTS.md')?.executable, false)
})
