#!/usr/bin/env python3
"""Generate branded Pokemon Agents *badge* social cards (HTML) for several platforms.

Same design language as the launch set (../launch/gen.py): crystal-blue paper,
deep navy ink, gold spark, Press Start 2P pixel face, the faint pixel-grid wash.
Where the launch cards held the live demo in a Game-Boy device, these hold the
eight gym badges in a navy "badge case" panel echoing that device screen.

Every badge, its name and what earns it are lifted verbatim from the game's own
rule table (src/rules.mjs BADGES) so the card can't drift from the product. The
raw badge sprite sheet (gfx/trainer_card/badges.png, 16x16 per badge, stacked)
is inlined as base64 and colourised in-page with Crystal's own two-bit maths
(shade = 3 - round(gray/85)) and the trainer-card badge palette, so the art is
the real sprite, not a redraw.
"""
import base64
import pathlib

HERE = pathlib.Path(__file__).parent
# the real sprite sheet the web app draws from
BADGE_PNG = pathlib.Path.home() / "code/pokemon-agents/.cache/assets/gfx/trainer_card/badges.png"
BADGES_B64 = base64.b64encode(BADGE_PNG.read_bytes()).decode()

GOV = "pokemonagents.dev"
DISCLAIMER = ("A non-commercial fan project. Not affiliated with or endorsed by "
              "Nintendo, Game Freak, Creatures or The Pokémon Company.")

# id, NAME, earned-by (from src/rules.mjs BADGES), legendary it releases (README)
BADGES = [
    ("zephyr",  "ZEPHYR",  "first commit",            None),
    ("hive",    "HIVE",    "10 green test runs",      None),
    ("plain",   "PLAIN",   "fix a red test, same run", "Raikou"),
    ("fog",     "FOG",     "first merge",             "Suicune"),
    ("storm",   "STORM",   "a 7-day streak",          "Entei"),
    ("mineral", "MINERAL", "100 commits",             None),
    ("glacier", "GLACIER", "a clean session",         None),
    ("rising",  "RISING",  "100 sessions",            "Lugia"),
]

FONTS = """
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Press+Start+2P&display=swap" rel="stylesheet">
"""

# Tokens copied from ../launch/gen.py so the two sets read as one product.
BASE_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --ground:#E9F1FB; --surface:#FFFFFF; --ink:#17284A; --ink2:#3D507A; --ink3:#7686A6;
  --accent:#2F6DB5; --gold:#F2B417; --screen:#0E1B33; --sky:#BFD9F2;
  --serif:'Young Serif',Georgia,serif; --sans:'Hanken Grotesk',system-ui,sans-serif;
  --mono:'Space Mono',ui-monospace,monospace; --pixel:'Press Start 2P',ui-monospace,monospace;
}
html,body{background:#0b1226}
.card{position:relative; overflow:hidden; background:
  radial-gradient(130% 100% at 100% 0%, #F3F8FE 0%, var(--ground) 55%, #DCE8F8 100%);
  color:var(--ink); font-family:var(--sans); display:flex;}
.card::before{content:""; position:absolute; inset:0; opacity:.5;
  background-image:radial-gradient(var(--sky) 1px, transparent 1.4px);
  background-size:22px 22px; -webkit-mask:linear-gradient(180deg, #000, transparent 70%);
          mask:linear-gradient(180deg, #000, transparent 70%);}
.card>*{position:relative}
.eyebrow{font-family:var(--pixel); color:var(--accent); text-transform:uppercase;
  letter-spacing:0; display:flex; align-items:center; gap:.7em;}
.eyebrow .live{width:.62em;height:.62em;border-radius:50%;background:var(--gold);
  box-shadow:0 0 0 .28em rgba(242,180,23,.28)}
.h{font-family:var(--pixel); color:var(--ink); line-height:1.4; letter-spacing:0; font-weight:400}
.h em{font-family:var(--pixel); font-style:normal; color:var(--accent)}
.sub{font-family:var(--pixel); color:var(--ink2); line-height:1.6; letter-spacing:0}
.sub .lead{color:var(--ink)}
.handle{font-family:var(--pixel); color:var(--ink); font-weight:400}
.foot{font-family:var(--pixel); color:var(--ink3); line-height:1.65; letter-spacing:0}

/* the badge case: a navy panel echoing the device screen of the launch cards */
.case{background:linear-gradient(165deg,#15294b,#0b1627);
  box-shadow:0 40px 80px -36px rgba(14,27,51,.55), inset 0 0 0 1px rgba(255,255,255,.08);
  display:grid; align-content:center;}
.badge{display:flex; flex-direction:column; align-items:center; text-align:center;}
.badge canvas{image-rendering:pixelated; filter:drop-shadow(0 3px 6px rgba(0,0,0,.45));}
.badge .bname{font-family:var(--pixel); color:#F6D978; font-weight:400}
.badge .bwhy{font-family:var(--pixel); color:#AFC2E4; line-height:1.55}
.badge .brel{font-family:var(--pixel); color:var(--gold)}
"""

# Draws the real 16x16 badge sprite into a scaled, pixelated canvas, using the
# web app's own shade maths + the trainer-card badge palette.
BADGE_JS = """
<script>
const SHEET = "data:image/png;base64,%s";
const PAL = [[248,248,248],[248,208,64],[184,112,24],[40,24,8]];
const ORDER = %s;  // index of each badge id in the sheet (BADGE_ORDER in screens.mjs)
function shadeAt(d,w,x,y){return 3 - Math.round(d[(y*w+x)*4]/85);}
const img = new Image();
img.onload = () => {
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  const sctx = src.getContext('2d'); sctx.imageSmoothingEnabled=false;
  sctx.drawImage(img,0,0);
  const d = sctx.getImageData(0,0,img.width,img.height).data;
  document.querySelectorAll('.badge[data-idx]').forEach(el => {
    const idx = ORDER[+el.dataset.idx];
    const scale = +el.dataset.scale || 6;
    const c = document.createElement('canvas');
    c.width = 16*scale; c.height = 16*scale;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled=false;
    for (let y=0;y<16;y++) for (let x=0;x<16;x++){
      const s = shadeAt(d, img.width, x, idx*16 + y);
      if (s===0) continue;                 // colour 0 is transparent on the case
      ctx.fillStyle = `rgb(${PAL[s].join(',')})`;
      ctx.fillRect(x*scale, y*scale, scale, scale);
    }
    el.querySelector('.slot').appendChild(c);
  });
  document.documentElement.dataset.badgesReady = '1';
};
img.src = SHEET;
</script>
"""

# sheet index per badge id, from BADGE_ORDER in web/js/screens.mjs
SHEET_ORDER = ['zephyr','hive','plain','fog','storm','mineral','glacier','rising']


def badge_tile(i, b, scale, name_px, why_px, gap):
    _id, name, why, rel = b
    rel_html = f'<div class="brel" style="margin-top:{gap}px">&uarr; {rel}</div>' if rel else ''
    return f"""
    <div class="badge" data-idx="{SHEET_ORDER.index(_id)}" data-scale="{scale}">
      <div class="slot" style="line-height:0; margin-bottom:{gap}px"></div>
      <div class="bname" style="font-size:{name_px}px; margin-bottom:{max(6,gap-6)}px">{name}</div>
      <div class="bwhy" style="font-size:{why_px}px">{why}</div>
      {rel_html}
    </div>"""


def case(tiles_html, cols, pad, colgap, rowgap, radius):
    return f"""
    <div class="case" style="grid-template-columns:repeat({cols},1fr);
      padding:{pad}px; column-gap:{colgap}px; row-gap:{rowgap}px; border-radius:{radius}px;">
      {tiles_html}
    </div>"""


def page(w, h, body, extra_css=""):
    order_js = "[" + ",".join(str(SHEET_ORDER.index(b[0])) for b in BADGES) + "]"
    # NB: data-idx already encodes the sheet index, so ORDER is identity here,
    # but kept explicit so the mapping is auditable in the rendered file.
    ident = "[" + ",".join(str(i) for i in range(len(BADGES))) + "]"
    return f"""<!doctype html><html><head><meta charset="utf-8">{FONTS}
<style>{BASE_CSS}
.card{{width:{w}px;height:{h}px}}
{extra_css}</style></head><body>
<div class="card">{body}</div>
{BADGE_JS % (BADGES_B64, ident)}
</body></html>"""


def tiles(scale, name_px, why_px, gap):
    return "".join(badge_tile(i, b, scale, name_px, why_px, gap) for i, b in enumerate(BADGES))


# ---- Twitter / X : 1600 x 900 landscape ----
twitter_css = """
.card{flex-direction:row; align-items:center; gap:58px; padding:78px 86px}
.col-l{flex:0 0 40%; display:flex; flex-direction:column; align-items:flex-start}
.eyebrow{font-size:15px; margin-bottom:26px}
.h{font-size:33px; margin-bottom:26px}
.sub{font-size:14px; max-width:430px; margin-bottom:34px}
.handle{font-size:16px}
.foot{position:absolute; left:86px; bottom:36px; font-size:11px; max-width:86%}
.col-r{flex:1 1 60%; display:flex; justify-content:center}
.case{width:100%}
"""
twitter = page(1600, 900, f"""
  <div class="col-l">
    <div class="h">Earn badges<br>as you code.</div>
    <div class="sub"><span class="lead">Track your progress, from your first merge to 100 commits.</span><br>Collect badges like a <em>Pokémon Master</em>.</div>
    <div class="handle">{GOV}</div>
  </div>
  <div class="col-r">{case(tiles(6, 13, 10, 12), 4, 56, 36, 40, 30)}</div>
  <div class="foot">{DISCLAIMER}</div>
""", twitter_css)

# ---- Instagram square : 1080 x 1080 ----
ig_sq_css = """
.card{flex-direction:column; padding:74px 70px 60px; align-items:center; text-align:center}
.eyebrow{font-size:14px; margin-bottom:22px; justify-content:center}
.h{font-size:34px; margin-bottom:22px}
.sub{font-size:13px; max-width:760px; margin:0 auto 34px}
.case{width:100%}
.handle{font-size:15px; margin-top:30px}
.foot{position:absolute; left:0; right:0; bottom:26px; font-size:10px; padding:0 70px}
"""
ig_square = page(1080, 1080, f"""
  <div class="h">Earn badges as you code.</div>
  <div class="sub">Track your progress, from your first merge to 100 commits. Collect badges like a <em>Pokémon Master</em>.</div>
  {case(tiles(5, 12, 9.5, 11), 4, 48, 30, 34, 28)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", ig_sq_css)

# ---- Instagram portrait / Threads : 1080 x 1350 (4:5) ----
portrait_css = """
.card{flex-direction:column; padding:70px 74px 58px; align-items:center; text-align:center}
.eyebrow{font-size:14px; margin-bottom:22px; justify-content:center}
.h{font-size:34px; margin-bottom:20px}
.sub{font-size:13px; max-width:720px; margin:0 auto 32px}
.case{width:100%}
.handle{font-size:15px; margin-top:26px}
.foot{position:absolute; left:0; right:0; bottom:26px; font-size:10px; padding:0 74px}
"""
portrait = page(1080, 1350, f"""
  <div class="h">Earn badges<br>as you code.</div>
  <div class="sub">Track your progress, from your first merge to 100 commits. Collect badges like a <em>Pokémon Master</em>.</div>
  {case(tiles(5, 12, 9.5, 10), 2, 46, 50, 30, 28)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", portrait_css)

# ---- Story : 1080 x 1920 (9:16), content inside the safe band ----
story_css = """
.card{flex-direction:column; padding:300px 78px 300px; align-items:center; text-align:center;
  justify-content:flex-start}
.eyebrow{font-size:16px; margin-bottom:30px; justify-content:center}
.h{font-size:40px; margin-bottom:26px}
.sub{font-size:15px; max-width:820px; margin:0 auto 50px}
.case{width:100%}
.handle{font-size:18px; margin-top:44px}
.foot{position:absolute; left:0; right:0; bottom:250px; font-size:12px; padding:0 90px}
"""
story = page(1080, 1920, f"""
  <div class="h">Earn badges<br>as you code.</div>
  <div class="sub">Track your progress, from your first merge to 100 commits. Collect badges like a <em>Pokémon Master</em>.</div>
  {case(tiles(6, 14, 11, 13), 2, 60, 56, 48, 32)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", story_css)

OUT = {
    "card-badges-twitter.html": twitter,
    "card-badges-instagram-square.html": ig_square,
    "card-badges-portrait.html": portrait,
    "card-badges-story.html": story,
}
for name, html in OUT.items():
    (HERE / name).write_text(html)
    print("wrote", name)
