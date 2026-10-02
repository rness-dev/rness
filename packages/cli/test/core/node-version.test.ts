import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MIN_NODE,
  MIN_NODE_LABEL,
  isSupportedNode,
  nodeMajor,
} from '../../src/core/node-version.ts'

test('nodeMajor reads the major component', () => {
  assert.equal(nodeMajor('24.16.0'), 24)
  assert.equal(nodeMajor('22.1.0'), 22)
})

test('the floor is Node 22.17 (ADR 0010), compared on major and minor', () => {
  assert.deepEqual(MIN_NODE, { major: 22, minor: 17 })
  assert.equal(MIN_NODE_LABEL, '22.17')
  assert.equal(isSupportedNode('22.17.0'), true)
  assert.equal(isSupportedNode('22.22.0'), true)
  assert.equal(isSupportedNode('23.0.0'), true)
  assert.equal(isSupportedNode('24.0.0'), true)
  assert.equal(isSupportedNode('25.3.1'), true)
  assert.equal(isSupportedNode('22.16.9'), false)
  assert.equal(isSupportedNode('22.0.0'), false)
  assert.equal(isSupportedNode('20.19.0'), false)
  assert.equal(isSupportedNode('nonsense'), false)
  assert.equal(isSupportedNode('22'), false)
})
