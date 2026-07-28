// Fixture for extractors.test.ts: a worker that throws uncaught at module
// load, exercising runIsolatedWorker's 'error' event path (distinct from the
// 'exit'-without-message path covered by crashing-worker.mjs).
throw new Error('boom');
