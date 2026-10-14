import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createTimeline, diffWorld } from '../src/timeline.mjs';

const S = (id, status, over = {}) => ({ id, status, name: id, project: `/code/${id}`, app: 'TERMINAL', title: `about ${id}`, ...over });
const goal = (status) => ({ id: 'g1', sessionId: 's9', project: '/code/weather', text: 'ship it', status });
const raikou = (alert, line = '') => ({ 243: { name: 'RAIKOU', alert, lines: line ? [line] : [] } });
const world = (over = {}) => ({ sessions: [], goals: [], legends: {}, ...over });

describe('diffing one look against the last', () => {
  it('the first look is never news: what was already there did not just happen', () => {
    const first = diffWorld(null, world({ sessions: [S('a', 'working')] }));
    assert.deepEqual(first.entries, []);
    assert.ok(first.state.sessions.has('a'), 'but it is remembered, so the next change is news');
  });

  it('writes down a status change and a session arriving', () => {
    const first = diffWorld(null, world({ sessions: [S('a', 'working')] }));
    const second = diffWorld(first.state, world({ sessions: [S('a', 'waiting'), S('b', 'working')] }));
    assert.deepEqual(second.entries.map((e) => [e.kind, e.id]), [['waiting', 'a'], ['working', 'b']]);
    assert.equal(second.entries[0].title, 'about a', 'with enough about it to read later');
  });

  it('keeps quiet about idle, but not about leaving the map', () => {
    const first = diffWorld(null, world({ sessions: [S('a', 'working'), S('b', 'working')] }));
    const second = diffWorld(first.state, world({ sessions: [S('b', 'idle')] }));
    assert.deepEqual(second.entries.map((e) => [e.kind, e.id]), [['left', 'a']]);
    assert.equal(second.entries[0].name, 'a', 'a session that has gone keeps the name it had');
  });

  it('says nothing at all when nothing changed', () => {
    const first = diffWorld(null, world({ sessions: [S('a', 'working')] }));
    const same = diffWorld(first.state, world({ sessions: [S('a', 'working')] }));
    assert.deepEqual(same.entries, []);
  });

  it('notices a status going back to one it held before', () => {
    const a = diffWorld(null, world({ sessions: [S('x', 'waiting')] }));
    const b = diffWorld(a.state, world({ sessions: [S('x', 'working')] }));
    const c = diffWorld(b.state, world({ sessions: [S('x', 'waiting')] }));
    assert.deepEqual(c.entries.map((e) => e.kind), ['waiting'], 'it asked you something again');
  });
});

describe('goals and legendaries', () => {
  it('writes down each stage of a goal, with the goal text', () => {
    const a = diffWorld(null, world());
    const b = diffWorld(a.state, world({ goals: [goal('running')] }));
    assert.deepEqual(b.entries.map((e) => e.kind), ['goal-running']);
    assert.equal(b.entries[0].text, 'ship it');
    assert.equal(b.entries[0].name, 'weather', 'named after the folder it runs in');
    assert.equal(b.entries[0].id, 's9', 'and pointing at its session, so you can open it');

    const c = diffWorld(b.state, world({ goals: [goal('done')] }));
    assert.deepEqual(c.entries.map((e) => e.kind), ['goal-done']);
    const d = diffWorld(c.state, world({ goals: [goal('done')] }));
    assert.deepEqual(d.entries, [], 'a goal that is still done is not done again');
  });

  it('a legendary that starts pointing at something is news, once', () => {
    const a = diffWorld(null, world({ legends: raikou(false) }));
    const b = diffWorld(a.state, world({ legends: raikou(true, '1 session(s) with a red test run:') }));
    assert.deepEqual(b.entries.map((e) => e.kind), ['legend']);
    assert.equal(b.entries[0].legend, 243);
    assert.match(b.entries[0].text, /red test/);

    const c = diffWorld(b.state, world({ legends: raikou(true, 'still red') }));
    assert.deepEqual(c.entries, [], 'one still pointing is not news again');
  });

  it('a legendary that stops and starts again is news again', () => {
    const a = diffWorld(null, world({ legends: raikou(true) }));
    const b = diffWorld(a.state, world({ legends: raikou(false) }));
    const c = diffWorld(b.state, world({ legends: raikou(true, 'red once more') }));
    assert.deepEqual(c.entries.map((e) => e.kind), ['legend']);
  });
});

describe('keeping the log', () => {
  const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-timeline-')), 'timeline.json');

  it('stamps entries, keeps the newest, and hands them to the page as they arrive', () => {
    const file = tempFile();
    const pushed = [];
    const timeline = createTimeline({ file, max: 3, onAdd: (e) => pushed.push(...e), now: () => 5 });

    timeline.add([{ kind: 'waiting', text: 'one' }, { kind: 'done', text: 'two' }]);
    timeline.add([{ kind: 'level', text: 'three' }, { kind: 'badge', text: 'four' }]);

    assert.deepEqual(timeline.list().map((e) => e.text), ['two', 'three', 'four'], 'oldest dropped at the cap');
    assert.equal(timeline.list()[0].ts, 5);
    assert.equal(pushed.length, 4, 'the page saw all four, cap or no cap');
  });

  it('adding nothing writes nothing', () => {
    const pushed = [];
    const timeline = createTimeline({ file: tempFile(), onAdd: (e) => pushed.push(...e) });
    timeline.add([]);
    assert.deepEqual(pushed, []);
    assert.deepEqual(timeline.list(), []);
  });

  it('survives a restart, and comes back capped', () => {
    const file = tempFile();
    const first = createTimeline({ file, max: 3, now: () => 5 });
    first.add([{ kind: 'waiting', text: 'one' }, { kind: 'done', text: 'two' }, { kind: 'level', text: 'three' }]);
    first.flush();

    const reloaded = createTimeline({ file, max: 3 });
    assert.deepEqual(reloaded.list().map((e) => e.text), ['one', 'two', 'three']);
    reloaded.add([{ kind: 'badge', text: 'four' }]);
    assert.deepEqual(reloaded.list().map((e) => e.text), ['two', 'three', 'four']);
  });

  it('an unreadable log starts a fresh one rather than refusing to boot', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'not json at all');
    assert.deepEqual(createTimeline({ file }).list(), []);
    fs.writeFileSync(file, '{"not":"an array"}');
    assert.deepEqual(createTimeline({ file }).list(), []);
  });

  it('writes the file whole, leaving no temporary behind', () => {
    const file = tempFile();
    const timeline = createTimeline({ file, now: () => 7 });
    timeline.add([{ kind: 'done', text: 'saved' }]);
    timeline.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ ts: 7, kind: 'done', text: 'saved' }]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['timeline.json']);
  });
});
