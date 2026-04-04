import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.mjs' };
    },
  },
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    splitting: false,
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
