#!/usr/bin/env node
// Stands in for `claude -p` while the demo records. It acts out a short goal run in real time,
// writing the transcript a real one would: reads a file, edits another, runs the tests, then asks
// a question with two options. Resumed, it applies the answer and reports. It never calls a model.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const resumed = args.includes('--resume');
const sessionId = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];

const dir = path.join(process.env.DEMO_PROJECTS, '-demo-weather-app');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${sessionId}.jsonl`);

const put = (line) => fs.appendFileSync(
  file,
  `${JSON.stringify({ cwd: process.cwd(), sessionId, entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), ...line })}\n`,
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
const useTool = async (name, input, ms = 1200) => {
  const id = `${sessionId}-${calls++}`;
  put({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
  await sleep(ms); // long enough to watch it walk to the right building
  put({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
};
const say = (text) => put({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });

let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });

process.stdin.on('end', async () => {
  put({ type: 'user', message: { content: stdin } });

  if (!resumed) {
    put({ type: 'ai-title', aiTitle: 'Dark mode toggle' });
    await useTool('Read', { file_path: 'src/theme.ts' }, 1500);
    await useTool('Edit', { file_path: 'src/Settings.tsx' }, 1800);
    await useTool('Bash', { command: 'npm test' }, 1800);
    say([
      'Dark mode follows the system setting now, and the toggle is in Settings. Tests pass.',
      '',
      'How should the toggle remember a choice?',
      '',
      '1. In the browser (localStorage)',
      '2. On the account, so it follows you between devices',
      '',
      'Which do you want?',
    ].join('\n'));
    return;
  }

  await useTool('Edit', { file_path: 'src/theme.ts' }, 1500);
  await useTool('Bash', { command: 'npm test' }, 1500);
  say('Done: the toggle remembers your choice in the browser. Tests pass.');
});
