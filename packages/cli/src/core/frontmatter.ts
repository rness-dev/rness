import { parse } from 'yaml'
import type { Fields } from './types.ts'

// The inner group is optional so that `---\n---\n` (an empty block with no line
// between the fences) is still recognised as front matter.
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/

function fail(message: string): never {
  throw new Error(`front matter: ${message}`)
}

/** Strip a leading UTF-8 BOM so `---` is still recognised as the first thing in the file. */
function stripBom(source: string): string {
  return source.startsWith('﻿') ? source.slice(1) : source
}

/**
 * Parse the leading `---` block as YAML (1.2 core schema: `2026-09-07` stays a
 * string, `1` becomes a number). Returns null when there is no block, `{}`
 * for an empty block, and throws a `front matter:`-prefixed error when the
 * YAML is invalid or is not a mapping.
 */
export function parseFrontMatter(source: string): Fields | null {
  const match = stripBom(source).match(FRONT_MATTER)
  if (match === null) return null
  const block = match[1] ?? ''
  if (block.trim() === '') return {}
  let doc: unknown
  try {
    // 'error': suppress the printed YAMLWarning (e.g. an unresolved `!!tag`)
    // without silencing real parse errors — `logLevel: 'silent'` would do that too.
    doc = parse(block, { logLevel: 'error' })
  } catch (e) {
    fail(e instanceof Error ? (e.message.split('\n')[0] ?? 'invalid YAML').replace(/:$/, '') : 'invalid YAML')
  }
  if (doc === null || doc === undefined) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) fail('block must be a mapping of keys to values')
  return doc as Fields
}

export function extractTitle(source: string): string | null {
  return stripBom(source).match(/^# (.+)$/m)?.[1]?.trim() ?? null
}
