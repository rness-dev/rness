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

class Parser {
  private readonly src: string
  private pos = 0
  private heredocs: { delimiter: string; tabs: boolean }[] = []

  constructor(src: string) {
    this.src = src
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
      let depth = 0
      let i = this.pos + 1
      for (; i < src.length; i++) {
        if (src[i] === '{') depth += 1
        else if (src[i] === '}' && --depth === 0) break
      }
      if (i >= src.length) throw new Unreadable('a ${ is not closed')
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
      if (c === '$' && src[i + 1] === '(') {
        const end = src[i + 2] === '(' ? this.arithmetic(i + 1, found) : null
        if (end !== null) i = end
        else {
          this.pos = i + 2
          found.push({ kind: 'enter' }, ...this.list(true), { kind: 'leave' })
          i = this.pos
        }
        continue
      }
      if (c === '`') {
        this.pos = i
        this.backquoted([], found)
        i = this.pos
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
    before.push({ kind: 'enter' }, ...new Parser(inner).parse(), {
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
export function shellCommands(script: string): ShellItem[] | null {
  try {
    return new Parser(script).parse()
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
