import { basename, dirname, isAbsolute, resolve } from 'node:path'

/**
 * The git calls of a Bash command that would skip the git hooks (spec 0040
 * §4.3): `git commit --no-verify` or `-n`, `git push --no-verify`, and
 * core.hooksPath set by `git -c`, `--config-env`, `git config` or the
 * environment. Pure: a command and where it starts in, the bypasses out,
 * each with the directory git runs in. The command is read as a POSIX shell
 * reads it (quotes, lists, subshells, substitutions, here-documents), not
 * matched as a string; what cannot be known here (an expansion of an unknown
 * variable, an alias, a script) is no bypass, as the hooks still run.
 *
 * The option tables are git 2.56.0's (`git <command>
 * --git-completion-helper-all`, read 2026-11-03): git takes an unambiguous
 * prefix of a long option (`--no-veri`), refuses an ambiguous or unknown one
 * (`--no-ver`) and so runs nothing, and the last of `--no-verify` and
 * `--verify` wins.
 */

/** The hooks of a clone that apply the policies (spec 0040 §4.2). */
export type SkippedHook = 'pre-commit' | 'commit-msg' | 'pre-push'

export interface GitBypass {
  /** The directory git runs in, absolute; null when the command does not say. */
  readonly dir: string | null
  /** The command as written. */
  readonly text: string
  /** What skips the hooks: `-n`, `--no-verify`, `core.hooksPath`, an environment variable. */
  readonly how: string
  readonly skips: readonly SkippedHook[]
  /** The core.hooksPath given, when the command sets it to a known value. */
  readonly hooksPath?: string
  /** Where a core.hooksPath is set: a `git config` scope, `-c`, or the environment. */
  readonly scope?: ConfigScope
}

export type ConfigScope =
  | 'local'
  | 'global'
  | 'system'
  | 'worktree'
  | 'file'
  | 'command'
  | 'environment'

/** Where the command starts: its directory and the environment it expands. */
export interface ShellStart {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}

type Segment =
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
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
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
        this.pos += 1
        items.push({ kind: 'enter' }, ...this.list(true), { kind: 'leave' })
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
      this.pos += 2
      before.push({ kind: 'enter' }, ...this.list(true), { kind: 'leave' })
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
        NAME.test(inner) ? { kind: 'var', name: inner } : { kind: 'unknown' }
      )
      this.pos = i + 1
    } else if (n === "'" && !quoted) {
      let out = ''
      let i = this.pos + 2
      for (; i < src.length && src[i] !== "'"; i++) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[i + 1] ?? ''
          out += ANSI_C[e] ?? `\\${e}`
          i += 1
        } else out += src[i]
      }
      if (i >= src.length) throw new Unreadable("a $' is not closed")
      text(out, true)
      this.pos = i + 1
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

// --- what runs, and where -------------------------------------------------

interface State {
  dir: string | null
  /** What `$NAME` expands to: the environment, then the script's own assignments. */
  vars: Map<string, string>
  /** What the script exports: what git sees of it. */
  exported: Map<string, string | null>
}

type Env = ReadonlyMap<string, string | null>

const RESERVED = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'case',
  'esac',
  'in',
  'function',
  'select',
  'coproc',
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh'])

const cloned = (s: State): State => ({
  dir: s.dir,
  vars: new Map(s.vars),
  exported: new Map(s.exported),
})

function valueOf(word: Word | undefined, state: State): string | null {
  if (word === undefined) return null
  let out = ''
  for (const s of word.segments) {
    if (s.kind === 'text') out += s.text
    else if (s.kind === 'var') {
      const v = state.vars.get(s.name)
      if (v === undefined) return null
      out += v
    } else if (s.kind === 'tilde') {
      const home = state.vars.get('HOME')
      if (home === undefined) return null
      out += home
    } else return null
  }
  return out
}

/** `NAME=value`: its name and value (null when not known); null for no assignment. */
function assignmentOf(
  word: Word,
  state: State
): { name: string; value: string | null } | null {
  const first = word.segments[0]
  if (first?.kind !== 'text' || first.quoted) return null
  const eq = first.text.indexOf('=')
  if (eq < 1 || !NAME.test(first.text.slice(0, eq))) return null
  const rest: Word = {
    segments: [
      { ...first, text: first.text.slice(eq + 1) },
      ...word.segments.slice(1),
    ],
  }
  return { name: first.text.slice(0, eq), value: valueOf(rest, state) }
}

/** A path from `from`; null when either is not known. */
function pathFrom(from: string | null, to: string | null): string | null {
  if (to === null) return null
  if (isAbsolute(to)) return resolve(to)
  return from === null ? null : resolve(from, to)
}

function walk(
  items: readonly ShellItem[],
  start: State,
  out: GitBypass[]
): void {
  const stack: State[] = []
  let state = start
  for (const item of items) {
    if (item.kind === 'enter') {
      stack.push(state)
      state = cloned(state)
    } else if (item.kind === 'leave') state = stack.pop() ?? state
    else command(item, state, out)
  }
}

function command(
  item: Extract<ShellItem, { kind: 'command' }>,
  state: State,
  out: GitBypass[]
): void {
  const { words } = item
  const prefix = new Map<string, string | null>()
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]
    if (w === undefined) break
    const [only, ...more] = w.segments
    if (
      only?.kind === 'text' &&
      !only.quoted &&
      more.length === 0 &&
      RESERVED.has(only.text)
    )
      continue
    const a = assignmentOf(w, state)
    if (a === null) break
    prefix.set(a.name, a.value)
  }
  if (i === words.length) {
    // Assignments alone: shell variables, exported when they already were.
    for (const [name, value] of prefix) {
      if (value === null) state.vars.delete(name)
      else state.vars.set(name, value)
      if (state.exported.has(name)) state.exported.set(name, value)
    }
    return
  }
  // What the parser cannot read is judged by its words, failing closed.
  if (run(words.slice(i), prefix, state, item.text, out) === 'unread')
    backstop(words.slice(i), state, item.text, out)
}

/** Whether a command was read to the end, or the parser gave up on it. */
type Read = 'read' | 'unread'

/**
 * Commands that run the command after their options (and, for `timeout`,
 * its duration): the options that take the next word, and those that
 * change directory.
 */
interface Wrapper {
  readonly args: readonly string[]
  readonly chdir?: readonly string[]
  readonly positionals?: number
}

const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  nohup: { args: [] },
  chronic: { args: [] },
  time: { args: [] },
  exec: { args: ['-a'] },
  nice: { args: ['-n', '--adjustment'] },
  timeout: {
    args: ['-s', '--signal', '-k', '--kill-after'],
    positionals: 1,
  },
  xargs: {
    args: '-a --arg-file -d --delimiter -E -I -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var'.split(
      ' '
    ),
  },
  sudo: {
    args: '-C --close-from -D --chdir -g --group -h --host -p --prompt -R --chroot -r --role -t --type -T --command-timeout -U --other-user -u --user'.split(
      ' '
    ),
    chdir: ['-D', '--chdir'],
  },
  doas: { args: ['-C', '-u'] },
  stdbuf: { args: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  ionice: {
    args: '-c --class -n --classdata -p --pid -P --pgid -u --uid'.split(' '),
  },
  watch: { args: ['-n', '--interval', '-q', '--equexit'] },
}

/** Commands that never run their arguments: nothing to judge in them. */
const NEVER_RUNS = new Set(
  'echo printf grep egrep fgrep rg ag ack man which type true false :'.split(
    ' '
  )
)

interface Unwrapped {
  rest: Word[]
  /** The option words, as given. */
  flags: string[]
  /** The directory the wrapper moves to; undefined when it does not. */
  chdir?: string | null
}

/** The command after a wrapper's options; null when an option cannot be read. */
function unwrap(
  words: readonly Word[],
  spec: Wrapper,
  state: State
): Unwrapped | null {
  const flags: string[] = []
  let chdir: string | null | undefined
  const takes = (opt: string, value: string | null): void => {
    if (spec.chdir?.includes(opt) === true) chdir = value
  }
  let i = 0
  for (; i < words.length; i++) {
    const v = valueOf(words[i], state)
    if (v === null) return null
    if (v === '--') {
      i += 1
      break
    }
    if (!v.startsWith('-') || v === '-') break
    flags.push(v)
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      if (eq !== -1) takes(v.slice(0, eq), v.slice(eq + 1))
      else if (spec.args.includes(v)) {
        takes(v, valueOf(words[i + 1], state))
        i += 1
      }
      continue
    }
    // A cluster: the first letter that takes a value takes the rest of it,
    // or the next word.
    for (let k = 1; k < v.length; k++) {
      const opt = `-${v[k] ?? ''}`
      if (!spec.args.includes(opt)) continue
      const attached = v.slice(k + 1)
      if (attached !== '') takes(opt, attached)
      else {
        takes(opt, valueOf(words[i + 1], state))
        i += 1
      }
      break
    }
  }
  return {
    rest: words.slice(i + (spec.positionals ?? 0)),
    flags,
    ...(chdir === undefined ? {} : { chdir }),
  }
}

/** A simple command: its words, the assignments before it, the shell's state. */
function run(
  words: readonly Word[],
  prefix: Map<string, string | null>,
  state: State,
  text: string,
  out: GitBypass[]
): Read {
  let rest = [...words]
  let dir = state.dir
  let name = valueOf(rest.shift(), state)
  // Wrappers that run the command after them.
  for (;;) {
    if (name === null) return 'unread'
    const spec = WRAPPERS[name]
    if (name === 'env') {
      for (;;) {
        const w = rest[0]
        if (w === undefined) return 'read'
        const a = assignmentOf(w, state)
        if (a !== null) {
          prefix.set(a.name, a.value)
          rest = rest.slice(1)
          continue
        }
        const v = valueOf(w, state)
        if (v === null) return 'unread'
        if (v === '-C' || v === '--chdir') {
          dir = pathFrom(dir, valueOf(rest[1], state))
          rest = rest.slice(2)
        } else if (v.startsWith('--chdir=')) {
          dir = pathFrom(dir, v.slice('--chdir='.length))
          rest = rest.slice(1)
        } else if (v === '-u' || v === '--unset') rest = rest.slice(2)
        else if (v === '-S' || v.startsWith('--split-string')) return 'unread'
        else if (v === '--') {
          rest = rest.slice(1)
          break
        } else if (v.startsWith('-')) rest = rest.slice(1)
        else break
      }
    } else if (name === 'command') {
      const v = valueOf(rest[0], state)
      if (v === '-v' || v === '-V') return 'read'
      if (v === '-p') rest = rest.slice(1)
    } else if (spec !== undefined) {
      const inner = unwrap(rest, spec, state)
      if (inner === null) return 'unread'
      rest = inner.rest
      if (inner.chdir !== undefined) dir = pathFrom(dir, inner.chdir)
      if (
        name === 'watch' &&
        !inner.flags.some(
          (f) => f === '--exec' || (/^-[^-]/.test(f) && f.includes('x'))
        )
      ) {
        // Without -x, watch runs its words through `sh -c`.
        const parts = rest.map((w) => valueOf(w, state))
        if (parts.some((p) => p === null)) return 'unread'
        const items = shellCommands(parts.join(' '))
        if (items === null) return 'unread'
        const child = cloned(state)
        child.dir = dir
        walk(items, child, out)
        return 'read'
      }
    } else break
    if (rest.length === 0) return 'read'
    name = valueOf(rest.shift(), state)
  }
  const env: Env = new Map([...state.exported, ...prefix])
  const base = basename(name)
  if (/^git$/i.test(base)) return gitCall(rest, dir, env, state, text, out)
  if (NEVER_RUNS.has(base)) return 'read'
  if (SHELLS.has(base)) {
    const script = shellScript(rest, state)
    const items = script === null ? null : shellCommands(script)
    if (items === null) return 'unread'
    const child = cloned(state)
    child.dir = dir
    for (const [k, v] of prefix) {
      child.exported.set(k, v)
      if (v !== null) child.vars.set(k, v)
    }
    walk(items, child, out)
    return 'read'
  }
  if (name === 'eval') {
    const parts = rest.map((w) => valueOf(w, state))
    if (parts.some((p) => p === null)) return 'unread'
    const items = shellCommands(parts.join(' '))
    if (items === null) return 'unread'
    walk(items, state, out)
    return 'read'
  }
  if (name === 'cd' || name === 'pushd') {
    while (/^-[LPe@]+$/.test(valueOf(rest[0], state) ?? ''))
      rest = rest.slice(1)
    const target =
      rest[0] === undefined
        ? (state.vars.get('HOME') ?? null)
        : valueOf(rest[0], state)
    state.dir = target === '-' ? null : pathFrom(state.dir, target)
    return 'read'
  }
  if (name === 'popd') {
    state.dir = null
    return 'read'
  }
  if (name === 'export') {
    for (const w of rest) {
      const a = assignmentOf(w, state)
      if (a !== null) {
        if (a.value === null) state.vars.delete(a.name)
        else state.vars.set(a.name, a.value)
        state.exported.set(a.name, a.value)
        continue
      }
      const v = valueOf(w, state)
      if (v !== null && NAME.test(v))
        state.exported.set(v, state.vars.get(v) ?? null)
    }
    return 'read'
  }
  return 'unread'
}

/** The script of `sh -c <script>`; null without `-c`, or when not known. */
function shellScript(words: readonly Word[], state: State): string | null {
  let c = false
  let i = 0
  for (; i < words.length; i++) {
    const v = valueOf(words[i], state)
    if (v === null) return null
    if (v === '--' || v === '-') {
      i += 1
      break
    }
    if (/^[-+][oO]$/.test(v) || v === '--rcfile' || v === '--init-file') {
      i += 1
      continue
    }
    if (v.startsWith('--')) continue
    if (/^[-+][A-Za-z]+$/.test(v)) {
      if (v.startsWith('-') && v.includes('c')) c = true
      continue
    }
    break
  }
  return c ? valueOf(words[i], state) : null
}

// --- git ------------------------------------------------------------------

const COMMIT_HOOKS: readonly SkippedHook[] = ['pre-commit', 'commit-msg']
const PUSH_HOOKS: readonly SkippedHook[] = ['pre-push']
const ALL_HOOKS: readonly SkippedHook[] = [
  'pre-commit',
  'commit-msg',
  'pre-push',
]
const HOOKS_PATH = 'core.hookspath'

/** Global options of git that take the next word (git.c `handle_options`). */
const GIT_GLOBAL_ARG = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--shallow-file',
  '--attr-source',
])

type Arg = 'none' | 'required' | 'optional'

interface Options {
  readonly long: Readonly<Record<string, Arg>>
  /** Short options that take the rest of the cluster, or the next word. */
  readonly required: string
  /** Short options that take the rest of the cluster only. */
  readonly optional: string
  readonly none: string
  /** The short option that skips the hooks, if any. */
  readonly skip: string | null
}

const table = (
  required: string,
  optional: string,
  none: string
): Record<string, Arg> =>
  Object.fromEntries([
    ...required.split(' ').map((n) => [n, 'required'] as const),
    ...optional.split(' ').map((n) => [n, 'optional'] as const),
    ...none.split(' ').map((n) => [n, 'none'] as const),
  ])

const COMMIT: Options = {
  long: table(
    'file author date message reedit-message reuse-message fixup squash trailer template cleanup unified inter-hunk-context pathspec-from-file',
    'gpg-sign untracked-files',
    'quiet verbose reset-author signoff edit status all include interactive patch only no-verify dry-run short branch ahead-behind porcelain long null amend no-post-rewrite pathspec-file-nul allow-empty allow-empty-message verify post-rewrite no-no-verify no-no-post-rewrite no-quiet no-verbose no-file no-author no-date no-message no-reedit-message no-reuse-message no-fixup no-squash no-reset-author no-trailer no-signoff no-template no-edit no-cleanup no-status no-gpg-sign no-all no-include no-interactive no-patch no-only no-dry-run no-short no-branch no-ahead-behind no-porcelain no-long no-null no-amend no-untracked-files no-pathspec-from-file no-pathspec-file-nul no-allow-empty no-allow-empty-message'
  ),
  required: 'mFcCtU',
  optional: 'Su',
  none: 'apsneiovqzh',
  skip: 'n',
}

const PUSH: Options = {
  long: table(
    'repo recurse-submodules receive-pack exec push-option',
    'force-with-lease signed',
    'verbose quiet all branches mirror delete tags dry-run porcelain force force-if-includes thin set-upstream progress prune no-verify follow-tags atomic ipv4 ipv6 verify no-no-verify no-verbose no-quiet no-repo no-all no-branches no-mirror no-delete no-tags no-dry-run no-porcelain no-force no-force-with-lease no-force-if-includes no-recurse-submodules no-thin no-receive-pack no-exec no-set-upstream no-progress no-prune no-follow-tags no-signed no-atomic no-push-option'
  ),
  required: 'o',
  optional: '',
  none: 'vqufnd46h',
  skip: null,
}

/** The long option `name` names, exactly or as its one prefix; null when git refuses it. */
function longOption(name: string, options: Options): string | null {
  if (Object.hasOwn(options.long, name)) return name
  const found = Object.keys(options.long).filter((o) => o.startsWith(name))
  return found.length === 1 ? (found[0] ?? null) : null
}

/**
 * How the hooks end up for these arguments of `git commit` or `git push`:
 * the flag that skipped them last, null when they run (or git refuses the
 * arguments, and runs nothing).
 */
function verifySkipped(
  values: readonly (string | null)[],
  options: Options
): string | null {
  let skipped: string | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    // An expansion: whatever it is, it cannot be read here.
    if (v === null || v === undefined) continue
    if (v === '--') break
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      const opt = longOption(eq === -1 ? v.slice(2) : v.slice(2, eq), options)
      if (opt === null) return null
      if (opt === 'no-verify') skipped = '--no-verify'
      else if (opt === 'verify' || opt === 'no-no-verify') skipped = null
      if (eq === -1 && options.long[opt] === 'required') i += 1
      continue
    }
    if (!v.startsWith('-') || v === '-') continue
    for (let k = 1; k < v.length; k++) {
      const c = v[k] ?? ''
      if (options.required.includes(c)) {
        if (k === v.length - 1) i += 1
        break
      }
      if (options.optional.includes(c)) break
      if (!options.none.includes(c)) return null
      if (c === options.skip) skipped = `-${c}`
    }
  }
  return skipped
}

const GIT_CONFIG_READ = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--unset',
  '--unset-all',
  '-l',
  '--list',
  '-e',
  '--edit',
  '--rename-section',
  '--remove-section',
  '--get-color',
  '--get-colorbool',
])
const GIT_CONFIG_WRITE = new Set(['--add', '--replace-all'])
const GIT_CONFIG_ARG = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
  '--url',
])
const GIT_CONFIG_SUBCOMMANDS = new Set([
  'set',
  'get',
  'unset',
  'list',
  'edit',
  'rename-section',
  'remove-section',
  'get-color',
  'get-colorbool',
])

/** A configuration value given to git: by `git config`, `-c`, or the environment. */
interface ConfigWrite {
  /** As written; null when the command does not say. */
  readonly key: string | null
  /** Null when not known; undefined when none is given. */
  readonly value: string | null | undefined
  readonly scope: ConfigScope
}

/**
 * What `git config` writes, in which scope, by the old form (`git config
 * <key> <value>`, `--add`, `--replace-all`) or the new (`git config set`);
 * null when it reads, unsets or lists.
 */
function configWrite(values: readonly (string | null)[]): ConfigWrite | null {
  const positional: (string | null)[] = []
  let mode: 'read' | 'write' | null = null
  let scope: ConfigScope = 'local'
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? null
    if (v === null || !v.startsWith('-') || v === '-') {
      positional.push(v)
      continue
    }
    if (v === '--global' || v === '--system' || v === '--worktree')
      scope = v.slice(2) as ConfigScope
    else if (
      v === '-f' ||
      v === '--file' ||
      v === '--blob' ||
      v.startsWith('--file=') ||
      v.startsWith('--blob=')
    )
      scope = 'file'
    if (GIT_CONFIG_ARG.has(v)) i += 1
    else if (GIT_CONFIG_READ.has(v)) mode = 'read'
    else if (GIT_CONFIG_WRITE.has(v)) mode = 'write'
  }
  const first = positional[0]
  if (
    mode === null &&
    first !== null &&
    first !== undefined &&
    GIT_CONFIG_SUBCOMMANDS.has(first)
  ) {
    positional.shift()
    mode = first === 'set' ? 'write' : 'read'
  }
  if (mode === 'read' || positional.length === 0) return null
  if (mode !== 'write' && positional.length < 2) return null
  return { key: positional[0] ?? null, value: positional[1], scope }
}

/** Whether an alias's value runs git without its hooks. */
function aliasSkips(value: string, state: State): boolean {
  if (value.includes('--no-veri')) return true
  const script = value.startsWith('!') ? value.slice(1) : `git ${value}`
  const items = shellCommands(script)
  if (items === null) return false
  const out: GitBypass[] = []
  walk(items, cloned(state), out)
  return out.length > 0
}

type Found = Omit<GitBypass, 'dir' | 'text'>

/**
 * Why a configuration value skips the hooks: core.hooksPath, an include (a
 * file that may set it), an alias whose value skips them; or a key the
 * command does not say. Null for any other key.
 */
function configBypass(w: ConfigWrite, state: State): Found | null {
  if (w.key === null) return { how: 'an unknown key', skips: ALL_HOOKS }
  const key = w.key.toLowerCase()
  if (key === HOOKS_PATH)
    return {
      how: 'core.hooksPath',
      skips: ALL_HOOKS,
      ...(typeof w.value === 'string' ? { hooksPath: w.value } : {}),
      scope: w.scope,
    }
  if (key === 'include.path' || key.startsWith('includeif.'))
    return { how: w.key, skips: ALL_HOOKS }
  if (
    key.startsWith('alias.') &&
    typeof w.value === 'string' &&
    aliasSkips(w.value, state)
  )
    return { how: w.key, skips: ALL_HOOKS }
  return null
}

/** `key=value` as `-c` takes it; the value of `--config-env` is an environment variable's. */
function keyValue(
  kv: string | null,
  scope: ConfigScope
): {
  key: string | null
  value: string | null | undefined
  scope: ConfigScope
} {
  if (kv === null) return { key: null, value: null, scope }
  const eq = kv.indexOf('=')
  return eq === -1
    ? { key: kv, value: undefined, scope }
    : { key: kv.slice(0, eq), value: kv.slice(eq + 1), scope }
}

/** The pairs of `GIT_CONFIG_PARAMETERS`: `'key'='value'`, or `'key=value'` as older git wrote. */
function parametersOf(text: string): ConfigWrite[] {
  const pairs: ConfigWrite[] = []
  for (const m of text.matchAll(/'([^']*)'(?:='([^']*)')?/g)) {
    const key = m[1] ?? ''
    const value = m[2]
    const eq = key.indexOf('=')
    pairs.push(
      value === undefined && eq !== -1
        ? {
            key: key.slice(0, eq),
            value: key.slice(eq + 1),
            scope: 'environment',
          }
        : { key, value, scope: 'environment' }
    )
  }
  return pairs
}

/** Variables that point git at another configuration file. */
const OTHER_CONFIG = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG']

/**
 * The configuration git gets from its environment: GIT_CONFIG_KEY_<n> and
 * GIT_CONFIG_VALUE_<n>, GIT_CONFIG_PARAMETERS, another configuration file.
 */
function environmentBypasses(env: Env, state: State): Found[] {
  const found: Found[] = []
  for (const [name, value] of env) {
    const n = /^GIT_CONFIG_KEY_(\d+)$/.exec(name)?.[1]
    if (n !== undefined) {
      const hit = configBypass(
        {
          key: value?.trim() ?? null,
          value: env.get(`GIT_CONFIG_VALUE_${n}`),
          scope: 'environment',
        },
        state
      )
      if (hit !== null)
        found.push(
          hit.how === 'core.hooksPath'
            ? { ...hit, how: `${name}=core.hooksPath` }
            : hit.how === 'an unknown key'
              ? { ...hit, how: name }
              : hit
        )
    } else if (name === 'GIT_CONFIG_PARAMETERS') {
      if (value === null) {
        found.push({ how: name, skips: ALL_HOOKS })
        continue
      }
      const hits = parametersOf(value)
        .map((w) => configBypass(w, state))
        .filter((h) => h !== null)
      const path = hits.find((h) => h.how === 'core.hooksPath')
      if (path !== undefined) found.push({ ...path, how: name })
      else if (value.toLowerCase().includes(HOOKS_PATH))
        found.push({ how: name, skips: ALL_HOOKS, scope: 'environment' })
      found.push(...hits.filter((h) => h.how !== 'core.hooksPath'))
    } else if (OTHER_CONFIG.includes(name))
      found.push({ how: name, skips: ALL_HOOKS })
  }
  return found
}

/** One call of git: its global options, then its subcommand. */
function gitCall(
  words: readonly Word[],
  from: string | null,
  env: Env,
  state: State,
  text: string,
  out: GitBypass[]
): Read {
  const values = words.map((w) => valueOf(w, state))
  let dir = from
  // The command line's options before the environment's variables; both
  // relative to where git ends up, after every -C.
  const fromEnv = (name: string): string | null | undefined =>
    env.has(name) ? (env.get(name) ?? null) : undefined
  let gitDir = fromEnv('GIT_DIR')
  let workTree = fromEnv('GIT_WORK_TREE')
  const configs: ConfigWrite[] = []
  const lookup = (kv: string | null): string | null => {
    const v = keyValue(kv, 'command').value
    if (typeof v !== 'string') return null
    return env.get(v) ?? state.vars.get(v) ?? null
  }
  let i = 0
  for (; i < values.length; i++) {
    const v = values[i]
    // An option git reads that cannot be read here: judged by its words.
    if (v === null || v === undefined) return 'unread'
    const next = values[i + 1] ?? null
    if (GIT_GLOBAL_ARG.has(v)) {
      if (v === '-C') dir = next === '' ? dir : pathFrom(dir, next)
      else if (v === '-c') configs.push(keyValue(next, 'command'))
      else if (v === '--config-env')
        configs.push({ ...keyValue(next, 'command'), value: lookup(next) })
      else if (v === '--git-dir') gitDir = next
      else if (v === '--work-tree') workTree = next
      i += 1
    } else if (v.startsWith('--config-env=')) {
      const kv = v.slice('--config-env='.length)
      configs.push({ ...keyValue(kv, 'command'), value: lookup(kv) })
    } else if (v.startsWith('--git-dir=')) {
      gitDir = v.slice('--git-dir='.length)
    } else if (v.startsWith('--work-tree=')) {
      workTree = v.slice('--work-tree='.length)
    } else if (!v.startsWith('-')) break
  }
  const sub = values[i]
  // No subcommand: git prints its usage and runs no hook.
  if (sub === null || sub === undefined) return 'read'
  const place = (p: string | null): string | null => pathFrom(dir, p)
  const where =
    workTree !== undefined
      ? place(workTree)
      : gitDir !== undefined
        ? ((d) =>
            d === null ? null : basename(d) === '.git' ? dirname(d) : d)(
            place(gitDir)
          )
        : dir
  const args = values.slice(i + 1)
  const found = (f: Found): void => {
    out.push({ dir: where, text, ...f })
  }

  for (const c of configs) {
    const hit = configBypass(c, state)
    if (hit !== null)
      found(hit.how === 'an unknown key' ? { ...hit, how: '-c' } : hit)
  }
  for (const f of environmentBypasses(env, state)) found(f)
  if (sub === 'commit') {
    const how = verifySkipped(args, COMMIT)
    if (how !== null) found({ how, skips: COMMIT_HOOKS })
  } else if (sub === 'push') {
    const how = verifySkipped(args, PUSH)
    if (how !== null) found({ how, skips: PUSH_HOOKS })
  } else if (sub === 'config') {
    const write = configWrite(args)
    const hit = write === null ? null : configBypass(write, state)
    if (hit !== null)
      found(hit.how === 'an unknown key' ? { ...hit, how: 'config' } : hit)
  }
  return 'read'
}

/**
 * The backstop, for a command the parser did not read to the end (a wrapper
 * it does not know, an option it cannot read): its words name git and then
 * `--no-verify`, or core.hooksPath where a value is set. A `-n` alone is
 * not enough (`xargs -n`, `git push -n`).
 */
function backstop(
  words: readonly Word[],
  state: State,
  text: string,
  out: GitBypass[]
): void {
  const values = words.map((w) => valueOf(w, state))
  const first = values[0]
  if (first !== null && first !== undefined && NEVER_RUNS.has(basename(first)))
    return
  const g = values.findIndex((v) => v !== null && /^git$/i.test(basename(v)))
  if (g === -1) return
  const after = values.slice(g + 1)
  const found = (how: string, skips: readonly SkippedHook[]): void => {
    out.push({ dir: state.dir, text, how, skips })
  }
  if (after.includes('--no-verify')) {
    found(
      '--no-verify',
      after.includes('push')
        ? PUSH_HOOKS
        : after.includes('commit')
          ? COMMIT_HOOKS
          : ALL_HOOKS
    )
    return
  }
  const config = after.indexOf('config')
  const set = after.some((v, k) => {
    const low = v?.toLowerCase() ?? ''
    if (/^--config-env=core\.hookspath(=|$)/.test(low)) return true
    if (!/^core\.hookspath(=|$)/.test(low)) return false
    const prev = after[k - 1]
    if (prev === '-c' || prev === '--config-env') return true
    const value = after[k + 1]
    return (
      config !== -1 &&
      config < k &&
      value !== undefined &&
      !(value ?? '').startsWith('-')
    )
  })
  if (set) found('core.hooksPath', ALL_HOOKS)
}

/**
 * The bypasses of the git hooks a Bash command holds, in the order they
 * run; null when the command cannot be read (the shell would refuse it).
 */
export function gitBypasses(
  command: string,
  start: ShellStart
): GitBypass[] | null {
  const items = shellCommands(command)
  if (items === null) return null
  const vars = new Map<string, string>()
  for (const [k, v] of Object.entries(start.env))
    if (v !== undefined) vars.set(k, v)
  const out: GitBypass[] = []
  walk(items, { dir: resolve(start.cwd), vars, exported: new Map() }, out)
  return out
}
