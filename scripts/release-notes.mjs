// The GitHub release of a tag (the Release workflow): its notes are
// the version's section of the CLI changelog, `## 0.20.1 — <tagline>` in
// packages/cli/README.md, its title `v0.20.1: <tagline>`. `--title` prints the
// title, otherwise the notes. A version with no section fails rather than
// leave a release empty: write it on main, then run Release by hand.
import { readFile } from 'node:fs/promises'

const CHANGELOG = 'packages/cli/README.md' // run from the repository root
const FULL_CHANGELOG =
  'https://github.com/rness-dev/rness/blob/main/packages/cli/README.md'

// GitHub draws every line break of a release body, so the wrapped lines of a
// paragraph or a list item are joined. A line that opens a block stays on its
// own; fenced code, and indented code after a blank line, stay verbatim.
// Nothing joins a heading, a table row or a fence either.
const OPENS_A_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|#|>|\||```)/
const STANDS_ALONE = /^\s*(?:#|\||```)/

function unwrap(lines) {
  const out = []
  let fence = false
  let code = false
  for (const line of lines) {
    const previous = out.at(-1)
    if (line.trimStart().startsWith('```')) fence = !fence
    else if (fence) {
      // verbatim
    } else if (previous === undefined || previous.trim() === '') {
      code = /^ {4}/.test(line) && !OPENS_A_BLOCK.test(line)
    } else if (
      line.trim() !== '' &&
      !code &&
      !OPENS_A_BLOCK.test(line) &&
      !STANDS_ALONE.test(previous)
    ) {
      out[out.length - 1] = `${previous} ${line.trim()}`
      continue
    }
    out.push(line)
  }
  return out
}

function trimBlankLines(lines) {
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1) return []
  const last = lines.findLastIndex((l) => l.trim() !== '')
  return lines.slice(first, last + 1)
}

const args = process.argv.slice(2)
const tag = args.find((a) => !a.startsWith('--'))
if (tag === undefined) {
  console.error('usage: node scripts/release-notes.mjs vX.Y.Z [--title]')
  process.exit(2)
}
const version = tag.replace(/^v/, '')
const lines = (await readFile(CHANGELOG, 'utf8')).split('\n')
const heading = `## ${version} — `
const start = lines.findIndex((l) => l.startsWith(heading))
if (start === -1) {
  console.error(
    `packages/cli/README.md has no "${heading}…" section: write it on main, then run the Release workflow for this tag`
  )
  process.exit(1)
}
const next = lines.findIndex((l, i) => i > start && l.startsWith('## '))
const section = trimBlankLines(
  lines.slice(start + 1, next === -1 ? lines.length : next)
)
if (section.length === 0) {
  console.error(
    `the "${heading}…" section is empty: write it on main, then run the Release workflow for this tag`
  )
  process.exit(1)
}

if (args.includes('--title')) {
  console.log(`v${version}: ${lines[start].slice(heading.length).trim()}`)
} else {
  const create = 'npm create rness'
  const upgrade = `pnpm rness upgrade ${version}`
  const width = Math.max(create.length, upgrade.length) + 2
  console.log(
    [
      ...unwrap(section),
      '',
      `Full changelog: ${FULL_CHANGELOG}`,
      '',
      '```bash',
      `${create.padEnd(width)}# a new workspace`,
      `${upgrade.padEnd(width)}# an existing one, from .rness/`,
      '```',
    ].join('\n')
  )
}
