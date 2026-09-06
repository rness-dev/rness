// Minimal front matter reader for this scaffold. Metadata intentionally uses a
// small YAML subset: a top-level string mapping plus literal blocks. Keeping
// the parser local makes the maintenance utilities runnable after a clone
// without downloading a package.

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FIELD = /^([^:#][^:]*):(?:[ ](.*))?$/
const LITERAL = /^([^:#][^:]*):\s*\|\s*$/

function scalar(value) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseBlock(lines) {
  const fields = {}

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '' || line.trimStart().startsWith('#')) continue

    const literal = line.match(LITERAL)
    if (literal) {
      const values = []
      index += 1
      while (index < lines.length && /^(  |\t)/.test(lines[index])) {
        values.push(lines[index].replace(/^(  |\t)/, ''))
        index += 1
      }
      index -= 1
      fields[literal[1].trim()] = `${values.join('\n')}\n`
      continue
    }

    const field = line.match(FIELD)
    if (!field) return null
    fields[field[1].trim()] = scalar(field[2] ?? '')
  }

  return fields
}

export function parseFrontMatter(source) {
  const block = source.match(FRONT_MATTER)?.[1]
  if (block === undefined) return null
  if (block.trim() === '') return {}
  return parseBlock(block.split(/\r?\n/))
}

export function extractTitle(source) {
  return source.match(/^# (.+)$/m)?.[1].trim() ?? null
}
