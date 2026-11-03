import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  expandBraces,
  literalOf,
  patternOf,
  shellCommands,
} from '../../src/core/shell-words.ts'

// The shell reader under the guard's Bash branch (spec 0040 §4.3): words as
// a POSIX shell splits them, read without running anything.

/** The words of each command, `enter`/`leave` for a subshell. */
const shape = (script: string, dialect?: 'bash' | 'zsh') =>
  shellCommands(script, dialect)?.map((item) =>
    item.kind === 'command' ? item.words.map(literalOf) : item.kind
  ) ?? null

test('shellCommands: lists, pipes, background and newlines separate commands; quotes hold them', () => {
  assert.deepEqual(
    shape(`cd 'a b' && git commit -m "x; y" | cat || true; ls &\npwd`),
    [
      ['cd', 'a b'],
      ['git', 'commit', '-m', 'x; y'],
      ['cat'],
      ['true'],
      ['ls'],
      ['pwd'],
    ]
  )
})

test('shellCommands: backslashes, single quotes, ANSI-C quotes and line continuations', () => {
  assert.deepEqual(
    shape(`echo a\\ b '$HOME' $'it\\'s' "say \\"hi\\"" one\\\ntwo`),
    [['echo', 'a b', '$HOME', "it's", 'say "hi"', 'onetwo']]
  )
})

test('shellCommands: an expansion makes a word unknown; a comment ends the line', () => {
  assert.deepEqual(shape('git $X "${Y}" `pwd` # git commit -n\nls'), [
    'enter',
    ['pwd'],
    'leave',
    ['git', null, null, null],
    ['ls'],
  ])
})

test('shellCommands: the commands of a substitution and of a subshell are read, as their own scope', () => {
  assert.deepEqual(shape('echo "$(git commit -n)" && (cd a; ls)'), [
    'enter',
    ['git', 'commit', '-n'],
    'leave',
    ['echo', null],
    'enter',
    ['cd', 'a'],
    ['ls'],
    'leave',
  ])
})

test('shellCommands: redirections and their targets are no words; a heredoc body is no command', () => {
  assert.deepEqual(
    shape(
      'git commit -n -F - 2>&1 >out.txt <<EOF\ngit commit --no-verify\nEOF\ngit status <<-"END"\n\tgit push --no-verify\n\tEND\nls'
    ),
    [['git', 'commit', '-n', '-F', '-'], ['git', 'status'], ['ls']]
  )
})

test('shellCommands: each command keeps its text as written', () => {
  const items = shellCommands(`cd org/web && git commit -m "a b"  ;ls`) ?? []
  assert.deepEqual(
    items.map((i) => (i.kind === 'command' ? i.text : i.kind)),
    ['cd org/web', 'git commit -m "a b"', 'ls']
  )
})

test('shellCommands: an unbalanced quote, substitution or subshell cannot be read', () => {
  for (const script of [
    'git commit -m "oops',
    "git commit -m 'oops",
    'echo $(git commit -n',
    'echo `git commit -n',
    '(git commit -n',
    'echo ${HOME',
  ])
    assert.equal(shellCommands(script), null, script)
})

test('shellCommands: ANSI-C quotes decode hex, octal, Unicode and control escapes; one they cannot decode is unknown', () => {
  assert.deepEqual(
    shape(
      `$'\\x67it' $'\\147it' $'\\u0067it' $'\\U00000067it' $'a\\cAb' g\\it $'\\q' $'\\x'`
    ),
    [['git', 'git', 'git', 'git', 'a\u0001b', 'git', null, null]]
  )
})

test('shellCommands: arithmetic is one piece: its << is no here-document, its substitutions are read', () => {
  assert.deepEqual(shape('echo $((1 << 2))\ngit commit -n'), [
    ['echo', null],
    ['git', 'commit', '-n'],
  ])
  assert.deepEqual(shape('((x <<= 1)); git commit -n'), [
    ['git', 'commit', '-n'],
  ])
  assert.deepEqual(shape('echo $(( $(git commit -n) + `pwd` ))'), [
    'enter',
    ['git', 'commit', '-n'],
    'leave',
    'enter',
    ['pwd'],
    'leave',
    ['echo', null],
  ])
  // Not closed as arithmetic: two subshells, as the shell reads it.
  assert.deepEqual(shape('((cd a && git commit -n); ls)'), [
    'enter',
    'enter',
    ['cd', 'a'],
    ['git', 'commit', '-n'],
    'leave',
    ['ls'],
    'leave',
  ])
  assert.equal(shellCommands('echo $((1 + 2'), null)
})

test('shellCommands: quotes inside $((...)), ((...)) and ${...} are quotes, as bash reads them', () => {
  const after = ['git', 'commit', '-n', '-m', 'x']
  for (const script of [
    `echo $(( ')' )) ; git commit -n -m x`,
    `echo $(( "))" )) ; git commit -n -m x`,
    `echo $(( $'))' )) ; git commit -n -m x`,
    `echo $(( \\) )) ; git commit -n -m x`,
    `echo \${x:-'}'} ; git commit -n -m x`,
    `echo "\${x:-"}"}" ; git commit -n -m x`,
    `echo \${x:-\\}} ; git commit -n -m x`,
  ])
    assert.deepEqual(shape(script), [['echo', null], after], script)
  assert.deepEqual(shape(`(( "))" )) ; git commit -n -m x`), [after])
  // What a substitution inside ${...} runs is read.
  assert.deepEqual(shape('echo ${x:-$(git commit -n)}'), [
    'enter',
    ['git', 'commit', '-n'],
    'leave',
    ['echo', null],
  ])
  // A quote that does not close: bash refuses the line.
  assert.equal(shellCommands(`echo $(( '1 )) ; git commit -n -m x`), null)
})

test('shellCommands: read as zsh, a single quote in a double-quoted ${...} is a character, and arithmetic ignores quotes', () => {
  const script = `echo "\${x:-'a}" ; git commit -n -m x`
  assert.equal(shellCommands(script), null, 'bash: the quote never closes')
  assert.deepEqual(shape(script, 'zsh'), [
    ['echo', null],
    ['git', 'commit', '-n', '-m', 'x'],
  ])
  assert.deepEqual(shape(`echo $(( '1 )) ; git commit -n -m x`, 'zsh'), [
    ['echo', null],
    ['git', 'commit', '-n', '-m', 'x'],
  ])
})

test('patternOf: an unquoted glob or brace expression in a word', () => {
  const [command] =
    shellCommands(
      `{gi,x}t /usr/bin/gi? "a*" x{a}y {a,b} {1..3} [ab] '{a,b}' plain`
    ) ?? []
  assert.ok(command?.kind === 'command')
  assert.deepEqual(command.words.map(patternOf), [
    'brace',
    'glob',
    null,
    null,
    'brace',
    'brace',
    'glob',
    null,
    null,
  ])
})

test('patternOf: a brace expression is decided on the whole word, its braces and separator unquoted; zsh expands =cmd', () => {
  const [command] =
    shellCommands(
      `{"gi",x}t {g'i',x}t "{"a,b} {"a,b"} \\{a,b} {a".."b} {a..b} =git = a=b`
    ) ?? []
  assert.ok(command?.kind === 'command')
  assert.deepEqual(command.words.map(patternOf), [
    'brace',
    'brace',
    null,
    null,
    null,
    null,
    'brace',
    'glob',
    null,
    null,
  ])
})

test('expandBraces: a word as bash expands its braces, quoted parts kept, capped', () => {
  const expand = (text: string) => {
    const [command] = shellCommands(text) ?? []
    assert.ok(command?.kind === 'command')
    const words =
      command.words[0] === undefined ? null : expandBraces(command.words[0])
    return words?.map(literalOf) ?? null
  }
  assert.deepEqual(expand('{gi,x}t'), ['git', 'xt'])
  assert.deepEqual(expand(`{"gi",x}t`), ['git', 'xt'])
  assert.deepEqual(expand('{--no-ver,x}ify'), ['--no-verify', 'xify'])
  assert.deepEqual(expand('docs/{a,b}.md'), ['docs/a.md', 'docs/b.md'])
  assert.deepEqual(expand('{a,{b,c}}d'), ['ad', 'bd', 'cd'])
  assert.deepEqual(expand('{a{b,c}}'), ['{ab}', '{ac}'])
  assert.deepEqual(expand('{1..7..3}'), ['1', '4', '7'])
  assert.deepEqual(expand('{c..a}'), ['c', 'b', 'a'])
  assert.deepEqual(expand(`{"a,b",c}`), ['a,b', 'c'])
  assert.deepEqual(expand('{a,b}{1,2}'), ['a1', 'a2', 'b1', 'b2'])
  assert.deepEqual(expand('x{a}y'), ['x{a}y'])
  assert.deepEqual(expand('{a,b'), ['{a,b'])
  assert.deepEqual(expand('{$X,b}'), [null, 'b'])
  assert.equal(expand('{1..100000}'), null, 'too many to read')
})
