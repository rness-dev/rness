import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { checkContract } from '../../src/core/contract.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { readPolicy } from '../../src/core/policy.ts'
import { SCAFFOLD_FILES, scaffoldDir } from '../../src/core/scaffold.ts'

test('every scaffold file exists', async () => {
  for (const rel of SCAFFOLD_FILES)
    await access(join(scaffoldDir(), ...rel.split('/')))
})

test('the scaffold ships _gitignore, never .gitignore', async () => {
  assert.ok(SCAFFOLD_FILES.includes('_gitignore'))
  await assert.rejects(access(join(scaffoldDir(), '.gitignore')))
})

test('the scaffold manifest is a valid empty workspace', async () => {
  const m = await loadManifest(scaffoldDir())
  assert.deepEqual(m, {
    contract: 1,
    provider: null,
    org: null,
    agents: null,
    boards: null,
    repos: {},
    scopes: {},
  })
})

test('the scaffold passes the contract (template ADR is skipped)', async () => {
  assert.deepEqual(await checkContract(scaffoldDir()), [])
})

test('package.json carries the tokens create replaces; the workflow names no version', async () => {
  const raw = await readFile(join(scaffoldDir(), 'package.json'), 'utf8')
  assert.match(raw, /"@rness\/cli": "__RNESS_VERSION__"/)
  assert.match(raw, /"packageManager": "__RNESS_PM__"/)
  assert.doesNotThrow(() => JSON.parse(raw))
  const workflow = await readFile(
    join(scaffoldDir(), '.github', 'workflows', 'validate.yml'),
    'utf8'
  )
  assert.doesNotMatch(workflow, /__RNESS_/)
  assert.match(workflow, /require\('\.\/package\.json'\)\.devDependencies/)
})

test('the scaffold ships a dependabot configuration for the pin', async () => {
  assert.ok(SCAFFOLD_FILES.includes('.github/dependabot.yml'))
  const text = await readFile(
    join(scaffoldDir(), '.github', 'dependabot.yml'),
    'utf8'
  )
  assert.match(text, /package-ecosystem: npm/)
  assert.match(text, /dependency-name: "@rness\/cli"/)
  assert.match(text, /interval: weekly/)
  // Dependabot's default 3-day cooldown stays on: for the organizations that
  // adopt rness, @rness/cli is a third-party package. The file says how to
  // lift it, in a comment, and never does it itself.
  assert.doesNotMatch(text, /^\s*cooldown:/m)
  assert.match(text, /^#\s+cooldown:$/m)
})

test('the scaffold ships the policy example, disabled, and the two hooks', async () => {
  for (const rel of [
    'policy/no-force-push.md',
    '.githooks/commit-msg',
    '.githooks/pre-push',
  ])
    assert.ok(SCAFFOLD_FILES.includes(rel), rel)
  const text = await readFile(
    join(scaffoldDir(), 'policy', 'no-force-push.md'),
    'utf8'
  )
  const { policy, problems } = readPolicy('policy/no-force-push.md', text)
  assert.deepEqual(problems, [])
  assert.equal(policy?.status, 'Disabled')
  assert.equal(policy?.title, 'No force push')
  assert.deepEqual(
    policy?.rules.map((r) => [r.check, r.deny]),
    [['push', 'non-fast-forward']]
  )
  assert.doesNotMatch(text, /\u2014/)
})

test('CONVENTIONS.md names the Policy role and its statuses', async () => {
  const text = await readFile(join(scaffoldDir(), 'CONVENTIONS.md'), 'utf8')
  assert.match(text, /\*\*Policy\*\* \(`policy\/`\)/)
  assert.match(text, /^\| Policy \| `Enabled`, `Disabled` \|$/m)
  assert.match(text, /not numbered/)
})

/** Runs a scaffold hook from a copy of `.rness` whose CLI is `cli` (a sh body), or absent. */
async function runHook(
  hook: string,
  cli: string | null
): Promise<{ code: number; err: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-hook-'))
  try {
    await cp(join(scaffoldDir(), '.githooks'), join(dir, '.githooks'), {
      recursive: true,
    })
    if (cli !== null) {
      const bin = join(dir, 'node_modules', '.bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, 'rness'), `#!/bin/sh\n${cli}\n`)
      await chmod(join(bin, 'rness'), 0o755)
    }
    try {
      const { stderr } = await promisify(execFile)(
        join(dir, '.githooks', hook),
        ['arg']
      )
      return { code: 0, err: stderr }
    } catch (e) {
      const f = e as { code: number; stderr: string }
      return { code: f.code, err: f.stderr }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

for (const hook of ['commit-msg', 'pre-push']) {
  test(`${hook}: refusal 20 blocks, 0 passes, another status fails open, a missing CLI fails open`, async () => {
    const calls =
      '[ "$1 $2 $3 $4" = "policy check ' + hook + ' arg" ] || exit 9;'
    assert.deepEqual(await runHook(hook, 'exit 20'), { code: 1, err: '' })
    assert.deepEqual(await runHook(hook, `${calls} exit 0`), {
      code: 0,
      err: '',
    })
    assert.deepEqual(await runHook(hook, 'exit 3'), {
      code: 0,
      err: 'rness: policies not checked: the rness CLI exited 3\n',
    })
    assert.deepEqual(await runHook(hook, null), {
      code: 0,
      err: 'rness: policies not checked: the rness CLI is not installed in .rness\n',
    })
  })
}

test('pre-commit: validate fails closed, then the policy check maps 20 to a refusal', async () => {
  assert.equal((await runHook('pre-commit', 'exit 5')).code, 5)
  assert.notEqual((await runHook('pre-commit', null)).code, 0)
  assert.deepEqual(
    await runHook(
      'pre-commit',
      '[ "$1" = validate ] && exit 0; [ "$3" = pre-commit ] && exit 20; exit 9'
    ),
    { code: 1, err: '' }
  )
  assert.equal(
    (
      await runHook(
        'pre-commit',
        '[ "$1" = validate ] && exit 0; [ "$3" = pre-commit ] && exit 0; exit 9'
      )
    ).code,
    0
  )
  const other = await runHook(
    'pre-commit',
    '[ "$1" = validate ] && exit 0; exit 4'
  )
  assert.equal(other.code, 0)
  assert.match(other.err, /the rness CLI exited 4/)
})
