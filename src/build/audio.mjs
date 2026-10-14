// Compiles Pokémon Crystal's own sound source (pret/pokecrystal audio/*.asm, fetched into .cache at
// setup and never committed) into plain note timelines a browser can play with Web Audio.
//
// It runs each channel's commands the way the Game Boy sound engine did — octaves, tempo, loops,
// calls, envelopes — and records every note that comes out: when it starts and how long it lasts in
// seconds, its pitch in Hz, its volume envelope and its pulse duty. The player in web/js/audio.mjs
// then only has to make sound, not interpret a format.
import fs from 'node:fs';
import path from 'node:path';

const FPS = 60; // the sound engine ticks once a frame

/** audio/notes.asm FrequencyTable, C_ to B_, as signed 16-bit. Octave n shifts it right by n - 1. */
const FREQUENCIES = [0xf82c, 0xf89d, 0xf907, 0xf96b, 0xf9ca, 0xfa23, 0xfa77, 0xfac7, 0xfb12, 0xfb58, 0xfb9b, 0xfbda]
  .map((x) => x - 0x10000);

const SEMITONES = { C_: 0, 'C#': 1, D_: 2, 'D#': 3, E_: 4, F_: 5, 'F#': 6, G_: 7, 'G#': 8, A_: 9, 'A#': 10, B_: 11 };

/** the Game Boy's four hardware channels, as the engine numbers them (5-8 are the sfx aliases) */
const CHANNEL_KIND = { 1: 'square', 2: 'square', 3: 'wave', 4: 'noise', 5: 'square', 6: 'square', 7: 'wave', 8: 'noise' };

/** the wave channel has four volume settings, not sixteen: off, full, half, quarter */
const WAVE_VOLUME = [0, 15, 8, 4];

const MAX_STEPS = 50_000; // a malformed jump must not spin forever
const MAX_SECONDS = 120;

/** rgbasm numbers: $hex, %binary, decimal, or a label to be resolved later */
const number = (token) => {
  const t = token.trim();
  if (/^-?\$[0-9a-f]+$/i.test(t)) return (t.startsWith('-') ? -1 : 1) * parseInt(t.replace(/^-?\$/, ''), 16);
  if (/^-?%[01]+$/.test(t)) return (t.startsWith('-') ? -1 : 1) * parseInt(t.replace(/^-?%/, ''), 2);
  return /^-?\d+$/.test(t) ? Number(t) : t;
};

/**
 * Parse assembly into a flat command list plus a label index. `.local` labels are qualified with
 * the global label above them, so two songs can both have a `.loop` without colliding.
 * Several files can be parsed into one program by passing the previous result back in.
 * @returns {{cmds: Array<{cmd: string, args: Array<string|number>}>, labels: Map<string, number>}}
 */
export function parseAsm(text, into = { cmds: [], labels: new Map() }) {
  let global = '';
  let pending = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    if (!line) continue;

    const label = /^(\.?[A-Za-z_][\w.]*):{0,2}$/.exec(line);
    if (label && (line.endsWith(':') || line.startsWith('.'))) {
      const name = label[1].startsWith('.') ? `${global}${label[1]}` : label[1];
      if (!label[1].startsWith('.')) global = label[1];
      pending.push(name);
      continue;
    }

    const [cmd, ...rest] = line.split(/\s+/);
    const args = rest.join(' ').split(',').filter((a) => a.trim()).map((a) => {
      const value = number(a);
      return typeof value === 'string' && value.startsWith('.') ? `${global}${value}` : value;
    });
    for (const name of pending) into.labels.set(name, into.cmds.length);
    pending = [];
    into.cmds.push({ cmd, args });
  }
  return into;
}

/** pitch + octave -> Hz. The period is 2048 minus the GB frequency register; the wave channel is an octave down. */
const hzFor = (semitone, octave, isWave) => {
  const note = ((semitone % 12) + 12) % 12;
  const oct = Math.min(8, Math.max(1, octave + Math.floor(semitone / 12)));
  const period = -(FREQUENCIES[note] >> (oct - 1));
  return (isWave ? 65536 : 131072) / Math.max(1, period);
};

const round3 = (note) => Object.fromEntries(
  Object.entries(note).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v]),
);

/**
 * Run one channel from `start` until it returns, loops back, or hits a limit.
 * @returns {{notes: object[], end: number, loop: boolean}} end is in frames
 */
function runChannel({ cmds, labels }, start, kind, song) {
  const ch = { speed: 1, octave: 4, volume: 15, fade: 0, duty: 2, transpose: 0 };
  const notes = [];
  const callStack = [];
  const loopCounters = new Map();
  let pc = start;
  let frame = 0;
  let loops = false;

  const labelAt = (name) => {
    if (!labels.has(name)) throw new Error(`no such label: ${name}`);
    return labels.get(name);
  };
  const push = (note) => notes.push(round3(note));

  for (let steps = 0; steps < MAX_STEPS && pc < cmds.length && frame / FPS < MAX_SECONDS; steps++) {
    const { cmd, args } = cmds[pc];
    pc++;

    switch (cmd) {
      // a sound effect names its pitch as a raw register value
      case 'square_note': case 'noise_note': {
        const [length, volume, fade, pitch] = args;
        const frames = length + 1;
        push(cmd === 'noise_note'
          ? { t: frame / FPS, d: frames / FPS, v: volume, f: fade, n: pitch }
          : { t: frame / FPS, d: frames / FPS, hz: 131072 / Math.max(1, 2048 - (pitch & 0x7ff)), v: volume, f: fade, duty: ch.duty });
        frame += frames;
        break;
      }

      // music names a note, and its length is scaled by the channel's speed and the song's tempo
      case 'note': case 'drum_note': case 'rest': {
        const [pitch, length] = cmd === 'rest' ? [0, args[0]] : args;
        const frames = (length * ch.speed * song.tempo) / 256;
        const semitone = typeof pitch === 'number' ? pitch : SEMITONES[pitch];
        if (cmd !== 'rest' && semitone !== undefined && frames > 0) {
          if (kind === 'noise') push({ t: frame / FPS, d: frames / FPS, v: ch.volume, f: ch.fade, drum: semitone });
          else push({
            t: frame / FPS,
            d: frames / FPS,
            hz: hzFor(semitone + ch.transpose, ch.octave, kind === 'wave'),
            v: kind === 'wave' ? WAVE_VOLUME[ch.volume & 3] : ch.volume,
            f: kind === 'wave' ? 0 : ch.fade,
            duty: ch.duty,
          });
        }
        frame += frames;
        break;
      }

      case 'note_type': case 'drum_speed':
        ch.speed = args[0];
        if (args.length >= 3) { ch.volume = args[1]; ch.fade = args[2]; }
        break;
      case 'octave': ch.octave = args[0]; break;
      case 'transpose': ch.transpose = args[0] * 12 + args[1]; break;
      case 'tempo': song.tempo = args[0]; break; // shared: one channel sets the tempo for all
      case 'duty_cycle': ch.duty = args[0] & 3; break;
      case 'volume_envelope': ch.volume = args[0]; ch.fade = args[1]; break;

      case 'sound_call': callStack.push(pc); pc = labelAt(args[0]); break;
      case 'sound_ret':
        if (!callStack.length) return { notes, end: frame, loop: loops };
        pc = callStack.pop();
        break;

      case 'sound_jump': {
        const to = labelAt(args[0]);
        // jumping backwards is a song's loop: record it and stop, having played through once
        if (to < pc) return { notes, end: frame, loop: true };
        pc = to;
        break;
      }

      case 'sound_loop': {
        const [count, label] = args;
        if (count === 0) return { notes, end: frame, loop: true }; // loop forever
        const site = pc - 1;
        const left = loopCounters.has(site) ? loopCounters.get(site) : count - 1;
        if (left > 0) { loopCounters.set(site, left - 1); pc = labelAt(label); } else loopCounters.delete(site);
        break;
      }

      default: // vibrato, panning, pitch sweeps and the rest change the timbre, not which notes play
    }
  }
  return { notes, end: frame, loop: loops };
}

/**
 * Compile one Sfx_ or Music_ label into channels of notes.
 * @returns {{channels: Array<{kind: string, notes: object[]}>, length: number, loop: boolean}}
 */
export function compileSound(asm, name) {
  if (!asm.labels.has(name)) throw new Error(`no sound called ${name}`);
  const head = asm.labels.get(name);
  if (asm.cmds[head]?.cmd !== 'channel_count') throw new Error(`${name} has no channel_count`);

  // take exactly channel_count channels: the header of the next sound usually follows immediately
  const count = asm.cmds[head].args[0];
  const headers = asm.cmds.slice(head + 1, head + 1 + count).filter((c) => c.cmd === 'channel').map((c) => c.args);

  const song = { tempo: 256 }; // one frame per length unit, until a `tempo` says otherwise
  const channels = headers.map(([number_, label]) => ({
    kind: CHANNEL_KIND[number_],
    ...runChannel(asm, asm.labels.get(label), CHANNEL_KIND[number_], song),
  }));

  return {
    channels: channels.map(({ kind, notes }) => ({ kind, notes })),
    length: Math.round((Math.max(0, ...channels.map((c) => c.end)) / FPS) * 1000) / 1000,
    loop: channels.some((c) => c.loop),
  };
}

/** what the game plays, and which of Crystal's own sounds it plays for it (see web/js/audio.mjs) */
export const SOUNDS = {
  waiting: 'Sfx_Call', // the Pokégear ringing: a session needs you
  done: 'Sfx_Save', // the save chime: it finished and reported
  working: 'Sfx_Menu',
  resting: 'Sfx_BallPoof',
  level: 'Sfx_LevelUp',
  badge: 'Sfx_GetBadge',
  egg: 'Sfx_GetEgg',
  join: 'Sfx_KeyItem',
  evolving: 'Music_Evolution', // the theme, looped while the silhouettes flash
  evolved: 'Sfx_CaughtMon', // what Crystal's own evolve.asm plays at the reveal
  goal: 'Sfx_ThrowBall',
  sent: 'Sfx_Item',
  legend: 'Sfx_Shine',
  wrong: 'Sfx_Wrong',
};

/** compile every sound the game uses, from a pokecrystal checkout -> { event: timeline } */
export function buildSounds(root) {
  const asm = parseAsm(fs.readFileSync(path.join(root, 'audio', 'sfx.asm'), 'utf8'));
  parseAsm(fs.readFileSync(path.join(root, 'audio', 'sfx_crystal.asm'), 'utf8'), asm);
  parseAsm(fs.readFileSync(path.join(root, 'audio', 'music', 'evolution.asm'), 'utf8'), asm);
  return Object.fromEntries(
    Object.entries(SOUNDS).map(([event, name]) => [event, { name, ...compileSound(asm, name) }]),
  );
}
