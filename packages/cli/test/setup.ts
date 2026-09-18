import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Loaded before every test file (`node --import`). Run from a terminal,
// `node --test` sets FORCE_COLOR=1 in its children: the CLI would then paint
// its output, and every assertion on plain text would fail there while
// passing in CI. Tests that want colour set it themselves.
delete process.env['FORCE_COLOR']
delete process.env['NO_COLOR']

// The stored GitHub login lives under the config directory: tests must never
// read — or overwrite — the developer's own. Every test process gets an
// empty one; a test that needs a login sets its own.

process.env['XDG_CONFIG_HOME'] = mkdtempSync(
  join(tmpdir(), 'rness-test-config-')
)
