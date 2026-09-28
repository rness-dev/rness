import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  detectPackageManager,
  frozenArgs,
  installErrorLine,
  isPackageManager,
  packageManagerVersion,
  rnessCommand,
  rnessRunner,
} from '../../src/core/pm.ts'

test('detects the package manager from the npm user agent, npm by default', () => {
  assert.equal(
    detectPackageManager('pnpm/12.2.1 npm/? node/v24.16.0 darwin arm64'),
    'pnpm'
  )
  assert.equal(detectPackageManager('yarn/4.5.0 npm/? node/v24.16.0'), 'yarn')
  assert.equal(detectPackageManager('bun/1.1.34 npm/? node/v24.16.0'), 'bun')
  assert.equal(
    detectPackageManager('npm/11.13.0 node/v24.16.0 darwin arm64'),
    'npm'
  )
  assert.equal(detectPackageManager(''), 'npm')
  assert.equal(detectPackageManager('cargo/1.0'), 'npm')
})

test('rnessRunner: the rness CLI without a global install, per manager', () => {
  assert.equal(rnessRunner('npm', '11.13.0'), 'npx @rness/cli')
  assert.equal(rnessRunner('pnpm', '12.2.1'), 'pnpm dlx @rness/cli')
  assert.equal(rnessRunner('bun', '1.1.34'), 'bunx @rness/cli')
  assert.equal(rnessRunner('yarn', '4.5.0'), 'yarn dlx @rness/cli')
  assert.equal(rnessRunner('yarn', '2.0.0'), 'yarn dlx @rness/cli')
  // Yarn 1 has no dlx, and an unknown yarn may be one: npx comes with Node.
  assert.equal(rnessRunner('yarn', '1.22.22'), 'npx @rness/cli')
  assert.equal(rnessRunner('yarn', null), 'npx @rness/cli')
})

test('rnessCommand: how the user launched rness, to type it again', () => {
  // No package manager in between: the `rness` they typed (a global install).
  assert.equal(rnessCommand({}), 'rness')
  assert.equal(rnessCommand({ npm_config_user_agent: '' }), 'rness')
  const agent = (ua: string) => rnessCommand({ npm_config_user_agent: ua })
  assert.equal(
    agent('npm/11.13.0 node/v24.16.0 darwin arm64'),
    'npx @rness/cli'
  )
  assert.equal(
    agent('pnpm/12.5.1 npm/? node/? darwin arm64'),
    'pnpm dlx @rness/cli'
  )
  assert.equal(agent('bun/1.3.14 npm/? node/v24.3.0'), 'bunx @rness/cli')
  assert.equal(agent('yarn/4.5.0 npm/? node/v24.16.0'), 'yarn dlx @rness/cli')
  assert.equal(agent('yarn/1.22.22 npm/? node/v24.16.0'), 'npx @rness/cli')
})

test('isPackageManager guards the --pm flag', () => {
  assert.equal(isPackageManager('pnpm'), true)
  assert.equal(isPackageManager('cargo'), false)
})

test('packageManagerVersion asks the binary; an absent one is a one-line error', async () => {
  assert.match(await packageManagerVersion('npm'), /^\d+\.\d+\.\d+/)
  await assert.rejects(
    packageManagerVersion('bun-does-not-exist' as 'bun'),
    /is not available on PATH/
  )
})

test("installErrorLine skips npm's bare error code for the line that says what is wrong", () => {
  assert.equal(
    installErrorLine(
      'npm error code ETARGET\nnpm error notarget No matching version found for @rness/cli@0.4.0.\nnpm error notarget In most cases you or one of your dependencies are requesting\n'
    ),
    'npm error notarget No matching version found for @rness/cli@0.4.0.'
  )
  assert.equal(
    installErrorLine(
      'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry/x\n'
    ),
    'npm ERR! 404 Not Found - GET https://registry/x'
  )
  // Nothing better than the code: keep it.
  assert.equal(
    installErrorLine('\nnpm error code EACCES\n'),
    'npm error code EACCES'
  )
  // Other package managers lead with the useful line.
  assert.equal(
    installErrorLine(
      ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @rness/cli@0.4.0\n'
    ),
    'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @rness/cli@0.4.0'
  )
  assert.equal(installErrorLine(''), 'unknown error')
})

test('frozenArgs: each manager has its own immutable install', () => {
  assert.deepEqual(frozenArgs('npm'), ['ci'])
  assert.deepEqual(frozenArgs('pnpm'), ['install', '--frozen-lockfile'])
  assert.deepEqual(frozenArgs('yarn'), ['install', '--immutable'])
  assert.deepEqual(frozenArgs('bun'), ['install', '--frozen-lockfile'])
})
