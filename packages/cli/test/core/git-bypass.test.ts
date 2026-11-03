import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type GitBypass, gitBypasses } from '../../src/core/git-bypass.ts'

// What the guard reads in a Bash command (spec 0040 §4.3): the git calls
// that would skip the hooks, where each runs. The option tables were read
// from git 2.56.0 (`git commit --git-completion-helper-all`) and each
// parsing rule below was checked against that git on 2026-11-03.

const AT = { cwd: '/w', env: { HOME: '/home/me' } }

const COMMIT = ['pre-commit', 'commit-msg']
const ALL = ['pre-commit', 'commit-msg', 'pre-push']

/** The bypasses of a command, without their text. */
const found = (script: string, at = AT) =>
  gitBypasses(script, at)?.map(({ text: _text, ...rest }: GitBypass) => rest) ??
  null

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
      scope: 'command',
    },
  ])
  assert.deepEqual(found('git -c CORE.HOOKSPATH=x status'), [
    {
      dir: '/w',
      how: 'core.hooksPath',
      skips: ALL,
      hooksPath: 'x',
      scope: 'command',
    },
  ])
  assert.deepEqual(found('git --config-env=core.hooksPath=V push'), [
    { dir: '/w', how: 'core.hooksPath', skips: ALL, scope: 'command' },
  ])
  assert.deepEqual(
    found('V=/dev/null git --config-env core.hookspath=V commit'),
    [
      {
        dir: '/w',
        how: 'core.hooksPath',
        skips: ALL,
        hooksPath: '/dev/null',
        scope: 'command',
      },
    ]
  )
  assert.deepEqual(found('git -c user.name=x commit -m x'), [])
  assert.deepEqual(found('git -c core.hooksPath=/dev/null'), [])
})

test('gitBypasses: setting core.hooksPath with git config; reading or unsetting it passes', () => {
  for (const [script, value, scope] of [
    ['git config core.hooksPath /dev/null', '/dev/null', 'local'],
    ['git config --local core.hooksPath x', 'x', 'local'],
    ['git config --global core.hookspath x', 'x', 'global'],
    ['git config --system core.hooksPath x', 'x', 'system'],
    ['git config --worktree core.hooksPath x', 'x', 'worktree'],
    ['git config -f .git/config core.hooksPath x', 'x', 'file'],
    ['git config --add core.hooksPath x', 'x', 'local'],
    ['git config set core.hooksPath x', 'x', 'local'],
    ['git config --type path set --global core.hooksPath x', 'x', 'global'],
  ] as const)
    assert.deepEqual(
      found(script),
      [
        {
          dir: '/w',
          how: 'core.hooksPath',
          skips: ALL,
          hooksPath: value,
          scope: scope,
        },
      ],
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
        scope: 'environment',
      },
    ]
  )
  assert.deepEqual(found('env -i GIT_CONFIG_KEY_3=Core.HooksPath git push'), [
    {
      dir: '/w',
      how: 'GIT_CONFIG_KEY_3=core.hooksPath',
      skips: ALL,
      scope: 'environment',
    },
  ])
  assert.deepEqual(
    found(
      `export GIT_CONFIG_PARAMETERS="'core.hooksPath'='/dev/null'"; git commit -m x`
    ),
    [
      {
        dir: '/w',
        how: 'GIT_CONFIG_PARAMETERS',
        skips: ALL,
        hooksPath: '/dev/null',
        scope: 'environment',
      },
    ]
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
    '$GIT push -n',
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

// --- after the security review of the first version (2026-11-03): where the
// parser cannot tell, a command pairing git with a hook-skipping word is
// refused rather than allowed.

test('gitBypasses: GIT_DIR and GIT_WORK_TREE place git as --git-dir and --work-tree do, the options first', () => {
  const dirs = (script: string) => found(script)?.map((b) => b.dir) ?? null
  assert.deepEqual(dirs('GIT_DIR=org/web/.git git commit -n'), ['/w/org/web'])
  assert.deepEqual(dirs('GIT_WORK_TREE=/x/y GIT_DIR=/x/y/.git git commit -n'), [
    '/x/y',
  ])
  assert.deepEqual(dirs('env GIT_DIR=/a/.git git commit -n'), ['/a'])
  assert.deepEqual(dirs('export GIT_DIR=/a/.git; git commit -n'), ['/a'])
  assert.deepEqual(dirs('GIT_DIR=/a/.git git --git-dir=/b/.git commit -n'), [
    '/b',
  ])
  // Relative to where git ends up: -C first.
  assert.deepEqual(dirs('git --git-dir=.git -C org/web commit -n'), [
    '/w/org/web',
  ])
  assert.deepEqual(dirs('GIT_DIR=$NOWHERE git commit -n'), [null])
})

test('gitBypasses: an alias that skips the hooks, set by -c, --config-env, the environment or git config', () => {
  const how = (script: string) => found(script)?.map((b) => b.how) ?? null
  for (const [script, key] of [
    ['git -c alias.ci="commit -n" ci -m x', 'alias.ci'],
    ['git -c alias.ci="commit -an" ci -m x', 'alias.ci'],
    [`git -c alias.ci='!git commit --no-verify' ci`, 'alias.ci'],
    ['git -c alias.p="push --no-verify" p', 'alias.p'],
    ['V="commit -n" git --config-env=alias.ci=V ci', 'alias.ci'],
    [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0="commit -n" git ci',
      'alias.ci',
    ],
    [`GIT_CONFIG_PARAMETERS="'alias.ci'='commit -n'" git ci`, 'alias.ci'],
    ['git config alias.ci "commit --no-verify"', 'alias.ci'],
    ['git config --global alias.ci "commit -n"', 'alias.ci'],
  ] as const)
    assert.deepEqual(how(script), [key], script)
  for (const script of [
    'git -c alias.lg="log -n 5" lg',
    'git -c alias.ci="commit -m -n" ci',
    'git config alias.st status',
    'git config --get alias.ci',
  ])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: another configuration for git, or an include written, skips every hook', () => {
  for (const [script, how] of [
    ['GIT_CONFIG_GLOBAL=/tmp/x git commit -m x', 'GIT_CONFIG_GLOBAL'],
    ['GIT_CONFIG_SYSTEM=/tmp/x git status', 'GIT_CONFIG_SYSTEM'],
    ['export GIT_CONFIG=/tmp/x; git push', 'GIT_CONFIG'],
    ['git -c include.path=/tmp/x commit -m x', 'include.path'],
    ['git config include.path /tmp/x', 'include.path'],
    [
      'git config --add includeIf.gitdir:~/w/.path /tmp/x',
      'includeIf.gitdir:~/w/.path',
    ],
  ] as const)
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how, skips: ALL, maybe: true }],
      script
    )
  for (const script of [
    'git config --get include.path',
    'git config --get-regexp includeIf',
    'GIT_CONFIG_NOSYSTEM=1 git commit -m x',
  ])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: the common wrappers are unwrapped', () => {
  for (const [script, how] of [
    ['xargs git commit --no-verify', '--no-verify'],
    ['xargs -0 -n 1 -I{} git commit -n -m {}', '-n'],
    ['sudo git commit --no-verify', '--no-verify'],
    ['sudo -E -u me git commit -n', '-n'],
    ['nice -n 10 git commit -n', '-n'],
    ['timeout 30 git commit -n', '-n'],
    ['timeout -s KILL 5m git commit -n', '-n'],
    ['doas -u me git commit -n', '-n'],
    ['stdbuf -oL git commit -n', '-n'],
    ['ionice -c 3 git commit -n', '-n'],
    ['chronic git commit -n', '-n'],
    ['watch -n 5 git commit -n', '-n'],
    ['watch -x git commit -n', '-n'],
  ] as const)
    assert.deepEqual(
      found(script)?.map((b) => b.how),
      [how],
      script
    )
  assert.deepEqual(
    found('sudo -D org/web git commit -n')?.map((b) => b.dir),
    ['/w/org/web']
  )
  for (const script of ['xargs -n 1 git push', 'timeout 5 git push -n'])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: a command the parser cannot read is refused when it pairs git with --no-verify or core.hooksPath', () => {
  for (const [script, how, skips] of [
    ['parallel git commit --no-verify ::: a', '--no-verify', COMMIT],
    ['parallel git commit -an ::: a', '-n', COMMIT],
    ['$GIT commit --no-verify', '--no-verify', COMMIT],
    ['$GIT commit -n', '-n', COMMIT],
    ['rg git --no-verify', '--no-verify', ALL],
    ['foo GIT_CONFIG_GLOBAL=/tmp/x git commit', 'GIT_CONFIG_GLOBAL', ALL],
    [
      'GIT_CONFIG_KEY_0=core.hooksPath foo git commit',
      'GIT_CONFIG_KEY_0=core.hooksPath',
      ALL,
    ],
    ['foo git -c alias.ci=x ci', 'alias.ci', ALL],
    ['foo git -c include.path=/x status', 'include.path', ALL],
    ['foo git --config-env=includeIf.x.path=V status', 'includeIf.x.path', ALL],
    ['foo git push --no-verify', '--no-verify', ['pre-push']],
    ['foo git --no-verify', '--no-verify', ALL],
    ['foo git -c core.hooksPath=/dev/null status', 'core.hooksPath', ALL],
    ['foo git config core.HooksPath /dev/null', 'core.hooksPath', ALL],
    ['env -S "x" git commit --no-verify', '--no-verify', COMMIT],
  ] as const)
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how, skips, maybe: true }],
      script
    )
  for (const script of [
    'parallel git push -n ::: a',
    'foo -n git status',
    'foo git config --get core.hooksPath',
    'grep git --no-verify',
    'foo --no-verify git status',
    'echo git commit --no-verify',
    'printf "%s\\n" git commit --no-verify',
    'git commit -m --no-verify',
  ])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: a configuration key the command does not say is refused; an option git reads that cannot be read is judged by its words', () => {
  for (const [script, how] of [
    ['git -c "$KV" commit -m x', '-c'],
    [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$K git commit -m x',
      'GIT_CONFIG_KEY_0',
    ],
    ['GIT_CONFIG_PARAMETERS=$P git commit -m x', 'GIT_CONFIG_PARAMETERS'],
    ['git -c alias.ci="$V" ci', 'alias.ci'],
    ['git --config-env=alias.ci=UNSET ci', 'alias.ci'],
    [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=$V git ci',
      'alias.ci',
    ],
  ] as const)
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how, skips: ALL, maybe: true }],
      script
    )
  for (const [script, how] of [
    ['git $OPTS commit --no-verify', '--no-verify'],
    ['git $OPTS commit -n', '-n'],
  ] as const)
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how, skips: COMMIT, maybe: true }],
      script
    )
})

test('gitBypasses: git merge and git pull --no-verify skip the commit-msg hook; their -n is --no-stat', () => {
  for (const script of [
    'git merge --no-verify feature',
    'git merge -m "x" --no-verify feature',
    'git pull --no-verify origin main',
    'git pull --rebase --no-verify',
  ])
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: '--no-verify', skips: ['commit-msg'] }],
      script
    )
  for (const script of [
    'git merge -n feature',
    'git pull -n',
    // Ambiguous to git: --no-verify or --no-verify-signatures.
    'git pull --no-veri',
    'git merge --no-verif feature',
    'git merge -m --no-verify feature',
    'git merge -s ours -X theirs -F msg feature',
    'git merge --no-verify --verify feature',
    'git pull -o --no-verify',
  ])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: a literal --no-verify survives an option git 2.56 does not know', () => {
  assert.deepEqual(found('git commit --newopt --no-verify -m x'), [
    { dir: '/w', how: '--no-verify', skips: COMMIT, maybe: true },
  ])
  assert.deepEqual(found('git push -Z --no-verify'), [
    { dir: '/w', how: '--no-verify', skips: ['pre-push'], maybe: true },
  ])
  for (const script of ['git commit --no-ver -m x', 'git commit -nX -m x'])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: an escaped git is git', () => {
  for (const script of [`g\\it commit -n`, `$'\\x67it' commit -n`])
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: '-n', skips: COMMIT }],
      script
    )
})

// --- fix round 2: what the shell reads before it runs a word ----------------

test('gitBypasses: a command name or a git word the shell expands (a glob, a brace expression) is judged by its shape', () => {
  for (const script of [
    '{gi,x}t commit -n -m x',
    '/usr/bin/gi? commit -n -m x',
    '/usr/bin/g[i]t commit -n -m x',
    '{git,commit} -n -m x',
    'git {commit,-n} -m x',
    'git commit {-n,-m} x',
    'sudo /usr/bin/gi? commit -n',
  ])
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: '-n', skips: COMMIT, maybe: true }],
      script
    )
  for (const script of ['git add *.ts', '/usr/bin/gi? push -n', 'ls {a,b}'])
    assert.deepEqual(found(script), [], script)
})

test('gitBypasses: read as bash and as zsh, what either would run is judged', () => {
  for (const script of [
    `echo $(( "))" )) ; git commit -n -m x`,
    `echo $(( $'))' )) ; git commit -n -m x`,
    `(( "))" )) ; git commit -n -m x`,
    `echo \${x:-'}'} ; git commit -n -m x`,
    // bash: the quote never closes; zsh runs git.
    `echo "\${x:-'a}" ; git commit -n -m x`,
    `echo $(( '1 )) ; git commit -n -m x`,
  ])
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: '-n', skips: COMMIT }],
      script
    )
  assert.equal(gitBypasses('git commit -n -m "never closed', AT), null)
})

// --- fix round 3: braces with quoted parts, globs after git, zsh =cmd -------

test('gitBypasses: a brace with quoted parts, zsh =cmd, and a glob after commit or push go to the backstop', () => {
  for (const script of [
    `{"gi",x}t commit -n -m x`,
    `{g'i',x}t commit -n -m x`,
    '=git commit -n -m x',
    'sudo =git commit -n',
  ])
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: '-n', skips: COMMIT, maybe: true }],
      script
    )
  for (const [script, skips] of [
    ['git commit -m x src/*.ts', COMMIT],
    ['git commit -m x =y', COMMIT],
    ['git push origin feat-?', ['pre-push']],
  ] as const)
    assert.deepEqual(
      found(script),
      [{ dir: '/w', how: 'a word the shell expands', skips, maybe: true }],
      script
    )
})

test('gitBypasses: globs, braces and quoted text that skip nothing are allowed', () => {
  for (const script of [
    'ls {a,b}',
    'git add *.ts',
    `git diff -- '*.md'`,
    `git log --format='%h {}'`,
    'ls *.md && git status',
    "git commit -F - <<'EOF'\nfeat: a {b,c} * --no-verify\nEOF",
    `git commit -m "$(cat <<'EOF'\nfeat: x\n\nbody --no-verify {a,b} *\nEOF\n)"`,
    'git commit -m "docs: explain --no-verify"',
  ])
    assert.deepEqual(found(script), [], script)
})
