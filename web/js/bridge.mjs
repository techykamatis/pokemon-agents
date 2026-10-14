// The page's end of the bridge: live sessions, progression and the timeline, pushed over a local
// WebSocket, plus the handful of actions the game can ask for. It reconnects on its own, backing
// off, so restarting the bridge only means the game says BRIDGE OFFLINE for a moment.
const TIMELINE_KEEP = 300; // the bridge caps its log at the same number
const RETRY_START_MS = 500;
const RETRY_MAX_MS = 8000;

export class Bridge {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.online = false;
    this.loaded = false; // a first look at the sessions has arrived
    this.sessions = [];
    this.goals = [];
    this.legends = {};
    this.timeline = [];
    this.scanning = null;
    this.progress = null; // progression state: the Pokémon and the trainer
    this.dev = false;
    this.connect();
  }

  connect(delay = RETRY_START_MS) {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { this.online = true; };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    ws.onclose = () => {
      if (this.online) this.onMessage({ type: 'offline' });
      this.online = false;
      setTimeout(() => this.connect(Math.min(delay * 2, RETRY_MAX_MS)), delay);
    };
  }

  handle(message) {
    switch (message.type) {
      case 'sessions':
        this.sessions = message.sessions;
        this.goals = message.goals ?? [];
        this.legends = message.legends ?? {};
        this.scanning = message.scanning;
        this.loaded = true;
        break;
      case 'state':
        this.progress = message.state;
        this.dev = message.dev;
        break;
      case 'timeline':
        this.timeline = message.entries;
        break;
      case 'timeline.add':
        this.timeline = [...this.timeline, ...message.entries].slice(-TIMELINE_KEEP);
        break;
      default:
    }
    this.onMessage(message);
  }

  get waiting() { return this.sessions.filter((s) => s.status === 'waiting'); }

  /** the Pokémon of the project a session belongs to */
  monOf(session) { return this.progress?.mons[session.project]; }

  async post(route, body) {
    try {
      const res = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch {
      return { ok: false, error: 'Bridge offline.' };
    }
  }

  /** bring this session's terminal to the front, or carry a finished goal on in a new window */
  focus(id) { return this.post('/focus', { id }); }

  /** one session's last ask, reply, question and options, read on demand */
  recap(id) { return this.post('/recap', { id }); }

  /** send an answer; `now` stops a goal's live run so it goes out at once */
  answer(id, text, now = false) { return this.post('/answer', { id, text, now }); }
}
