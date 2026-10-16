# Marketing assets

Social/launch assets for Pokémon Agents, organised by campaign. Each campaign
folder holds the finished, drop-in deliverables and its own `copy.md` (captions,
hooks, the non-affiliation line). Working files (HTML cards + render scripts)
live under `_build/<campaign>/` and are not needed to post.

```
marketing/
├── launch/                 first launch campaign — "your coding agents, as Pokémon"
│   ├── posts/              twitter-x 16:9, instagram 1:1, portrait 4:5
│   ├── stories/            9:16 story card
│   ├── reels/              9:16 demo reel (mp4)
│   ├── motion/             raw demo gif
│   └── copy.md
├── badges/                 badges campaign — the 8 gym badges, earned from real work
│   ├── posts/              twitter-x 16:9, instagram 1:1, portrait 4:5
│   ├── stories/            9:16 story card
│   ├── motion/             badge-card gif + full demo gif (dummy-data capture)
│   └── copy.md
└── _build/                 source HTML + Playwright render scripts (one dir per campaign)
    ├── launch/
    └── badges/
```

## Rebuilding

Each campaign's cards are generated from a Python file that writes HTML, then
rendered to PNG with Playwright at exact canvas sizes:

```
cd _build/badges
python3 gen_badges.py     # writes the card-*.html files
node render.mjs           # screenshots each to ../../badges/{posts,stories}/
```

## Motion / gifs

The gifs are recorded from the game running on a fully synthetic world (temp
transcripts, a fake `claude`, invented projects on their own port — never your
real sessions), then cropped to the screen and encoded with ffmpeg:

```
npm run demo                      # full ~42s product loop -> artifacts/demo/pokemon-agents-demo.gif
node scripts/demo-badges.mjs      # ~10s badge-card loop   -> artifacts/demo/pokemon-agents-badges.gif
```

Copy the result into the relevant campaign's `motion/` folder. The gifs are a
screen capture of Nintendo's artwork, so they are campaign assets here but are
not committed to the repo.

Design tokens (crystal-blue paper, deep navy ink, gold spark, Press Start 2P
pixel face) are shared across campaigns so every asset reads as one product.
The badge art is the game's real sprite sheet, colourised in-page with the same
two-bit palette maths the web app uses — so the cards can't drift from what the
product actually shows.

Every asset carries the non-commercial fan-project disclaimer. Keep it on the
posts and in the captions.
