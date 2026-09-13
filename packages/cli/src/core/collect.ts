import { glob, readFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'

import {
  extractTitle,
  parseFrontMatter,
  stripFrontMatter,
} from './frontmatter.ts'
import type { MarkdownItem } from './types.ts'

function toPosix(rel: string): string {
  return rel.split(sep).join(posix.sep)
}

/**
 * Every `*.md` under `dir`, recursively, sorted by `rel`. A missing directory
 * yields []. A file whose front matter fails to parse is kept with
 * `fields: null` and the error in `fieldsError`, so one broken file cannot
 * hide a whole collection.
 */
export async function collectMarkdown(dir: string): Promise<MarkdownItem[]> {
  const rels: string[] = []
  for await (const rel of glob('**/*.md', { cwd: dir })) rels.push(toPosix(rel))
  const items = await Promise.all(
    rels.map(async (rel): Promise<MarkdownItem> => {
      const path = join(dir, ...rel.split(posix.sep))
      const body = await readFile(path, 'utf8')
      let fields: MarkdownItem['fields'] = null
      let fieldsError: string | null = null
      try {
        fields = parseFrontMatter(body)
      } catch (e) {
        fieldsError = e instanceof Error ? e.message : String(e)
      }
      return {
        path,
        rel,
        fields,
        fieldsError,
        title: extractTitle(body),
        body,
        content: stripFrontMatter(body),
      }
    })
  )
  return items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}
