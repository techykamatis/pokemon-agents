import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLEAN_RUN_TOOLS, asksYou, newCursor, readLine, stationOf, storable, toolLabel } from '../src/transcript.mjs';

// a transcript, one line at a time, with timestamps that always move forward
let tick = 0;
const at = () => new Date(Date.UTC(2026, 9, 12, 8, 0, tick++)).toISOString();
const WHO = { cwd: '/repo', sessionId: 's1', gitBranch: 'main', entrypoint: 'cli', isSidechain: false };
const L = (o) => JSON.stringify({ ...WHO, timestamp: at(), ...o });

const prompt = (text) => L({ type: 'user', message: { role: 'user', content: text } });
const call = (id, name, input, stop = 'tool_use') => L({ type: 'assistant', requestedModel: 'claude-opus-5', message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: stop } });
const answer = (id, { failed = false, text = 'ok' } = {}) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: text }] } });
const reply = (text = 'All done.', stop = 'end_turn') => L({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: stop } });

const read = (lines, cursor = newCursor()) => {
  const events = lines.flatMap((l) => readLine(cursor, l));
  return { cursor, events, kinds: events.map((e) => e.kind) };
};

describe('a session on the map', () => {
  it('starts once, carrying its folder and entry point', () => {
    const { kinds, events, cursor } = read([prompt('hi'), prompt('and again')]);
    assert.deepEqual(kinds, ['session']);
    assert.equal(events[0].cwd, '/repo');
    assert.equal(events[0].sessionId, 's1');
    assert.equal(cursor.entry, 'cli');
    assert.equal(cursor.branch, 'main');
  });

  it('a subagent transcript is not a session and never waits on you', () => {
    const cursor = newCursor({ isSub: true });
    const { kinds } = read([L({ type: 'user', isSidechain: true, message: { content: 'go and look' } }), reply()], cursor);
    assert.ok(!kinds.includes('session'));
    assert.equal(cursor.waiting, false);
  });

  it('picks up the title Claude gives it', () => {
    const { cursor } = read([prompt('hi'), L({ type: 'ai-title', aiTitle: 'Invoice rounding bug' })]);
    assert.equal(cursor.title, 'Invoice rounding bug');
  });

  it('ignores lines that are not JSON at all', () => {
    assert.deepEqual(read(['{ half a line', '', '"a bare string"', 'null']).kinds, []);
  });
});

describe('what the work was worth', () => {
  it('counts tools, and tests, commits and merges only when they succeed', () => {
    const { kinds } = read([
      prompt('go'),
      call('a', 'Bash', { command: 'npm test' }), answer('a'),
      call('b', 'Bash', { command: 'git commit -m x' }), answer('b', { failed: true, text: 'Exit code 1' }),
      call('c', 'Bash', { command: 'git -C /repo commit -m y' }), answer('c'),
      call('d', 'Bash', { command: 'gh pr merge 12 --squash' }), answer('d'),
    ]);
    assert.deepEqual(kinds, ['session', 'tool', 'test', 'tool', 'tool', 'commit', 'tool', 'merge']);
  });

  it('a red test run turned green in the same session is a fix', () => {
    const { kinds } = read([
      prompt('the suite is red'),
      call('a', 'Bash', { command: 'pytest -q' }), answer('a', { failed: true, text: 'Exit code 1' }),
      call('b', 'Bash', { command: 'pytest -q' }), answer('b'),
    ]);
    assert.deepEqual(kinds.filter((k) => k === 'test' || k === 'fix'), ['test', 'fix']);
  });

  it('you saying no to a tool is a decision, not an error and not a red test', () => {
    const { cursor, kinds } = read([
      prompt('go'),
      call('a', 'Bash', { command: 'npm test' }),
      answer('a', { failed: true, text: "The user doesn't want to proceed with this tool use. The tool use was rejected" }),
      call('b', 'Bash', { command: 'npm test' }), answer('b'),
    ]);
    assert.equal(cursor.errors, 0);
    assert.ok(!kinds.includes('fix'), 'nothing was broken, so nothing was fixed');
  });

  it('handing work to a subagent is a trade', () => {
    const { kinds } = read([prompt('go'), call('a', 'Agent', { subagent_type: 'Explore', description: 'find the callers' })]);
    assert.ok(kinds.includes('subagent'));
  });

  it(`a clean run (${CLEAN_RUN_TOOLS}+ tools, no errors) is counted once, and a single error rules it out`, () => {
    const lines = [prompt('go')];
    for (let i = 0; i < CLEAN_RUN_TOOLS + 5; i++) lines.push(call(`t${i}`, 'Read', { file_path: `/repo/f${i}.ts` }), answer(`t${i}`));
    assert.equal(read(lines).kinds.filter((k) => k === 'clean').length, 1);

    const spoiled = [prompt('go'), call('bad', 'Read', { file_path: '/repo/gone.ts' }), answer('bad', { failed: true, text: 'ENOENT' })];
    for (let i = 0; i < CLEAN_RUN_TOOLS + 5; i++) spoiled.push(call(`t${i}`, 'Read', { file_path: `/repo/f${i}.ts` }), answer(`t${i}`));
    assert.ok(!read(spoiled).kinds.includes('clean'));
  });

  it('counts edits made since the last commit, and a commit clears them', () => {
    const { cursor } = read([
      prompt('go'),
      call('1', 'Edit', { file_path: '/repo/a.ts' }), answer('1'),
      call('2', 'Write', { file_path: '/repo/b.ts' }), answer('2'),
    ]);
    assert.equal(cursor.dirty, 2);
    readLine(cursor, call('3', 'Bash', { command: 'git commit -m x' }));
    readLine(cursor, answer('3'));
    assert.equal(cursor.dirty, 0);
    assert.ok(cursor.firstTs > 0 && cursor.lastTs >= cursor.firstTs);
  });
});

describe('whose turn it is', () => {
  it('waiting means the turn ended and no new prompt followed', () => {
    const { cursor } = read([prompt('go'), call('a', 'Read', { file_path: '/x/a.ts' }), answer('a'), reply()]);
    assert.equal(cursor.waiting, true);
    readLine(cursor, prompt('now do the next bit'));
    assert.equal(cursor.waiting, false);
  });

  it('a session that exited is not waiting for an answer from anyone', () => {
    const { cursor } = read([prompt('go'), reply()]);
    readLine(cursor, L({ type: 'cost-state', totalCostUSD: 0.12 }));
    assert.equal(cursor.waiting, false);
  });

  it('asks tells a question apart from a report', () => {
    const asked = (text) => read([prompt('go'), reply(text)]).cursor.asks;
    for (const text of [
      'Want me to build it?',
      'Should I push?\n\n',
      'Pinning them needs your decision.',
      'Which one: **A** or **B**?',
      'Done. Let me know if the numbers look off.',
    ]) assert.equal(asked(text), true, text);

    for (const text of [
      'Done. All 46 tests pass.',
      'I can look into either. Groups A and B are still on offer.',
      'See http://127.0.0.1:7880/?tab=x for it.',
      '',
    ]) assert.equal(asked(text), false, text);
  });

  it('a later plain report clears an earlier question', () => {
    const { cursor } = read([prompt('go'), reply('Ship it?')]);
    readLine(cursor, prompt('yes'));
    readLine(cursor, reply('Shipped.'));
    assert.equal(cursor.asks, false);
  });

  it('asks only weighs the tail of a long reply, where an ask would be', () => {
    assert.equal(asksYou(`Shall I? ${'Then I did a thing. '.repeat(100)}`), false);
    assert.equal(asksYou(`${'I did a thing. '.repeat(100)}Shall I deploy?`), true);
  });

  it('remembers the tools still out, by name, and forgets each as it answers', () => {
    const { cursor } = read([prompt('go'), call('q', 'AskUserQuestion', { questions: [] }), call('r', 'Read', { file_path: '/x' })]);
    assert.deepEqual([...cursor.pending.values()].map((p) => p.name), ['AskUserQuestion', 'Read']);
    assert.equal(cursor.inFlight, 2);
    readLine(cursor, answer('q'));
    assert.deepEqual([...cursor.pending.values()].map((p) => p.name), ['Read']);
    assert.equal(cursor.inFlight, 1);
  });

  it('storable keeps the facts and drops the live tool bookkeeping', () => {
    const { cursor } = read([prompt('go'), call('r', 'Read', { file_path: '/x' })]);
    const saved = storable(cursor);
    assert.ok(!('pending' in saved) && !('inFlight' in saved));
    assert.equal(newCursor(saved).sessionId, 's1');
    assert.equal(newCursor(saved).tools, 1);
    assert.equal(JSON.parse(JSON.stringify(saved)).cwd, '/repo', 'it has to survive a JSON round trip');
  });
});

describe('what is on screen', () => {
  it('activity shows a short target, never file contents or output', () => {
    const { cursor } = read([prompt('go'), call('a', 'Edit', { file_path: '/Users/me/private/app/src/app.ts', old_string: 'API_KEY=hunter2', new_string: 'x' })]);
    assert.deepEqual(cursor.activity, { tool: 'Edit', target: 'app.ts' });
    assert.ok(!JSON.stringify(cursor).includes('hunter2'));
  });

  it('toolLabel keeps labels short and harmless', () => {
    assert.equal(toolLabel('Bash', { command: 'cd /x && npm run build -- --prod' }), 'npm run');
    assert.equal(toolLabel('WebFetch', { url: 'https://docs.example.com/a?token=sekrit' }), 'docs.example.com');
    assert.equal(toolLabel('WebFetch', { url: 'not a url' }), 'web');
    assert.equal(toolLabel('Grep', { pattern: 'x'.repeat(50) }).length, 20);
    assert.equal(toolLabel('Mystery', { anything: 1 }), '');
  });

  it('the station follows the tool in hand', () => {
    assert.equal(stationOf({ tool: 'Edit', target: 'a.ts' }), 'desk');
    assert.equal(stationOf({ tool: 'Grep', target: 'x' }), 'library');
    assert.equal(stationOf({ tool: 'TodoWrite', target: '' }), 'library', 'planning is study, not editing');
    assert.equal(stationOf({ tool: 'Bash', target: 'npm test' }), 'testbench');
    assert.equal(stationOf({ tool: 'Bash', target: 'git status' }), 'mergestation');
    assert.equal(stationOf({ tool: 'Bash', target: 'grep -rn' }), 'library');
    assert.equal(stationOf({ tool: 'Bash', target: 'curl -s' }), 'gate');
    assert.equal(stationOf({ tool: 'Bash', target: 'npm run' }), 'terminal');
    assert.equal(stationOf({ tool: 'Agent', target: 'Explore' }), 'meeting');
    assert.equal(stationOf({ tool: 'SendMessage', target: '' }), 'meeting');
    assert.equal(stationOf({ tool: 'WebSearch', target: 'search' }), 'gate');
    assert.equal(stationOf({ tool: 'mcp__linear__issues', target: '' }), 'gate');
    assert.equal(stationOf({ tool: 'Mystery', target: '' }), 'terminal');
    assert.equal(stationOf(null), 'terminal');
  });
});
