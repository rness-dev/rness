import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { stripFrontMatter } from '../core/frontmatter.ts'

/**
 * A document of `.rness/` as its issue's body (spec 0018 §3): the same
 * document gives the same body, byte for byte. Pure: the caller reads the
 * files and knows the issue numbers.
 */

/** GitHub's limit for an issue body, in characters (spec 0018 §3.5). */
export const BODY_LIMIT = 65_536

export interface BodySource {
  /** The document's path in `.rness/`, with `/`: `specs/0016-cli-status.md`. */
  path: string
  /** The document as read. */
  text: string
  org: string
  /** The issue number of every document on the board, by path. */
  numbers: ReadonlyMap<string, number>
  /** Every file of `.rness/`, by path. */
  files: ReadonlySet<string>
}

const blobUrl = (org: string, path: string): string =>
  `https://github.com/${org}/.rness/blob/main/${encodeURI(path)}`
const issueUrl = (org: string, number: number): string =>
  `https://github.com/${org}/.rness/issues/${number}`

/** A body's first line (spec 0018 §3.1); the whole body of an issue whose document is not written yet. */
export function headerOf(path: string, org: string): string {
  return `\`${path}\` · [on GitHub](${blobUrl(org, path)})`
}

const digest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
const comment = (d: string): string => `<!-- rness ${d} -->`
/** What the digest line adds to a body, with the blank line before it. */
const TAIL = `\n\n${comment('0'.repeat(12))}`.length
const LAST_LINE = /\n\n<!-- rness ([0-9a-f]{12}) -->\s*$/

/**
 * The digest a body's last line carries, when it is the digest of what
 * precedes it; null otherwise — no such line, or a body edited by hand
 * (spec 0018 §4). CRLF, as GitHub's editor stores it, reads as LF.
 */
export function digestOf(body: string): string | null {
  const text = body.replaceAll('\r\n', '\n')
  const m = LAST_LINE.exec(text)
  const d = m?.[1]
  if (m === null || d === undefined) return null
  return digest(text.slice(0, m.index)) === d ? d : null
}

const OPENER = /^ *(`{3,}|~{3,})(.*)$/
const CLOSER = /^ *(`{3,}|~{3,})[ \t]*$/

/** Per line: whether it is code — a fence, or inside one. Fences may be indented (a list item's). */
function fenced(lines: readonly string[]): boolean[] {
  const code: boolean[] = []
  let run: string | null = null
  for (const line of lines) {
    if (run === null) {
      const m = OPENER.exec(line)
      const fence = m?.[1]
      // A backtick fence's info string holds no backtick (CommonMark 4.5).
      if (
        fence !== undefined &&
        !(fence.startsWith('`') && (m?.[2] ?? '').includes('`'))
      )
        run = fence
      code.push(run !== null)
      continue
    }
    code.push(true)
    const fence = CLOSER.exec(line)?.[1]
    if (
      fence !== undefined &&
      fence[0] === run[0] &&
      fence.length >= run.length
    )
      run = null
  }
  return code
}

const TITLE = /^ {0,3}#(?:[ \t]|$)/

/** Without the first `#` heading outside code, nor the blank lines after it (spec 0018 §3.2). */
function withoutTitle(lines: readonly string[]): string[] {
  const code = fenced(lines)
  const at = lines.findIndex((line, i) => code[i] !== true && TITLE.test(line))
  if (at < 0) return [...lines]
  let end = at + 1
  while (end < lines.length && (lines[end] ?? '').trim() === '') end++
  return [...lines.slice(0, at), ...lines.slice(end)]
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const IMAGE = /\.(?:png|jpe?g|gif|svg|webp|avif)$/i

const decoded = (path: string): string => {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

/** A link's destination (spec 0018 §3.3); as written when absolute, or no file of `.rness/`. */
function target(dest: string, s: BodySource): string {
  const raw = dest.startsWith('<') ? dest.slice(1, -1) : dest
  if (
    raw === '' ||
    SCHEME.test(raw) ||
    raw.startsWith('//') ||
    raw.startsWith('#')
  )
    return dest
  const hash = raw.indexOf('#')
  const pathPart = hash < 0 ? raw : raw.slice(0, hash)
  const anchor = hash < 0 ? '' : raw.slice(hash)
  const file = decoded(
    posix.normalize(
      pathPart.startsWith('/')
        ? pathPart.slice(1)
        : posix.join(posix.dirname(s.path), pathPart)
    )
  )
  const number = s.numbers.get(file)
  if (number !== undefined) return issueUrl(s.org, number)
  if (!s.files.has(file)) return dest
  return `${blobUrl(s.org, file)}${IMAGE.test(file) ? '?raw=true' : ''}${anchor}`
}

/**
 * What neutralizing leaves alone, and where a link's destination is: a code
 * span (it may cross a line), an HTML comment, an autolink, a reference
 * definition's destination, an inline link's destination, a bare URL.
 */
const PROTECTED = new RegExp(
  [
    /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/.source,
    /<!--[\s\S]*?-->/.source,
    /<[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*>/.source,
    /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*(?<def><[^>\n]*>|\S+)/.source,
    /\]\([ \t]*(?<dest><[^>\n]*>|[^\s()]+)/.source,
    /\b(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,:;"')\]]/.source,
  ].join('|'),
  'gm'
)
const MENTION = /(^|[^\w`\\])@([A-Za-z0-9][A-Za-z0-9-]*)/g
const REFERENCE = /(^|[^\w&#/\\])#(\d+)(?!\w)/g
const ZWSP = '​'

/** Prose made harmless (spec 0018 §3.4): it mentions no one and names no issue. */
const neutral = (text: string): string =>
  text.replace(MENTION, '$1\\@$2').replace(REFERENCE, `$1#${ZWSP}$2`)

function inline(text: string, s: BodySource): string {
  let out = ''
  let from = 0
  for (const m of text.matchAll(PROTECTED)) {
    const at = m.index ?? 0
    out += neutral(text.slice(from, at))
    const dest = m.groups?.['dest'] ?? m.groups?.['def']
    out +=
      dest === undefined
        ? m[0]
        : `${m[0].slice(0, m[0].length - dest.length)}${target(dest, s)}`
    from = at + m[0].length
  }
  return out + neutral(text.slice(from))
}

/** Links rewritten and prose neutralized a paragraph at a time; fenced blocks as they are. */
function rewrite(lines: readonly string[], s: BodySource): string[] {
  const code = fenced(lines)
  const out: string[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) out.push(inline(paragraph.join('\n'), s))
    paragraph = []
  }
  lines.forEach((line, i) => {
    if (code[i] === true || line.trim() === '') {
      flush()
      out.push(line)
    } else paragraph.push(line)
  })
  flush()
  return out
}

/**
 * `text` cut before its last blank line outside code that leaves room for
 * `rest` and the digest (spec 0018 §3.5). The blank line after the first
 * line always qualifies.
 */
function cut(text: string, rest: string): string {
  const room = BODY_LIMIT - TAIL - 2 - rest.length
  const lines = text.split('\n')
  const code = fenced(lines)
  let length = -1
  let at = 1
  for (let k = 1; k < lines.length; k++) {
    length += 1 + (lines[k - 1] ?? '').length
    if (length > room) break
    if (code[k] !== true && (lines[k] ?? '').trim() === '') at = k
  }
  return `${lines.slice(0, at).join('\n').trimEnd()}\n\n${rest}`
}

export function issueBody(s: BodySource): string {
  const lines = withoutTitle(
    stripFrontMatter(s.text.replaceAll('\r\n', '\n')).split('\n')
  )
  const content = rewrite(lines, s)
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
  const header = headerOf(s.path, s.org)
  const whole = content === '' ? header : `${header}\n\n${content}`
  const text =
    whole.length + TAIL <= BODY_LIMIT
      ? whole
      : cut(whole, `The rest: ${blobUrl(s.org, s.path)}`)
  return `${text}\n\n${comment(digest(text))}`
}
