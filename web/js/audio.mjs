// Crystal's own sounds, played the way the Game Boy made them: pulse waves with a duty cycle, a
// triangle for the wave channel, filtered noise for drums, and volume envelopes that step every
// fade/64 of a second. The timelines come from /assets/sounds.json, compiled at setup by
// src/build/audio.mjs, so nothing here has to understand the sound engine's format.
//
// Browsers keep audio muted until the page has been interacted with, so the first key or click
// unlocks it. N turns sound off, and that choice is remembered in this browser.
const STORAGE_KEY = 'pokemon-agents:sound';
const MASTER_GAIN = 0.12; // square waves are loud
const DUTY_CYCLES = [0.125, 0.25, 0.5, 0.75];
const ENVELOPE_STEPS = 15;

const remembered = () => { try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; } };
const remember = (on) => { try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* private mode: not remembered */ } };

export class Audio {
  constructor() {
    this.on = remembered();
    this.data = null;
    this.ctx = null;
    this.lastPlayed = {};
    fetch('/assets/sounds.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { this.data = data; })
      .catch(() => {}); // no sounds is quiet, not broken
  }

  /** call this from a key or click handler: before that, a browser will not let us make a sound */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = MASTER_GAIN;
        this.master.connect(this.ctx.destination);
        this.pulses = DUTY_CYCLES.map((duty) => this.pulseWave(duty));
        this.noise = this.noiseBuffer();
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  toggle() {
    this.on = !this.on;
    remember(this.on);
    return this.on;
  }

  /**
   * Play the sound for a game event (the names are in SOUNDS, src/build/audio.mjs).
   * @param {{minGap?: number}} [opts] minGap: skip if this event played less than that long ago,
   *   because status changes can arrive in bursts and a burst of phone rings is just noise.
   * @returns {{stop: () => void}|null}
   */
  play(event, { minGap = 0 } = {}) {
    const sound = this.data?.[event];
    if (!this.on || !this.ctx || this.ctx.state !== 'running' || !sound) return null;

    const now = performance.now();
    if (minGap && now - (this.lastPlayed[event] ?? -Infinity) < minGap) return null;
    this.lastPlayed[event] = now;

    const sources = [];
    let playing = true;
    const run = () => {
      if (!playing) return;
      const at = this.ctx.currentTime + 0.02; // a beat of headroom, so nothing is scheduled late
      for (const channel of sound.channels) {
        for (const note of channel.notes) sources.push(this.note(channel.kind, note, at));
      }
      // a song (the evolution theme) goes round until something stops it
      if (sound.loop) setTimeout(run, sound.length * 1000);
    };
    run();

    return {
      stop: () => {
        playing = false;
        for (const source of sources) {
          try { source.stop(); } catch { /* already finished */ }
        }
      },
    };
  }

  /** one note: an oscillator or a burst of noise, under a Game Boy volume envelope */
  note(kind, note, at) {
    const { ctx } = this;
    const start = at + note.t;
    const end = start + note.d;

    const gain = ctx.createGain();
    gain.connect(this.master);
    gain.gain.setValueAtTime((note.v ?? ENVELOPE_STEPS) / ENVELOPE_STEPS, start);
    // the envelope steps one fifteenth every |fade|/64 s, down when fade is positive and up when not
    if (note.f) {
      const step = Math.abs(note.f) / 64;
      let level = note.v;
      for (let i = 1; i <= ENVELOPE_STEPS && start + i * step < end; i++) {
        level = note.f > 0 ? Math.max(0, level - 1) : Math.min(ENVELOPE_STEPS, level + 1);
        gain.gain.setValueAtTime(level / ENVELOPE_STEPS, start + i * step);
      }
    }
    gain.gain.setValueAtTime(0, end);

    let source;
    if (kind === 'noise') {
      source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      // a drum has its own pitch; a noise note's shift code makes it duller the higher it goes
      filter.frequency.value = note.drum !== undefined
        ? 6000 - note.drum * 300
        : Math.max(300, 12000 / (1 + ((note.n ?? 0) >> 4)));
      source.connect(filter).connect(gain);
    } else {
      source = ctx.createOscillator();
      if (kind === 'wave') source.type = 'triangle';
      else source.setPeriodicWave(this.pulses[note.duty ?? 2]);
      source.frequency.setValueAtTime(note.hz, start);
      source.connect(gain);
    }

    source.start(start);
    source.stop(end + 0.01);
    return source;
  }

  /** a pulse wave of a given duty cycle, as Fourier terms */
  pulseWave(duty) {
    const terms = 64;
    const real = new Float32Array(terms);
    const imaginary = new Float32Array(terms);
    for (let k = 1; k < terms; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    return this.ctx.createPeriodicWave(real, imaginary);
  }

  /** a second of white noise, looped and filtered into drums */
  noiseBuffer() {
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return buffer;
  }
}
