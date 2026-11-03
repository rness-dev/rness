import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  type GitBypass,
  gitBypasses,
  literalOf,
  shellCommands,
} from '../../src/core/git-bypass.ts'

// What the guard reads in a Bash command (spec 0040 §4.3): the git calls
// that would skip the hooks, where each runs. The option tables were read
// from git 2.56.0 (`git commit --git-completion-helper-all`) and each
// parsing rule below was checked against that git on 2026-11-03.

const AT = { cwd: '/w', env: { HOME: '/home/me' } }

/** The words of each command, `enter`/`leave` for a subshell. */
const shape = (script: string) =>
  shellCommands(script)?.map((item) =>
    item.kind === 'command' ? item.words.map(literalOf) : item.kind
  ) ?? null

const COMMIT = ['pre-commit', 'commit-msg']
const ALL = ['pre-commit', 'commit-msg', 'pre-push']

/** The bypasses of a command, without their text. */
const found = (script: string, at = AT) =>
  gitBypasses(script, at)?.map(({ text: _text, ...rest }: GitBypass) => rest) ??
  null

// --- the tokenizer -----------------------------------------------------------

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

// --- git commit ---------------------------------------------------------------

test('gitBypasses: git commit -n and --no-verify, in a cluster, abbreviated', () => {
  const commit = (how: string) => [{ dir: '/w', how, skips: COMMIT }]
  assert.deepEqual(found('git commit -n -m x'), commit('-n'))
  assert.deepEqual(found('git commit -an -m x'), commit('-n'))
  assert.deepEqual(found('git commit -nm x'), commit('-n'))
  assert.deepEqual(found('git commit -C HEAD -n'), commit('-n'))
  assert.deepEqual(found('git commit -uno -n -m x'), commit('-n'))
  assert.deepEqual(
    found('git commit --amend --no-verify'),
    commit('--no-verify')
  )
  assert.deepEqual(found('git commit --no-veri -m x'), commit('--no-verify'))
  assert.deepEqual(found('git commit -m x file.txt -n'), commit('-n'))
})

test('gitBypasses: -n inside an option argument is a message; --verify after it runs the hooks', () => {
  for (const script of [
    'git commit -m "-n"',
    'git commit -m n',
    'git commit -m -n',
    'git commit -mn',
    'git commit --message -n',
    'git commit --mess -n',
    'git commit --message=-n',
    'git commit -F -n',
    'git commit -Sn -m x',
    'git commit -m x -- -n',
    'git commit -n --verify -m x',
    'git commit --no-verify --veri -m x',
    'git commit --no-verify --no-no-verify -m x',
    // Ambiguous to git (--no-verbose or --no-verify), or unknown: git refuses.
    'git commit --no-ver -m x',
    'git commit -nX -m x',
    'git commit -m "git commit -n"',
  ])
    assert.deepEqual(found(script), [], script)
})

// --- git push -----------------------------------------------------------------

test('gitBypasses: git push --no-verify; -n is a dry run; -o takes the next word', () => {
  assert.deepEqual(found('git push --no-verify origin main'), [
    { dir: '/w', how: '--no-verify', skips: ['pre-push'] },
  ])
  assert.deepEqual(found('git push -u origin HEAD --no-veri'), [
    { dir: '/w', how: '--no-verify', skips: ['pre-push'] },
  ])
  for (const script of [
    'git push -n origin main',
    'git push --dry-run',
    'git push -o --no-verify origin',
    'git push --push-option --no-verify origin',
    'git push --no-verify --verify',
    'git push --no-v',
  ])
    assert.deepEqual(found(script), [], script)
})

// --- core.hooksPath -----------------------------------------------------------

test('gitBypasses: git -c core.hooksPath=... on any subcommand, the key in any case', () => {
  assert.deepEqual(found('git -c core.hooksPath=/dev/null commit -m x'), [
    {
      dir: '/w',
      how: 'core.hooksPath',
      skips: ALL,
      hooksPath: '/dev/null',
    },
  ])
  assert.deepEqual(found('git -c CORE.HOOKSPATH=x status'), [
    { dir: '/w', how: 'core.hooksPath', skips: ALL, hooksPath: 'x' },
  ])
  assert.deepEqual(found('git --config-env=core.hooksPath=V push'), [
    { dir: '/w', how: 'core.hooksPath', skips: ALL },
  ])
  assert.deepEqual(found('git --config-env core.hookspath=V commit'), [
    { dir: '/w', how: 'core.hooksPath', skips: ALL },
  ])
  assert.deepEqual(found('git -c user.name=x commit -m x'), [])
  assert.deepEqual(found('git -c core.hooksPath=/dev/null'), [])
})

test('gitBypasses: setting core.hooksPath with git config; reading or unsetting it passes', () => {
  for (const [script, value] of [
    ['git config core.hooksPath /dev/null', '/dev/null'],
    ['git config --local core.hooksPath x', 'x'],
    ['git config --global core.hookspath x', 'x'],
    ['git config -f .git/config core.hooksPath x', 'x'],
    ['git config --add core.hooksPath x', 'x'],
    ['git config set core.hooksPath x', 'x'],
    ['git config --type path set core.hooksPath x', 'x'],
  ] as const)
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: 'core.hooksPath', skips: ALL, hooksPath: value }],
      script
    )
  for (const script of [
    'git config core.hooksPath',
    'git config --get core.hooksPath',
    'git config --get-all core.hooksPath',
    'git config get core.hooksPath',
    'git config --unset core.hooksPath',
    'git config unset core.hooksPath',
    'git config --list',
    'git config core.editor vim',
  ])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: the environment forms, as a prefix, through env, or exported', () => {
  assert.deepEqual(
    found(
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x'
    ),
    [
      {
        dir: '/w',
        how: 'GIT_CONFIG_KEY_0=core.hooksPath',
        skips: ALL,
        hooksPath: '/dev/null',
      },
    ]
  )
  assert.deepEqual(found('env -i GIT_CONFIG_KEY_3=Core.HooksPath git push'), [
    { dir: '/w', how: 'GIT_CONFIG_KEY_3=core.hooksPath', skips: ALL },
  ])
  assert.deepEqual(
    found(
      `export GIT_CONFIG_PARAMETERS="'core.hooksPath'='/dev/null'"; git commit -m x`
    ),
    [{ dir: '/w', how: 'GIT_CONFIG_PARAMETERS', skips: ALL }]
  )
  // Not exported: git never sees it.
  assert.deepEqual(found('GIT_CONFIG_KEY_0=core.hooksPath; git commit'), [])
  assert.deepEqual(found('GIT_CONFIG_KEY_0=user.name git commit'), [])
})

// --- where git runs -------------------------------------------------------------

test('gitBypasses: cd, git -C and the other global options set where git runs', () => {
  const dirs = (script: string) => found(script)?.map((b) => b.dir) ?? null
  assert.deepEqual(dirs('cd org/web && git commit --no-verify -m x'), [
    '/w/org/web',
  ])
  assert.deepEqual(dirs('(cd a && git commit -n); git commit -n'), [
    '/w/a',
    '/w',
  ])
  assert.deepEqual(dirs('git -C org/web commit -n'), ['/w/org/web'])
  assert.deepEqual(dirs('git -C a -C b commit -n'), ['/w/a/b'])
  assert.deepEqual(
    dirs('git --no-pager -c color.ui=never -C org/web -p commit -n'),
    ['/w/org/web']
  )
  assert.deepEqual(dirs('git --git-dir=org/web/.git commit -n'), ['/w/org/web'])
  assert.deepEqual(dirs('git --work-tree /x/y --git-dir /x/y/.git commit -n'), [
    '/x/y',
  ])
  assert.deepEqual(dirs('cd ~/x && git commit -n'), ['/home/me/x'])
  assert.deepEqual(dirs('cd "$HOME/x" && git commit -n'), ['/home/me/x'])
  assert.deepEqual(dirs('D=org/web; cd $D; git commit -n'), ['/w/org/web'])
  assert.deepEqual(dirs('cd /abs && cd .. && git commit -n'), ['/'])
  assert.deepEqual(dirs('cd $NOWHERE && git commit -n'), [null])
  assert.deepEqual(dirs('cd - && git commit -n'), [null])
  assert.deepEqual(dirs('env -C org/web git commit -n'), ['/w/org/web'])
})

test('gitBypasses: git by its path, behind a wrapper, in sh -c, eval or a substitution', () => {
  for (const script of [
    '/usr/bin/git commit -n',
    'command git commit -n',
    'exec git commit -n',
    'time git commit -n',
    'nohup git commit -n',
    'env FOO=1 git commit -n',
    'if git commit -n; then echo ok; fi',
    '{ git commit -n; }',
    `bash -c 'git commit -n'`,
    `sh -lc "git commit -n"`,
    'eval git commit -n',
    'echo $(git commit -n)',
    'echo `git commit -n`',
  ])
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: '-n', skips: COMMIT }],
      script
    )
  assert.deepEqual(
    found(`sh -c "cd org/web && git commit -n"`)?.map((b) => b.dir),
    ['/w/org/web']
  )
})

test('gitBypasses: commands that only mention git, or skip nothing', () => {
  for (const script of [
    'git status',
    'git log --grep=-n',
    'git commit -m x',
    'echo git commit -n',
    'grep -n git file.txt',
    'command -v git',
    'gitk -n',
    '$GIT commit -n',
  ])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: one per bypass, with the text of its command', () => {
  assert.deepEqual(
    gitBypasses(
      'git add -A && git commit -n -m "a  b" && git push --no-verify',
      AT
    ),
    [
      {
        dir: '/w',
        text: 'git commit -n -m "a  b"',
        how: '-n',
        skips: COMMIT,
      },
      {
        dir: '/w',
        text: 'git push --no-verify',
        how: '--no-verify',
        skips: ['pre-push'],
      },
    ]
  )
})

test('gitBypasses: a command that cannot be read is null', () => {
  assert.equal(gitBypasses('git commit -n -m "oops', AT), null)
})
