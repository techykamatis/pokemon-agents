// What one session is actually about, read on demand: your last ask, its last reply, the thing it
// needs from you, the options it offered, and the step it recommends next.
//
// Unlike the watcher, this does read prompt and reply text. So it runs only when you open a
// session's SUMMARY, RECAP or ANSWER, never on a schedule, and only ever answers our own page
// (see the route in src/server.mjs). Nothing it reads is stored except where you can already see
// it: the timeline keeps the question or recap of a moment it logs.
import fs from 'node:fs';
import { asksYou } from './transcript.mjs';

const TAIL = 2 * 1024 * 1024; // the last couple of megabytes: plenty for one turn
const REPLY_LIMIT = 3000;

/** Claude Code's own away-summary usually spells out the next step */
const NEXT_RE = /\bnext(?: step)?(?: is|:|,)\s*(.+?[.!?])(?=\s|$)/i;
const RECOMMENDS_RE = /\b(I recommend|I'd recommend|recommended|I suggest|I'd suggest|next step)\b/i;
/** a numbered or lettered list item: "1. ...", "2) ...", "(A) ..." */
const LIST_ITEM_RE = /^\s*(?:(\d+)[.)]|\(?([A-Ha-h])[.)])\s+(.+?)\s*$/;
/** an ask that can only really be answered yes or no */
const YES_NO_RE = /^(want me to|should I|shall I|do you want|ok to|okay to|can I|ready to|proceed)\b/i;
/** slash commands, hook output and system notes are not something you said */
const NOT_YOURS_RE = /^\s*<(command-|local-command|system-reminder|bash-)|^Caveat:/;

/**
 * Markdown and anything outside printable ASCII out: the Game Boy font has one glyph per
 * character and no way to draw the rest.
 */
export const plain = (text) => String(text)
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // a link keeps its words, loses its URL
  .replace(/^\s*[#>]+\s*/gm, '')
  .replace(/[*`]/g, '')
  .replace(/[–—]/g, '-')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/…/g, '...')
  .replace(/[^\x20-\x7e\n]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const sentencesIn = (text) => text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

/**
 * The last numbered or lettered list in a reply, 2 to 6 items: the choices it is offering.
 * The last one, because a reply often lists what it did before listing what you could do next.
 */
function listedOptions(raw) {
  let run = [];
  let last = [];
  for (const line of raw.split('\n')) {
    const item = LIST_ITEM_RE.exec(line);
    if (item) run.push(item);
    else if (line.trim()) { if (run.length >= 2) last = run; run = []; } // prose ends a list
  }
  if (run.length >= 2) last = run;

  return last.slice(0, 6).map((item) => {
    const label = plain(item[3]).slice(0, 80);
    const marker = item[1] ?? item[2].toUpperCase();
    // send the number as well as the words: it is what you would have typed yourself
    return { label, send: `Option ${marker}: ${label}` };
  });
}

/**
 * What it is asking and what you can send back. An open AskUserQuestion is a picker, with its own
 * question and its own options; otherwise the ask comes out of the reply, with either its list or
 * a plain yes and no.
 */
function decisionFrom(picker, raw, cta) {
  if (picker) {
    return {
      question: plain(picker.question ?? ''),
      options: (picker.options ?? []).slice(0, 6).map((o) => ({ label: plain(o.label ?? ''), send: plain(o.label ?? '') })),
      picker: true,
    };
  }
  if (!cta) return { question: null, options: [], picker: false };
  const options = YES_NO_RE.test(cta) ? [{ label: 'Yes', send: 'Yes' }, { label: 'No', send: 'No' }] : listedOptions(raw);
  return { question: cta, options, picker: false };
}

/** the tail of a transcript, newest line first */
function tailLines(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // the first line was cut in half by where we started
    return lines.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

/** the words you typed on this line, or null if they are not yours */
function yourWords(d) {
  if (d.type === 'last-prompt') return d.lastPrompt ?? null;
  if (d.type !== 'user' || d.isMeta) return null;
  const content = d.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && !content.some((c) => c.type === 'tool_result')
      ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : '';
  return text && !NOT_YOURS_RE.test(text) ? text : null;
}

/**
 * @param {string} file a transcript path
 * @returns {{ask, reply, recap, cta, next, question, options: Array<{label, send}>, picker: boolean}}
 */
export function recapOf(file) {
  let ask = null;
  let reply = null;
  let raw = '';
  let recap = null;
  let picker = null;
  let sawTool = false;
  const answered = new Set();

  for (const line of tailLines(file)) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || typeof d !== 'object') continue;

    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    for (const c of content) if (c.type === 'tool_result') answered.add(c.tool_use_id);

    // the most recent tool call decides whether a picker is still open, so only the first one counts
    if (!sawTool && d.type === 'assistant') {
      const use = content.findLast((c) => c.type === 'tool_use');
      if (use) {
        sawTool = true;
        if (use.name === 'AskUserQuestion' && !answered.has(use.id)) picker = use.input?.questions?.[0] ?? null;
      }
    }

    if (!reply && d.type === 'assistant') {
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) { raw = text; reply = plain(text); }
    }

    // an away-summary only counts while it is newer than the last reply; older than that it is stale
    if (!reply && !recap && d.type === 'system' && d.subtype === 'away_summary') {
      recap = plain(String(d.content ?? '').replace(/\(disable recaps in \/config\)/, ''));
    }

    const yours = !ask && yourWords(d);
    if (yours) ask = plain(yours).slice(0, 400);
    // a real prompt is where the turn began; `last-prompt` lines trail the reply, so they do not end it
    if (ask && (reply || d.type === 'user')) break;
  }

  // a line break ends a sentence too, or a bulleted ask would run into the line after it
  const pieces = raw.split('\n').flatMap(sentencesIn).map(plain).filter(Boolean);
  const cta = reply && asksYou(reply) ? pieces.filter(asksYou).at(-1) ?? null : null;
  const next = recap?.match(NEXT_RE)?.[1] ?? pieces.filter((s) => RECOMMENDS_RE.test(s)).at(-1) ?? null;
  // an ask usually closes a reply, so a long one keeps its end rather than its beginning
  const trimmed = reply && reply.length > REPLY_LIMIT ? `...${reply.slice(-REPLY_LIMIT)}` : reply;

  return { ask, reply: trimmed, recap, cta, next, ...decisionFrom(picker, raw, cta) };
}
