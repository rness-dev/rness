import { basename, dirname, isAbsolute, resolve } from 'node:path'

import {
  type Dialect,
  type ShellItem,
  VARIABLE_NAME,
  type Word,
  expandBraces,
  patternOf,
  shellCommands,
} from './shell-words.ts'

/**
 * The git calls of a Bash command that would skip the git hooks (spec 0040
 * §4.3): `git commit --no-verify` or `-n`, `git push`, `git merge` and `git
 * pull --no-verify`; core.hooksPath, an alias that skips them, an include or
 * another configuration file given to git by `-c`, `--config-env`, `git
 * config` or the environment. Pure: a command and where it starts in, the
 * bypasses out, each with the directory git runs in. The command is read as
 * the shell reads it (`./shell-words.ts`), not matched as a string. Where it
 * cannot be read to the end (an unknown wrapper, an expansion), its words
 * are judged by a backstop that fails closed: the finding is a "may".
 *
 * The option tables are git 2.56.0's (`git <command>
 * --git-completion-helper-all`, read 2026-11-03): git takes an unambiguous
 * prefix of a long option (`--no-veri` for commit), refuses an ambiguous or
 * unknown one (`--no-ver`) and so runs nothing, and the last of
 * `--no-verify` and `--verify` wins. An option this git does not know
 * leaves only a literal `--no-verify` to read, which may skip the hooks.
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
  /**
   * The command may skip the hooks, as far as can be told here: another
   * configuration given to git, a value or a command not read to the end.
   */
  readonly maybe?: true
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

/** A command name: its value, or null when the shell expands it (a glob, a brace expression) or it cannot be read. */
function nameOf(word: Word | undefined, state: State): string | null {
  if (word === undefined || patternOf(word) !== null) return null
  return valueOf(word, state)
}

/** `NAME=value`: its name and value (null when not known); null for no assignment. */
function assignmentOf(
  word: Word,
  state: State
): { name: string; value: string | null } | null {
  const first = word.segments[0]
  if (first?.kind !== 'text' || first.quoted) return null
  const eq = first.text.indexOf('=')
  if (eq < 1 || !VARIABLE_NAME.test(first.text.slice(0, eq))) return null
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
    backstop(words.slice(i), prefix, state, item.text, out)
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
  'echo printf grep egrep fgrep which type true false :'.split(' ')
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
  let name = nameOf(rest.shift(), state)
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
    name = nameOf(rest.shift(), state)
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
      if (v !== null && VARIABLE_NAME.test(v))
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

/** git merge: `-n` is `--no-stat`; `--no-verify` skips commit-msg (and pre-merge-commit). */
const MERGE: Options = {
  long: table(
    'cleanup strategy strategy-option message file into-name',
    'gpg-sign log',
    'stat summary compact-summary squash commit edit ff ff-only rerere-autoupdate verify-signatures verbose quiet abort quit continue allow-unrelated-histories progress autostash overwrite-ignore signoff no-verify verify no-stat no-summary no-compact-summary no-log no-squash no-commit no-edit no-cleanup no-ff no-rerere-autoupdate no-verify-signatures no-strategy no-strategy-option no-message no-into-name no-verbose no-quiet no-abort no-quit no-continue no-allow-unrelated-histories no-progress no-gpg-sign no-autostash no-overwrite-ignore no-signoff'
  ),
  required: 'smXF',
  optional: 'S',
  none: 'nevqh',
  skip: null,
}

/** git pull: what it hands git merge, `--no-verify` among it. */
const PULL: Options = {
  long: table(
    'cleanup strategy strategy-option upload-pack depth shallow-since shallow-exclude deepen refmap server-option negotiation-restrict negotiation-tip negotiation-include',
    'recurse-submodules rebase gpg-sign jobs log',
    'verbose quiet progress stat summary compact-summary signoff squash commit edit ff ff-only verify verify-signatures autostash allow-unrelated-histories all append force tags prune dry-run keep unshallow update-shallow ipv4 ipv6 show-forced-updates set-upstream no-verify no-verbose no-quiet no-progress no-recurse-submodules no-rebase no-stat no-summary no-compact-summary no-log no-signoff no-squash no-commit no-edit no-cleanup no-ff no-verify-signatures no-autostash no-strategy no-strategy-option no-gpg-sign no-allow-unrelated-histories no-all no-append no-upload-pack no-force no-tags no-prune no-jobs no-dry-run no-keep no-depth no-shallow-since no-shallow-exclude no-deepen no-update-shallow no-server-option no-ipv4 no-ipv6 no-negotiation-restrict no-negotiation-tip no-negotiation-include no-show-forced-updates no-set-upstream'
  ),
  required: 'sXo',
  optional: 'rSj',
  none: 'vqnaftpk46h',
  skip: null,
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

/** The subcommands whose `--no-verify` skips hooks of a clone, and which. */
const VERIFIED: Readonly<
  Record<string, { options: Options; hooks: readonly SkippedHook[] }>
> = {
  commit: { options: COMMIT, hooks: COMMIT_HOOKS },
  push: { options: PUSH, hooks: PUSH_HOOKS },
  merge: { options: MERGE, hooks: ['commit-msg'] },
  pull: { options: PULL, hooks: ['commit-msg'] },
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
): { how: string; maybe: boolean } | null {
  let skipped: string | null = null
  // An option this git does not know: git 2.56 refuses the command, a newer
  // git may not, and whether it takes a value cannot be told. Then only a
  // literal --no-verify is read, and it may skip the hooks.
  let unsure = false
  let literal = false
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    // An expansion: whatever it is, it cannot be read here.
    if (v === null || v === undefined) continue
    if (v === '--') break
    if (v === '--no-verify') literal = true
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      const opt = longOption(eq === -1 ? v.slice(2) : v.slice(2, eq), options)
      if (opt === null) {
        unsure = true
        continue
      }
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
      if (!options.none.includes(c)) {
        unsure = true
        break
      }
      if (c === options.skip) skipped = `-${c}`
    }
  }
  if (unsure) return literal ? { how: '--no-verify', maybe: true } : null
  return skipped === null ? null : { how: skipped, maybe: false }
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
  if (w.key === null)
    return { how: 'an unknown key', skips: ALL_HOOKS, maybe: true }
  const key = w.key.toLowerCase()
  if (key === HOOKS_PATH)
    return {
      how: 'core.hooksPath',
      skips: ALL_HOOKS,
      ...(typeof w.value === 'string' ? { hooksPath: w.value } : {}),
      scope: w.scope,
    }
  if (key === 'include.path' || key.startsWith('includeif.'))
    return { how: w.key, skips: ALL_HOOKS, maybe: true }
  if (key.startsWith('alias.')) {
    // An alias whose value is not known may be anything.
    if (w.value === null) return { how: w.key, skips: ALL_HOOKS, maybe: true }
    if (typeof w.value === 'string' && aliasSkips(w.value, state))
      return { how: w.key, skips: ALL_HOOKS }
  }
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

/**
 * `-c`'s word: its key and value; when the word holds an expansion, the key
 * it starts with written out (`alias.ci=$V`), its value not known.
 */
function keyValueOf(word: Word | undefined, state: State): ConfigWrite {
  const whole = valueOf(word, state)
  if (whole !== null || word === undefined) return keyValue(whole, 'command')
  let lead = ''
  for (const seg of word.segments) {
    if (seg.kind !== 'text') break
    lead += seg.text
  }
  const eq = lead.indexOf('=')
  return eq === -1
    ? { key: null, value: null, scope: 'command' }
    : { key: lead.slice(0, eq), value: null, scope: 'command' }
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
        found.push({ how: name, skips: ALL_HOOKS, maybe: true })
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
      found.push({ how: name, skips: ALL_HOOKS, maybe: true })
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
  // A glob or a brace expression makes other words of these: judged by the
  // backstop (a brace by its parts, a glob as a word not known).
  if (words.some((w) => patternOf(w) !== null)) return 'unread'
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
      else if (v === '-c') configs.push(keyValueOf(words[i + 1], state))
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
  const skipped = VERIFIED[sub]
  if (skipped !== undefined) {
    const hit = verifySkipped(args, skipped.options)
    if (hit !== null)
      found({
        how: hit.how,
        skips: skipped.hooks,
        ...(hit.maybe ? { maybe: true as const } : {}),
      })
  } else if (sub === 'config') {
    const write = configWrite(args)
    const hit = write === null ? null : configBypass(write, state)
    if (hit !== null)
      found(hit.how === 'an unknown key' ? { ...hit, how: 'config' } : hit)
  }
  return 'read'
}

/**
 * Whether a word the shell expands may start with `-`, and so be an option,
 * decided on what it expands to first, empty quotes (`""`, `''`) skipped:
 * `-`, an unquoted glob or brace character, or an expansion not known. A
 * tilde starts a path.
 */
function mayStartWithDash(word: Word): boolean {
  const first = word.segments.find(
    (seg) => seg.kind !== 'text' || seg.text !== ''
  )
  if (first === undefined) return false
  if (first.kind === 'tilde') return false
  if (first.kind !== 'text') return true
  const c = first.text[0] ?? ''
  return c === '-' || (!first.quoted && '*?[{'.includes(c))
}

/** A short-option cluster holding `n`: `-n`, `-an`, `-nm`. */
const N_CLUSTER = /^-[A-Za-z]*n[A-Za-z]*$/

/**
 * The backstop, for a command the parser did not read to the end (a wrapper
 * it does not know, an option or a command name it cannot read). It fails
 * closed on what the words show, each finding one that may skip the hooks:
 * git (or a command name that cannot be read) then `--no-verify`, or then
 * `commit` and a short-option cluster holding `n`, or then `commit` or
 * `push` and a word the shell expands (a glob, an unknown expansion);
 * git then core.hooksPath,
 * an alias or an include given a value (`-c`, `--config-env`, `config`);
 * git given another configuration by its environment (the command's
 * assignments, the exported ones, `VAR=value` words before git). A `-n`
 * without `commit` is not enough (`xargs -n`, `git push -n`).
 */
function backstop(
  words: readonly Word[],
  prefix: ReadonlyMap<string, string | null>,
  state: State,
  text: string,
  out: GitBypass[]
): void {
  // The words as the shell may run them. Up to the word holding `commit` or
  // `push`, a brace word is expanded as bash expands it, so that git and its
  // verb are found. After it, a pattern is judged by its first character: one
  // that may start with `-` is not known (it may be an option); one that
  // cannot (`src/*.ts`, `docs/{a,b}.md`, zsh's `=cmd`) stands as its text.
  const asRun = (x: Word): string | null =>
    patternOf(x) === null
      ? valueOf(x, state)
      : mayStartWithDash(x)
        ? null
        : x.segments
            .map((seg) => (seg.kind === 'text' ? seg.text : ''))
            .join('')
  const values: (string | null)[] = []
  const wordAt: number[] = []
  let verbSeen = false
  words.forEach((w, k) => {
    const parts =
      patternOf(w) === 'brace' && !verbSeen
        ? (expandBraces(w)?.map(asRun) ?? [null])
        : [asRun(w)]
    for (const part of parts) {
      values.push(part)
      wordAt.push(k)
      if (part === 'commit' || part === 'push') verbSeen = true
    }
  })
  const first = values[0]
  if (first !== null && first !== undefined && NEVER_RUNS.has(basename(first)))
    return
  let g = values.findIndex((v) => v !== null && /^git$/i.test(basename(v)))
  const named = g !== -1
  if (!named) {
    // A word that cannot be read, or a pattern none of whose parts is git
    // (`{gi,x}t`, `/usr/bin/gi?`), may be git: git's own shape only.
    g = values.findIndex(
      (v, k) =>
        v === null ||
        patternOf(words[wordAt[k] ?? 0] ?? { segments: [] }) !== null
    )
    if (g === -1) return
  }
  const after = values.slice(g + 1)
  const found = (how: string, skips: readonly SkippedHook[]): void => {
    out.push({ dir: state.dir, text, how, skips, maybe: true })
  }
  const sub = after.some((v) => v === 'commit' || v === 'push')
  if (after.includes('--no-verify') && (named || sub)) {
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
  const commit = after.indexOf('commit')
  if (
    commit !== -1 &&
    after.slice(commit + 1).some((v) => v !== null && N_CLUSTER.test(v))
  ) {
    found('-n', COMMIT_HOOKS)
    return
  }
  // A word after `commit` or `push` that the shell expands (a glob, an
  // expansion not known) may be `--no-verify`, or `-n`.
  const verb = after.findIndex((v) => v === 'commit' || v === 'push')
  if (verb !== -1 && after.slice(verb + 1).some((v) => v === null)) {
    found(
      'a word the shell expands',
      after[verb] === 'push' ? PUSH_HOOKS : COMMIT_HOOKS
    )
    return
  }
  if (!named) return
  const env = new Map([...state.exported, ...prefix])
  for (const w of words.slice(0, wordAt[g] ?? 0)) {
    const a = assignmentOf(w, state)
    if (a !== null) env.set(a.name, a.value)
  }
  const configured = environmentBypasses(env, state)
  if (configured.length > 0) {
    for (const f of configured) found(f.how, f.skips)
    return
  }
  const config = after.indexOf('config')
  for (let k = 0; k < after.length; k++) {
    const v = after[k]
    if (v === null || v === undefined) continue
    const prev = after[k - 1]
    const next = after[k + 1]
    let kv: string | null = null
    if (prev === '-c' || prev === '--config-env') kv = v
    else if (v.toLowerCase().startsWith('--config-env='))
      kv = v.slice('--config-env='.length)
    else if (
      config !== -1 &&
      config < k &&
      !v.startsWith('-') &&
      next !== undefined &&
      !(next ?? '').startsWith('-')
    )
      kv = v
    if (kv === null) continue
    const key = kv.split('=')[0] ?? ''
    const low = key.toLowerCase()
    if (low === HOOKS_PATH) {
      found('core.hooksPath', ALL_HOOKS)
      return
    }
    if (
      low.startsWith('alias.') ||
      low.startsWith('include.') ||
      low.startsWith('includeif.')
    ) {
      found(key, ALL_HOOKS)
      return
    }
  }
}

/**
 * The bypasses of the git hooks a Bash command holds, in the order they
 * run; null when the command cannot be read (the shell would refuse it).
 */
export function gitBypasses(
  command: string,
  start: ShellStart
): GitBypass[] | null {
  // Claude Code's Bash tool may run bash or zsh: what either would run is
  // judged, each bypass once; null only when neither would read it.
  let read = false
  const out: GitBypass[] = []
  const seen = new Set<string>()
  for (const dialect of DIALECTS) {
    const items = shellCommands(command, dialect)
    if (items === null) continue
    read = true
    const vars = new Map<string, string>()
    for (const [k, v] of Object.entries(start.env))
      if (v !== undefined) vars.set(k, v)
    const found: GitBypass[] = []
    walk(items, { dir: resolve(start.cwd), vars, exported: new Map() }, found)
    for (const b of found) {
      const key = JSON.stringify([b.dir, b.text, b.how, b.skips])
      if (seen.has(key)) continue
      seen.add(key)
      out.push(b)
    }
  }
  return read ? out : null
}

const DIALECTS: readonly Dialect[] = ['bash', 'zsh']
