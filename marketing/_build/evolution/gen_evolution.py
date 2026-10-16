#!/usr/bin/env python3
"""Generate branded Pokemon Agents *evolution* social cards (HTML) for several platforms.

Same design language as the launch set (../launch/gen.py) and the badge set
(../badges/gen_badges.py): crystal-blue paper, deep navy ink, gold spark,
Press Start 2P pixel face, the faint pixel-grid wash.

Where the badge cards hold the eight gym badges in a navy case, these hold a
real frame from the product in that same panel: the moment a project's
CHARMANDER finished evolving into CHARMELEON. The frame is lifted straight out
of scripts/demo-evolution.mjs's recording rather than redrawn, the same way the
launch cards used frames from the demo, so the card cannot drift from what the
game actually shows.

The four ways to evolve are the ones the game implements (src/rules.mjs
findEvolution + README "Progression"): level, stone, friendship and trade.
Nothing here is embellished -- if it is on the card, the code does it.
"""
import base64
import pathlib

HERE = pathlib.Path(__file__).parent
HERO_B64 = base64.b64encode((HERE / "hero-evolved.png").read_bytes()).decode()

GOV = "pokemonagents.dev"
DISCLAIMER = ("A non-commercial fan project. Not affiliated with or endorsed by "
              "Nintendo, Game Freak, Creatures or The Pokémon Company.")

HEADLINE = "Evolution"
HEADLINE_WIDE = "Evolution"
SUB = ("Your Pok&eacute;mon evolves by the same rules as the games. What changes is the "
       "trigger: your real coding work is what moves it along.")

# (name, what actually triggers it) -- straight from the rule table
# Kept to one line each: wrapped rows in a two-column grid pick up a hanging
# indent that reads as ragged at card sizes.
WAYS = [
    ("LEVEL",      "commits, merges, green tests, sessions"),
    ("STONE",      "earned from a gym badge"),
    ("FRIENDSHIP", "active days and commits, day or night"),
    ("TRADE",      "a session handing work to a subagent"),
]

FONTS = """
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Press+Start+2P&display=swap" rel="stylesheet">
"""

# Tokens copied from ../launch/gen.py so every campaign reads as one product.
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
.h{font-family:var(--pixel); color:var(--ink); line-height:1.4; letter-spacing:0; font-weight:400}
.h em{font-family:var(--pixel); font-style:normal; color:var(--accent)}
.sub{font-family:var(--pixel); color:var(--ink2); line-height:1.6; letter-spacing:0}
.handle{font-family:var(--pixel); color:var(--ink); font-weight:400}
.foot{font-family:var(--pixel); color:var(--ink3); line-height:1.65; letter-spacing:0}

/* the device -- copied verbatim from ../launch/gen.py so the evolution set sits
   in the same hardware as the launch cards rather than a lookalike */
.device{background:linear-gradient(165deg,#46474a,#1c1c1e); box-shadow:
  0 40px 80px -36px rgba(14,27,51,.55), inset 0 0 0 1px rgba(255,255,255,.08);}
.cam{display:flex; justify-content:center}
.cam::before{content:""; border-radius:50%; background:#0a0a0b; box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.screen{overflow:hidden; background:#000; line-height:0}
.screen img{width:100%; height:auto; display:block; image-rendering:pixelated}

/* the four ways to evolve */
.ways{display:grid; gap:0}
.way{display:grid; grid-template-columns:auto 1fr; align-items:baseline;}
.way .wn{font-family:var(--pixel); color:var(--accent); font-weight:400}
.way .ww{font-family:var(--pixel); color:var(--ink2); line-height:1.6}
/* no ::before here: in a two-column grid it lands as a THIRD item and shunts the
   label out of column one, which is exactly what it did on the first render. */
"""


def ways_html(name_px, why_px, rowgap, colgap):
    rows = "".join(f"""
      <div class="way" style="column-gap:{colgap}px">
        <div class="wn" style="font-size:{name_px}px">{n}</div>
        <div class="ww" style="font-size:{why_px}px">{w}</div>
      </div>""" for n, w in WAYS)
    return f'<div class="ways" style="row-gap:{rowgap}px">{rows}</div>'


def device(pad, radius, screen_radius, cam):
    """The launch set's device(), same arguments and same markup."""
    return f"""
    <div class="device" style="padding:{pad}px; border-radius:{radius}px;">
      <div class="cam" style="padding-bottom:{cam}px;"><span style="width:{max(5, cam)}px;height:{max(5, cam)}px"></span></div>
      <div class="screen" style="border-radius:{screen_radius}px;">
        <img src="data:image/png;base64,{HERO_B64}" alt="Pokemon Agents evolution">
      </div>
    </div>"""


def page(w, h, body, extra_css=""):
    return f"""<!doctype html><html><head><meta charset="utf-8">{FONTS}
<style>{BASE_CSS}
.card{{width:{w}px;height:{h}px}}
{extra_css}</style></head><body>
<div class="card">{body}</div>
</body></html>"""


# ---- Twitter / X : 1600 x 900 landscape ----
twitter_css = """
.card{flex-direction:row; align-items:center; gap:58px; padding:78px 86px}
.col-l{flex:0 0 44%; display:flex; flex-direction:column; align-items:flex-start}
.h{font-size:30px; margin-bottom:24px}
.sub{font-size:13px; max-width:470px; margin-bottom:32px}
.ways{margin-bottom:34px}
.handle{font-size:16px}
.foot{position:absolute; left:86px; bottom:36px; font-size:11px; max-width:86%}
.col-r{flex:1 1 56%; display:flex; justify-content:center}
.device{width:100%}
"""
twitter = page(1600, 900, f"""
  <div class="col-l">
    <div class="h">{HEADLINE}</div>
    <div class="sub">{SUB}</div>
    {ways_html(12, 11, 16, 16)}
    <div class="handle">{GOV}</div>
  </div>
  <div class="col-r">{device(18, 40, 22, 9)}</div>
  <div class="foot">{DISCLAIMER}</div>
""", twitter_css)

# ---- Instagram square : 1080 x 1080 ----
square_css = """
.card{flex-direction:column; align-items:center; text-align:center; padding:74px 70px}
.h{font-size:27px; margin-bottom:20px}
.sub{font-size:12px; max-width:760px; margin:0 auto 30px}
.device{width:560px; margin:0 auto 30px}
.ways{text-align:left; max-width:700px; margin:0 auto 26px}
.handle{font-size:16px}
.foot{position:absolute; left:0; right:0; bottom:28px; font-size:10px; padding:0 70px}
"""
ig_square = page(1080, 1080, f"""
  <div class="h">{HEADLINE_WIDE}</div>
  <div class="sub">{SUB}</div>
  {device(16, 36, 20, 8)}
  {ways_html(11, 10, 13, 14)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", square_css)

# ---- Portrait 4:5 : 1080 x 1350 ----
portrait_css = """
.card{flex-direction:column; align-items:center; text-align:center; padding:92px 76px}
.h{font-size:30px; margin-bottom:24px}
.sub{font-size:13px; max-width:780px; margin:0 auto 36px}
.device{width:620px; margin:0 auto 38px}
.ways{text-align:left; max-width:740px; margin:0 auto 34px}
.handle{font-size:18px}
.foot{position:absolute; left:0; right:0; bottom:40px; font-size:11px; padding:0 76px}
"""
portrait = page(1080, 1350, f"""
  <div class="h">{HEADLINE}</div>
  <div class="sub">{SUB}</div>
  {device(16, 38, 20, 8)}
  {ways_html(12, 11, 15, 15)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", portrait_css)

# ---- Story 9:16 : 1080 x 1920, held inside the safe band ----
story_css = """
.card{flex-direction:column; align-items:center; text-align:center; padding:300px 86px 260px}
.h{font-size:31px; margin-bottom:26px}
.sub{font-size:14px; max-width:800px; margin:0 auto 42px}
.device{width:660px; margin:0 auto 44px}
.ways{text-align:left; max-width:760px; margin:0 auto 42px}
.handle{font-size:18px}
.foot{position:absolute; left:0; right:0; bottom:250px; font-size:12px; padding:0 90px}
"""
story = page(1080, 1920, f"""
  <div class="h">{HEADLINE}</div>
  <div class="sub">{SUB}</div>
  {device(18, 42, 24, 9)}
  {ways_html(13, 12, 17, 16)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", story_css)

# ---- Reel background: the same vertical device, screen left EMPTY so the gif can be
# composited into it (the launch set does this with card-reel-bg.html + reel-screen-rect.json).
reel_bg_css = story_css + """
.screen{background:#000}
.screen img{visibility:hidden}
"""
reel_bg = page(1080, 1920, f"""
  <div class="h">{HEADLINE}</div>
  <div class="sub">{SUB}</div>
  {device(18, 42, 24, 9).replace('class="screen"', 'class="screen" id="reel-screen"', 1)}
  {ways_html(13, 12, 17, 16)}
  <div class="handle">{GOV}</div>
  <div class="foot">{DISCLAIMER}</div>
""", reel_bg_css)

OUT = {
    "card-evolution-reel-bg.html": reel_bg,
    "card-evolution-twitter.html": twitter,
    "card-evolution-instagram-square.html": ig_square,
    "card-evolution-portrait.html": portrait,
    "card-evolution-story.html": story,
}
for name, html in OUT.items():
    (HERE / name).write_text(html)
    print("wrote", name)
