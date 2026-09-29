import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  type Look,
  pageSize,
  press,
  renderView,
} from '../../src/core/status-view.ts'
import type { StatusTab } from '../../src/core/status.ts'

/** Plain text; the active tab between brackets, a missing status marked. */
const LOOK: Look = {
  bold: (s) => s,
  dim: (s) => s,
  inverse: (s) => `[${s.slice(1, -1)}]`,
  tone: (tone, s) => (tone === 'missing' ? s.replace('?', '!') : s),
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: String(n - i).padStart(4, '0'),
    title: `Document ${n - i}`,
    status: i % 2 === 0 ? 'Draft' : 'Completed',
    path: `plans/${n - i}.md`,
  }))

const TABS: StatusTab[] = [
  { name: 'adr', label: 'ADR', rows: [] },
  {
    name: 'specs',
    label: 'Specs',
    rows: [
      {
        id: '0016',
        title: 'A title long enough to be cut at this width',
        status: 'Approved',
        path: 'specs/0016.md',
      },
      { id: '0001', title: 'Short', status: null, path: 'specs/0001.md' },
    ],
  },
  { name: 'plans', label: 'Plans', rows: rows(30) },
]

test('the header, the tab bar with the active tab, rows cut to the width, the footer', () => {
  assert.deepEqual(renderView({ tab: 1, top: 0 }, TABS, 'acme', 50, 8, LOOK), [
    ' rness · acme',
    '  ADR (0)  [Specs (2)]  Plans (30) ',
    ` ${'─'.repeat(48)}`,
    '  0016  A title long enough to be cut…   Approved',
    '  0001  Short                            !       ',
    '',
    ` ${'─'.repeat(48)}`,
    '  ←/→ tab · ↑/↓ scroll · q close',
  ])
})

test('an empty tab says so', () => {
  const lines = renderView({ tab: 0, top: 0 }, TABS, 'acme', 50, 8, LOOK)
  assert.equal(lines[1], ' [ADR (0)]  Specs (2)   Plans (30) ')
  assert.equal(lines[3], '  Nothing here yet.')
})

test('a long tab shows a page and counts what is above and below', () => {
  const lines = renderView({ tab: 2, top: 5 }, TABS, 'acme', 50, 10, LOOK)
  assert.equal(pageSize(10), 5)
  assert.deepEqual(lines.slice(3, 8), [
    '  0025  Document 25                     Completed',
    '  0024  Document 24                     Draft    ',
    '  0023  Document 23                     Completed',
    '  0022  Document 22                     Draft    ',
    '  0021  Document 21                     Completed',
  ])
  // At 50 columns the footer is cut; the counts come first.
  assert.equal(lines[9], '  ↑ 5 above · ↓ 20 more · ←/→ tab · ↑/↓ scroll · q')
})

test('keys: tabs wrap and reset the scroll; lines, pages and ends are clamped', () => {
  const page = 5
  const at = (tab: number, top: number) => ({ tab, top })
  assert.deepEqual(press(at(2, 7), 'right', TABS, page), at(0, 0))
  assert.deepEqual(press(at(0, 0), 'left', TABS, page), at(2, 0))
  assert.deepEqual(press(at(1, 0), 'tab', TABS, page), at(2, 0))
  assert.deepEqual(press(at(0, 0), 'backtab', TABS, page), at(2, 0))
  assert.deepEqual(press(at(2, 0), 'down', TABS, page), at(2, 1))
  assert.deepEqual(press(at(2, 0), 'up', TABS, page), at(2, 0))
  assert.deepEqual(press(at(2, 0), 'pagedown', TABS, page), at(2, 5))
  assert.deepEqual(press(at(2, 23), 'pagedown', TABS, page), at(2, 25))
  assert.deepEqual(press(at(2, 3), 'pageup', TABS, page), at(2, 0))
  assert.deepEqual(press(at(2, 3), 'end', TABS, page), at(2, 25))
  assert.deepEqual(press(at(2, 9), 'home', TABS, page), at(2, 0))
  // A tab shorter than a page does not scroll.
  assert.deepEqual(press(at(1, 0), 'down', TABS, page), at(1, 0))
})

test('a terminal smaller than the frame still renders, one row at least', () => {
  const lines = renderView({ tab: 2, top: 0 }, TABS, 'acme', 12, 3, LOOK)
  assert.equal(lines.length, 3)
  assert.equal(pageSize(3), 1)
  for (const line of renderView({ tab: 1, top: 0 }, TABS, 'acme', 4, 8, LOOK))
    assert.ok([...line].length <= 4, line)
})
