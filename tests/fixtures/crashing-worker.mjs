// Fixture for extractors.test.ts: a worker that dies immediately with a
// non-zero exit code and never posts a message, simulating what happens when
// the resourceLimits heap cap kills the real extraction worker (OOM).
process.exit(1);
