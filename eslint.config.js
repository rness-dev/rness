import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '.superpowers/**',
    // Copied verbatim into user workspaces by `rness create`: not ours to lint.
    'packages/cli/scaffold/**',
    // Byte-exact inputs and expected outputs of the merge tests.
    'packages/cli/test/fixtures/**',
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
  // Last: turns off every rule that would fight the formatter.
  prettier,
])
