import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Node's built-in SQLite driver still prints an "experimental" notice; keep test output clean.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
