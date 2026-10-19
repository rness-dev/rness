import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { stripFrontMatter } from '../core/frontmatter.ts'
import { type BodyProvider, contextUrls } from './urls.ts'

/**
 * A document of `.rness/` as its issue's body (spec 0018 §3): the same
 * document gives the same body, byte for byte. Pure: the caller reads the
 * files and knows the issue numbers.
 */

/** GitHub's limit for an issue body, in characters (spec 0018 §3.5). */
export const BODY_LIMIT = 65_536

/** An issue body's limit on the provider: GitLab's description takes 1,048,576 characters (spec 0037 §6). */
export const bodyLimit = (provider: BodyProvider = 'github'): number =>
  provider === 'gitlab' ? 1_048_576 : BODY_LIMIT

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
  /** Where the issue lives; GitHub when absent. */
  provider?: BodyProvider
}

/** A body's first line (spec 0018 §3.1); the whole body of an issue whose document is not written yet. */
export function headerOf(
  path: string,
  org: string,
  provider: BodyProvider = 'github'
): string {
  const where = provider === 'gitlab' ? 'GitLab' : 'GitHub'
  return `\`${path}\` · [on ${where}](${contextUrls(provider).blob(org, path)})`
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
  const text = body.replace(/\r\n?/g, '\n')
  const m = LAST_LINE.exec(text)
  const d = m?.[1]
  if (m === null || d === undefined) return null
  return digest(text.slice(0, m.index)) === d ? d : null
}

const OPENER = /^[ \t]*(`{3,}|~{3,})(.*)$/
const CLOSER = /^[ \t]*(`{3,}|~{3,})[ \t]*$/

/** Per line: whether it is code — a fence, or inside one. Fences may be indented (a list item's), with spaces or tabs. */
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
  const urls = contextUrls(s.provider ?? 'github')
  const number = s.numbers.get(file)
  if (number !== undefined) return urls.issue(s.org, number)
  if (!s.files.has(file)) return dest
  return IMAGE.test(file)
    ? `${urls.image(s.org, file)}${anchor}`
    : `${urls.blob(s.org, file)}${anchor}`
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
// `\@name` mentions no one; `\#4` still links issue 4 (spec 0018 §1).
const MENTION = /(^|[^A-Za-z0-9`\\])@([A-Za-z0-9][A-Za-z0-9-]*)/g
const REFERENCE = /(^|[^A-Za-z0-9&#/])#(\d+)(?![A-Za-z0-9])/g
const ZWSP = '\u200B'

/**
 * GitLab's references, each escaped by the backslash its Markdown documents
 * and plan 0049 task 1 saw render as text: an issue `#4`, a merge request
 * `!5`, an epic `&6`, a snippet `$7`, a label `~bug`, a milestone `%v1`, a
 * user `@name` (spec 0037 §6). A marker after a project's path (`api#4`,
 * `acme/api!5`) is a cross-project reference: escaped too, since `C\#8`
 * still reads `C#8`. A marker is escaped already only after an odd run of
 * backslashes: `\\@name` is a backslash, then a mention. Left as they are:
 * an email's `@`, the `~` of `~~struck~~`, the `#` of a character reference.
 */
const UNESCAPED = String.raw`(?<!(?:^|[^\\])(?:\\\\)*\\)`
const GITLAB_REFERENCES: readonly RegExp[] = [
  // `#` of `&#233;` belongs to the reference; `&#4` is no reference.
  new RegExp(
    String.raw`${UNESCAPED}(?:(?<!&)#|(?<=&)#(?![0-9]{1,7};|[xX][0-9a-fA-F]{1,6};))(?=\d)`,
    'g'
  ),
  new RegExp(String.raw`${UNESCAPED}!(?=\d)`, 'g'),
  new RegExp(String.raw`${UNESCAPED}&(?=\d)`, 'g'),
  new RegExp(String.raw`${UNESCAPED}\$(?=\d)`, 'g'),
  new RegExp(String.raw`${UNESCAPED}(?<!~)~(?=[A-Za-z0-9"])`, 'g'),
  new RegExp(String.raw`${UNESCAPED}(?<![A-Za-z0-9%])%(?=[A-Za-z0-9"])`, 'g'),
  new RegExp(String.raw`${UNESCAPED}(?<![A-Za-z0-9\x60])@(?=[A-Za-z0-9])`, 'g'),
]

/** The characters GitLab makes references of, and what must follow one for it to be a reference. */
const MARKERS: ReadonlyMap<string, RegExp> = new Map([
  ['#', /^\d/],
  ['!', /^\d/],
  ['&', /^\d/],
  ['$', /^\d/],
  ['~', /^[A-Za-z0-9"]/],
  ['%', /^[A-Za-z0-9"]/],
  ['@', /^[A-Za-z0-9]/],
])
const NAMED: Readonly<Record<string, string>> = {
  num: '#',
  excl: '!',
  amp: '&',
  dollar: '$',
  percnt: '%',
  commat: '@',
}
const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g

/**
 * A character reference that decodes to a marker would become one once
 * GitLab decodes it (`&#064;cedric`): judged by its value, its `&` escaped,
 * and it reads as written. Any other (`&#233;`, `&eacute;`) is left alone.
 */
const escapedReferences = (text: string): string =>
  text.replace(
    CHARACTER_REFERENCE,
    (
      whole: string,
      dec: string | undefined,
      hex: string | undefined,
      name: string | undefined,
      at: number
    ) => {
      const code =
        dec !== undefined
          ? Number.parseInt(dec, 10)
          : hex !== undefined
            ? Number.parseInt(hex, 16)
            : null
      const char =
        code !== null
          ? code <= 0x10ffff
            ? String.fromCodePoint(code)
            : ''
          : (NAMED[(name ?? '').toLowerCase()] ?? '')
      const follows = MARKERS.get(char)
      const live =
        follows !== undefined && follows.test(text.slice(at + whole.length))
      return live ? `\\${whole}` : whole
    }
  )

/** Prose made harmless (spec 0018 §3.4): it mentions no one and names no issue. */
const neutral = (text: string, provider: BodyProvider): string =>
  provider === 'gitlab'
    ? GITLAB_REFERENCES.reduce(
        (t, re) => t.replace(re, (mark) => `\\${mark}`),
        escapedReferences(text)
      )
    : text.replace(MENTION, '$1\\@$2').replace(REFERENCE, `$1#${ZWSP}$2`)

function inline(text: string, s: BodySource): string {
  const provider = s.provider ?? 'github'
  let out = ''
  let from = 0
  for (const m of text.matchAll(PROTECTED)) {
    const at = m.index ?? 0
    out += neutral(text.slice(from, at), provider)
    const dest = m.groups?.['dest'] ?? m.groups?.['def']
    out +=
      dest === undefined
        ? m[0]
        : `${m[0].slice(0, m[0].length - dest.length)}${target(dest, s)}`
    from = at + m[0].length
  }
  return out + neutral(text.slice(from), provider)
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
function cut(text: string, rest: string, limit: number): string {
  const room = limit - TAIL - 2 - rest.length
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
    stripFrontMatter(s.text.replace(/\r\n?/g, '\n')).split('\n')
  )
  const content = rewrite(lines, s)
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
  const provider = s.provider ?? 'github'
  const header = headerOf(s.path, s.org, provider)
  const whole = content === '' ? header : `${header}\n\n${content}`
  const limit = bodyLimit(provider)
  const text =
    whole.length + TAIL <= limit
      ? whole
      : cut(
          whole,
          `The rest: ${contextUrls(provider).blob(s.org, s.path)}`,
          limit
        )
  return `${text}\n\n${comment(digest(text))}`
}
