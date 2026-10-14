#!/usr/bin/env node
// Stands in for `claude -p` in the end-to-end run. It writes the transcript a real goal run would
// — a question with two options the first time, a short report when resumed — and records each
// call, so the run can check what it was asked to do. It never calls a model.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });

process.stdin.on('end', () => {
  const resumed = args.includes('--resume');
  const sessionId = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
  const root = process.env.E2E_PROJECTS;

  fs.appendFileSync(path.join(root, 'calls.jsonl'), `${JSON.stringify({ args, stdin })}\n`);

  const dir = path.join(root, '-goal-lab');
  fs.mkdirSync(dir, { recursive: true });
  const put = (line) => fs.appendFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ cwd: process.cwd(), sessionId, entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), ...line })}\n`,
  );

  put({ type: 'user', message: { content: stdin } });
  const reply = resumed
    ? 'Went with it. Done.'
    : 'Two ways to store it.\n\n1. Postgres\n2. SQLite\n\nWhich do you want?';
  put({ type: 'assistant', message: { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' } });
});
