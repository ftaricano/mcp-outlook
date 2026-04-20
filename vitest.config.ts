import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Scoped to pure / easily-mockable modules. Network-heavy modules
      // (emailService, securityManager, graphAuth, handlers, cache/file/
      // parallel infra) are intentionally excluded: they require a real
      // Microsoft Graph client and are covered by smoke tests instead.
      include: [
        'src/config/**/*.ts',
        'src/schemas/**/*.ts',
        'src/templates/**/*.ts',
        'src/services/emailSummarizer.ts',
        'src/utils/attachmentValidator.ts',
        'src/utils/RateLimiter.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/index.ts',
        'src/logging/**',
        'src/monitoring/**',
      ],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 40,
        statements: 40,
      },
    },
    testTimeout: 10_000,
  },
});
