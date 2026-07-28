// Fixture for extractors.test.ts: a worker that never posts a message and
// never exits on its own, used to exercise runIsolatedWorker's timeout path
// without waiting out the real 30s production timeout.
setInterval(() => {}, 1_000);
