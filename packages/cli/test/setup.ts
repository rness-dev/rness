// Loaded before every test file (`node --import`). Run from a terminal,
// `node --test` sets FORCE_COLOR=1 in its children: the CLI would then paint
// its output, and every assertion on plain text would fail there while
// passing in CI. Tests that want colour set it themselves.
delete process.env['FORCE_COLOR']
delete process.env['NO_COLOR']
