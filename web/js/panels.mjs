// The screens where the game acts rather than watches: answering a session that asked you
// something, and starting and following goals. A legendary's report lives here too, because it is
// the other screen that points you at sessions and lets you act on them.
import {
  LegendCard, STATUS, goToTerminal, inApp, loadRecap, onMap, para, sessionSummary, terminalLabel,
} from './screens.mjs';

const folderName = (project) => (project ? project.split('/').filter(Boolean).pop() : '?');

const GOAL_STATUS = {
  running: ['RUNNING', 'green'],
  done: ['DONE', 'blue'],
  failed: ['FAILED', 'red'],
  stopped: ['STOPPED', 'gray'],
  ended: ['ENDED', 'gray'], // it outlived a bridge restart, so its exit code is not ours to know
};

const goalFor = (game, session) => game.bridge.goals.find((g) => g.sessionId === session.id);

async function send(game, session, text, screen, now = false) {
  const out = await game.bridge.answer(session.id, text, now);
  game.audio?.play(out.ok ? 'sent' : 'wrong');
  if (out.ok && screen) game.ui.pop(screen);

  const name = session.name.toUpperCase();
  const queued = `Queued: its run is still going, often a background watch like CI. ${name} gets your answer the moment that run ends. SEND NOW in its ANSWER stops the run to answer at once.`;
  if (!out.ok) { game.ui.say(out.error ?? 'Could not send.'); return; }
  game.ui.say(now ? `Stopped its run; sent to ${name}.` : out.queued ? queued : `Sent to ${name}.`);
}

/** ANSWER: what it asked, the options to pick from, or type your own */
export function answerScreen(game, session) {
  const box = loadRecap(game, session.id);
  // an answer cannot reach a picker in a terminal (it needs arrow keys), nor a session in the app
  const mustAnswerThere = () => (box.r?.picker && session.entry === 'cli') || inApp(session);

  const screen = game.ui.screen({
    title: `${session.name.toUpperCase()} ASKS`.slice(0, 39),
    footer: 'A:PICK B:BACK',
    rows: () => {
      const r = box.r;
      if (!r) return [{ text: 'LOADING...', color: 'gray' }];
      if (!r.ok) return [{ text: r.error ?? 'Nothing to answer.', color: 'red' }];

      const question = para('QUESTION', r.question ?? r.cta ?? 'No question; you can still reply.', 'red');

      if (mustAnswerThere()) {
        return [
          ...question,
          ...r.options.map((option, i) => ({ text: ` ${i + 1}. ${option.label}`.slice(0, 38), noScroll: true })),
          { text: '' },
          { text: inApp(session) ? `Answer it in ${session.app}.` : 'A picker only works in its terminal.', color: 'gray' },
          { text: terminalLabel(session), onPick: () => goToTerminal(game, session.id) },
        ];
      }

      const waiting = goalFor(game, session)?.queued;
      return [
        ...question,
        ...(waiting ? [
          ...para('QUEUED, SENT WHEN ITS RUN ENDS', waiting, 'blue'),
          { text: 'SEND NOW: stop its run and answer', color: 'red', onPick: () => send(game, session, waiting, screen, true) },
          { text: '' },
        ] : []),
        ...r.options.map((option, i) => ({
          text: `${i + 1}. ${option.label}`.slice(0, 37),
          color: 'green',
          onPick: () => confirmOption(game, session, option, screen),
        })),
        ...(onMap(game, session.id) ? [{ text: 'WALK TO IT', onPick: () => game.goTo(session.id) }] : []),
        {
          text: 'TYPE AN ANSWER',
          onPick: () => game.ui.ask(`ANSWER ${session.name.toUpperCase()}`, (text) => text && send(game, session, text, screen), { max: 2000 }),
        },
        { text: terminalLabel(session), onPick: () => goToTerminal(game, session.id) },
      ];
    },
  });
  return screen;
}

/** picking an option is a decision, so it is confirmed before it goes */
function confirmOption(game, session, option, screen) {
  game.ui.menu([
    { label: 'SEND', onPick: () => send(game, session, option.send, screen) },
    { label: 'CANCEL' },
  ], { title: option.label.slice(0, 16) });
}

/** START > GOALS: every goal, newest first, and NEW GOAL to start another */
export function goalsScreen(game) {
  return game.ui.screen({
    title: () => `GOALS - ${game.bridge.goals.filter((g) => g.status === 'running').length} RUNNING`,
    footer: 'A:PICK B:BACK',
    rows: () => [
      { text: '+ NEW GOAL', color: 'green', onPick: () => folderPicker(game, (dir) => newGoal(game, dir)) },
      { text: '' },
      ...game.bridge.goals.flatMap((goal) => {
        const session = game.bridge.sessions.find((s) => s.id === goal.sessionId);
        // a goal that has asked you something matters more than the fact that it is running
        const [label, color] = goal.queued
          ? ['QUEUED', 'blue']
          : session?.status === 'waiting'
            ? [STATUS.waiting, 'red']
            : GOAL_STATUS[goal.status] ?? [goal.status.toUpperCase(), 'gray'];
        return [
          {
            text: `${label.padEnd(9)} ${folderName(goal.project)}`,
            color,
            onPick: () => goalMenu(game, goal, session),
          },
          { text: `  ${goal.text.replace(/\s+/g, ' ')}`.slice(0, 38), color: 'gray', noScroll: true },
        ];
      }),
    ],
  });
}

function goalMenu(game, goal, liveSession) {
  // a goal whose run has ended has no live session, but you can still read and continue it
  const session = liveSession ?? {
    id: goal.sessionId,
    project: goal.project,
    name: folderName(goal.project),
    status: 'done',
    entry: 'sdk-cli',
    app: 'GOAL',
    title: goal.text,
  };

  game.ui.menu([
    ...(session.status === 'waiting' ? [{ label: 'ANSWER', onPick: () => answerScreen(game, session) }] : []),
    ...(onMap(game, session.id) ? [{ label: 'WALK TO IT', onPick: () => game.goTo(session.id) }] : []),
    { label: 'SUMMARY', onPick: () => sessionSummary(game, session) },
    ...(goal.queued ? [{ label: 'SEND NOW', onPick: () => send(game, session, goal.queued, null, true) }] : []),
    ...(goal.status !== 'running' ? [{ label: 'CONTINUE', onPick: () => goToTerminal(game, goal.sessionId) }] : []),
    ...(goal.status === 'running' ? [{
      label: 'STOP',
      onPick: async () => {
        const out = await game.bridge.post('/goal/stop', { id: goal.id });
        game.ui.say(out.ok ? 'Stopped.' : out.error);
      },
    }] : []),
    { label: 'CANCEL' },
  ], { title: folderName(goal.project).toUpperCase().slice(0, 12) });
}

/** type a goal for a folder, and start an agent on it */
export function newGoal(game, project) {
  const name = (game.bridge.progress?.mons[project]?.nickname ?? folderName(project)).toUpperCase();
  game.ui.ask(`NEW GOAL FOR ${name}`, async (text) => {
    if (!text) return;
    const out = await game.bridge.post('/goal', { project, text });
    game.audio?.play(out.ok ? 'goal' : 'wrong');
    game.ui.say(out.ok
      ? `${name} is on it! Its Pokémon shows up while it works.`
      : out.error ?? 'Could not start it.');
  }, { max: 4000 });
}

/** where a goal should run: any folder, or one of your projects */
function folderPicker(game, onPicked) {
  const mons = Object.values(game.bridge.progress?.mons ?? {});
  const lastDay = (mon) => mon.days?.at(-1) ?? '';
  // most recently worked on first, then newest: the one you want is usually at the top
  const projects = mons.sort((a, b) => (lastDay(b) > lastDay(a) ? 1 : lastDay(b) < lastDay(a) ? -1 : 0) || (b.joined ?? 0) - (a.joined ?? 0));

  const took = (out) => {
    if (out.ok) onPicked(out.dir);
    else if (out.error !== 'Cancelled.') game.ui.say(out.error ?? 'No folder.');
  };

  const screen = game.ui.screen({
    title: 'WHERE SHOULD IT WORK?',
    footer: 'A:PICK B:BACK',
    rows: () => [
      {
        text: 'CHOOSE A FOLDER... (Finder)',
        color: 'green',
        onPick: async () => { game.ui.pop(screen); took(await game.bridge.post('/folder/choose', {})); },
      },
      {
        text: 'NEW FOLDER IN ~/code',
        color: 'green',
        onPick: () => {
          game.ui.pop(screen);
          game.ui.ask('NEW FOLDER NAME', async (name) => name && took(await game.bridge.post('/folder/new', { name })), { max: 64 });
        },
      },
      {
        text: 'TYPE A PATH',
        color: 'green',
        onPick: () => {
          game.ui.pop(screen);
          game.ui.ask('FOLDER PATH, LIKE ~/code/app', (typed) => typed && onPicked(typed), { max: 500 });
        },
      },
      { text: '' },
      { text: 'OR ONE OF YOUR PROJECTS:', color: 'gray' },
      ...projects.map((mon) => ({
        text: `${mon.nickname.padEnd(11)} ${folderName(mon.project)}`.slice(0, 37),
        onPick: () => { game.ui.pop(screen); onPicked(mon.project); },
      })),
    ],
  });
  return screen;
}

/** a legendary's report: its job, what it has noticed, and the sessions it points at */
export function legendScreen(game, species) {
  const legend = () => game.bridge.legends?.[species];

  return game.ui.screen({
    title: () => (legend() ? `${legend().name} - ${legend().job}` : 'LEGENDARY').slice(0, 39),
    footer: 'A:PICK B:BACK',
    rows: () => {
      const it = legend();
      if (!it) return [{ text: 'It is watching from afar.', color: 'gray' }];
      return [
        { text: 'POKéMON DETAILS', color: 'blue', onPick: () => game.ui.push(new LegendCard(game, species)) },
        ...para('', it.lore, 'gray').slice(1),
        ...it.lines.map((line, i) => ({
          text: line.slice(0, 38),
          color: i === 0 && it.alert ? 'red' : undefined,
          noScroll: true,
        })),
        ...it.sessions.map((pointer) => ({
          text: ` ${pointer.label}`.slice(0, 38),
          color: 'green',
          noScroll: true,
          onPick: () => openPointer(game, pointer),
        })),
      ];
    },
  });
}

function openPointer(game, pointer) {
  const session = game.bridge.sessions.find((s) => s.id === pointer.id);
  if (!session) { game.ui.say('That one is not on the map right now.'); return; }
  game.ui.menu([
    ...(onMap(game, session.id) ? [{ label: 'WALK TO IT', onPick: () => game.goTo(session.id) }] : []),
    { label: 'SUMMARY', onPick: () => sessionSummary(game, session) },
    { label: 'CANCEL' },
  ], { title: session.name.toUpperCase().slice(0, 12) });
}
