// The timeline screen: everything that happened, newest first, so a sound you heard while looking
// the other way can be found again. The bridge keeps the log (src/timeline.mjs); this reads it.
// Entries you have not seen are counted on screen as H:n, and opening the timeline marks them read,
// which is remembered in this browser.
import { wrap } from './pixels.mjs';
import { answerScreen } from './panels.mjs';
import { onMap, sessionSummary } from './screens.mjs';

const SEEN_KEY = 'pokemon-agents:timeline-seen';

const LABELS = {
  waiting: ['NEEDS YOU', 'red'],
  done: ['DONE', 'blue'],
  working: ['WORKING', 'green'],
  resting: ['RESTING', 'gray'],
  left: ['IN ITS BALL', 'gray'],
  level: ['LEVEL UP', 'green'],
  evolve: ['EVOLVED', 'green'],
  badge: ['BADGE', 'green'],
  achievement: ['ACHIEVEMENT', 'green'],
  join: ['NEW POKéMON', 'green'],
  hatch: ['EGG HATCHED', 'green'],
  'goal-running': ['GOAL STARTED', 'blue'],
  'goal-done': ['GOAL DONE', 'blue'],
  'goal-failed': ['GOAL FAILED', 'red'],
  'goal-stopped': ['GOAL STOPPED', 'gray'],
  'goal-ended': ['GOAL ENDED', 'gray'],
  legend: ['LEGENDARY !', 'red'],
};

export const seenAt = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const markSeen = (ts) => { try { localStorage.setItem(SEEN_KEY, String(ts)); } catch { /* not remembered */ } };

/** how many entries you have not read yet */
export const unseenCount = (game) => {
  const since = seenAt();
  return game.bridge.timeline.filter((entry) => entry.ts > since).length;
};

const clock = (ts) => {
  const at = new Date(ts);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  // today needs only the time; anything older needs the day as well
  return new Date().toDateString() === at.toDateString() ? hhmm : `${at.getDate()}/${at.getMonth() + 1} ${hhmm}`;
};

/** what you can do with one entry, if its session is still around */
function openEntry(game, entry) {
  const session = entry.id && game.bridge.sessions.find((s) => s.id === entry.id);
  if (!session) {
    game.ui.say(entry.id ? 'That session is no longer on the map.' : 'Nothing to open for this one.');
    return;
  }
  game.ui.menu([
    ...(session.status === 'waiting' ? [{ label: 'ANSWER', onPick: () => answerScreen(game, session) }] : []),
    ...(onMap(game, session.id) ? [{ label: 'WALK TO IT', onPick: () => game.goTo(session.id) }] : []),
    { label: 'SUMMARY', onPick: () => sessionSummary(game, session) },
    { label: 'CANCEL' },
  ], { title: session.name.toUpperCase().slice(0, 12) });
}

export function timelineScreen(game) {
  // anything newer than this is marked with a * for the length of this visit
  const unreadBefore = seenAt();
  const newest = game.bridge.timeline.at(-1)?.ts;
  if (newest) markSeen(newest);

  return game.ui.screen({
    title: () => `TIMELINE - ${game.bridge.timeline.length} EVENTS`,
    footer: 'A:OPEN B:BACK',
    rows: () => {
      const entries = [...game.bridge.timeline].reverse();
      if (!entries.length) return [{ text: 'Nothing yet. It fills in as things happen.', color: 'gray' }];

      return entries.flatMap((entry) => {
        const [label, color] = LABELS[entry.kind] ?? [entry.kind.toUpperCase(), 'dark'];
        const unread = entry.ts > unreadBefore ? '*' : ' ';
        const heading = `${unread}${clock(entry.ts)} ${label} ${(entry.name ?? '').toUpperCase()}`.slice(0, 38);
        const body = wrap((entry.text ?? '').replace(/\s+/g, ' '), 35)
          .slice(0, 2)
          .map((line) => ({ text: `   ${line}`, color: 'gray', noScroll: true }));
        return [
          { text: heading, color, noScroll: true, onPick: () => openEntry(game, entry) },
          ...body,
        ];
      });
    },
  });
}
