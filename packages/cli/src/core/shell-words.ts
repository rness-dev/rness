/**
 * A shell command read as a POSIX shell reads it (quotes, lists, pipes,
 * subshells, substitutions, here-documents, comments, redirections), each
 * simple command as its words: what is written out, the variables to
 * expand, and what cannot be known here. Pure; it runs nothing.
 */

export type Segment =
  | { readonly kind: 'text'; readonly text: string; readonly quoted: boolean }
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'tilde' }
  /** An expansion whose value is not known here. */
  | { readonly kind: 'unknown' }

export interface Word {
  readonly segments: readonly Segment[]
}

export type ShellItem =
  | { readonly kind: 'command'; readonly words: Word[]; readonly text: string }
  /** A subshell or a substitution starts: what `cd` does inside stays inside. */
  | { readonly kind: 'enter' }
  | { readonly kind: 'leave' }

class Unreadable extends Error {}

const BLANK = new Set([' ', '\t'])
const ENDS_WORD = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
/** A shell variable's name. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ANSI_C: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\u0007',
  b: '\b',
  e: '\u001b',
  E: '\u001b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}

/**
 * Which shell's reading, where bash and zsh read a command differently: a
 * single quote inside a double-quoted `${...}` (a quote to bash, a
 * character to zsh), quotes inside arithmetic (skipped by bash, not by zsh).
 */
export type Dialect = 'bash' | 'zsh'

class Parser {
  private readonly src: string
  private readonly dialect: Dialect
  private pos = 0
  private heredocs: { delimiter: string; tabs: boolean }[] = []

  constructor(src: string, dialect: Dialect) {
    this.src = src
    this.dialect = dialect
  }

  parse(): ShellItem[] {
    return this.list(false)
  }

  /** Commands up to the end, or up to the `)` that closes the list when `closing`. */
  private list(closing: boolean): ShellItem[] {
    const src = this.src
    const items: ShellItem[] = []
    let words: Word[] = []
    let before: ShellItem[] = []
    let start = -1
    let end = -1
    let target = false
    const flush = (): void => {
      items.push(...before)
      if (words.length > 0)
        items.push({ kind: 'command', words, text: src.slice(start, end) })
      words = []
      before = []
      start = -1
    }
    while (this.pos < src.length) {
      const c = src[this.pos] ?? ''
      const next = src[this.pos + 1] ?? ''
      if (BLANK.has(c)) {
        this.pos += 1
      } else if (c === '\\' && next === '\n') {
        this.pos += 2
      } else if (c === '\n') {
        flush()
        this.pos += 1
        this.skipHeredocs()
      } else if (c === '#') {
        const eol = src.indexOf('\n', this.pos)
        this.pos = eol === -1 ? src.length : eol
      } else if (c === '&' && next === '>') {
        this.pos += src[this.pos + 2] === '>' ? 3 : 2
        target = true
      } else if (c === ';' || c === '&' || c === '|') {
        flush()
        this.pos += next === c || (c === '|' && next === '&') ? 2 : 1
      } else if (c === '(') {
        flush()
        // `((...))`, an arithmetic command, when it closes as one.
        const end = next === '(' ? this.arithmetic(this.pos, items) : null
        if (end !== null) this.pos = end
        else {
          this.pos += 1
          items.push({ kind: 'enter' }, ...this.list(true), { kind: 'leave' })
        }
      } else if (c === ')') {
        flush()
        this.pos += 1
        if (closing) return items
        // A `case` pattern's: nothing to close.
      } else if ((c === '<' || c === '>') && next === '(') {
        // A process substitution: its commands run, its word is a path.
        this.pos += 2
        before.push({ kind: 'enter' }, ...this.list(true), { kind: 'leave' })
        if (!target) {
          if (start === -1) start = this.pos
          end = this.pos
          words.push({ segments: [{ kind: 'unknown' }] })
        }
        target = false
      } else if (c === '<' || c === '>') {
        if (c === '<' && next === '<' && src[this.pos + 2] !== '<') {
          const tabs = src[this.pos + 2] === '-'
          this.pos += tabs ? 3 : 2
          while (BLANK.has(src[this.pos] ?? '')) this.pos += 1
          const delimiter = this.word(before)
          this.heredocs.push({
            delimiter: delimiter.segments
              .map((s) => (s.kind === 'text' ? s.text : ''))
              .join(''),
            tabs,
          })
        } else {
          const op = /^(?:<<<|>>|<>|<&|>&|>\||<|>)/.exec(
            src.slice(this.pos, this.pos + 3)
          )?.[0]
          this.pos += op?.length ?? 1
          target = true
        }
      } else {
        const at = this.pos
        const word = this.word(before)
        const raw = src.slice(at, this.pos)
        const after = src[this.pos] ?? ''
        // The descriptor of a redirection (`2>`), or its target: no word.
        if (/^\d+$/.test(raw) && (after === '<' || after === '>')) continue
        if (target) {
          target = false
          continue
        }
        if (start === -1) start = at
        end = this.pos
        words.push(word)
      }
    }
    if (closing)
      throw new Unreadable('a subshell or substitution is not closed')
    flush()
    return items
  }

  /** The bodies of the here-documents the line opened: no commands. */
  private skipHeredocs(): void {
    for (const { delimiter, tabs } of this.heredocs) {
      while (this.pos < this.src.length) {
        const eol = this.src.indexOf('\n', this.pos)
        const line = this.src.slice(this.pos, eol === -1 ? undefined : eol)
        this.pos = eol === -1 ? this.src.length : eol + 1
        if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break
      }
    }
    this.heredocs = []
  }

  /** One word, quotes removed; the commands of its substitutions go to `before`. */
  private word(before: ShellItem[]): Word {
    const src = this.src
    const segments: Segment[] = []
    const text = (t: string, quoted: boolean): void => {
      const last = segments.at(-1)
      if (last?.kind === 'text' && last.quoted === quoted)
        segments[segments.length - 1] = { ...last, text: last.text + t }
      else segments.push({ kind: 'text', text: t, quoted })
    }
    while (this.pos < src.length) {
      const c = src[this.pos] ?? ''
      if (ENDS_WORD.has(c)) break
      if (c === '\\') {
        const n = src[this.pos + 1]
        if (n === undefined) text('\\', false)
        else if (n !== '\n') text(n, true)
        this.pos += 2
      } else if (c === "'") {
        const close = src.indexOf("'", this.pos + 1)
        if (close === -1) throw new Unreadable('a single quote is not closed')
        text(src.slice(this.pos + 1, close), true)
        this.pos = close + 1
      } else if (c === '"') {
        this.pos += 1
        this.doubleQuoted(segments, text, before)
      } else if (c === '$') {
        this.dollar(segments, text, before, false)
      } else if (c === '`') {
        this.backquoted(segments, before)
      } else if (c === '~' && segments.length === 0) {
        const n = src[this.pos + 1] ?? ''
        this.pos += 1
        if (n === '' || n === '/' || ENDS_WORD.has(n))
          segments.push({ kind: 'tilde' })
        else segments.push({ kind: 'unknown' })
      } else {
        text(c, false)
        this.pos += 1
      }
    }
    return { segments }
  }

  private doubleQuoted(
    segments: Segment[],
    text: (t: string, quoted: boolean) => void,
    before: ShellItem[]
  ): void {
    const src = this.src
    while (this.pos < src.length) {
      const c = src[this.pos] ?? ''
      if (c === '"') {
        this.pos += 1
        // `""` is a word, empty.
        if (segments.length === 0) text('', true)
        return
      }
      if (c === '\\') {
        const n = src[this.pos + 1] ?? ''
        if ('$`"\\'.includes(n) && n !== '') {
          text(n, true)
          this.pos += 2
        } else if (n === '\n') this.pos += 2
        else {
          text('\\', true)
          this.pos += 1
        }
      } else if (c === '$') this.dollar(segments, text, before, true)
      else if (c === '`') this.backquoted(segments, before)
      else {
        text(c, true)
        this.pos += 1
      }
    }
    throw new Unreadable('a double quote is not closed')
  }

  private dollar(
    segments: Segment[],
    text: (t: string, quoted: boolean) => void,
    before: ShellItem[],
    quoted: boolean
  ): void {
    const src = this.src
    const n = src[this.pos + 1] ?? ''
    if (n === '(') {
      // `$((...))`, arithmetic, when it closes as such; else a substitution.
      const end =
        src[this.pos + 2] === '(' ? this.arithmetic(this.pos + 1, before) : null
      if (end !== null) this.pos = end
      else {
        this.pos += 2
        before.push({ kind: 'enter' }, ...this.list(true), { kind: 'leave' })
      }
      segments.push({ kind: 'unknown' })
    } else if (n === '{') {
      const i = this.braceEnd(this.pos + 1, quoted, before)
      const inner = src.slice(this.pos + 2, i)
      segments.push(
        VARIABLE_NAME.test(inner)
          ? { kind: 'var', name: inner }
          : { kind: 'unknown' }
      )
      this.pos = i + 1
    } else if (n === "'" && !quoted) {
      const decoded = this.ansiC()
      if (decoded === null) segments.push({ kind: 'unknown' })
      else text(decoded, true)
    } else if (n === '"' && !quoted) {
      // `$"..."`, a translated string: a double-quoted one here.
      this.pos += 1
    } else if (/[A-Za-z_]/.test(n)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(this.pos + 1))?.[0]
      segments.push({ kind: 'var', name: name ?? n })
      this.pos += 1 + (name?.length ?? 1)
    } else if (/[0-9@*#?$!-]/.test(n) && n !== '') {
      segments.push({ kind: 'unknown' })
      this.pos += 2
    } else {
      text('$', quoted)
      this.pos += 1
    }
  }

  /**
   * `$'...'` from `$`, decoded as bash decodes it: the named escapes, `\NNN`
   * octal, `\xHH`, `\uHHHH`, `\UHHHHHHHH` and `\cX`; null when it holds an
   * escape decoded here in no known way, so the word is unknown.
   */
  private ansiC(): string | null {
    const src = this.src
    let out = ''
    let known = true
    let i = this.pos + 2
    const digits = (re: RegExp): string => re.exec(src.slice(i + 1))?.[0] ?? ''
    for (; i < src.length && src[i] !== "'"; i++) {
      if (src[i] !== '\\') {
        out += src[i]
        continue
      }
      const e = src[i + 1] ?? ''
      i += 1
      const named = ANSI_C[e]
      if (named !== undefined) out += named
      else if (/[0-7]/.test(e)) {
        const d = /^[0-7]{1,3}/.exec(src.slice(i))?.[0] ?? e
        out += String.fromCharCode(parseInt(d, 8) & 0xff)
        i += d.length - 1
      } else if (e === 'x' || e === 'u' || e === 'U') {
        const d = digits(
          e === 'x'
            ? /^[0-9A-Fa-f]{1,2}/
            : e === 'u'
              ? /^[0-9A-Fa-f]{1,4}/
              : /^[0-9A-Fa-f]{1,8}/
        )
        const code = parseInt(d, 16)
        if (d === '' || code > 0x10ffff) known = false
        else out += String.fromCodePoint(code)
        i += d.length
      } else if (e === 'c' && i + 1 < src.length && src[i + 1] !== "'") {
        out += String.fromCharCode((src.charCodeAt(i + 1) ?? 0) & 0x1f)
        i += 1
      } else known = false
    }
    if (i >= src.length) throw new Unreadable("a $' is not closed")
    this.pos = i + 1
    return known ? out : null
  }

  /**
   * `((`...`))` from its first `(`: arithmetic, one piece, the commands of
   * its substitutions to `before`; the position after it, or null (nothing
   * read) when its parentheses do not close as arithmetic but as subshells.
   */
  private arithmetic(start: number, before: ShellItem[]): number | null {
    const src = this.src
    const saved = { pos: this.pos, heredocs: [...this.heredocs] }
    const found: ShellItem[] = []
    let depth = 0
    let i = start + 2
    while (i < src.length) {
      const c = src[i]
      // bash skips quotes, escapes and expansions as parse_matched_pair does;
      // zsh only the substitutions.
      const piece =
        this.dialect === 'bash'
          ? this.skipPiece(i, false, found)
          : c === '`' || (c === '$' && src[i + 1] === '(')
            ? this.skipPiece(i, false, found)
            : null
      if (piece !== null) {
        i = piece + 1
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') {
        if (depth > 0) depth -= 1
        else if (src[i + 1] === ')') {
          before.push(...found)
          return i + 2
        } else break
      }
      i += 1
    }
    if (i >= src.length) throw new Unreadable('arithmetic is not closed')
    this.pos = saved.pos
    this.heredocs = saved.heredocs
    return null
  }

  /**
   * A quote, an escape or an expansion at `i`, inside `$((`, `((` or `${`,
   * skipped as bash's parse_matched_pair skips it, the commands of its
   * substitutions read into `found`: the index of its last character, or
   * null when `src[i]` starts none. Read as zsh, a single quote inside a
   * double-quoted `${...}` is a character.
   */
  private skipPiece(
    i: number,
    inDouble: boolean,
    found: ShellItem[]
  ): number | null {
    const src = this.src
    const c = src[i]
    const n = src[i + 1]
    const none = (): void => undefined
    if (c === '\\') return i + 1
    if (c === "'") {
      if (inDouble && this.dialect === 'zsh') return null
      const close = src.indexOf("'", i + 1)
      if (close === -1) throw new Unreadable('a single quote is not closed')
      return close
    }
    if (c === '"') {
      this.pos = i + 1
      this.doubleQuoted([], none, found)
      return this.pos - 1
    }
    if (c === '`') {
      this.pos = i
      this.backquoted([], found)
      return this.pos - 1
    }
    if (c === '$' && (n === '(' || n === '{' || (n === "'" && !inDouble))) {
      this.pos = i
      this.dollar([], none, found, inDouble)
      return this.pos - 1
    }
    return null
  }

  /** The index of the `}` that closes the `${` whose `{` is at `open`. */
  private braceEnd(
    open: number,
    inDouble: boolean,
    found: ShellItem[]
  ): number {
    const src = this.src
    let depth = 1
    for (let i = open + 1; i < src.length; i++) {
      const piece = this.skipPiece(i, inDouble, found)
      if (piece !== null) {
        i = piece
        continue
      }
      if (src[i] === '{') depth += 1
      else if (src[i] === '}' && --depth === 0) return i
    }
    throw new Unreadable('a ${ is not closed')
  }

  private backquoted(segments: Segment[], before: ShellItem[]): void {
    const src = this.src
    let inner = ''
    let i = this.pos + 1
    for (; i < src.length && src[i] !== '`'; i++) {
      const e = src[i + 1] ?? ''
      if (src[i] === '\\' && '$`\\'.includes(e) && e !== '') {
        inner += e
        i += 1
      } else inner += src[i]
    }
    if (i >= src.length) throw new Unreadable('a backquote is not closed')
    this.pos = i + 1
    before.push({ kind: 'enter' }, ...new Parser(inner, this.dialect).parse(), {
      kind: 'leave',
    })
    segments.push({ kind: 'unknown' })
  }
}

/**
 * The commands of a shell script, in the order they run, a substitution's
 * before the command holding it; null when the shell would refuse it (an
 * unbalanced quote, subshell or substitution).
 */
export function shellCommands(
  script: string,
  dialect: Dialect = 'bash'
): ShellItem[] | null {
  try {
    return new Parser(script, dialect).parse()
  } catch (e) {
    if (e instanceof Unreadable) return null
    throw e
  }
}

/** A word's value when it is written out, with no expansion; else null. */
export function literalOf(word: Word): string | null {
  let out = ''
  for (const s of word.segments) {
    if (s.kind !== 'text') return null
    out += s.text
  }
  return out
}

/**
 * An unquoted glob (`*`, `?`, `[`) or brace expression (`{a,b}`, `{1..3}`)
 * in a word: the shell expands it before it runs anything, so the word as
 * written is not the word run. A brace expression is decided on the whole
 * word, as bash decides it: its `{`, its `,` or `..` and its `}` unquoted,
 * whatever is quoted between (`{"gi",x}t` is `git xt`). A word starting
 * with an unquoted `=` is zsh's `=cmd`, the command's path: a glob here.
 * Null for none.
 */
export function patternOf(word: Word): 'glob' | 'brace' | null {
  // Each character, and whether the shell may expand it; an expansion
  // stands for characters it does not.
  const chars: { c: string; open: boolean }[] = []
  for (const seg of word.segments)
    if (seg.kind === 'text')
      for (const c of seg.text) chars.push({ c, open: !seg.quoted })
    else chars.push({ c: '', open: false })
  const open = (i: number, c: string): boolean =>
    chars[i]?.open === true && chars[i]?.c === c
  for (let i = 0; i < chars.length; i++) {
    if (!open(i, '{')) continue
    let separated = false
    for (let j = i + 1; j < chars.length; j++) {
      if (open(j, ',') || (open(j, '.') && open(j + 1, '.'))) separated = true
      else if (open(j, '}') && separated) return 'brace'
    }
  }
  if (open(0, '=') && chars.length > 1) return 'glob'
  return chars.some((ch) => ch.open && '*?['.includes(ch.c) && ch.c !== '')
    ? 'glob'
    : null
}

/** A character of a word, whether the shell may expand it, or a whole expansion. */
type Char =
  { readonly c: string; readonly open: boolean } | { readonly segment: Segment }

const opens = (ch: Char | undefined, c: string): boolean =>
  ch !== undefined && 'c' in ch && ch.open && ch.c === c

/** More words than this from one word: not read here. */
const MAX_EXPANSION = 256

/** `{a..e}`, `{1..9}`, `{1..9..2}`: its items; null for no sequence. */
function sequenceOf(inner: readonly Char[]): string[] | null | 'too many' {
  if (!inner.every((ch) => 'c' in ch && ch.open)) return null
  const text = inner.map((ch) => ('c' in ch ? ch.c : '')).join('')
  const numbers = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text)
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(text)
  const m = numbers ?? letters
  if (m === null) return null
  const from = numbers ? Number(m[1]) : (m[1] ?? '').charCodeAt(0)
  const to = numbers ? Number(m[2]) : (m[2] ?? '').charCodeAt(0)
  const given = Number(m[3] ?? 1)
  // No arithmetic on a bound or step that is no safe integer: past 2^53,
  // v + 1 is v, and a loop on it never ends. Too many, as the cap.
  if (![from, to, given].every(Number.isSafeInteger)) return 'too many'
  const step = Math.abs(given) || 1
  if (Math.floor(Math.abs(to - from) / step) + 1 > MAX_EXPANSION)
    return 'too many'
  const items: string[] = []
  const dir = to >= from ? 1 : -1
  // Bounded by a count too, whatever the arithmetic does.
  for (
    let v = from, n = 0;
    (dir > 0 ? v <= to : v >= to) && n <= MAX_EXPANSION;
    v += dir * step, n += 1
  )
    items.push(numbers ? String(v) : String.fromCharCode(v))
  return items.length > MAX_EXPANSION ? 'too many' : items
}

/** The expansions of `chars`, appended to `out`; false past the cap. */
function expandChars(chars: readonly Char[], out: Char[][]): boolean {
  for (let i = 0; i < chars.length; i++) {
    if (!opens(chars[i], '{')) continue
    let depth = 0
    let close = -1
    const commas: number[] = []
    for (let j = i; j < chars.length; j++) {
      if (opens(chars[j], '{')) depth += 1
      else if (opens(chars[j], '}')) {
        depth -= 1
        if (depth === 0) {
          close = j
          break
        }
      } else if (depth === 1 && opens(chars[j], ',')) commas.push(j)
    }
    // A `{` the word never closes is a character; a later one may expand.
    if (close === -1) continue
    let alternatives: Char[][]
    if (commas.length > 0) {
      alternatives = []
      let from = i + 1
      for (const at of [...commas, close]) {
        alternatives.push(chars.slice(from, at))
        from = at + 1
      }
    } else {
      const items = sequenceOf(chars.slice(i + 1, close))
      if (items === 'too many') return false
      if (items === null) continue
      alternatives = items.map((item) =>
        [...item].map((c) => ({ c, open: false }))
      )
    }
    const before = chars.slice(0, i)
    const after = chars.slice(close + 1)
    for (const alternative of alternatives)
      if (!expandChars([...before, ...alternative, ...after], out)) return false
    return true
  }
  out.push([...chars])
  return out.length <= MAX_EXPANSION
}

/**
 * A word's brace expansion, as bash makes it before anything else: comma
 * lists and sequences, nested, left to right, only an unquoted `{`, `,`,
 * `..` and `}` counting. The word itself when it holds none; null past
 * MAX_EXPANSION words.
 */
export function expandBraces(word: Word): Word[] | null {
  const chars: Char[] = []
  for (const segment of word.segments)
    if (segment.kind === 'text')
      for (const c of segment.text) chars.push({ c, open: !segment.quoted })
    else chars.push({ segment })
  const out: Char[][] = []
  if (!expandChars(chars, out)) return null
  return out.map((expanded) => {
    const segments: Segment[] = []
    for (const ch of expanded) {
      if ('segment' in ch) {
        segments.push(ch.segment)
        continue
      }
      const last = segments.at(-1)
      if (last?.kind === 'text' && last.quoted === !ch.open)
        segments[segments.length - 1] = { ...last, text: last.text + ch.c }
      else segments.push({ kind: 'text', text: ch.c, quoted: !ch.open })
    }
    return { segments }
  })
}
