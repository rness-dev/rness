import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupportedNode, nodeMajor } from '../../src/core/node-version.ts'

test('nodeMajor reads the major component', () => {
  assert.equal(nodeMajor('24.16.0'), 24)
  assert.equal(nodeMajor('22.1.0'), 22)
})

test('Node 24 and newer are supported, older are not', () => {
  assert.equal(isSupportedNode('24.0.0'), true)
  assert.equal(isSupportedNode('25.3.1'), true)
  assert.equal(isSupportedNode('22.20.0'), false)
  assert.equal(isSupportedNode('nonsense'), false)
})
