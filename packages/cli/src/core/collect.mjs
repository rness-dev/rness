import { readdir, readFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import { parseFrontMatter, extractTitle } from './frontmatter.mjs'

async function walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full)
  }
  return files
}

export async function collectMarkdown(dir) {
  const files = await walk(dir)
  const items = await Promise.all(
    files.map(async (path) => {
      const body = await readFile(path, 'utf8')
      const rel = path.slice(dir.length + 1).split(sep).join(posix.sep)
      return { path, rel, fields: parseFrontMatter(body), title: extractTitle(body), body }
    }),
  )
  return items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}
