import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['./tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'index.ts'],
      exclude: ['src/event-shape.contract.ts', '**/*.d.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 85,
        lines: 85,
      },
    },
  },
  resolve: {
    alias: {
      // Consumer compile contract test (ADR-014 gate): resolve the package
      // name to the package's own dist entry, simulating how a real consumer
      // would import it. This catches barrel export drift at test time.
      '@oh-my-matrix/dynamic-workflows': new URL('./dist/index.js', import.meta.url).pathname,
    },
  },
});
