import { appendFileSync, writeFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FIXTURE_MODE;
process.on('SIGTERM', () => {
  appendFileSync(process.env.FIXTURE_EVENTS, 'term\n');
  if (mode?.includes('resistant')) return;
  setTimeout(() => {
    appendFileSync(process.env.FIXTURE_EVENTS, 'closed\n');
    process.exit(0);
  }, 100);
});
writeFileSync(`${process.env.FIXTURE_PID}.tmp`, String(process.pid));
renameSync(`${process.env.FIXTURE_PID}.tmp`, process.env.FIXTURE_PID);
const answer = (id, result) => {
  const line = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
  process.stdout.write(line);
  if (mode === 'duplicate') process.stdout.write(line);
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  appendFileSync(process.env.FIXTURE_EVENTS, `${frame.method}\n`);
  if (mode?.startsWith('hang')) return;
  if (frame.method === 'initialize') answer(frame.id, { capabilities: { tools: {} } });
  if (frame.method === 'tools/list') {
    const inputSchema = mode === 'old' ? { properties: {} } : mode === 'malformed' ? { properties: { noRetry: { type: 'string' } } } : { properties: { noRetry: { type: 'boolean' } } };
    answer(frame.id, { tools: [{ name: 'send_email', inputSchema }] });
  }
  if (frame.method === 'tools/call') answer(frame.id, { content: [{ type: 'text', text: 'FIXTURE_ACCEPTED' }] });
});
setInterval(() => {}, 1 << 30);
