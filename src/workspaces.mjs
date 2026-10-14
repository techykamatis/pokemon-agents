// Where a goal is allowed to run: any real folder inside your home directory — but not your home
// itself, and not a temp dir or a scratchpad, which never get a Pokémon and so could not be shown
// on the map anyway. You can pick one in Finder, type a path, or have a fresh one made under ~/code.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isThrowaway } from './watcher.mjs';

const run = promisify(execFile);

/** a plain folder name: no separators, no leading dot, nothing to escape */
const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const FINDER_PROMPT = [
  'tell application "Finder"',
  'activate',
  'set f to choose folder with prompt "Folder for the new goal"',
  'end tell',
  'return POSIX path of f',
].join('\n');

/**
 * Check a folder a goal has been pointed at.
 *
 * Everything is resolved with realpath first, so `..` and a symlink out of your home are both
 * caught by the one containment check rather than by guessing at the string.
 *
 * @param {string} input an absolute path, or one starting with ~
 * @returns {{ok: true, dir: string} | {ok: false, error: string}}
 */
export function goalFolder(input, { home = os.homedir(), throwaway = isThrowaway } = {}) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'No folder given.' };

  const expanded = input.trim().replace(/^~(?=$|\/)/, home);
  if (!path.isAbsolute(expanded)) return { ok: false, error: 'Give a full path, like ~/code/app.' };

  let dir;
  try { dir = fs.realpathSync(expanded); } catch { return { ok: false, error: 'No such folder.' }; }
  if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'That is a file, not a folder.' };

  const inside = path.relative(fs.realpathSync(home), dir);
  // empty means it *is* home; '..' or an absolute result means it is outside it
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    return { ok: false, error: 'Pick a folder inside your home folder.' };
  }
  if (throwaway(dir)) return { ok: false, error: "Temp and scratchpad folders don't get a Pokémon." };

  return { ok: true, dir };
}

/** make (or reuse) <base>/<name> */
export function newFolder(name, { base = path.join(os.homedir(), 'code') } = {}) {
  if (typeof name !== 'string' || !FOLDER_NAME_RE.test(name)) {
    return { ok: false, error: 'Letters, digits, . _ - only (up to 64).' };
  }
  const dir = path.join(base, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Could not make it: ${e.code ?? e.message}` };
  }
  return { ok: true, dir };
}

/** the macOS folder dialog, brought to the front. Waits as long as you take to answer it. */
export async function chooseFolder() {
  if (process.platform !== 'darwin') return { ok: false, error: 'Type the path instead.' };
  try {
    const { stdout } = await run('osascript', ['-e', FINDER_PROMPT], { timeout: 5 * 60_000 });
    return goalFolder(stdout.trim()); // whatever you picked still has to pass the rules
  } catch (e) {
    return { ok: false, error: /-128/.test(e.message) ? 'Cancelled.' : 'Could not open the folder picker.' };
  }
}
