// The pixel layer: loading pret's two-bit grayscale PNGs, colouring them with Crystal's palettes,
// drawing text with the real font and charmap, drawing the text-box frame, and deriving a 16x16
// overworld walker for a Pokémon that never had one.
export const W = 160;
export const H = 144;

export function canvas(w, h) {
  const element = document.createElement('canvas');
  element.width = w;
  element.height = h;
  const ctx = element.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  return element;
}

export async function loadImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = canvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return {
    w: img.width,
    h: img.height,
    canvas: c,
    data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data,
  };
}

/** pret's images are grayscale: white is colour 0, black is colour 3 */
export const shadeAt = (img, x, y) => 3 - Math.round(img.data[(y * img.w + x) * 4] / 85);

/**
 * Colour a region of a two-bit image.
 * @param {number[][]} palette four [r, g, b]
 * @param {boolean} [transparent0] make colour 0 transparent, as a sprite palette does
 */
export function colorize(img, sx, sy, w, h, palette, transparent0 = false) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const shade = shadeAt(img, sx + x, sy + y);
      const [r, g, b] = palette[shade];
      out.data.set([r, g, b, transparent0 && shade === 0 ? 0 : 255], (y * w + x) * 4);
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

export const css = ([r, g, b]) => `rgb(${r},${g},${b})`;

// --- text ---------------------------------------------------------------------------------------
export const TEXT_PAL = [[248, 248, 248], [168, 168, 168], [88, 88, 88], [16, 16, 16]];

// Crystal's font has no " # $ % * + < = > \ ^ _ ` { | } ~ @ or heart, and a diff or a shell command
// needs most of them. They are drawn here in one-pixel strokes and thickened the way the real
// glyphs are. Rows run top to bottom; '#' is ink.
const EXTRA_GLYPHS = {
  '"': ['', '.#..#', '.#..#', '.#..#'],
  '#': ['', '..#.#', '.#####', '..#.#', '.#####', '..#.#'],
  $: ['...#', '..####', '.#.#', '..###', '...#.#', '.####', '...#'],
  '%': ['', '.#....#', '.#...#', '....#', '...#', '..#...#', '.#....#'],
  '*': ['', '...#', '.#.#.#', '..###', '.#.#.#', '...#'],
  '+': ['', '...#', '...#', '.#####', '...#', '...#'],
  '<': ['', '....#', '...#', '..#', '...#', '....#'],
  '=': ['', '', '.#####', '', '.#####'],
  '>': ['', '.#', '..#', '...#', '..#', '.#'],
  '\\': ['', '.#', '..#', '...#', '....#', '.....#'],
  '^': ['...#', '..#.#', '.#...#'],
  _: ['', '', '', '', '', '', '######'],
  '`': ['.#', '..#'],
  '{': ['....#', '...#', '...#', '..#', '...#', '...#', '....#'],
  '|': ['...#', '...#', '...#', '...#', '...#', '...#', '...#'],
  '}': ['.#', '..#', '..#', '...#', '..#', '..#', '.#'],
  '~': ['', '', '..#...#', '.#.#.#', '....#'],
  '@': ['', '..###', '.#...#', '.#.###', '.#.#.#', '.#..##', '..##'],
  '♥': ['', '.##.##', '######', '######', '.####', '..##'],
};
const EXTRA_CHARS = Object.keys(EXTRA_GLYPHS);

export class Font {
  constructor(img, charmap) {
    this.img = img;
    this.charmap = { ...charmap };
    // the extra glyphs live past the real font, at indices 128 and up
    EXTRA_CHARS.forEach((ch, i) => { this.charmap[ch] = 128 + i; });
    this.sheets = new Map();
  }

  /** the font plus the extra glyphs, in one colour; cached per colour */
  sheet(color) {
    const key = color.join(',');
    const cached = this.sheets.get(key);
    if (cached) return cached;

    const c = canvas(128, 80);
    const ctx = c.getContext('2d');
    ctx.drawImage(colorize(this.img, 0, 0, this.img.w, this.img.h, [[0, 0, 0], color, color, color], true), 0, 0);
    ctx.fillStyle = css(color);
    EXTRA_CHARS.forEach((ch, i) => {
      const ox = (i % 16) * 8;
      const oy = 64 + Math.floor(i / 16) * 8;
      EXTRA_GLYPHS[ch].forEach((row, y) => {
        [...row].forEach((pixel, x) => {
          // the left of a glyph is two pixels wide, matching the weight of the real font
          if (pixel === '#') ctx.fillRect(ox + x, oy + y, x < 6 ? 2 : 1, 1);
        });
      });
    });
    this.sheets.set(key, c);
    return c;
  }

  /** É has no glyph of its own, but é does, so case is tried both ways before giving up */
  glyph(ch) {
    const index = this.charmap[ch] ?? this.charmap[ch.toUpperCase()] ?? this.charmap[ch.toLowerCase()] ?? this.charmap['?'];
    return index < 0 ? -1 : index;
  }

  /** draw text at a pixel position; one character is 8px wide */
  draw(ctx, text, x, y, color = TEXT_PAL[3]) {
    const sheet = this.sheet(color);
    let cx = x;
    for (const ch of String(text)) {
      const index = this.glyph(ch);
      if (index >= 0) ctx.drawImage(sheet, (index % 16) * 8, Math.floor(index / 16) * 8, 8, 8, cx, y, 8, 8);
      cx += 8;
    }
  }
}

/** Crystal's text frame: the six corner, edge and side tiles of frames/1.png */
export function frameDrawer(img) {
  const tiles = colorize(img, 0, 0, img.w, img.h, TEXT_PAL);

  const tile = (ctx, index, x, y, mirrored = false) => {
    ctx.save();
    if (mirrored) { ctx.translate(x + 8, y); ctx.scale(-1, 1); x = 0; y = 0; }
    ctx.drawImage(tiles, (index % 3) * 8, Math.floor(index / 3) * 8, 8, 8, x, y, 8, 8);
    ctx.restore();
  };

  /** a box, measured in 8px tiles */
  return (ctx, tx, ty, tw, th) => {
    const x0 = tx * 8;
    const y0 = ty * 8;
    ctx.fillStyle = css(TEXT_PAL[0]);
    ctx.fillRect(x0, y0, tw * 8, th * 8);

    tile(ctx, 0, x0, y0);
    tile(ctx, 2, x0 + (tw - 1) * 8, y0);
    tile(ctx, 4, x0, y0 + (th - 1) * 8);
    tile(ctx, 5, x0 + (tw - 1) * 8, y0 + (th - 1) * 8);
    for (let i = 1; i < tw - 1; i++) {
      tile(ctx, 1, x0 + i * 8, y0);
      tile(ctx, 1, x0 + i * 8, y0 + (th - 1) * 8);
    }
    for (let j = 1; j < th - 1; j++) {
      tile(ctx, 3, x0, y0 + j * 8);
      tile(ctx, 3, x0 + (tw - 1) * 8, y0 + j * 8, true); // the right edge is the left one mirrored
    }
  };
}

/** wrap text to a number of characters, keeping existing line breaks */
export function wrap(text, columns) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (word.length > columns) {
        // a path or a hash longer than the screen: break it rather than overflow
        if (line) lines.push(line);
        const chunks = word.match(new RegExp(`.{1,${columns}}`, 'g'));
        lines.push(...chunks.slice(0, -1));
        line = chunks.at(-1);
        continue;
      }
      if ((line ? line.length + 1 : 0) + word.length > columns) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

// --- walkers ------------------------------------------------------------------------------------
/**
 * Gen 2 has no overworld sprite per species, so one is built: crop a Gen 7 menu icon to its own
 * pixels, box-filter it down to fit 16x16, and quantize to three colours and transparency, which
 * is what a Game Boy Color sprite palette holds.
 *
 * @returns {HTMLCanvasElement[]} two frames; the second bobs a pixel, as Crystal's party icons do
 */
export function makeWalker(icon) {
  const { w, h, data } = icon;

  // the icon's own bounding box: the sheet has a lot of empty space around each one
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 127) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }

  const cropW = x1 - x0 + 1;
  const cropH = y1 - y0 + 1;
  const scale = Math.min(1, 15 / Math.max(cropW, cropH));
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));

  // average each source block down to one pixel, keeping it only if it was mostly opaque
  const pixels = [];
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let r = 0; let g = 0; let b = 0; let opaque = 0; let total = 0;
      const sx0 = x0 + Math.floor(ox / scale);
      const sx1 = x0 + Math.max(Math.floor((ox + 1) / scale), Math.floor(ox / scale) + 1);
      const sy0 = y0 + Math.floor(oy / scale);
      const sy1 = y0 + Math.max(Math.floor((oy + 1) / scale), Math.floor(oy / scale) + 1);
      for (let y = sy0; y < Math.min(sy1, y0 + cropH); y++) {
        for (let x = sx0; x < Math.min(sx1, x0 + cropW); x++) {
          const i = (y * w + x) * 4;
          total++;
          if (data[i + 3] > 127) { r += data[i]; g += data[i + 1]; b += data[i + 2]; opaque++; }
        }
      }
      pixels.push(opaque * 2 >= total && opaque ? [r / opaque, g / opaque, b / opaque] : null);
    }
  }

  const palette = kmeans(pixels.filter(Boolean), 3);
  return [0, 1].map((bob) => {
    const c = canvas(16, 16);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(16, 16);
    const offX = Math.floor((16 - outW) / 2);
    const offY = 16 - outH - (bob ? 0 : 1);
    pixels.forEach((pixel, i) => {
      if (!pixel) return;
      const x = offX + (i % outW);
      const y = offY + Math.floor(i / outW);
      if (y < 0 || y > 15) return;
      const [r, g, b] = palette[nearest(palette, pixel)];
      img.data.set([r, g, b, 255], (y * 16 + x) * 4);
    });
    ctx.putImageData(img, 0, 0);
    return c;
  });
}

const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest = (palette, color) => palette.reduce((best, c, i) => (distance(c, color) < distance(palette[best], color) ? i : best), 0);
const luminance = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/** a small k-means, seeded by luminance thirds; the darkest centre is pushed down to act as an outline */
function kmeans(points, k) {
  if (!points.length) return [[0, 0, 0]];
  const sorted = [...points].sort((a, b) => luminance(a) - luminance(b));
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) * sorted.length) / k)]);

  for (let round = 0; round < 8; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const point of points) {
      const sum = sums[nearest(centers, point)];
      sum[0] += point[0]; sum[1] += point[1]; sum[2] += point[2]; sum[3]++;
    }
    centers = sums.map((sum, i) => (sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] : centers[i]));
  }

  centers.sort((a, b) => luminance(a) - luminance(b));
  centers[0] = centers[0].map((c) => c * 0.35);
  return centers.map((c) => c.map(Math.round));
}
