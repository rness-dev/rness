import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { 'bin/rness': 'src/bin/rness.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node24',
  splitting: true,
  clean: true,
  dts: false,
  sourcemap: true,
  external: [/^[^./]/],
})
