import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { goalFolder, newFolder } from '../src/workspaces.mjs';

// a stand-in home, so nothing here depends on the real one
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-home-')));
fs.mkdirSync(path.join(home, 'code', 'app'), { recursive: true });
fs.writeFileSync(path.join(home, 'notes.txt'), 'not a folder');
// the fake home lives in a temp dir, which the real throwaway rule would reject outright
const opts = { home, throwaway: () => false };

describe('where a goal may run', () => {
  it('takes any real folder inside your home, with ~ expanded', () => {
    assert.deepEqual(goalFolder('~/code/app', opts), { ok: true, dir: path.join(home, 'code', 'app') });
    assert.deepEqual(goalFolder(` ${path.join(home, 'code')} `, opts), { ok: true, dir: path.join(home, 'code') });
  });

  it('refuses anything outside your home', () => {
    assert.match(goalFolder('/etc', opts).error, /inside your home/);
    assert.match(goalFolder('~/code/app/../../..', opts).error, /inside your home/);
  });

  it('refuses your home itself: it is not a project', () => {
    assert.match(goalFolder('~', opts).error, /inside your home/);
    assert.match(goalFolder(home, opts).error, /inside your home/);
  });

  it('refuses a file, a path that is not there, and a relative one', () => {
    assert.match(goalFolder('~/notes.txt', opts).error, /not a folder/);
    assert.match(goalFolder('~/nope', opts).error, /No such folder/);
    assert.match(goalFolder('code/app', opts).error, /full path/);
  });

  it('refuses nothing at all, and anything that is not a string', () => {
    for (const bad of ['', '   ', 7, null, undefined, {}]) assert.equal(goalFolder(bad, opts).ok, false, String(bad));
  });

  it('refuses a temp dir or a scratchpad, which never get a Pokémon', () => {
    assert.match(goalFolder('~/code/app', { home, throwaway: () => true }).error, /Temp/);
  });

  it('follows a symlink out of your home and still refuses it', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-outside-')));
    const link = path.join(home, 'shortcut');
    fs.symlinkSync(outside, link);
    assert.match(goalFolder(link, opts).error, /inside your home/, 'the real path is what counts');
  });
});

describe('making a new folder', () => {
  const base = path.join(home, 'code');

  it('makes it under ~/code, and is happy to reuse one', () => {
    assert.deepEqual(newFolder('fresh-idea', { base }), { ok: true, dir: path.join(base, 'fresh-idea') });
    assert.ok(fs.statSync(path.join(base, 'fresh-idea')).isDirectory());
    assert.equal(newFolder('app', { base }).ok, true, 'one that already exists is fine');
  });

  it('takes plain names only, so there is nothing to escape', () => {
    for (const bad of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(65), 'sp ace', 'quote"d', 7, null]) {
      assert.equal(newFolder(bad, { base }).ok, false, String(bad));
    }
    assert.match(newFolder('../escape', { base }).error, /Letters/);
  });

  it('says why when it cannot make one', () => {
    const result = newFolder('nope', { base: path.join(home, 'notes.txt') }); // a file, not a folder
    assert.equal(result.ok, false);
    assert.match(result.error, /Could not make it/);
  });
});
