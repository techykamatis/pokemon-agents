// Boot, input and the game loop. The overworld itself is in actors.mjs; the screens are in
// screens.mjs, panels.mjs and timeline.mjs. Read-only by nature: the game watches your sessions,
// and only ever acts when you ask it to.
import { DIRS, Overworld, Sprites } from './actors.mjs';
import { Audio } from './audio.mjs';
import { Bridge } from './bridge.mjs';
import { City, SQUARE, period } from './city.mjs';
import { Font, H, W, frameDrawer } from './pixels.mjs';
import { answerScreen, goalsScreen, legendScreen, newGoal } from './panels.mjs';
import {
  DexCard, EvolutionScene, STATUS, TrainerCard, dexList, goToTerminal, helpScreen, inApp, itemName,
  sessionRecap, sessionSummary, sessionsScreen, soundTest,
} from './screens.mjs';
import { timelineScreen, unseenCount } from './timeline.mjs';
import { UI } from './widgets.mjs';

const gameCanvas = document.getElementById('game');
const overlayCanvas = document.getElementById('overlay');
const ctx = gameCanvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const assetUrl = (file) => `/assets/${file}`;

// --- boot ----------------------------------------------------------------------------------------
const [worldJson, dexJson] = await Promise.all([
  fetch(assetUrl('world.json')).then((res) => res.json()),
  fetch(assetUrl('pokedex.json')).then((res) => res.json()),
]);

const sprites = await Sprites.load(worldJson, assetUrl);
const city = new City(worldJson, sprites.images.tileset, sprites.images.roof);
const ui = new UI({
  font: new Font(sprites.images.font, worldJson.charmap),
  frame: frameDrawer(sprites.images.frame),
  overlay: overlayCanvas,
});
const dex = { ...dexJson, byId: new Map(dexJson.species.map((s) => [s.id, s])) };

const audio = new Audio();
const bridge = new Bridge(onBridgeMessage);
const overworld = new Overworld({ city, sprites, bridge });

/** the context every screen is handed: what to read, what to draw with, and how to act */
const game = {
  bridge,
  ui,
  dex,
  audio,
  sprites,
  /** where on the map a session is, and so what kind of work it is doing */
  place: (session) => city.stations[session.station]?.label ?? '',
  goTo: (id) => {
    while (ui.busy) ui.pop(); // get out of the menus, so you can watch yourself walk
    overworld.walkTo(id);
  },
};

const folderName = (project) => (project ? project.split('/').filter(Boolean).pop() : '?');
const nameOf = (project) => bridge.progress?.mons[project]?.nickname ?? folderName(project).toUpperCase();
const speciesName = (id) => dex.byId.get(id)?.name.toUpperCase();
const monSpecies = (mon) => (mon ? speciesName(mon.species) : 'POKé BALL');

// --- talking to things ---------------------------------------------------------------------------
function talkTo(sessionId) {
  const session = overworld.sessionAt(sessionId);
  if (!session) return;
  const mon = bridge.monOf(session);

  const doing = `${game.place(session)}${session.status === 'working' && session.activity ? `: ${session.activity.tool} ${session.activity.target}` : ''}`;
  // a stand-in should say whose helper it is, rather than pretend to be the project
  const who = session.look && mon && session.look !== mon.species
    ? `${speciesName(session.look)}, for ${nameOf(session.project)}`
    : `${nameOf(session.project)} the ${monSpecies(mon)} :L${mon?.level ?? '?'}`;
  const lines = [
    who,
    `${STATUS[session.status]}: ${doing}`,
    ...(session.branch ? [`BRANCH ${session.branch}`] : []),
    session.title ?? '',
    ...(session.subagents ? [`+${session.subagents} subagents helping`] : []),
  ];

  ui.say(lines.join('\n'), () => {
    ui.menu([
      ...(session.status === 'waiting' ? [{ label: 'ANSWER', onPick: () => answerScreen(game, session) }] : []),
      { label: 'SUMMARY', onPick: () => sessionSummary(game, session) },
      { label: 'RECAP', onPick: () => sessionRecap(game, session) },
      {
        label: inApp(session) ? 'OPEN APP' : session.app === 'GOAL' ? 'CONTINUE' : 'TERMINAL',
        onPick: () => goToTerminal(game, session.id),
      },
      ...(mon ? [{ label: 'POKéMON', onPick: () => ui.push(new DexCard(game, session.project, session.look)) }] : []),
      ...(mon ? [{ label: 'NEW GOAL', onPick: () => newGoal(game, session.project) }] : []),
      { label: 'CANCEL' },
    ], { title: folderName(session.project).toUpperCase().slice(0, 12) });
  });
}

/** each sign says what its building means, and who is there right now */
const whoIsHere = (station) => {
  const names = bridge.sessions
    .filter((s) => s.station === station && s.status !== 'resting')
    .map((s) => s.name.toUpperCase());
  if (!names.length) return '';
  return `\nHERE: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
};

const SIGNS = {
  VioletCitySign: () => {
    const all = bridge.sessions;
    ui.say(`VIOLET CITY\n${all.filter((s) => s.status === 'working').length} working, ${bridge.waiting.length} need you, ${all.length} live.`);
  },
  VioletCityPokecenterSign: () => {
    const team = bridge.progress?.team;
    ui.say(`POKéMON CENTER: git and GitHub. ${team?.commits ?? 0} commits, ${team?.merges ?? 0} merges so far.${whoIsHere('mergestation')}`);
  },
  VioletGymSign: () => {
    const team = bridge.progress?.team;
    ui.say(`VIOLET GYM: tests. ${team?.testsGreen ?? 0} green runs, ${team?.fixes ?? 0} red-to-green fixes.${whoIsHere('testbench')}`);
  },
  EarlsPokemonAcademySign: () => ui.say(`EARL'S ACADEMY: sessions reading, searching and planning study here.${whoIsHere('library')}`),
  SproutTowerSign: () => {
    const count = (status) => bridge.goals.filter((g) => g.status === status).length;
    ui.say(`SPROUT TOWER: goals. ${count('running')} running, ${count('done')} done. Finished goals report here.${whoIsHere('tower')}`);
  },
  VioletCityMartSign: () => ui.say(`POKéMART: sessions running other shell commands shop here.${whoIsHere('terminal')}`),
};

function interact() {
  const facing = overworld.facing();
  if (!facing) return;
  if (facing.kind === 'session') talkTo(facing.id);
  else if (facing.kind === 'legend') legendScreen(game, facing.id);
  else if (facing.kind === 'sign') SIGNS[facing.id]?.();
}

/** the Pokégear town map: the whole city at half scale, with everyone where they are */
class TownMap {
  constructor() { this.overlay = true; }

  key(key, ev, host) {
    if (key === 'B' || key === 'A' || ev?.key === 'm' || ev?.key === 'M') host.pop(this);
  }

  draw(c, host) {
    // the city is drawn at half size; 96 skips the border blocks the overlay has no room for
    c.drawImage(city.layer(period()), 96, 96, 640, 576, 0, 0, 320, 288);

    for (const [id, walker] of overworld.walkers) {
      const session = overworld.sessionAt(id);
      if (!session) continue;
      // three-quarter size: neighbours stay apart, and each is still recognisable
      c.drawImage(overworld.monFrame(session, walker, host.tick), walker.px / 2 - 2, walker.py / 2 - 6, 12, 12);
      if (session.status === 'waiting' && (host.tick >> 4) % 2) {
        c.drawImage(sprites.emote('shock'), walker.px / 2 - 2, walker.py / 2 - 18, 12, 12);
      }
    }
    for (const [species, walker] of overworld.roamers) {
      const frames = sprites.walkerFrames(Number(species), false);
      if (frames) c.drawImage(frames[0], walker.px / 2 - 4, walker.py / 2 - 10);
    }
    c.drawImage(overworld.playerFrame('day'), overworld.player.px / 2 - 4, overworld.player.py / 2 - 10);

    host.frame(c, 0, 0, 40, 3);
    const needed = bridge.waiting.length ? `  !${bridge.waiting.length} NEED YOU` : '';
    host.text(c, `POKéGEAR MAP  ${bridge.sessions.length} LIVE${needed}`.slice(0, 38), 8, 8);
  }
}

function startMenu() {
  const waiting = bridge.waiting.length;
  const unread = unseenCount(game);
  ui.menu([
    { label: `SESSIONS${waiting ? ` !${waiting}` : ''}`, color: waiting ? 'red' : undefined, onPick: () => sessionsScreen(game) },
    { label: `TIMELINE${unread ? ` ${unread}` : ''}`, onPick: () => timelineScreen(game) },
    { label: 'MAP', onPick: () => ui.push(new TownMap()) },
    { label: 'PARTY', onPick: () => dexList(game) },
    { label: 'PC BOX', onPick: () => dexList(game, { all: true }) },
    { label: 'TRAINER', onPick: () => ui.push(new TrainerCard(game)) },
    { label: `GOALS${bridge.goals.some((g) => g.status === 'running') ? ' *' : ''}`, onPick: () => goalsScreen(game) },
    { label: 'SOUND TEST', onPick: () => soundTest(game) },
    { label: 'HELP', onPick: () => helpScreen(game) },
    { label: 'EXIT' },
  ], { y: 0, w: 10 });
}

// --- the HUD -------------------------------------------------------------------------------------
let hudOn = true;

function drawHud(tick) {
  if (ui.busy) return;
  if (!bridge.online) {
    ui.frame(ctx, 0, 0, 20, 3);
    ui.text(ctx, 'BRIDGE OFFLINE...', 8, 8, 'red');
    return;
  }
  if (bridge.scanning) {
    const done = Math.floor((bridge.scanning.done / Math.max(1, bridge.scanning.files)) * 100);
    ui.frame(ctx, 0, 0, 20, 3);
    ui.text(ctx, `SCANNING ${done}%`, 8, 8);
    return;
  }

  if (hudOn) {
    const working = bridge.sessions.filter((s) => s.status === 'working').length;
    const label = `LIVE ${working}/${bridge.sessions.length}`;
    ui.frame(ctx, 0, 0, label.length + 2, 3);
    ui.text(ctx, label, 8, 8);
  }

  const blinking = (tick >> 5) % 2;
  const waiting = bridge.waiting.length;
  if (waiting) {
    ui.frame(ctx, 15, 0, 5, 3);
    ui.text(ctx, blinking ? `!${waiting}` : `D:${waiting}`, 128, 8, blinking ? 'red' : 'dark');
  }
  const unread = unseenCount(game);
  if (unread) {
    ui.frame(ctx, 0, 15, 6, 3);
    ui.text(ctx, `H:${Math.min(unread, 99)}`, 8, 128, 'blue');
  }
  const waitingMilestones = milestonesWaiting();
  if (waitingMilestones) {
    ui.frame(ctx, 15, 15, 5, 3);
    ui.text(ctx, `★${waitingMilestones}`, 128, 128, blinking ? 'blue' : 'dark');
  }
}

// --- things that happened ------------------------------------------------------------------------
const pending = [];

/**
 * A session that has newly started asking you something pops its question up as soon as you are
 * out of the menus. Ids already waiting when the page loaded are treated as seen, so a reload does
 * not reopen every one of them at you.
 */
let alreadyAsked = null;
function popNewDecisions() {
  if (!bridge.loaded || bridge.scanning) return;
  const waiting = bridge.waiting;
  if (!alreadyAsked) { alreadyAsked = new Set(waiting.map((s) => s.id)); return; }
  // answered: it may legitimately ask again later
  for (const id of alreadyAsked) if (!waiting.some((s) => s.id === id)) alreadyAsked.delete(id);
  const fresh = waiting.find((s) => !alreadyAsked.has(s.id));
  if (fresh && !ui.busy) {
    alreadyAsked.add(fresh.id);
    answerScreen(game, fresh);
  }
}

// One sound per update, the most important of whatever changed: the phone for a session needing
// you, the save chime for one that finished, a blip for one starting work, the ball for one going
// away. Nothing plays for the first list, or a page load would be a fanfare.
const SOUND_PRIORITY = ['waiting', 'done', 'resting', 'working'];
let lastStatuses = null;
let lastAlerts = new Set();

function playStatusSounds() {
  const now = new Map(bridge.sessions.map((s) => [s.id, s.status]));
  const alerts = new Set(Object.entries(bridge.legends ?? {}).filter(([, l]) => l.alert).map(([id]) => id));

  if (lastStatuses && !bridge.scanning) {
    const changed = [...now]
      // a session we have never seen only counts if it arrived already needing you
      .filter(([id, status]) => lastStatuses.get(id) !== status && (lastStatuses.has(id) || status === 'waiting'))
      .map(([, status]) => status);
    for (const id of lastStatuses.keys()) if (!now.has(id)) changed.push('resting'); // it left the map

    const loudest = SOUND_PRIORITY.find((status) => changed.includes(status));
    if (loudest) audio.play(loudest, { minGap: loudest === 'working' ? 5000 : 1500 });
    if ([...alerts].some((id) => !lastAlerts.has(id))) audio.play('legend', { minGap: 10_000 });
  }

  lastStatuses = now;
  lastAlerts = alerts;
}

function onBridgeMessage(message) {
  if (message.type === 'milestones') {
    for (const event of message.events) {
      // a burst of level-ups for one Pokémon is one box, at the level it ended on
      if (event.kind === 'level') {
        const already = pending.findIndex((p) => p.kind === 'level' && p.agentId === event.agentId);
        if (already >= 0) pending.splice(already, 1);
      }
      pending.push(event);
    }
  }
  if (message.type === 'sessions') playStatusSounds();
}

// Milestones are for witnessing: they play only while this page is in front, each waits for A, and
// while you are away they queue in order and the tab title says how many are waiting.
const MILESTONES = new Set(['evolve', 'badge', 'achievement', 'join', 'hatch', 'level']);
const watching = () => document.visibilityState === 'visible' && document.hasFocus();
const milestonesWaiting = () => pending.filter((e) => MILESTONES.has(e.kind)).length;

function playPending() {
  if (ui.busy || !pending.length) return;
  // while you are away only the minor notices go by; the milestones wait for you
  const at = watching() ? 0 : pending.findIndex((e) => !MILESTONES.has(e.kind));
  if (at < 0) return;
  const [event] = pending.splice(at, 1);

  const sfx = { badge: 'badge', hatch: 'egg', join: 'join', level: 'level' }[event.kind]
    ?? (event.kind === 'achievement' && event.egg ? 'egg' : null);
  if (sfx) audio.play(sfx, { minGap: 1500 }); // an evolution plays its own, from its scene

  const released = event.legendary ? `\n${speciesName(event.legendary)} appeared in VIOLET CITY!` : '';
  const got = (item) => (item ? `\nGot ${itemName(item)}!` : '');

  switch (event.kind) {
    case 'evolve':
      sprites.loadMon(event.from);
      sprites.loadMon(event.to);
      ui.push(new EvolutionScene(game, event));
      break;
    case 'badge':
      ui.say(`${nameOf(event.agentId)} earned the ${event.name}! (${event.why})${got(event.item)}${released}`);
      break;
    case 'achievement':
      ui.say(event.egg
        ? `Huh? You found an EGG! (${event.why})`
        : `${event.name}! (${event.why})${got(event.item)}${released}`);
      break;
    case 'join':
      ui.say(`A wild ${speciesName(event.species)} appeared! It's ${nameOf(event.agentId)}!${event.shiny ? ' ★SHINY★' : ''}`);
      break;
    case 'hatch':
      ui.say(`Huh? The EGG hatched into ${speciesName(event.species)}! It's ${nameOf(event.agentId)}!`);
      break;
    case 'level':
      ui.say(`${nameOf(event.agentId)} grew to level ${event.level}!`);
      break;
    case 'trade':
      ui.toast(`${nameOf(event.agentId)} sent out a subagent!`);
      break;
    case 'scanned':
      ui.toast(`Read ${event.files} transcripts: ${event.projects} POKéMON in your PC.`);
      break;
    default:
  }
}

// the tab title is how it calls you back: (!needs-you ★milestones) whenever anything is waiting.
// On a timer rather than in the frame loop, because a background tab stops being drawn.
let lastTitle = '';
setInterval(() => {
  const waiting = bridge.waiting.length;
  const milestones = milestonesWaiting();
  const counts = [waiting && `!${waiting}`, milestones && `★${milestones}`].filter(Boolean).join(' ');
  const title = `${counts ? `(${counts}) ` : ''}Pokémon Agents`;
  if (title !== lastTitle) { document.title = title; lastTitle = title; }
}, 1000);

// --- input ---------------------------------------------------------------------------------------
const KEYMAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  z: 'A', Z: 'A', ' ': 'A',
  x: 'B', X: 'B', Escape: 'B', Backspace: 'B',
  Enter: 'START', Shift: 'SELECT',
  PageUp: 'PGUP', PageDown: 'PGDN',
};
const held = new Set();

window.addEventListener('pointerdown', () => audio.unlock());

window.addEventListener('keydown', (ev) => {
  audio.unlock(); // browsers allow audio only after a key or a click

  // a text box wants every key, including the ones that are game controls everywhere else
  if (ui.top?.typing) {
    if (!ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); ui.top.key(null, ev, ui); }
    return;
  }
  if (ev.metaKey || ev.ctrlKey) return; // leave the browser's own shortcuts alone

  const key = KEYMAP[ev.key];
  if (key) ev.preventDefault();

  if (ui.busy) {
    if (key) ui.key(key, ev);
    else if (ev.key === 'm' || ev.key === 'M') ui.key(null, ev); // M closes the town map
    return;
  }

  if (Object.hasOwn(DIRS, key ?? '')) held.add(key);
  if (key === 'A') interact();
  if (key === 'START') startMenu();
  if (key === 'SELECT') hudOn = !hudOn;
  if (ev.key === 'd' || ev.key === 'D') sessionsScreen(game, { onlyWaiting: true });
  if (ev.key === 'm' || ev.key === 'M') ui.push(new TownMap());
  if (ev.key === 'h' || ev.key === 'H') timelineScreen(game);
  if (ev.key === 'n' || ev.key === 'N') ui.toast(audio.toggle() ? 'SOUND ON' : 'SOUND OFF');
});

window.addEventListener('keyup', (ev) => held.delete(KEYMAP[ev.key]));
window.addEventListener('paste', (ev) => {
  if (!ui.top?.typing) return;
  ev.preventDefault();
  ui.top.key(null, { type: 'paste', text: ev.clipboardData.getData('text') }, ui);
});
window.addEventListener('blur', () => held.clear()); // never keep walking after losing focus

// --- the loop ------------------------------------------------------------------------------------
/** scale the screen to a whole number of pixels, so nothing is ever drawn blurry */
function fit() {
  const scale = Math.max(1, Math.floor(Math.min(window.innerWidth / W, (window.innerHeight - 80) / H)));
  for (const element of [gameCanvas, overlayCanvas]) {
    element.style.width = `${W * scale}px`;
    element.style.height = `${H * scale}px`;
  }
}
window.addEventListener('resize', fit);
fit();

const FRAME_MS = 1000 / 60;
let tick = 0;
let previous = performance.now();
let behind = 0;

function frame(now) {
  // a fixed step, so walking is the same speed whatever the display does. Capped, so coming back to
  // a backgrounded tab catches up in a moment rather than fast-forwarding through everything.
  behind = Math.min(behind + (now - previous), 250);
  previous = now;

  while (behind >= FRAME_MS) {
    behind -= FRAME_MS;
    tick++;

    const walked = overworld.advance(held, ui.busy);
    if (walked?.arrived) talkTo(walked.arrived);
    else if (walked?.message) ui.say(walked.message);

    if (tick % 4 === 0) overworld.updateWalkers();
    if (tick % 30 === 0) popNewDecisions();
    overworld.updateRoamers(tick);
    playPending();
  }

  overworld.draw(ctx, tick, period());
  drawHud(tick);
  ui.draw(ctx);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// a handle for the e2e and demo runs to look at the live game through
window.__pokemonAgents = { game, overworld, city, ui, bridge };
