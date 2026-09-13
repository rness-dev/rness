import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  detectPackageManager,
  isPackageManager,
  packageManagerVersion,
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
