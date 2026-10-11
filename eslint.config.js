import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '.superpowers/**',
    '.verdaccio/**',
    // Copied verbatim into user workspaces by `rness create`: not ours to lint.
    'packages/cli/scaffold/**',
    // Byte-exact inputs and expected outputs of the merge tests.
    'packages/cli/test/fixtures/**',
    // Claude Code's API types, laid when it loads the mod from this folder.
    'packages/cli/mod/.claude-plugin/types/**',
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // No em dash (U+2014) in a string of the CLI or the mod: rness writes
    // text into every repository of a workspace, and the standard of this one
    // forbids the character in any text. The raw source is what is read, so
    // the escape \u2014 passes: a parser that must still read an older title
    // says so. Tests hold a user's titles as inputs, so they are not covered.
    files: ['packages/cli/src/**', 'packages/cli/mod/**'],
    ignores: ['**/*.test.*'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[raw=/\u2014/]',
          message:
            'No em dash in a string rness writes: " - ", a comma, a colon or a period (standards/documentation.md).',
        },
        {
          selector: 'TemplateElement[value.raw=/\u2014/]',
          message:
            'No em dash in a string rness writes: " - ", a comma, a colon or a period (standards/documentation.md).',
        },
      ],
    },
  },
  {
    // typescript-eslint disables no-undef only for TypeScript files (the
    // compiler already checks names there); plain JS keeps the rule and
    // needs Node's globals declared explicitly.
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
  // Last: turns off every rule that would fight the formatter.
  prettier,
])
