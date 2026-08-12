import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globalSetup: ['tests/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Scoped to pure / easily-mockable modules. Network-heavy modules
      // (emailService, securityManager, graphAuth, handlers, cache/file/
      // parallel infra) are intentionally excluded: they require a real
      // Microsoft Graph client and are covered by smoke tests instead.
      // extractionWorker executes as the compiled dist artifact in a nested
      // worker_thread, outside Vitest's source instrumentation. It remains in
      // this honest denominator; tests/plugin/extractors.test.ts exercises that
      // production artifact end to end (formats, caps, timeout, and crashes).
      include: [
        'src/config/**/*.ts',
        'src/schemas/**/*.ts',
        'src/templates/**/*.ts',
        'src/plugin/config.ts',
        'src/plugin/createPluginServer.ts',
        'src/plugin/extractionFormat.ts',
        'src/plugin/extractionWorker.ts',
        'src/plugin/extractors.ts',
        'src/plugin/http.ts',
        'src/plugin/logging.ts',
        'src/plugin/MultiMailboxService.ts',
        'src/plugin/schemas.ts',
        'src/plugin/searchMemory.ts',
        'src/plugin/zipArchive.ts',
        'src/plugin/zipEntryName.ts',
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
