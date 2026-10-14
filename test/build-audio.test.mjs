import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { SOUNDS, buildSounds, compileSound, parseAsm } from '../src/build/audio.mjs';

/** within a couple of percent: these are frequencies, not integers */
const near = (actual, expected, tolerance = 0.02) => Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));

// a sound effect: pitches given as raw register values, one pulse channel and one noise channel
const BEEP = `
Sfx_Beep:
	channel_count 2
	channel 5, Sfx_Beep_Ch5
	channel 8, Sfx_Beep_Ch8

Sfx_Beep_Ch5:
	duty_cycle 2
	square_note 2, 15, 1, 1792
	square_note 14, 14, -3, 1984
	sound_ret

Sfx_Beep_Ch8:
	noise_note 3, 10, 2, 17
	sound_ret
`;

// a tune: named notes, a tempo, a counted loop, a call, and a jump back to the top
const TUNE = `
Music_Tune:
	channel_count 2
	channel 1, Music_Tune_Ch1
	channel 3, Music_Tune_Ch3

Music_Tune_Ch1:
	tempo 128
	duty_cycle 1
	note_type 8, 11, 1
	octave 4
	note A_, 2
.loop
	note C_, 1
	sound_loop 3, .loop
	sound_call .sub
	sound_loop 0, Music_Tune_Ch1
.sub
	rest 2
	octave 5
	note A_, 4
	sound_ret

Music_Tune_Ch3:
	note_type 8, 2, 5
	octave 4
	note A_, 4
	sound_ret
`;

describe('parsing the assembly', () => {
  it('indexes global labels and qualifies the local ones under them', () => {
    const asm = parseAsm(TUNE);
    assert.ok(asm.labels.has('Music_Tune'));
    assert.ok(asm.labels.has('Music_Tune_Ch1.loop'), 'a .local label belongs to the label above it');
    assert.ok(asm.labels.has('Music_Tune_Ch1.sub'));
    assert.equal(asm.cmds[asm.labels.get('Music_Tune')].cmd, 'channel_count');
  });

  it('reads hex, binary and decimal arguments, and drops comments', () => {
    const asm = parseAsm('\tvolume_envelope $0f, %101 ; loud\n\toctave 4\n');
    assert.deepEqual(asm.cmds[0], { cmd: 'volume_envelope', args: [15, 5] });
    assert.deepEqual(asm.cmds[1], { cmd: 'octave', args: [4] });
  });

  it('merges several files into one program, so two songs can share a .loop', () => {
    const asm = parseAsm('A_Song:\n.loop\n\toctave 4\n');
    parseAsm('B_Song:\n.loop\n\toctave 5\n', asm);
    assert.ok(asm.labels.has('A_Song.loop') && asm.labels.has('B_Song.loop'));
    assert.notEqual(asm.labels.get('A_Song.loop'), asm.labels.get('B_Song.loop'));
  });
});

describe('compiling a sound effect', () => {
  const beep = compileSound(parseAsm(BEEP), 'Sfx_Beep');

  it('turns a register pitch into Hz and a length into seconds', () => {
    const [pulse] = beep.channels;
    assert.equal(pulse.kind, 'square');
    assert.equal(pulse.notes.length, 2);
    assert.ok(near(pulse.notes[0].hz, 131072 / (2048 - 1792)), `got ${pulse.notes[0].hz}`);
    assert.ok(near(pulse.notes[0].d, 3 / 60), 'a length of 2 lasts three frames');
    assert.ok(near(pulse.notes[1].t, 3 / 60), 'and the next note starts where it ended');
  });

  it('keeps the volume, the envelope direction and the duty cycle', () => {
    const [pulse] = beep.channels;
    assert.deepEqual([pulse.notes[0].v, pulse.notes[0].f, pulse.notes[0].duty], [15, 1, 2]);
    assert.equal(pulse.notes[1].f, -3, 'a rising envelope stays negative');
  });

  it('gives the noise channel its own kind and pitch code', () => {
    const noise = beep.channels[1];
    assert.equal(noise.kind, 'noise');
    assert.equal(noise.notes[0].n, 17, 'noise keeps the raw code: the player filters by it');
    assert.equal(noise.notes[0].hz, undefined);
  });

  it('measures the whole thing by its longest channel', () => {
    assert.ok(near(beep.length, 18 / 60));
    assert.equal(beep.loop, false, 'an effect that returns does not loop');
  });
});

describe('compiling a tune', () => {
  const tune = compileSound(parseAsm(TUNE), 'Music_Tune');
  const unit = (8 * 128) / 256 / 60; // note_type speed x tempo / 256, in seconds per length unit

  it('turns a named note and an octave into Hz', () => {
    const [pulse] = tune.channels;
    assert.ok(near(pulse.notes[0].hz, 880, 0.03), `A in octave 4: ${pulse.notes[0].hz}`);
    assert.ok(near(pulse.notes[0].d, 2 * unit), 'scaled by the channel speed and the tempo');
  });

  it('plays a counted loop the right number of times', () => {
    const [pulse] = tune.channels;
    const cs = pulse.notes.filter((n) => near(n.hz, pulse.notes[1].hz));
    assert.equal(cs.length, 3, 'sound_loop 3 plays its body three times');
  });

  it('follows a call, and the rest inside it costs time', () => {
    const last = tune.channels[0].notes.at(-1);
    assert.ok(near(last.hz, 1760, 0.03), 'the call changed octave on the way in');
    assert.ok(near(last.t, (2 + 3 + 2) * unit), 'two units, three looped notes, then a rest of two');
  });

  it('marks a song that loops, having played it through once', () => {
    assert.equal(tune.loop, true);
  });

  it('shares the tempo across channels, and sounds the wave channel an octave lower', () => {
    const wave = tune.channels[1];
    assert.equal(wave.kind, 'wave');
    assert.ok(near(wave.notes[0].hz, 440, 0.03));
    assert.ok(near(wave.notes[0].d, 4 * unit), 'the tempo set on channel 1 applies here too');
  });

  it('scales the wave channel volume to its four settings, not sixteen', () => {
    // the wave channel has codes 0-3 for off, full, half and quarter, so 2 means half of 15
    assert.equal(tune.channels[1].notes[0].v, 8);
    assert.equal(tune.channels[1].notes[0].f, 0, 'and no envelope: the wave channel has none');
  });
});

describe('refusing to guess', () => {
  it('a name it does not have fails loudly', () => {
    assert.throws(() => compileSound(parseAsm(BEEP), 'Sfx_Nope'), /Sfx_Nope/);
  });

  it('a label that is not a sound header fails loudly', () => {
    assert.throws(() => compileSound(parseAsm(BEEP), 'Sfx_Beep_Ch5'), /channel_count/);
  });

  it('a jump to a label that does not exist fails loudly', () => {
    const broken = 'Sfx_X:\n\tchannel_count 1\n\tchannel 5, Sfx_X_Ch5\n\nSfx_X_Ch5:\n\tsound_call Nowhere\n';
    assert.throws(() => compileSound(parseAsm(broken), 'Sfx_X'), /Nowhere/);
  });
});

const CRYSTAL = new URL('../.cache/pokecrystal', import.meta.url);
describe('against the real sound source', { skip: !fs.existsSync(CRYSTAL) && 'assets not fetched: run npm run setup' }, () => {
  it('compiles every sound the game plays into audible notes', () => {
    const sounds = buildSounds(CRYSTAL.pathname);
    assert.deepEqual(Object.keys(sounds).sort(), Object.keys(SOUNDS).sort());

    for (const [event, sound] of Object.entries(sounds)) {
      assert.ok(sound.channels.length, `${event} has no channels`);
      const notes = sound.channels.flatMap((c) => c.notes);
      assert.ok(notes.length, `${event} compiled to silence`);
      assert.ok(sound.length > 0, `${event} has no length`);
      for (const note of notes) {
        assert.ok(note.d > 0, `${event} has a note of no length`);
        assert.ok(note.hz === undefined || (note.hz > 20 && note.hz < 20_000), `${event} has a note at ${note.hz} Hz`);
      }
    }
    assert.equal(sounds.evolving.loop, true, 'the evolution theme plays until the reveal');
    assert.ok(sounds.waiting.length < 5, 'the Pokégear ring is short enough to be a notification');
  });
});
