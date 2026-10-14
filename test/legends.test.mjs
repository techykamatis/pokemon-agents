import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEGENDS, legendsReport } from '../src/legends.mjs';
import { newCursor } from '../src/transcript.mjs';

const NOW = new Date(2026, 9, 13, 15, 0).getTime();
const MINUTE = 60_000;
const ALL = [243, 244, 245, 249, 250, 251];

const cursor = (over) => ({
  ...newCursor(),
  entry: 'cli',
  sessionId: over.id,
  cwd: `/code/${over.folder ?? 'app'}`,
  title: over.title ?? null,
  lastTs: over.ts ?? NOW,
  mtime: over.ts ?? NOW,
  ...over,
});
const session = (id, status, over = {}) => ({ id, status, name: over.name ?? 'app', project: '/code/app', ...over });
const input = (over = {}) => ({
  unlocked: ALL,
  cursors: [],
  sessions: [],
  team: { days: [], streak: 0, bestStreak: 0 },
  goals: [],
  now: NOW,
  ...over,
});

describe('which legendaries report', () => {
  it('only the ones you have released, each with its job and its building', () => {
    const report = legendsReport(input({ unlocked: [243] }));
    assert.deepEqual(Object.keys(report), ['243']);
    assert.equal(report[243].job, 'TEST WATCHER');
    assert.equal(report[243].home, 'testbench');
    assert.ok(report[243].lore);
  });

  it('every legendary in the table has a job, a home and lore to tell you', () => {
    for (const [id, legend] of Object.entries(LEGENDS)) {
      assert.ok(legend.name && legend.job && legend.home && legend.lore, `#${id} is incomplete`);
    }
  });

  it('each report names the badge that released it, when, and for which project', () => {
    const team = {
      days: [], streak: 0, bestStreak: 0,
      badges: [{ id: 'plain', ts: 1000, agentId: '/code/app' }],
      achievements: [{ id: 'celebi', ts: 2000, agentId: '/code/notes' }],
    };
    const report = legendsReport(input({ unlocked: [243, 251], team }));
    assert.deepEqual(report[243].released, { by: 'PLAINBADGE', why: 'a failing test fixed in the same session', ts: 1000, project: '/code/app' });
    assert.equal(report[251].released.by, 'TIME TRAVELER');
    assert.equal(report[251].released.project, '/code/notes');
  });

  it('says which badge would release one you have not earned yet', () => {
    const report = legendsReport(input({ unlocked: [249], team: { days: [], streak: 0, bestStreak: 0 } }));
    assert.equal(report[249].released.by, 'RISINGBADGE');
    assert.equal(report[249].released.ts, null, 'not earned, so there is no date on it');
  });
});

describe('RAIKOU, on tests', () => {
  it('points at live sessions whose last test run was red', () => {
    const cursors = [cursor({ id: 'a', lastTestFailed: true, title: 'Fix login' }), cursor({ id: 'b', lastTestFailed: false })];
    const report = legendsReport(input({ cursors, sessions: [session('a', 'done'), session('b', 'working')] }))[243];
    assert.equal(report.alert, true);
    assert.deepEqual(report.sessions.map((s) => s.id), ['a']);
    assert.match(report.sessions[0].label, /Fix login/);
  });

  it('is quiet when everything is green', () => {
    const cursors = [cursor({ id: 'b', lastTestFailed: false })];
    const report = legendsReport(input({ cursors, sessions: [session('b', 'working')] }))[243];
    assert.equal(report.alert, false);
    assert.deepEqual(report.sessions, []);
  });
});

describe('SUICUNE, on unsaved work', () => {
  it('points at sessions that stopped with edits they never committed', () => {
    const cursors = [cursor({ id: 'a', dirty: 3 }), cursor({ id: 'b', dirty: 2 }), cursor({ id: 'c', dirty: 0 })];
    const report = legendsReport(input({ cursors, sessions: [session('a', 'done'), session('b', 'working'), session('c', 'idle')] }))[245];
    assert.equal(report.alert, true);
    assert.deepEqual(report.sessions.map((s) => s.id), ['a'], 'one still working is fine, and a clean one is fine');
    assert.match(report.sessions[0].label, /3 edits/);
  });
});

describe('ENTEI, on the streak', () => {
  it('warns when today has nothing in it yet', () => {
    const team = { days: ['2026-10-11', '2026-10-12'], streak: 2, bestStreak: 9 };
    const report = legendsReport(input({ team }))[244];
    assert.equal(report.alert, true);
    assert.match(report.lines.join(' '), /at risk/);
  });

  it('is content once today has something in it', () => {
    const team = { days: ['2026-10-11', '2026-10-12', '2026-10-13'], streak: 3, bestStreak: 9 };
    assert.equal(legendsReport(input({ team }))[244].alert, false);
  });

  it('does not nag when there is no streak to lose', () => {
    assert.equal(legendsReport(input({ team: { days: [], streak: 0, bestStreak: 0 } }))[244].alert, false);
  });
});

describe('LUGIA, on long runs', () => {
  it('points at work running over twenty minutes, and at goals still going', () => {
    const cursors = [cursor({ id: 'a', firstTs: NOW - 45 * MINUTE }), cursor({ id: 'b', firstTs: NOW - 5 * MINUTE })];
    const report = legendsReport(input({
      cursors,
      sessions: [session('a', 'working', { since: NOW - 45 * MINUTE }), session('b', 'working', { since: NOW - 5 * MINUTE })],
      goals: [{ id: 'g', status: 'running', text: 'ship it', sessionId: 'b', started: NOW - 30 * MINUTE }],
    }))[249];

    assert.equal(report.alert, true);
    assert.deepEqual(report.sessions.map((s) => s.id), ['a', 'b']);
    assert.match(report.sessions[0].label, /45m/);
  });

  it('a running goal alone is worth listing but not alarming', () => {
    const report = legendsReport(input({ goals: [{ id: 'g', status: 'running', text: 'ship it', sessionId: 'x', started: NOW - 30 * MINUTE }] }))[249];
    assert.equal(report.alert, false, 'a goal is meant to run long');
    assert.equal(report.sessions.length, 1);
  });
});

describe('HO-OH and CELEBI, on time', () => {
  const day = (d) => new Date(2026, 9, d, 11).getTime();
  const cursors = [
    cursor({ id: 't', title: 'Today work', ts: day(13) }),
    cursor({ id: 'w', title: 'Last week work', ts: day(6) }),
    cursor({ id: 'm', title: 'Last month work', ts: day(-17) }),
    cursor({ id: 'old', title: 'Long ago', ts: day(1) }),
    cursor({ id: 's', title: 'A subagent', ts: day(13), isSub: true }),
    cursor({ id: 'cron', title: 'Cron sweep', ts: day(13), entry: 'sdk-cli' }),
  ];

  it('HO-OH recaps today, and counts only sessions you sat at', () => {
    const report = legendsReport(input({ cursors }))[250];
    assert.ok(report.lines.some((l) => l.includes('Today work')));
    assert.ok(!report.lines.some((l) => l.includes('A subagent')), 'a subagent is not a session of yours');
    assert.ok(!report.lines.some((l) => l.includes('Cron sweep')), 'nor is an automated run');
    assert.equal(report.alert, false, 'a recap is never an alarm');
  });

  it('CELEBI looks back a week and a month, and not at today', () => {
    const report = legendsReport(input({ cursors }))[251];
    assert.ok(report.lines.some((l) => l.includes('Last week work')));
    assert.ok(report.lines.some((l) => l.includes('Last month work')));
    assert.ok(!report.lines.some((l) => l.includes('Today work')));
  });

  it('CELEBI says so plainly when those days were quiet', () => {
    const report = legendsReport(input({ cursors: [cursors[0]] }))[251];
    assert.equal(report.lines.filter((l) => l === '(quiet)').length, 2);
  });
});
