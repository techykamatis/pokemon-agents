// The modal UI, Crystal style: text boxes, ▶ menus, typed entry, toasts, and the "PC" screen.
//
// Everything lives on a stack, and only the top of it takes input. The PC screen draws to the
// 320x288 overlay instead of the 160x144 game screen, which gives it 40 columns — enough for a diff
// or a list to stay readable — while still using the same 8x8 font, so it reads as a monitor in the
// world rather than a web page on top of it.
import { TEXT_PAL, css, wrap } from './pixels.mjs';

export const COLORS = {
  dark: TEXT_PAL[3],
  gray: [120, 120, 120],
  green: [24, 136, 48],
  red: [200, 40, 32],
  blue: [40, 80, 200],
  gold: [176, 120, 0],
};

const SCREEN_COLS = 20; // the game screen, in 8px tiles
const PC_ROWS = 31; // rows of text on the overlay
const TOAST_FRAMES = 150;

export class UI {
  constructor({ font, frame, overlay }) {
    this.font = font;
    this.frame = frame;
    this.stack = [];
    this.toasts = [];
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext('2d');
    this.overlayCtx.imageSmoothingEnabled = false;
    this.tick = 0;
  }

  get top() { return this.stack.at(-1); }
  get busy() { return this.stack.length > 0; }

  push(modal) { this.stack.push(modal); return modal; }
  pop(modal) {
    const at = modal ? this.stack.lastIndexOf(modal) : this.stack.length - 1;
    if (at >= 0) this.stack.splice(at, 1);
  }
  replace(modal, next) {
    const at = this.stack.lastIndexOf(modal);
    if (at >= 0) this.stack[at] = next; else this.push(next);
  }

  key(key, ev) { this.top?.key(key, ev, this); }

  text(ctx, words, x, y, color = 'dark') { this.font.draw(ctx, words, x, y, COLORS[color] ?? COLORS.dark); }

  draw(ctx) {
    this.tick++;
    const top = this.stack.at(-1);
    // the overlay shows only while a PC screen is on top; a card opened from one draws over it
    this.overlay.style.display = top?.overlay ? 'block' : 'none';
    for (const modal of this.stack) {
      if (!modal.overlay) { modal.draw(ctx, this); continue; }
      if (modal !== top) continue;
      this.overlayCtx.fillStyle = css(TEXT_PAL[0]);
      this.overlayCtx.fillRect(0, 0, 320, 288);
      modal.draw(this.overlayCtx, this);
    }
    if (!this.busy) this.drawToast(ctx);
  }

  /** a passing note, shown only when nothing is in the way */
  toast(message) {
    if (this.toasts.length < 12) this.toasts.push({ lines: wrap(message, 18).slice(0, 2), age: 0 });
  }

  drawToast(ctx) {
    const toast = this.toasts[0];
    if (!toast) return;
    if (++toast.age > TOAST_FRAMES) { this.toasts.shift(); return; }
    this.frame(ctx, 0, 0, SCREEN_COLS, 4);
    toast.lines.forEach((line, i) => this.text(ctx, line, 8, 8 + i * 8));
  }

  // --- the things it can put up ------------------------------------------------------------------
  say(text, onDone) { return this.push(new TextBox(text, onDone)); }
  menu(items, opts) { return this.push(new Menu(items, opts)); }
  ask(prompt, onSubmit, opts) { return this.push(new TextEntry(prompt, onSubmit, opts)); }
  screen(opts) { return this.push(new PCScreen(opts)); }
}

/** The bottom text box: four lines of eighteen characters a page. A or B turns the page. */
export class TextBox {
  constructor(text, onDone) {
    const lines = wrap(text, 18);
    this.pages = [];
    for (let i = 0; i < lines.length; i += 4) this.pages.push(lines.slice(i, i + 4));
    this.page = 0;
    this.onDone = onDone;
  }

  key(key, ev, ui) {
    if (key !== 'A' && key !== 'B') return;
    if (++this.page >= this.pages.length) { ui.pop(this); this.onDone?.(); }
  }

  draw(ctx, ui) {
    ui.frame(ctx, 0, 12, SCREEN_COLS, 6);
    (this.pages[this.page] ?? []).forEach((line, i) => ui.text(ctx, line, 8, 104 + i * 8));
    // the blinking ▼ is how Crystal says there is another page
    if (this.page < this.pages.length - 1 && (ui.tick >> 4) % 2) ui.text(ctx, '▼', 144, 136);
  }
}

/**
 * A ▶ menu box, sized to its longest item.
 * @param {Array<{label: string, color?: string, onPick?: () => void}>} items
 * @param {{x, y, w, onCancel, title, keep}} [opts] keep: stay open after a pick
 */
export class Menu {
  constructor(items, { x, y, w, onCancel, title, keep = false } = {}) {
    this.items = items;
    this.i = 0;
    this.title = title;
    this.keep = keep;
    this.onCancel = onCancel;
    this.w = w ?? Math.min(SCREEN_COLS, Math.max(...items.map((it) => it.label.length), title?.length ?? 0) + 3);
    this.visible = title ? 7 : 8;
    this.h = Math.min(items.length, this.visible) * 2 + (title ? 2 : 0);
    this.x = x ?? SCREEN_COLS - this.w;
    this.y = y ?? Math.max(0, 12 - this.h);
  }

  key(key, ev, ui) {
    if (key === 'UP') this.i = (this.i + this.items.length - 1) % this.items.length;
    if (key === 'DOWN') this.i = (this.i + 1) % this.items.length;
    if (key === 'B') { ui.pop(this); this.onCancel?.(); }
    if (key === 'A') {
      const item = this.items[this.i];
      if (!this.keep) ui.pop(this);
      item.onPick?.();
    }
  }

  draw(ctx, ui) {
    ui.frame(ctx, this.x, this.y, this.w, this.h + 2);
    let row = this.y + 1;
    if (this.title) { ui.text(ctx, this.title, this.x * 8 + 8, row * 8); row += 2; }

    const { visible } = this;
    const from = Math.max(0, Math.min(this.i - Math.floor(visible / 2), this.items.length - visible));
    this.items.slice(from, from + visible).forEach((item, j) => {
      const y = (row + j * 2) * 8;
      ui.text(ctx, from + j === this.i ? '▶' : ' ', this.x * 8 + 8, y);
      ui.text(ctx, item.label.slice(0, this.w - 3), this.x * 8 + 16, y, item.color ?? 'dark');
    });
  }
}

/** Typed text in a text box. Enter submits, Escape cancels, and paste works. */
export class TextEntry {
  constructor(prompt, onSubmit, { onCancel, initial = '', max = 2000 } = {}) {
    this.prompt = prompt;
    this.value = initial;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.max = max;
    this.typing = true; // tells the input handler to send every key here, not just the game keys
  }

  key(key, ev, ui) {
    if (ev?.key === 'Enter') { ui.pop(this); this.onSubmit(this.value.trim()); return; }
    if (ev?.key === 'Escape') { ui.pop(this); this.onCancel?.(); return; }
    if (ev?.key === 'Backspace') { this.value = this.value.slice(0, -1); return; }
    if (ev?.type === 'paste') { this.value = (this.value + ev.text).slice(0, this.max); return; }
    if (ev?.key?.length === 1 && !ev.metaKey && !ev.ctrlKey) this.value = (this.value + ev.key).slice(0, this.max);
  }

  draw(ctx, ui) {
    ui.frame(ctx, 0, 0, SCREEN_COLS, 4);
    wrap(this.prompt, 18).slice(0, 2).forEach((line, i) => ui.text(ctx, line, 8, 8 + i * 8));
    ui.frame(ctx, 0, 10, SCREEN_COLS, 8);
    const lines = wrap(`${this.value}${(ui.tick >> 4) % 2 ? '_' : ' '}`, 18);
    lines.slice(-4).forEach((line, i) => ui.text(ctx, line, 8, 88 + i * 8));
    ui.text(ctx, 'ENTER:OK  ESC:BACK', 8, 120, 'gray');
  }
}

/**
 * The 40-column PC screen.
 *
 * @param {object} opts
 * @param {string|(() => string)} opts.title
 * @param {Array|(() => Array)} opts.rows  [{text, color, onPick, bg, noScroll}]. A function is
 *   re-read every frame, which is how a screen fills in as its recap arrives and keeps up with
 *   live sessions without anything having to tell it to refresh.
 */
export class PCScreen {
  constructor({ title, rows, onLeft, onRight, onA, footer = 'B:BACK', onExit }) {
    this.overlay = true;
    this.title = title;
    this.rows = rows;
    this.onLeft = onLeft;
    this.onRight = onRight;
    this.onA = onA;
    this.footer = footer;
    this.onExit = onExit;
    this.top = 0;
    this.sel = 0;
    this.hscroll = 0;
  }

  get list() { return typeof this.rows === 'function' ? this.rows() : this.rows; }
  /** the indices of the rows you can actually choose */
  get picks() { return this.list.map((row, i) => (row.onPick ? i : -1)).filter((i) => i >= 0); }

  key(key, ev, ui) {
    if (key === 'B') { ui.pop(this); this.onExit?.(); return; }
    if (key === 'A' && this.onA) { this.onA(this); return; }

    const picks = this.picks;
    if (picks.length) {
      const at = Math.max(0, picks.indexOf(this.sel));
      if (key === 'UP') this.sel = picks[Math.max(0, at - 1)];
      if (key === 'DOWN') this.sel = picks[Math.min(picks.length - 1, at + 1)];
      if (key === 'A') this.list[this.sel]?.onPick?.();
      // keep the selection in view
      if (this.sel < this.top) this.top = this.sel;
      if (this.sel >= this.top + PC_ROWS) this.top = this.sel - PC_ROWS + 1;
    } else {
      const last = Math.max(0, this.list.length - PC_ROWS);
      if (key === 'UP') this.top = Math.max(0, this.top - 1);
      if (key === 'DOWN') this.top = Math.min(last, this.top + 1);
      if (key === 'PGUP') this.top = Math.max(0, this.top - PC_ROWS);
      if (key === 'PGDN') this.top = Math.min(last, this.top + PC_ROWS);
    }

    if (key === 'LEFT') { if (this.onLeft) this.onLeft(this); else this.hscroll = Math.max(0, this.hscroll - 20); }
    if (key === 'RIGHT') { if (this.onRight) this.onRight(this); else this.hscroll += 20; }
  }

  draw(ctx, ui) {
    ctx.fillStyle = css([200, 216, 248]);
    ctx.fillRect(0, 0, 320, 16);
    ui.text(ctx, String(typeof this.title === 'function' ? this.title() : this.title).slice(0, 39), 8, 4);

    const list = this.list;
    const picks = this.picks;
    // the rows can change under us, so a selection that has gone is moved rather than left dangling
    if (picks.length && !picks.includes(this.sel)) this.sel = picks[0];

    list.slice(this.top, this.top + PC_ROWS).forEach((row, j) => {
      const index = this.top + j;
      const y = 20 + j * 8;
      if (row.bg) { ctx.fillStyle = css(row.bg); ctx.fillRect(0, y, 320, 8); }
      if (picks.length && index === this.sel) ui.text(ctx, '▶', 0, y);
      const from = row.noScroll ? 0 : this.hscroll;
      ui.text(ctx, String(row.text).slice(from, from + 38), 8, y, row.color ?? 'dark');
    });

    if (list.length > PC_ROWS) {
      ui.text(ctx, `${this.top + 1}-${Math.min(list.length, this.top + PC_ROWS)}/${list.length}`, 8, 276, 'gray');
    }
    ui.text(ctx, this.footer.slice(0, 26), 320 - Math.min(26, this.footer.length) * 8 - 4, 276, 'gray');
  }
}
