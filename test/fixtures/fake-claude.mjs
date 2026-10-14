#!/usr/bin/env node
// Stands in for the claude CLI in the tests. It records how it was called — argv, cwd and whatever
// came in on stdin — then exits with FAKE_EXIT after FAKE_SLEEP milliseconds.
import fs from 'node:fs';

let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_OUT, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin })}\n`);
  setTimeout(() => process.exit(Number(process.env.FAKE_EXIT ?? 0)), Number(process.env.FAKE_SLEEP ?? 0));
});
