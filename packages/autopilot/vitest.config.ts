import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['./tests/**/*.test.ts', './tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'index.ts'],
      exclude: ['src/event-shape.contract.ts', '**/*.d.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 90,
        lines: 88,
      },
    },
  },
  resolve: {
    alias: {
      // matrixassistant-audit is mocked in g1-priority-inversion.test.ts;
      // alias points to the host's audit plugin so the vi.mock() intercept works.
      '@openclaw/matrixassistant-audit': resolve(
        __dirname,
        '../../node_modules/@openclaw/matrixassistant-audit'
      ),
    },
  },
});
