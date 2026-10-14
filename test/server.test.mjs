// Boots the real bridge and throws hostile input at it. Needs the fetched assets, because the
// bridge refuses to start without a Pokédex.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

const ROOT = new URL('..', import.meta.url).pathname;
const assetsReady = fs.existsSync(path.join(ROOT, '.cache/assets/pokedex.json'));
const PORT = 7950;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the real ~/.claude is never read from a test: an empty directory stands in for it
const NO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-no-projects-'));

async function boot(home) {
  const proc = spawn(process.execPath, [
    path.join(ROOT, 'src/server.mjs'),
    '--port', String(PORT),
    '--home', home,
    '--projects', NO_PROJECTS,
    '--sessions', NO_PROJECTS,
  ], { stdio: 'pipe' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(ORIGIN); return proc; } catch { await sleep(100); }
  }
  throw new Error('the bridge did not start');
}

const stop = async (proc) => { proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r)); };

/** a raw request: fetch() tidies up paths, which would hide a traversal attempt */
const raw = (requestPath, host = `127.0.0.1:${PORT}`) => new Promise((resolve) => {
  import('node:http').then(({ request }) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: requestPath, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('error'));
    req.end();
  });
});

const post = (route, origin, body) => fetch(`${ORIGIN}${route}`, { method: 'POST', headers: origin ? { origin } : {}, body });

describe('the bridge', { skip: !assetsReady && 'assets not fetched: run npm run setup' }, () => {
  let proc;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-bridge-'));
  before(async () => { proc = await boot(home); });
  after(async () => { await stop(proc); });

  it('serves the fetched assets, and nothing outside them', async () => {
    const dex = await fetch(`${ORIGIN}/assets/pokedex.json`);
    assert.equal(dex.status, 200);
    assert.equal((await dex.json()).species.length, 251);
    assert.equal((await fetch(`${ORIGIN}/assets/nothing-here.json`)).status, 404);
  });

  it('survives malformed and hostile paths, and keeps serving afterwards', async () => {
    for (const p of ['/%E0%A4%A', '/%', '/%00', '/assets/%00x', '/../package.json', '/assets/../../package.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json']) {
      const code = await raw(p);
      assert.ok([400, 403, 404].includes(code), `${p} answered ${code}`);
    }
    assert.equal((await fetch(`${ORIGIN}/assets/pokedex.json`)).status, 200, 'still serving after the barrage');
  });

  it('refuses a foreign origin on the socket, and a host it does not answer to', async () => {
    const tryWs = (origin) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, origin ? { origin } : {});
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('error', () => resolve('refused'));
    });
    assert.equal(await tryWs('https://evil.example'), 'refused');
    assert.equal(await tryWs('null'), 'refused');
    assert.equal(await tryWs(undefined), 'refused', 'no origin at all is not our page either');
    assert.equal(await tryWs(ORIGIN), 'open');
    assert.equal(await raw('/', `evil.example:${PORT}`), 421, 'a rebinding host is refused');
  });

  it('sends a new page the state, the sessions and the timeline', async () => {
    const seen = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: ORIGIN });
      const types = [];
      ws.on('message', (data) => {
        types.push(JSON.parse(data).type);
        if (types.length >= 3) { ws.close(); resolve(types); }
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); resolve(types); }, 5000);
    });
    assert.deepEqual(seen.sort(), ['sessions', 'state', 'timeline']);
  });

  it('every action is our-page-only', async () => {
    for (const route of ['/focus', '/recap', '/answer', '/goal', '/goal/stop', '/folder/new', '/folder/choose']) {
      assert.equal((await post(route, 'https://evil.example', '{}')).status, 403, `${route} took a foreign origin`);
      assert.equal((await post(route, undefined, '{}')).status, 403, `${route} took no origin`);
    }
  });

  it('refuses a session it has never heard of', async () => {
    const unknown = '{"id":"11111111-2222-3333-4444-555555555555"}';
    assert.equal((await post('/focus', ORIGIN, unknown)).status, 404);
    assert.equal((await post('/recap', ORIGIN, unknown)).status, 404);
    assert.equal((await post('/answer', ORIGIN, '{"id":"11111111-2222-3333-4444-555555555555","text":"yes"}')).status, 404);
  });

  it('refuses nonsense in place of an id, rather than trusting its shape', async () => {
    assert.equal((await post('/recap', ORIGIN, '{"id":{"toString":1}}')).status, 404);
    assert.equal((await post('/focus', ORIGIN, '{"id":["x"]}')).status, 404);
    assert.equal((await post('/goal', ORIGIN, '{"project":{"__proto__":1}}')).status, 404);
    assert.equal((await post('/focus', ORIGIN, '{not json')).status, 400);
  });

  it('holds a goal to the same folder rules as everything else', async () => {
    const missing = await post('/goal', ORIGIN, '{"project":"/not/a/project","text":"hi"}');
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /No such folder/);

    const outside = await post('/goal', ORIGIN, '{"project":"/etc","text":"hi"}');
    assert.match((await outside.json()).error, /inside your home/);

    const escaping = await post('/folder/new', ORIGIN, '{"name":"../escape"}');
    assert.match((await escaping.json()).error, /Letters/);
  });

  it('keeps the dev hooks off unless it was started with --dev', async () => {
    for (const route of ['/dev/patch', '/dev/apply', '/dev/give']) {
      assert.equal((await post(route, ORIGIN, '{}')).status, 404, route);
    }
  });

  it('refuses a body far too large to be an answer', async () => {
    const huge = JSON.stringify({ id: '11111111-2222-3333-4444-555555555555', text: 'x'.repeat(200_000) });
    assert.equal((await post('/answer', ORIGIN, huge)).status, 400);
  });
});

describe('an unreadable progress file', { skip: !assetsReady && 'assets not fetched: run npm run setup' }, () => {
  for (const contents of ['null', '[]', '{}', '{not json', '{"version":99,"progress":{},"scan":{}}']) {
    it(`starts fresh and keeps a .bad copy when progress.json is ${contents}`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-state-'));
      fs.writeFileSync(path.join(home, 'progress.json'), contents);
      const proc = await boot(home);
      await stop(proc);
      assert.ok(fs.existsSync(path.join(home, 'progress.json.bad')), 'the file we could not read is kept');
      assert.ok(fs.existsSync(path.join(home, 'progress.json')), 'and a fresh one is written');
    });
  }
});
