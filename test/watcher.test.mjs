import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AWAKE_MS, STALE_MS, Watcher, isThrowaway } from '../src/watcher.mjs';

const REPO = '/nonexistent/repo-a'; // never a real folder: repoOf must fall back to the folder name
const line = (o) => `${JSON.stringify({ cwd: REPO, sessionId: 's1', entrypoint: 'cli', timestamp: '2026-10-12T08:00:00.000Z', ...o })}\n`;
const prompt = (text = 'hi', o = {}) => line({ ...o, type: 'user', message: { content: text } });
const reply = (text, o = {}) => line({ ...o, type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
// the odd filename is deliberate: it puts a multi-byte character in the middle of the line
const toolCall = (id, o = {}) => line({ ...o, type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x/é😀.ts' } }], stop_reason: 'tool_use' } });
const toolDone = (id, o = {}) => line({ ...o, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const call = (id, name, o = {}) => line({ ...o, type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }], stop_reason: 'tool_use' } });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-projects-'));
  fs.mkdirSync(path.join(root, '-repo-a', 's1', 'subagents', 'workflows', 'wf1'), { recursive: true });
  const file = path.join(root, '-repo-a', 's1.jsonl');
  const got = [];
  return { root, file, got, watcher: (scan) => new Watcher({ root, scan, onEvents: (e) => got.push(...e) }) };
}

describe('finding transcripts', () => {
  it('finds each session, and subagent and workflow transcripts nested under it', () => {
    const { root, file, watcher } = setup();
    fs.writeFileSync(file, prompt());
    fs.writeFileSync(path.join(root, '-repo-a', 's1', 'subagents', 'a.jsonl'), '');
    fs.writeFileSync(path.join(root, '-repo-a', 's1', 'subagents', 'workflows', 'wf1', 'b.jsonl'), '');
    fs.writeFileSync(path.join(root, '-repo-a', 'notes.txt'), 'ignored');
    assert.equal(watcher({}).list().length, 3);
  });

  it('a missing projects folder is empty, not an error', () => {
    const w = new Watcher({ root: '/nonexistent/projects', onEvents: () => {} });
    assert.deepEqual(w.list(), []);
    assert.deepEqual(w.sessions(), []);
  });
});

describe('reading incrementally', () => {
  it('reads appends only, and never counts a line twice, even across a restart', async () => {
    const { file, got, watcher } = setup();
    fs.writeFileSync(file, prompt() + toolCall('a'));
    const w = watcher({});
    await w.backfill();
    assert.deepEqual(got.map((e) => e.kind), ['session', 'tool']);

    w.poll();
    assert.equal(got.length, 2, 'nothing new on disk, nothing counted');

    fs.appendFileSync(file, toolCall('b'));
    w.poll();
    assert.deepEqual(got.map((e) => e.kind), ['session', 'tool', 'tool']);

    // restart: a fresh watcher resuming from the saved offsets, as the bridge does
    const saved = JSON.parse(JSON.stringify(w.scan));
    const w2 = watcher(saved);
    await w2.backfill();
    assert.equal(got.length, 3, 'a replay of the same bytes adds nothing');
    fs.appendFileSync(file, toolCall('c'));
    w2.poll();
    assert.equal(got.length, 4);
    assert.equal(got.at(-1).sessionId, 's1', 'the resumed cursor still knows whose session it is');
  });

  it('a half-written last line is held back, then read once and whole', async () => {
    const { file, got, watcher } = setup();
    const whole = Buffer.from(toolCall('a'));
    const cut = whole.indexOf(Buffer.from('😀')) + 2; // mid-way through a 4-byte character
    fs.writeFileSync(file, Buffer.concat([Buffer.from(prompt()), whole.subarray(0, cut)]));

    const w = watcher({});
    await w.backfill();
    assert.deepEqual(got.map((e) => e.kind), ['session'], 'the torn line is not read yet');

    fs.appendFileSync(file, whole.subarray(cut));
    w.poll();
    assert.deepEqual(got.map((e) => e.kind), ['session', 'tool']);
    assert.equal(w.cursors.get(file).activity.target, 'é😀.ts', 'and the character survived the join');
  });

  it('a file rewritten shorter is read again from the start, without starting the session twice', async () => {
    const { file, got, watcher } = setup();
    fs.writeFileSync(file, prompt() + toolCall('a') + toolCall('b'));
    const w = watcher({});
    await w.backfill();
    assert.deepEqual(got.map((e) => e.kind), ['session', 'tool', 'tool']);

    fs.writeFileSync(file, prompt() + toolCall('c')); // rewritten shorter
    w.poll();
    // the bytes are read again from zero, but the cursor remembers this session already began
    assert.deepEqual(got.slice(3).map((e) => e.kind), ['tool']);
  });

  it('tags every event with its project, falling back to the folder name outside a repo', async () => {
    const { file, got, watcher } = setup();
    fs.writeFileSync(file, prompt());
    await watcher({}).backfill();
    assert.equal(got[0].project, REPO);
    assert.equal(got[0].name, 'repo-a');
  });
});

describe('what each session is doing', () => {
  it('a turn ending on a question needs you; one that just reports is done', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt('add a cart') + reply('Built it. Want me to merge it?'));
    const w = watcher({});
    await w.backfill();
    assert.equal(w.sessions()[0].status, 'waiting');
    assert.equal(w.sessions()[0].station, 'user', 'it comes to find you');

    fs.appendFileSync(file, prompt('yes') + reply('Merged.'));
    w.poll();
    assert.equal(w.sessions()[0].status, 'done');
    assert.equal(w.sessions()[0].station, 'lounge');
  });

  it('an unanswered AskUserQuestion needs you at once; a quick tool stuck on a prompt after a minute', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt() + call('q', 'AskUserQuestion'));
    const w = watcher({});
    await w.backfill();
    assert.equal(w.sessions()[0].status, 'waiting', 'it is asking right now');

    fs.appendFileSync(file, toolDone('q') + call('e', 'Edit'));
    w.poll();
    assert.equal(w.sessions()[0].status, 'working', 'it just started editing');
    w.now = () => Date.now() + 2 * 60_000;
    assert.equal(w.sessions()[0].status, 'waiting', 'an edit still out after two minutes is a permission prompt');

    w.now = Date.now;
    fs.appendFileSync(file, toolDone('e') + call('b', 'Bash'));
    w.poll();
    w.now = () => Date.now() + 2 * 60_000;
    assert.equal(w.sessions()[0].status, 'working', 'a long Bash run is not mistaken for a prompt');
  });

  it('subagents still at work keep a quiet session working, and are counted', async () => {
    const { root, file, watcher } = setup();
    // the session itself has been quiet for three minutes, mid-turn
    fs.writeFileSync(file, prompt('go and refactor it'));
    const quiet = new Date(Date.now() - 3 * 60_000);
    fs.utimesSync(file, quiet, quiet);
    const w = watcher({});
    await w.backfill();
    assert.equal(w.sessions()[0].status, 'idle', 'on its own it looks idle');
    assert.equal(w.sessions()[0].subagents, 0);

    // ...but a subagent it sent out is writing right now
    fs.writeFileSync(path.join(root, '-repo-a', 's1', 'subagents', 'a.jsonl'), line({ isSidechain: true, type: 'user', message: { content: 'task' } }));
    w.poll();
    const [s] = w.sessions();
    assert.equal(s.status, 'working', 'its helpers are working, so it is');
    assert.equal(s.subagents, 1);
  });

  it('a session whose Claude has exited leaves the map at once', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt() + reply('Merge it?'));
    const w = watcher({});
    await w.backfill();
    w.live = () => new Map([['s1', 123]]);
    assert.equal(w.sessions().length, 1, 'still running');
    w.live = () => new Map();
    assert.equal(w.sessions().length, 0, 'its process is gone');
    w.live = () => null;
    assert.equal(w.sessions().length, 1, 'with no registry to ask, recency decides');
  });

  it('a quiet session goes to sleep, then leaves the map altogether', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt());
    const w = watcher({});
    await w.backfill();
    assert.equal(w.sessions()[0].status, 'working');
    w.now = () => Date.now() + AWAKE_MS + 60_000;
    assert.equal(w.sessions()[0].status, 'resting');
    w.now = () => Date.now() + STALE_MS + 60_000;
    assert.equal(w.sessions().length, 0);
  });

  it('a Claude desktop session is one you talk to, with its own label', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt('hi', { entrypoint: 'claude-desktop' }) + reply('Ship it?', { entrypoint: 'claude-desktop' }));
    const w = watcher({});
    await w.backfill();
    w.live = () => new Map(); // the desktop app is not in the CLI's registry: that must not hide it
    w.now = () => Date.now() + 5 * 60_000;
    const [s] = w.sessions();
    assert.equal(s.status, 'waiting');
    assert.equal(s.app, 'CLAUDE APP');
  });

  it('an automated run shows only while it is working', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt('review', { entrypoint: 'sdk-py' }) + toolCall('a', { entrypoint: 'sdk-py' }));
    const w = watcher({});
    await w.backfill();
    assert.equal(w.sessions()[0].status, 'working');
    assert.equal(w.sessions()[0].app, 'AUTOMATED');
    w.now = () => Date.now() + 20 * 60_000;
    assert.equal(w.sessions().length, 0, 'nobody is sitting at it, so there is nothing to show');
  });

  it('a goal stays on the map after its run ends, and can still need you', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt('goal', { entrypoint: 'sdk-cli' }) + reply('Postgres or SQLite?', { entrypoint: 'sdk-cli' }));
    const w = watcher({});
    await w.backfill();
    w.live = () => new Map(); // a headless run is never in the registry
    w.now = () => Date.now() + 5 * 60_000;
    assert.equal(w.sessions().length, 0, 'an ordinary headless run is gone once it stops');

    w.pinned = () => new Set(['s1']);
    const [s] = w.sessions();
    assert.equal(s.status, 'waiting');
    assert.equal(s.goal, true);
    assert.equal(s.app, 'GOAL');
  });

  it('a finished goal reports at Sprout Tower rather than idling in the park', async () => {
    const { file, watcher } = setup();
    fs.writeFileSync(file, prompt('goal', { entrypoint: 'sdk-cli' }) + reply('Shipped it.', { entrypoint: 'sdk-cli' }));
    const w = watcher({});
    await w.backfill();
    w.live = () => new Map();
    w.pinned = () => new Set(['s1']);
    w.now = () => Date.now() + 5 * 60_000;
    assert.deepEqual([w.sessions()[0].status, w.sessions()[0].station], ['done', 'tower']);
  });
});

describe('throwaway folders', () => {
  it('temp dirs and scratchpads earn no events and no Pokémon', async () => {
    for (const cwd of ['/private/tmp/claude-1/x/scratchpad/tg', '/tmp/foo', '/var/folders/ab/T/x', '/Users/me/notes/scratchpad']) {
      const { file, got, watcher } = setup();
      fs.writeFileSync(file, prompt('hi', { cwd }) + toolCall('a', { cwd }));
      const w = watcher({});
      await w.backfill();
      assert.deepEqual(got, [], cwd);
      assert.equal(w.sessions().length, 0, cwd);
    }
  });

  it('only a whole folder called scratchpad counts, not one that merely starts with it', () => {
    assert.equal(isThrowaway('/Users/me/code/scratchpad-app'), false);
    assert.equal(isThrowaway('/Users/me/code/scratchpad'), true);
    assert.equal(isThrowaway('/Users/me/code/app'), false);
  });
});
