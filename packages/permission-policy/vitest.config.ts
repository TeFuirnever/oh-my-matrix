import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['./tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'index.ts'],
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 78,
        branches: 85,
        functions: 88,
        lines: 78,
      },
    },
  },
});
