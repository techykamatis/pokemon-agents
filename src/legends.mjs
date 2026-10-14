// The roaming legendaries. Each is released by a badge, and each is given a job that fits its
// Crystal lore and a building to patrol. Talk to one and it reports; a `!` above it means something
// it watches over wants your attention.
//
// Pure: every report is built from what the watcher and progression already know, so opening one
// reads nothing and costs nothing.
import path from 'node:path';
import { BADGES, EXTRAS, localDay } from './rules.mjs';
import { APPS } from './watcher.mjs';

const MINUTE = 60_000;
export const LONG_RUN_MS = 20 * MINUTE;
const LISTED = 6; // sessions named in one report

export const LEGENDS = {
  243: { name: 'RAIKOU', job: 'TEST WATCHER', home: 'testbench', lore: 'Lightning-fast: it races to every red test.' },
  245: { name: 'SUICUNE', job: 'KEEPS WORK SAVED', home: 'mergestation', lore: 'It purifies: edits left uncommitted are muddy water.' },
  244: { name: 'ENTEI', job: 'STREAK KEEPER', home: 'lounge', lore: 'A volcano at heart: it keeps your daily fire lit.' },
  249: { name: 'LUGIA', job: 'LONG RUNS', home: 'gate', lore: 'Guardian of the deep: it watches work that runs long.' },
  250: { name: 'HO-OH', job: "TODAY'S RAINBOW", home: 'tower', lore: 'A rainbow after the storm: what today brought.' },
  251: { name: 'CELEBI', job: 'ON THIS DAY', home: 'library', lore: 'It travels through time: what you did back then.' },
};

const folderOf = (cursor) => path.basename(cursor.cwd ?? '') || '?';
const describe = (cursor) => `${folderOf(cursor)}: ${cursor.title ?? 'untitled'}`;
const dayOf = (ts) => localDay(new Date(ts));
const duration = (ms) => (ms >= 90 * MINUTE ? `${Math.round(ms / 3600_000)}h` : `${Math.max(1, Math.round(ms / MINUTE))}m`);
/** a session a report points at, so the game can offer WALK TO IT and SUMMARY for it */
const pointAt = (cursor, suffix = '') => ({ id: cursor.sessionId, label: `${describe(cursor)}${suffix}`.slice(0, 60) });

/**
 * @param {object} input
 * @param {number[]} input.unlocked  which legendaries you have released
 * @param {object[]} input.cursors   every transcript the watcher has read
 * @param {object[]} input.sessions  the ones on the map right now
 * @param {object} input.team        progression's trainer-level state
 * @param {object[]} input.goals
 * @param {number} input.now
 * @returns {Record<number, {name, job, home, lore, released, alert: boolean, lines: string[], sessions: Array<{id, label}>}>}
 */
export function legendsReport({ unlocked, cursors, sessions, team, goals, now }) {
  const mains = cursors.filter((c) => !c.isSub && c.sessionId);
  // a recap of your day should not be padded out with crons, hooks and SDK runs
  const yours = mains.filter((c) => Object.hasOwn(APPS, c.entry));
  const byId = new Map(mains.map((c) => [c.sessionId, c]));
  const live = sessions.map((s) => ({ session: s, cursor: byId.get(s.id) })).filter((x) => x.cursor);

  const reports = {
    // RAIKOU: live sessions whose last test run came back red
    243: () => {
      const red = live.filter(({ cursor }) => cursor.lastTestFailed).map(({ cursor }) => pointAt(cursor));
      return {
        alert: red.length > 0,
        lines: red.length ? [`${red.length} session(s) with a red test run:`] : ['Every live test run is green.'],
        sessions: red,
      };
    },

    // SUICUNE: sessions that have stopped working with edits they never committed
    245: () => {
      const muddy = live
        .filter(({ session, cursor }) => cursor.dirty > 0 && session.status !== 'working')
        .map(({ cursor }) => pointAt(cursor, ` (${cursor.dirty} edits)`));
      return {
        alert: muddy.length > 0,
        lines: muddy.length ? ['Edits not committed yet:'] : ['All finished work is committed.'],
        sessions: muddy,
      };
    },

    // ENTEI: today's fire, and whether it is lit yet
    244: () => {
      const lit = team.days?.includes(dayOf(now));
      return {
        alert: !lit && (team.streak ?? 0) > 0,
        lines: [
          `Streak ${team.streak ?? 0} days, best ${team.bestStreak ?? 0}.`,
          lit ? 'Today is lit.' : 'No session yet today: the streak is at risk!',
        ],
        sessions: [],
      };
    },

    // LUGIA: anything that has been running a long time, goals included
    249: () => {
      const long = live
        .filter(({ session }) => session.status === 'working' && session.since && now - session.since >= LONG_RUN_MS)
        .map(({ session, cursor }) => pointAt(cursor, ` (${duration(now - session.since)})`));
      const running = goals
        .filter((g) => g.status === 'running' && !long.some((x) => x.id === g.sessionId))
        .map((g) => ({ id: g.sessionId, label: `${`goal: ${g.text}`.slice(0, 60)} (${duration(now - g.started)})` }));
      const pointing = [...long, ...running];
      return {
        alert: long.length > 0,
        lines: pointing.length ? ['Running long:'] : ['Nothing is running long.'],
        sessions: pointing,
      };
    },

    // HO-OH: what today brought
    250: () => {
      const today = yours.filter((c) => dayOf(c.lastTs) === dayOf(now)).sort((a, b) => b.lastTs - a.lastTs);
      return { alert: false, lines: [`${today.length} session(s) today:`, ...today.slice(0, LISTED * 2).map(describe)], sessions: [] };
    },

    // CELEBI: this day a week ago, and a month ago
    251: () => {
      const onDay = (daysAgo) => {
        const day = dayOf(now - daysAgo * 86_400_000);
        return yours.filter((c) => dayOf(c.lastTs) === day).map(describe);
      };
      const week = onDay(7);
      const month = onDay(30);
      return {
        alert: false,
        lines: [
          'A week ago:', ...(week.length ? week.slice(0, LISTED) : ['(quiet)']),
          'A month ago:', ...(month.length ? month.slice(0, LISTED) : ['(quiet)']),
        ],
        sessions: [],
      };
    },
  };

  /** which badge or achievement released it, when, and for which project */
  const releasedBy = (id) => {
    const rule = [...BADGES, ...EXTRAS].find((r) => r.unlock === id);
    if (!rule) return null;
    const earned = [...(team.badges ?? []), ...(team.achievements ?? [])].find((e) => e.id === rule.id);
    return { by: rule.name, why: rule.why, ts: earned?.ts ?? null, project: earned?.agentId ?? null };
  };

  const out = {};
  for (const id of unlocked) {
    if (reports[id]) out[id] = { ...LEGENDS[id], released: releasedBy(id), ...reports[id]() };
  }
  return out;
}
