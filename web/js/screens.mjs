// The full screens: a project's Pokédex card, the party and PC lists, the trainer card, the
// evolution scene, a session's summary and recap, the live session list, the sound test, a
// legendary's card, and the help screen.
//
// Every Pokémon is a project; every live session is that Pokémon at work.
import { TEXT_PAL, css, wrap } from './pixels.mjs';
import { answerScreen } from './panels.mjs';

const BADGE_ORDER = ['zephyr', 'hive', 'plain', 'fog', 'storm', 'mineral', 'glacier', 'rising'];
const BADGE_PALETTE = [[248, 248, 248], [248, 208, 64], [184, 112, 24], [40, 24, 8]];
const UNEARNED_PALETTE = [[248, 248, 248], [224, 224, 224], [200, 200, 200], [176, 176, 176]];

export const STATUS = { working: 'WORKING', waiting: 'NEEDS YOU', done: 'DONE', idle: 'IDLE', resting: 'RESTING' };
export const itemName = (slug) => slug.replace(/-/g, ' ').toUpperCase().replace('KINGS ROCK', "KING'S ROCK");

const folderName = (project) => (project ? project.split('/').filter(Boolean).pop() : '?');
const sinceWhen = (ts) => {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'now';
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
};

/** a session in the Claude desktop app has no tab to type into: you finish in the app */
const APP_ACTION = { 'claude-desktop': 'OPEN CLAUDE APP' };
export const inApp = (session) => Object.hasOwn(APP_ACTION, session.entry);
export const terminalLabel = (session) => APP_ACTION[session.entry]
  ?? (session.app === 'GOAL' ? 'CONTINUE IN TERMINAL' : 'GO TO TERMINAL');

/** is this session's Pokémon out on the map, so that walking to it could work? */
export const onMap = (game, id) => game.bridge.sessions.some((s) => s.id === id && s.status !== 'resting');

/** the session to walk to for a project: the one wearing its Pokémon, else any that is out */
const leadOf = (game, project) => {
  const out = game.bridge.sessions.filter((s) => s.project === project && s.status !== 'resting');
  return out.find((s) => s.look === game.bridge.progress?.mons[project]?.species) ?? out[0];
};

/** bring a session's terminal to the front, and say why if that cannot be done */
export async function goToTerminal(game, id) {
  const out = await game.bridge.focus(id);
  if (!out.ok) game.ui.say(out.error ?? 'Could not reach that terminal.');
}

/**
 * Fetch a session's recap once. The screens read `box.r` every frame, so one fills itself in the
 * moment the answer lands without anything having to tell it to.
 */
export function loadRecap(game, id) {
  const box = { r: null };
  game.bridge.recap(id).then((r) => { box.r = r; });
  return box;
}

/** a labelled paragraph on a PC screen, or nothing at all if there is nothing to say */
export const para = (label, text, color) => (text
  ? [{ text: label, color: 'gray' }, ...wrap(text, 37).map((line) => ({ text: ` ${line}`, color, noScroll: true })), { text: '' }]
  : []);

/** what it would take for this Pokémon to evolve next, one short line per way */
export function evolutionHints(dex, mon) {
  return dex.evolutions.filter((e) => e.from === mon.species).map((e) => {
    const into = dex.byId.get(e.to).name.toUpperCase();
    if (e.trigger === 'use-item') return `${itemName(e.item)}>${into}`;
    if (e.trigger === 'trade') return `SUBAGENT${e.heldItem ? `+${itemName(e.heldItem)}` : ''}>${into}`;
    const needs = [];
    if (e.minLevel) needs.push(`LV${e.minLevel}`);
    if (e.minHappiness) needs.push(`♥${e.minHappiness}`);
    if (e.timeOfDay) needs.push(e.timeOfDay === 'night' ? 'NITE' : 'DAY');
    if (e.relativePhysicalStats != null) needs.push(['TST', 'EQ', 'CMT'][e.relativePhysicalStats + 1]);
    return `${needs.join(' ')}>${into}`;
  });
}

/**
 * A project's card. Opened from a session wearing a stand-in, it shows the Pokémon you actually saw
 * on the map and says whose helper it is — but the level and the counters are the project's.
 */
export class DexCard {
  constructor(game, project, look = null) {
    this.game = game;
    this.project = project;
    this.look = look;
    this.page = 0;
  }

  key(key, ev, ui) {
    if (key === 'B') ui.pop(this);
    if (key === 'A' || key === 'RIGHT' || key === 'LEFT') this.page = (this.page + 1) % 2;
  }

  draw(ctx, ui) {
    const { game } = this;
    const mon = game.bridge.progress?.mons[this.project];
    ctx.fillStyle = css(TEXT_PAL[0]);
    ctx.fillRect(0, 0, 160, 144);
    if (!mon) { ui.text(ctx, 'NO DATA', 8, 8); return; }

    const isHelper = this.look && this.look !== mon.species;
    const shown = isHelper ? this.look : mon.species;
    const species = game.dex.byId.get(shown);
    const front = game.sprites.front(shown, !isHelper && mon.shiny);
    if (front) ctx.drawImage(front, 4, 4);

    ui.text(ctx, `No.${String(shown).padStart(3, '0')}`, 72, 8);
    ui.text(ctx, species.name.toUpperCase().slice(0, 10), 72, 20);
    ui.text(ctx, mon.nickname.slice(0, 10), 72, 32, 'blue');
    ui.text(ctx, `:L${mon.level}${mon.shiny ? ' ★' : ''}`, 72, 44);
    const live = game.bridge.sessions.filter((s) => s.project === this.project);
    ui.text(ctx, live.length ? `${live.length} LIVE` : 'IN PC', 72, 54, live.length ? 'green' : 'gray');

    ui.frame(ctx, 0, 8, 20, 10);
    if (this.page === 0) {
      const toNext = mon.level >= 100 ? 0 : (mon.level + 1) ** 3 - mon.xp;
      const hints = evolutionHints(game.dex, mon).slice(0, 2);
      const rows = [
        ...(isHelper ? [`HELPS ${game.dex.byId.get(mon.species).name.toUpperCase()}`] : []),
        `EXP ${mon.xp}`,
        `NEXT ${toNext} ♥${mon.friendship}`,
        `SESSIONS ${mon.sessions} DAYS ${mon.days.length}`,
        `TOOLS ${mon.toolCalls}`,
        `COMMITS ${mon.commits} MERGE ${mon.merges}`,
        `TESTS ${mon.testsGreen} SUBS ${mon.trades}`,
        ...hints,
      ];
      const firstHint = rows.length - hints.length;
      rows.slice(0, 8).forEach((row, i) => {
        const color = isHelper && i === 0 ? 'blue' : i >= firstHint ? 'green' : 'dark';
        ui.text(ctx, row.slice(0, 18), 8, 72 + i * 8, color);
      });
    } else {
      ui.text(ctx, folderName(mon.project).toUpperCase().slice(0, 18), 8, 72, 'gray');
      wrap(species.flavor, 18).slice(0, 6).forEach((line, i) => ui.text(ctx, line, 8, 84 + i * 8));
      if (mon.evolutions.length) ui.text(ctx, `EVOLVED ${mon.evolutions.length}x`, 8, 132, 'green');
    }
  }
}

/** PARTY: the projects with a live session. PC BOX: all of them, strongest first. */
export function dexList(game, { all = false } = {}) {
  const mons = game.bridge.progress?.mons ?? {};
  const live = new Set(game.bridge.sessions.map((s) => s.project));
  const projects = Object.keys(mons)
    .filter((project) => all || live.has(project))
    .sort((a, b) => mons[b].xp - mons[a].xp);

  if (!projects.length) {
    return game.ui.say(all ? 'The PC is empty. No Claude sessions found yet.' : 'No live sessions right now. Check the PC for everyone.');
  }

  return game.ui.menu(projects.map((project) => {
    const mon = mons[project];
    const card = () => game.ui.push(new DexCard(game, project));
    const lead = leadOf(game, project);
    return {
      label: `${mon.nickname.slice(0, 10).padEnd(10)} L${mon.level}`,
      color: live.has(project) ? 'dark' : 'gray',
      onPick: () => (lead
        ? game.ui.menu([
          { label: 'WALK TO IT', onPick: () => game.goTo(lead.id) },
          { label: 'CARD', onPick: card },
          { label: 'CANCEL' },
        ])
        : card()),
    };
  }), { x: 0, y: 0, w: 20, title: all ? `PC BOX - ${projects.length} POKéMON` : 'PARTY - LIVE NOW', keep: true });
}

/** the trainer card: what you have done across every project, your badges and your bag */
export class TrainerCard {
  constructor(game) { this.game = game; }

  key(key, ev, ui) { if (key === 'B' || key === 'A') ui.pop(this); }

  draw(ctx, ui) {
    const team = this.game.bridge.progress?.team;
    ctx.fillStyle = css([200, 216, 248]);
    ctx.fillRect(0, 0, 160, 144);

    ui.frame(ctx, 0, 0, 20, 6);
    ui.text(ctx, `SESSIONS ${team?.sessions ?? 0}`, 8, 8);
    ui.text(ctx, `COMMITS ${team?.commits ?? 0} DAYS ${team?.daysActive ?? 0}`, 8, 20);
    ui.text(ctx, `STREAK ${team?.streak ?? 0} BEST ${team?.bestStreak ?? 0}`, 8, 32);

    BADGE_ORDER.forEach((id, i) => {
      const earned = team?.badges.some((b) => b.id === id);
      const tile = this.game.sprites.badge(i, earned ? BADGE_PALETTE : UNEARNED_PALETTE);
      ctx.drawImage(tile, 8 + (i % 4) * 36, 52 + Math.floor(i / 4) * 22);
    });

    ui.frame(ctx, 0, 12, 20, 6);
    const bag = Object.entries(team?.bag ?? {}).filter(([, n]) => n > 0);
    const lines = [
      ...bag.map(([item, n]) => `${itemName(item).slice(0, 14)} x${n}`),
      ...(team?.eggs ? [`EGG x${team.eggs}`] : []),
    ];
    (lines.length ? lines : ['BAG IS EMPTY']).slice(0, 4).forEach((line, i) => ui.text(ctx, line, 8, 104 + i * 8));
  }
}

/** "What? X is evolving!" — the two silhouettes flash faster and faster, then the reveal. */
export class EvolutionScene {
  constructor(game, event, onDone) {
    this.game = game;
    this.event = event;
    this.onDone = onDone;
    this.frame = 0;
    this.mon = game.bridge.progress?.mons[event.agentId];
    this.nickname = this.mon?.nickname ?? folderName(event.agentId).toUpperCase();
    this.fromName = game.dex.byId.get(event.from).name.toUpperCase();
    this.toName = game.dex.byId.get(event.to).name.toUpperCase();
  }

  key(key, ev, ui) {
    if ((key === 'A' || key === 'B') && this.frame > 300) {
      this.music?.stop();
      ui.pop(this);
      this.onDone?.();
    }
  }

  draw(ctx, ui) {
    const { game, event } = this;
    this.frame++;
    // the same order Crystal's own evolve.asm uses: the theme while it flashes, then the fanfare
    if (this.frame === 61) this.music = game.audio?.play('evolving');
    if (this.frame === 261) { this.music?.stop(); game.audio?.play('evolved'); }

    ctx.fillStyle = css(TEXT_PAL[0]);
    ctx.fillRect(0, 0, 160, 144);

    const flashing = this.frame > 60 && this.frame <= 260;
    let showNew = this.frame > 260;
    if (flashing) {
      // the gap between flashes closes as it goes, which is what makes it feel like a struggle
      const gap = Math.max(2, Math.round(24 * (1 - (this.frame - 60) / 200)));
      showNew = Math.floor(this.frame / gap) % 2 === 1;
    }
    const species = showNew ? event.to : event.from;
    const image = flashing ? game.sprites.silhouette(species) : game.sprites.front(species, this.mon?.shiny);
    if (image) ctx.drawImage(image, 52, 16);

    ui.frame(ctx, 0, 12, 20, 6);
    const words = this.frame <= 260
      ? `What? ${this.nickname} is evolving!`
      : `Congratulations! Your ${this.fromName} evolved into ${this.toName}!`;
    wrap(words, 18).slice(0, 4).forEach((line, i) => ui.text(ctx, line, 8, 104 + i * 8));
    if (this.frame > 300 && (ui.tick >> 4) % 2) ui.text(ctx, '▼', 144, 136);
  }
}

/** SUMMARY: what the session is about, what you asked, what it needs, and what to do next */
export function sessionSummary(game, session) {
  const box = loadRecap(game, session.id);
  return game.ui.screen({
    title: `${session.name.toUpperCase()} - ${STATUS[session.status] ?? ''}`.slice(0, 39),
    footer: 'A:PICK B:BACK',
    rows: () => {
      const r = box.r;
      if (!r) return [{ text: 'LOADING...', color: 'gray' }];
      if (!r.ok) return [{ text: r.error ?? 'No recap.', color: 'red' }];

      const fallbackNext = session.status === 'waiting'
        ? 'Answer it in its terminal.'
        : session.status === 'done' ? 'Check the result, then give it the next task or close it.' : null;
      const inWhat = session.app && session.app !== 'TERMINAL' ? ` (in ${session.app})` : '';

      return [
        ...para('ABOUT', `${session.title ?? session.name}${inWhat}`),
        ...para('YOU ASKED', r.ask),
        ...para('IT NEEDS FROM YOU', r.cta, 'red'),
        ...para('RECOMMENDED NEXT', r.next ?? fallbackNext, 'green'),
        ...(session.status === 'working' ? [] : [{
          text: session.status === 'waiting' ? 'ANSWER: pick or type' : 'REPLY: give it the next step',
          color: session.status === 'waiting' ? 'red' : undefined,
          onPick: () => answerScreen(game, session),
        }]),
        { text: 'RECAP: the full last reply', onPick: () => sessionRecap(game, session, box) },
        ...(onMap(game, session.id) ? [{ text: 'WALK TO IT', onPick: () => game.goTo(session.id) }] : []),
        { text: terminalLabel(session), onPick: () => goToTerminal(game, session.id) },
      ];
    },
  });
}

/** RECAP: Claude's own away-summary if there is one, then its whole last reply */
export function sessionRecap(game, session, box = loadRecap(game, session.id)) {
  return game.ui.screen({
    title: `RECAP - ${session.name.toUpperCase()}`.slice(0, 39),
    footer: 'UP/DN:SCROLL B:BACK',
    rows: () => {
      const r = box.r;
      if (!r) return [{ text: 'LOADING...', color: 'gray' }];
      if (!r.ok) return [{ text: r.error ?? 'No recap.', color: 'red' }];
      return [...para('WHILE YOU WERE AWAY', r.recap, 'blue'), ...para('LAST REPLY', r.reply ?? 'No reply yet.')];
    },
  });
}

/** SESSIONS: every live session, the ones needing you first */
export function sessionsScreen(game, { onlyWaiting = false } = {}) {
  const order = { waiting: 0, working: 1, done: 2, idle: 3, resting: 4 };
  const colors = { waiting: 'red', working: 'green', done: 'blue', idle: 'dark', resting: 'gray' };

  return game.ui.screen({
    title: () => {
      const live = game.bridge.sessions.length;
      const waiting = game.bridge.waiting.length;
      return onlyWaiting ? `NEEDS YOU - ${waiting}` : `SESSIONS - ${live} LIVE, ${waiting} NEED YOU`;
    },
    footer: onlyWaiting ? 'A:SUMMARY B:BACK' : 'A:POKéMON B:BACK',
    rows: () => {
      const list = game.bridge.sessions
        .filter((s) => !onlyWaiting || s.status === 'waiting')
        .sort((a, b) => order[a.status] - order[b.status] || b.lastTs - a.lastTs);
      if (!list.length) return [{ text: onlyWaiting ? 'Nobody is waiting on you.' : 'No live sessions.', color: 'gray' }];

      return list.flatMap((session) => {
        const mon = game.bridge.monOf(session);
        const look = session.look ?? mon?.species;
        // a * marks a stand-in: this is not the project's own Pokémon
        const speciesLabel = look
          ? `${game.dex.byId.get(look).name.toUpperCase()}${mon && look !== mon.species ? '*' : ''}`
          : '?';
        const app = session.app && session.app !== 'TERMINAL' ? ` - ${session.app}` : '';
        const doing = session.status === 'working' && session.activity
          ? ` ${session.activity.tool} ${session.activity.target}`
          : '';

        return [
          {
            text: `${STATUS[session.status].padEnd(9)} ${session.name}${app}`.slice(0, 38),
            color: colors[session.status],
            noScroll: true,
            onPick: () => (onlyWaiting ? sessionSummary(game, session) : game.ui.menu([
              ...(onMap(game, session.id) ? [{ label: 'WALK TO IT', onPick: () => game.goTo(session.id) }] : []),
              { label: 'SUMMARY', onPick: () => sessionSummary(game, session) },
              ...(mon ? [{ label: 'POKéMON', onPick: () => game.ui.push(new DexCard(game, session.project, session.look)) }] : []),
              { label: 'CANCEL' },
            ], { title: session.name.toUpperCase().slice(0, 12) })),
          },
          { text: `  ${speciesLabel} L${mon?.level ?? '?'}  ${session.branch ?? ''}  ${sinceWhen(session.lastTs)}${session.subagents ? `  +${session.subagents} SUB` : ''}`, color: 'gray', noScroll: true },
          { text: `  ${session.title ?? ''}`.slice(0, 38), noScroll: true },
          { text: `  ${game.place(session)}${doing}`.slice(0, 38), color: 'blue', noScroll: true },
        ];
      });
    },
  });
}

/** SOUND TEST: every sound the game uses, what it is for, and A to hear it */
const SOUND_LABELS = {
  waiting: 'NEEDS YOU',
  done: 'DONE',
  working: 'WORKING',
  resting: 'BACK IN BALL',
  level: 'LEVEL UP',
  badge: 'BADGE',
  egg: 'EGG',
  join: 'NEW POKéMON',
  evolving: 'EVOLVING',
  evolved: 'EVOLVED',
  goal: 'GOAL STARTED',
  sent: 'ANSWER SENT',
  legend: 'LEGENDARY !',
  wrong: 'REFUSED',
};

export function soundTest(game) {
  let playing = null;
  return game.ui.screen({
    title: () => `SOUND TEST - ${game.audio.on ? 'ON' : 'OFF, N TURNS ON'}`,
    footer: 'A:PLAY B:BACK',
    onExit: () => playing?.stop(),
    rows: () => {
      const data = game.audio.data;
      if (!data) return [{ text: 'No sounds yet: run npm run setup.', color: 'red' }];
      return Object.entries(SOUND_LABELS).filter(([event]) => data[event]).map(([event, label]) => ({
        text: `${label.padEnd(13)} ${data[event].name.replace(/^(Sfx|Music)_/, '')}`.slice(0, 37),
        onPick: () => {
          playing?.stop();
          game.audio.unlock();
          playing = game.audio.play(event);
        },
      }));
    },
  });
}

/** a legendary's card: who it is, its job, who released it and when; page two is its Pokédex entry */
export class LegendCard {
  constructor(game, species) {
    this.game = game;
    this.species = species;
    this.page = 0;
  }

  key(key, ev, ui) {
    if (key === 'B') ui.pop(this);
    if (key === 'A' || key === 'RIGHT' || key === 'LEFT') this.page = (this.page + 1) % 2;
  }

  draw(ctx, ui) {
    const { game, species } = this;
    const legend = game.bridge.legends?.[species];
    const dexEntry = game.dex.byId.get(species);

    ctx.fillStyle = css(TEXT_PAL[0]);
    ctx.fillRect(0, 0, 160, 144);
    const front = game.sprites.front(species, false);
    if (front) ctx.drawImage(front, 4, 4);

    ui.text(ctx, `No.${String(species).padStart(3, '0')}`, 72, 8);
    ui.text(ctx, dexEntry.name.toUpperCase().slice(0, 10), 72, 20);
    ui.text(ctx, 'LEGENDARY', 72, 32, 'blue');
    if (legend) ui.text(ctx, legend.alert ? 'HAS NEWS!' : 'ON PATROL', 72, 44, legend.alert ? 'red' : 'green');

    ui.frame(ctx, 0, 8, 20, 10);
    if (this.page === 0 && legend) {
      const released = legend.released;
      const when = released?.ts
        ? new Date(released.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()
        : null;
      const rows = [
        [legend.job, 'blue'],
        [`HOME ${game.place({ station: legend.home })}`, 'dark'],
        ...(released ? [
          [`FROM ${released.by}`, 'dark'],
          ...wrap(released.why, 18).slice(0, 3).map((line) => [line, 'gray']),
          ...(when ? [[`ON ${when}`, 'dark']] : []),
          ...(released.project ? [[`IN ${folderName(released.project).toUpperCase()}`, 'dark']] : []),
        ] : []),
      ];
      rows.slice(0, 8).forEach(([text, color], i) => ui.text(ctx, text.slice(0, 18), 8, 72 + i * 8, color));
    } else {
      ui.text(ctx, (dexEntry.genus ?? '').toUpperCase().slice(0, 18), 8, 72, 'gray');
      wrap(dexEntry.flavor ?? '', 18).slice(0, 7).forEach((line, i) => ui.text(ctx, line, 8, 84 + i * 8));
    }
  }
}

/** START > HELP: what the game does and how to use it, on one screen you can scroll */
const HELP = [
  ['WHAT THIS IS', 'A non-commercial fan project inspired by the Pokémon games, not affiliated with Nintendo, Game Freak, Creatures or The Pokémon Company. Your Claude Code sessions, in the terminal and in the Claude app, live as Pokémon in Violet City. Each project is one Pokémon, kept for good: it levels up and evolves from what your sessions actually do.'],
  ['WHERE THEY GO', 'Every place means a kind of work: the house is editing, the Academy reading and planning, the Gym tests, the Pokémon Center git, the Mart other shell work, the trade house subagents, the Route 31 gate the web. Sprout Tower is where finished goals report. Anything done or idle rests in the park.'],
  ['STATUSES', 'WORKING: busy. NEEDS YOU: it asked you something, so it walks up to you with a ! and its question pops up. DONE: it finished and reported. IDLE or RESTING: quiet; after 30 minutes it goes back in its ball, and it leaves for good once its Claude exits.'],
  ['TALK (A)', 'Face a Pokémon and press A: ANSWER (pick an option or type one), SUMMARY (what you asked, what it needs, the next step), RECAP (its last reply in full), TERMINAL (jump to its tab, or open the Claude app), POKéMON (its card) and NEW GOAL.'],
  ['D: DECISIONS', 'Lists every session waiting on you. An answer is typed into its Terminal tab, or sent to a goal by resuming it. A picker, or a session in the Claude app, has to be answered there: the game shows you the question and opens it for you.'],
  ['GOALS', 'START > GOALS > NEW GOAL: pick a folder (in Finder, a new one under ~/code, a typed path, or one of your projects) and type the goal. An agent works on it in the background and shows up as a Pokémon, and it can ask you things like any other session. Up to 4 run at once; STOP ends one, and CONTINUE opens a finished one in a new Terminal window so you can keep talking to it.'],
  ['WALK TO IT', 'In SESSIONS, SUMMARY, GOALS, PARTY, the PC BOX and the timeline: walk straight over to that Pokémon and talk to it. Any arrow key cancels.'],
  ['LEGENDARIES', 'Badges release them, and each patrols a building with a job: Raikou red tests, Suicune uncommitted edits, Entei your streak, Lugia long runs, Ho-Oh today, Celebi a week and a month ago. A ! means it has something for you; talk to it.'],
  ['TIMELINE (H)', 'Everything that happened, newest first, with times: sessions needing you (with the question), finishing (with a recap), starting work, going back in their ball; level ups, badges and evolutions; goals; legendaries. Every sound you hear has an entry. H:n counts the ones you have not read; pick one to answer it, walk to it, or see its summary.'],
  ['MILESTONES', 'Evolutions, badges, level ups, Eggs and new Pokémon wait for you: they play only while this page is in front, and each waits for A. While you are away they queue up and the tab title counts them (★N), alongside the sessions needing you (!N).'],
  ['SOUND', "Pokémon Crystal's own sounds for statuses, level ups, badges and evolutions. N turns sound on and off, and START > SOUND TEST plays each one."],
  ['KEYS', 'Arrows walk; hold into one of your own Pokémon to swap places with it. Z or Space is A, X or Esc is B, Enter is START, D decisions, H the timeline, M the town map, N sound, Shift hides the counter.'],
];

export function helpScreen(game) {
  return game.ui.screen({
    title: 'HELP - WHAT THIS CAN DO',
    footer: 'UP/DN:SCROLL B:BACK',
    rows: HELP.flatMap(([heading, body]) => [
      { text: heading, color: 'blue' },
      ...wrap(body, 37).map((line) => ({ text: ` ${line}`, noScroll: true })),
      { text: '' },
    ]),
  });
}
