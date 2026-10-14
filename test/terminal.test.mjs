import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chainTtys, findPid, liveSessions, resumeInTerminal, typeable, typeInto } from '../src/terminal.mjs';

const LIVE_ID = '11111111-2222-3333-4444-555555555555';
const DEAD_ID = '66666666-7777-8888-9999-000000000000';
const registry = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-sessions-'));
const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

describe("Claude's registry of running sessions", () => {
  it('maps a live session to its pid, ignoring stale, junk and malformed entries', () => {
    const dir = registry();
    write(dir, `${process.pid}.json`, { pid: process.pid, sessionId: LIVE_ID });
    write(dir, '999999.json', { pid: 999_999, sessionId: DEAD_ID });
    write(dir, '1.json', '{ not json');
    write(dir, '00.json', { pid: 999_998, sessionId: LIVE_ID }); // a stale twin, listed first
    write(dir, `${process.pid}.abc.key`, 'not a session file at all');

    assert.equal(findPid(LIVE_ID, dir), process.pid, 'the live twin wins over the stale one');
    assert.equal(findPid(DEAD_ID, dir), null, 'its process has gone');
    assert.equal(findPid('../../etc/passwd', dir), null, 'not a session id');
    assert.equal(findPid(undefined, dir), null);
    assert.equal(findPid(LIVE_ID, path.join(dir, 'missing')), null);
  });

  it('tells "nothing is running" apart from "I cannot tell"', () => {
    const dir = registry();
    assert.equal(liveSessions(path.join(dir, 'missing')), null, 'no registry at all: unknown');
    assert.equal(liveSessions(dir), null, 'an empty registry: still unknown');

    write(dir, '999999.json', { pid: 999_999, sessionId: 'gone' });
    assert.deepEqual([...liveSessions(dir).keys()], [], 'records, but none alive: everything has exited');

    write(dir, `${process.pid}.json`, { pid: process.pid, sessionId: 'here' });
    assert.deepEqual([...liveSessions(dir).keys()], ['here']);
  });

  it('skips a record missing the fields it needs', () => {
    const dir = registry();
    write(dir, '2.json', { pid: 'not a number', sessionId: 'x' });
    write(dir, '3.json', { pid: process.pid });
    write(dir, '4.json', { sessionId: 'y' });
    assert.equal(liveSessions(dir).size, 0);
  });
});

describe('finding the tab a session is in', () => {
  it('walks past helpers with no terminal, and judges the foreground per terminal', () => {
    // this exact shape: a session under Claude Code's background helper, below the claude you can
    // see in a Terminal tab that is itself wrapped in `script`
    const rows = [
      { tty: 'ttys018', stat: 'SNs+' }, // the session itself
      { tty: '??', stat: 'SNs' }, // the app helper: no terminal
      { tty: '??', stat: 'Ss' }, // the launcher: no terminal
      { tty: 'ttys005', stat: 'S+' }, // the claude you can see
      { tty: 'ttys005', stat: 'Ss' }, // its zsh: the same terminal, met second
      { tty: 'ttys004', stat: 'S+' }, // script
      { tty: 'ttys004', stat: 'S' }, // the login shell
      { tty: '??', stat: 'S' }, // Terminal.app
    ];
    assert.deepEqual(chainTtys(rows), [
      { tty: '/dev/ttys018', fg: true },
      { tty: '/dev/ttys005', fg: true },
      { tty: '/dev/ttys004', fg: true },
    ]);
  });

  it('notices when a terminal along the way is not showing Claude', () => {
    const rows = [
      { tty: 'ttys018', stat: 'SNs+' },
      { tty: 'ttys005', stat: 'T' }, // the claude TUI is suspended, so its zsh holds the tab
      { tty: 'ttys005', stat: 'Ss+' },
    ];
    assert.equal(chainTtys(rows).every((x) => x.fg), false);
  });

  it('a chain with no terminal in it at all is empty', () => {
    assert.deepEqual(chainTtys([{ tty: '??', stat: 'Ss' }, { tty: undefined, stat: 'S' }]), []);
  });
});

describe('typing an answer', () => {
  it('collapses an answer to the one line it would type', () => {
    assert.deepEqual(typeable('  yes,\n ship   it '), { ok: true, line: 'yes, ship it' });
  });

  it('refuses an empty answer', () => {
    assert.equal(typeable('').ok, false);
    assert.equal(typeable('   ').ok, false);
    assert.equal(typeable(undefined).ok, false);
  });

  it("refuses Claude Code's shell mode rather than running a command by accident", () => {
    assert.equal(typeable('  !rm -rf ~').ok, false);
    assert.match(typeable('!ls').error, /shell commands/);
    assert.equal(typeable('Option 1: run !this').ok, true, 'only a leading ! is shell mode');
  });

  it('truncates something far too long instead of sending all of it', () => {
    assert.equal(typeable('x'.repeat(5000)).line.length, 2000);
  });

  it('will not type into a session that is not open anywhere', async () => {
    const result = await typeInto(LIVE_ID, registry(), 'yes');
    assert.equal(result.ok, false);
    assert.match(result.error, /Not open in any terminal/);
  });

  it('checks the answer before it goes looking for a terminal', async () => {
    const result = await typeInto(LIVE_ID, registry(), '!rm -rf ~');
    assert.match(result.error, /shell commands/, 'refused on the text, not on the terminal');
  });
});

describe('carrying a session on in a new window', () => {
  it('refuses a bad id or a relative folder before touching Terminal', async () => {
    assert.equal((await resumeInTerminal('/Users/me/code/app', 'x; rm -rf ~')).ok, false);
    assert.equal((await resumeInTerminal('code/app', LIVE_ID)).ok, false);
    assert.equal((await resumeInTerminal(undefined, LIVE_ID)).ok, false);
    assert.equal((await resumeInTerminal('/Users/me/code/app', undefined)).ok, false);
  });
});
