// eslint.config.mjs — OMM flat config (ESM, TS-aware).
// Mirrors docs/design/dev-harness.md §1.2:
// @eslint/js recommended + typescript-eslint recommended, '_'-prefixed ignore idiom, eqeqeq warn.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'website/.vitepress/dist/**',
      'landing/**',
      '.codegraph/**',
      '.context/**',
      '.autopilot/**',
      '.omc/**',
      '.omx/**',
      'coverage/**',
      'packages/*/*.tgz',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Let the TS rule own unused-vars (avoids duplicate noise on .ts files).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['warn', 'always'],
    },
  },
  // Source .ts: keep `any` visible but non-blocking. The repo already uses `any`
  // in a few host-deployed guard files we deliberately won't churn (AGENTS.md:
  // high-risk spine code). `warn` nudges new code without breaking the build.
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Tests: `any` is a legitimate mocking tool here — don't fight that style.
  {
    files: ['**/tests/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
