import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { plain, recapOf } from '../src/recap.mjs';

/** a throwaway transcript holding exactly these lines, oldest first */
const transcript = (lines) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-recap-')), 's.jsonl');
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
};

const you = (content) => ({ type: 'user', message: { role: 'user', content } });
const claude = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
const toolResult = (id, content = 'output') => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const awaySummary = (content) => ({ type: 'system', subtype: 'away_summary', content });
const askTool = (id, questions) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }], stop_reason: 'tool_use' } });

describe('what the session is about', () => {
  it('finds your ask, what it needs from you, and the step it recommends', () => {
    const r = recapOf(transcript([
      you('an older ask'),
      claude('an older reply'),
      { type: 'last-prompt', lastPrompt: 'an older ask' },
      you('split **NEEDS YOU** into asks and done reports'),
      toolResult('x', 'some tool output nobody should see'),
      claude('Built it; 50 tests pass. Want me to merge it into `main`?'),
      awaySummary('You asked for the split. It is built and tested. Next, merge it into main. (disable recaps in /config)'),
    ]));

    assert.equal(r.ask, 'split NEEDS YOU into asks and done reports');
    assert.equal(r.cta, 'Want me to merge it into main?');
    assert.equal(r.next, 'merge it into main.');
    assert.equal(r.recap, 'You asked for the split. It is built and tested. Next, merge it into main.');
    assert.match(r.reply, /^Built it; 50 tests pass/);
    assert.ok(!r.reply.includes('nobody should see'), 'tool output is not part of the reply');
  });

  it('ignores an away-summary written before your latest prompt', () => {
    const r = recapOf(transcript([
      you('the first thing'), claude('First done.'), awaySummary('Old recap. Next, do the old thing.'),
      you('the second thing'), claude('Second done. I recommend rerunning the e2e.'),
    ]));
    assert.equal(r.ask, 'the second thing');
    assert.equal(r.recap, null, 'that summary belongs to a turn you have already seen');
    assert.equal(r.cta, null, 'a plain report asks you nothing');
    assert.equal(r.next, 'I recommend rerunning the e2e.');
  });

  it('does not mistake a slash command or a system note for something you said', () => {
    const r = recapOf(transcript([
      you('the real ask'),
      claude('Working on it.'),
      you('<command-name>/compact</command-name>'),
      you('<system-reminder>be brief</system-reminder>'),
    ]));
    assert.equal(r.ask, 'the real ask');
  });

  it('finds the question at the end of a very long reply, and keeps the end of it', () => {
    const r = recapOf(transcript([you('go'), claude(`${'Did a thing. '.repeat(400)}Should I deploy it?`)]));
    assert.equal(r.cta, 'Should I deploy it?');
    assert.ok(r.reply.length <= 3003);
    assert.ok(r.reply.startsWith('...'), 'the middle is dropped, not the ask');
    assert.ok(r.reply.endsWith('Should I deploy it?'));
  });

  it('a missing or empty transcript gives nulls rather than throwing', () => {
    const empty = { ask: null, reply: null, recap: null, cta: null, next: null, question: null, options: [], picker: false };
    assert.deepEqual(recapOf('/nonexistent/never.jsonl'), empty);
    assert.deepEqual(recapOf(transcript([])), empty);
  });

  it('skips lines that are not JSON instead of giving up on the file', () => {
    const file = transcript([you('go'), claude('All done. Shall I tag it?')]);
    fs.appendFileSync(file, '{ truncated\nnull\n');
    assert.equal(recapOf(file).cta, 'Shall I tag it?');
  });
});

describe('the decision it is waiting on', () => {
  it('an open AskUserQuestion is a picker, with its own question and options', () => {
    const r = recapOf(transcript([
      you('go'),
      claude('There are two ways to do this.'),
      askTool('q1', [{ question: 'Which database?', options: [{ label: 'Postgres', description: 'scales' }, { label: 'SQLite' }] }]),
    ]));
    assert.equal(r.picker, true);
    assert.equal(r.question, 'Which database?');
    assert.deepEqual(r.options, [{ label: 'Postgres', send: 'Postgres' }, { label: 'SQLite', send: 'SQLite' }]);
  });

  it('an AskUserQuestion that has been answered is not a picker any more', () => {
    const r = recapOf(transcript([
      you('go'),
      askTool('q1', [{ question: 'Which?', options: [{ label: 'A' }] }]),
      toolResult('q1', 'A'),
      claude('Went with A.'),
    ]));
    assert.equal(r.picker, false);
  });

  it('a numbered or lettered list before the question becomes the options', () => {
    const r = recapOf(transcript([you('go'), claude('Found two fixes.\n\n1. **Patch** the parser\n2. Rewrite it with `zod`\n\nWhich do you want?')]));
    assert.equal(r.picker, false);
    assert.equal(r.question, 'Which do you want?');
    assert.deepEqual(r.options, [
      { label: 'Patch the parser', send: 'Option 1: Patch the parser' },
      { label: 'Rewrite it with zod', send: 'Option 2: Rewrite it with zod' },
    ]);

    const lettered = recapOf(transcript([you('go'), claude('A) keep it\nB) drop it\nYour call?')]));
    assert.deepEqual(lettered.options.map((o) => o.send), ['Option A: keep it', 'Option B: drop it']);
  });

  it('takes the last list in a reply, not a list of what it already did', () => {
    const r = recapOf(transcript([you('go'), claude([
      'Done:',
      '1. fixed the parser',
      '2. added a test',
      '',
      'Now, where should it live?',
      '',
      '1. in the bridge',
      '2. in the client',
      '',
      'Which do you want?',
    ].join('\n'))]));
    assert.deepEqual(r.options.map((o) => o.label), ['in the bridge', 'in the client']);
  });

  it('a yes-or-no question gets Yes and No', () => {
    const r = recapOf(transcript([you('go'), claude('All green. Want me to merge it?')]));
    assert.deepEqual(r.options.map((o) => o.label), ['Yes', 'No']);
  });

  it('a report, or a plain bullet list, offers nothing to pick', () => {
    assert.deepEqual(recapOf(transcript([you('go'), claude('Done:\n- fixed a\n- fixed b')])).options, []);
    assert.equal(recapOf(transcript([you('go'), claude('Done. All 46 tests pass.')])).question, null);
  });
});

describe('plain text for a Game Boy font', () => {
  it('drops markdown and anything the font cannot draw', () => {
    assert.equal(plain('## **Bold** `code` 😀 [link](http://x) — done\n\n- item'), 'Bold code link - done - item');
  });

  it('turns smart punctuation into the ASCII it stands for', () => {
    assert.equal(plain('“quoted” and ‘single’ and an ellipsis…'), '"quoted" and \'single\' and an ellipsis...');
  });

  it('squashes runs of whitespace, so a reply fits a 20-column screen predictably', () => {
    assert.equal(plain('  lots\n\n\tof   space  '), 'lots of space');
  });
});
