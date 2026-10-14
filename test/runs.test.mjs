import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_GOAL, createRuns } from '../src/runs.mjs';

const FAKE_CLAUDE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-runs-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-project-'));
  const record = path.join(home, 'calls.jsonl');
  Object.assign(process.env, { FAKE_OUT: record, FAKE_EXIT: '0', FAKE_SLEEP: '0', ...env });

  const calls = () => (fs.existsSync(record)
    ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const until = async (done) => { for (let i = 0; i < 120 && !done(); i++) await sleep(25); };

  return { home, project, calls, until, runs: (opts) => createRuns({ home, bin: FAKE_CLAUDE, ...opts }) };
}

describe('starting a goal', () => {
  it('runs claude headless in the folder, with the goal on stdin and a session id of its own', async () => {
    const { project, calls, until, runs } = setup();
    const r = runs();
    // text that would be read as flags if it were ever passed as an argument
    const started = r.start({ project, text: '--dangerously-skip-permissions fix the flaky test' });
    assert.equal(started.ok, true);
    await until(() => r.list()[0].status !== 'running');

    const [call] = calls();
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(project));
    assert.equal(call.stdin, '--dangerously-skip-permissions fix the flaky test', 'on stdin, where it cannot be a flag');
    assert.deepEqual(call.argv, ['-p', '--session-id', started.goal.sessionId]);
    assert.equal(r.list()[0].status, 'done');
  });

  it('keeps a log of the run, named after the goal', async () => {
    const { home, project, until, runs } = setup();
    const r = runs();
    const { goal } = r.start({ project, text: 'go' });
    await until(() => r.list()[0].status !== 'running');
    assert.ok(fs.existsSync(path.join(home, 'goals', `${goal.id}.log`)));
  });

  it('refuses what it cannot run, and says why', async () => {
    const { project, until, runs } = setup({ FAKE_SLEEP: '400' });
    const r = runs({ maxRunning: 1 });
    assert.match(r.start({ project: '/nonexistent/repo', text: 'x' }).error, /folder is gone/);
    assert.match(r.start({ project, text: '   ' }).error, /empty/);
    assert.match(r.start({ project, text: 'x'.repeat(MAX_GOAL + 1) }).error, /under/);
    assert.match(r.start({ project: null, text: 'x' }).error, /folder is gone/);

    assert.equal(r.start({ project, text: 'the first one' }).ok, true);
    assert.match(r.start({ project, text: 'the second one' }).error, /already running/);
    await until(() => r.list()[0].status !== 'running');
  });

  it('reports a run that exits badly as failed', async () => {
    const { project, until, runs } = setup({ FAKE_EXIT: '1' });
    const r = runs();
    r.start({ project, text: 'go' });
    await until(() => r.list()[0].status !== 'running');
    assert.equal(r.list()[0].status, 'failed');
    assert.equal(r.list()[0].exitCode, 1);
  });
});

describe('answering a goal', () => {
  it('resumes the very same session, so it keeps its Pokémon', async () => {
    const { project, calls, until, runs } = setup({ FAKE_EXIT: '1' });
    const r = runs();
    const { goal } = r.start({ project, text: 'go' });
    await until(() => r.list()[0].status !== 'running');

    process.env.FAKE_EXIT = '0';
    assert.equal(r.resume(goal.sessionId, project, 'yes, ship it').ok, true);
    assert.equal(r.list()[0].status, 'running', 'the goal is going again');
    await until(() => calls().length === 2 && r.list()[0].status !== 'running');

    assert.deepEqual(calls()[1].argv, ['-p', '--resume', goal.sessionId]);
    assert.equal(calls()[1].stdin, 'yes, ship it');
    assert.equal(r.list()[0].status, 'done');
  });

  it('queues an answer while the run is still alive, and sends it the moment it ends', async () => {
    const { project, calls, until, runs } = setup({ FAKE_SLEEP: '400' });
    const r = runs();
    const { goal } = r.start({ project, text: 'watch CI, then ask me' });
    await until(() => calls().length === 1);

    assert.deepEqual(r.resume(goal.sessionId, project, 'yes please'), { ok: true, queued: true });
    assert.equal(r.list()[0].queued, 'yes please');

    await until(() => calls().length === 2);
    assert.deepEqual(calls()[1].argv, ['-p', '--resume', goal.sessionId]);
    assert.equal(calls()[1].stdin, 'yes please');
    assert.equal(r.list()[0].queued, undefined, 'sent, so no longer waiting');
    await until(() => r.list()[0].status !== 'running');
  });

  it('send-now stops the live run so the answer goes out at once', async () => {
    const { project, calls, until, runs } = setup({ FAKE_SLEEP: '5000' });
    const r = runs();
    const { goal } = r.start({ project, text: 'a long watch' });
    await until(() => calls().length === 1);

    process.env.FAKE_SLEEP = '0';
    assert.deepEqual(r.resume(goal.sessionId, project, 'go ahead', { now: true }), { ok: true, queued: true });
    await until(() => calls().length === 2);
    assert.equal(calls()[1].stdin, 'go ahead');
    await until(() => r.list()[0].status === 'done');
    assert.equal(r.list()[0].status, 'done', 'the answered run sets the status, not the one we stopped');
  });

  it('refuses an answer it has nowhere to send', () => {
    const { project, runs } = setup();
    const r = runs();
    assert.equal(r.resume('not-a-uuid', project, 'x').ok, false);
    assert.equal(r.resume('11111111-2222-3333-4444-555555555555', '/nonexistent', 'x').ok, false);
    assert.equal(r.resume('11111111-2222-3333-4444-555555555555', project, '  ').ok, false);
    assert.equal(r.resume('11111111-2222-3333-4444-555555555555', project, 'x'.repeat(MAX_GOAL + 1)).ok, false);
  });
});

describe('stopping and restarting', () => {
  it('stop ends a running goal, and no queued answer follows it', async () => {
    const { project, calls, until, runs } = setup({ FAKE_SLEEP: '5000' });
    const r = runs();
    const { goal } = r.start({ project, text: 'a long one' });
    await until(() => calls().length === 1);

    r.resume(goal.sessionId, project, 'an answer nobody wants now');
    assert.equal(r.stop(goal.id).ok, true);
    await until(() => r.list()[0].status !== 'running');
    assert.equal(r.list()[0].status, 'stopped');
    await sleep(300);
    assert.equal(calls().length, 1, 'you stopped it, so the queued answer is dropped');
    assert.equal(r.list()[0].queued, undefined);
  });

  it('stop refuses a goal that is not running', () => {
    const { runs } = setup();
    const r = runs();
    assert.equal(r.stop('nope').ok, false);
  });

  it('goals survive a restart, and a run that died with the last bridge is not left running', async () => {
    const { home, project, until, runs } = setup({ FAKE_SLEEP: '0' });
    const r = runs();
    const { goal } = r.start({ project, text: 'go' });
    await until(() => r.list()[0].status !== 'running');

    // as the file would look if the bridge had been killed mid-run
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'goals.json'), 'utf8'));
    saved[0].status = 'running';
    saved[0].pid = 999_999;
    fs.writeFileSync(path.join(home, 'goals.json'), JSON.stringify(saved));

    const after = runs();
    assert.equal(after.list()[0].status, 'ended', 'ended, not done: we cannot know how it went');
    assert.deepEqual([...after.sessionIds()], [goal.sessionId], 'and it stays on the map');
  });

  it('an unreadable goals file starts empty rather than refusing to boot', () => {
    const { home, runs } = setup();
    fs.writeFileSync(path.join(home, 'goals.json'), 'not json');
    assert.deepEqual(runs().list(), []);
    fs.writeFileSync(path.join(home, 'goals.json'), '{"not":"an array"}');
    assert.deepEqual(runs().list(), []);
  });
});
