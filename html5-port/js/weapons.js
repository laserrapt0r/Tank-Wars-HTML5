// weapons.js — weapon table and impact effects, faithful to the fire routine
// sub_bd08 and its category dispatch (re/spec_rules.md §1, §2, §3).
//
// WEAPON_TABLE: index 1..13 (0 unused to keep 1-based like the original).
//   name, cat(egory), price($ per lot), lot(size), B(radius/param).
// Category: 0 crater bomb · 1 earthquake · 2 ping-pong · 3 CR-Inducer ·
//           4 Julia · 5 Captain Caveman · 6 protection item.

import { COL } from './palette.js';
import { FIELD, makeCrater, surfaceYAt } from './terrain.js';

const WEAPON_TABLE = [
  null,
  { name: 'HandGrenade',              cat: 0, price: 1000,  lot: 100, B: 4   },
  { name: '5 kT Nuke',               cat: 0, price: 2000,  lot: 10,  B: 30  },
  { name: '5 MT Nuke',               cat: 0, price: 10000, lot: 1,   B: 100 },
  { name: 'Earthquake',              cat: 1, price: 5000,  lot: 1,   B: 30  },
  { name: 'Ping Pong Jack',          cat: 2, price: 5000,  lot: 5,   B: 10  },
  { name: 'ChainReactionInducer 256',cat: 3, price: 5000,  lot: 1,   B: 4   },
  { name: 'ChainReactionInducer 512',cat: 3, price: 10000, lot: 1,   B: 8   },
  { name: 'Julia 256',               cat: 4, price: 5000,  lot: 1,   B: 4   },
  { name: 'Julia 512',               cat: 4, price: 10000, lot: 1,   B: 8   },
  { name: 'Captain Caveman',         cat: 5, price: 20000, lot: 1,   B: 5   },
  { name: 'Parachute',               cat: 6, price: 10000, lot: 1,   B: 0   },
  { name: 'Quake Protection',        cat: 6, price: 10000, lot: 1,   B: 0   },
  { name: 'Protection Shield',       cat: 6, price: 20000, lot: 1,   B: 0   },
];
const WPN = { HANDGRENADE:1, NUKE5KT:2, NUKE5MT:3, EARTHQUAKE:4, PINGPONG:5,
  CR256:6, CR512:7, JULIA256:8, JULIA512:9, CAVEMAN:10,
  PARACHUTE:11, QUAKEPROT:12, SHIELD:13 };

// ---- direct-blast crew damage (common loop 0xc8ca), returns men killed (enemies) ----
// impact = {x,y}; shooter = index of firing player; players = live array.
function applyBlastDamage(players, shooterIdx, impact, B) {
  let menKilled = 0;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    if (!t.alive) continue;
    const dx = t.x - impact.x;
    const dy = (t.y - impact.y) - 4.0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const D = Math.max(1, Math.round(dist - 3.0));
    if (B > D) {
      let dmg = t.hasShield ? Math.floor(B / D) : Math.floor((80 * B) / D);
      dmg = Math.min(dmg, t.crew);
      t.crew -= dmg;
      t.power = Math.min(t.power, 10 * t.crew);
      if (i !== shooterIdx) menKilled += dmg;
      if (t.crew <= 0) { t.crew = 0; }
    }
  }
  return menKilled;
}

// Every offensive effect returns { menKilled, anim } where `anim` drives a progressive,
// sound-tracked reveal in the game loop (game.stepAnim), matching the original's animated
// weapons. Terrain is carved during the animation, not instantly. `anim` kinds:
//   {kind:'crater', x,y,B}        — grow a red disc r=0..B (Sound 200+2r) then lay the crater
//   {kind:'ops', ops:[{px:[idx],f:Hz}]} — reveal batches of pixel-ops, playing each op's tone

// collect the GROUND pixels to erase for a "removal op", plus its sound freq and its
// processing weight (`cost` ≈ pixels the original touched for this op — replayed at
// EFFECT_SAMPLES_PER_SEC in game.stepAnim so the pace matches the CPU-bound original)
function op(vga, pixels, f, cost) { return { px: pixels, f, cost: cost || (pixels.length + 1) }; }

// ---- category 0: crater bomb (grenade / nukes) — animated red flash then crater ----
function effectCrater(vga, players, shooterIdx, impact, B) {
  const menKilled = applyBlastDamage(players, shooterIdx, impact, B);
  const box = { minX: Math.max(4, impact.x - B), maxX: Math.min(635, impact.x + B),
                maxY: Math.min(475, impact.y + B) };
  return { menKilled, anim: { kind: 'crater', x: impact.x, y: impact.y, B }, box };
}

// ---- category 1: earthquake — DECOMPILED 1:1 from sub_3511 (driver), sub_2f9a
// (recursive fissure walker) and sub_2c0d (strip-line eraser):
//   driver:  count = 20·power;  dir normalised to length 0.7 (with the original's
//            quirk of re-using the already-normalised vx for vy's norm);
//            start = impact − (0.005·count·vx/2, −0.005·count·vy/2).
//   walker:  angle = arctan(vy/vx) (+π if vx<0); per step: (dx,dy)=0.7·(cos,sin);
//            pos += (dx,dy); angle += rand·0.08 − 0.04; draw TWO strip lines from the
//            path to its perpendicular offset 0.005·count·(dy,−dx)  → a WEDGE that is
//            0.0035·count px wide at the epicentre and tapers to 0 at the tip.
//            With p=1/20 per step: n = Random(round(0.2·count)); n odd → branch at
//            −45° from the strip edge at (count−n); n even → branch at +45° (literal
//            offset arithmetic below) and the parent shifts by 0.005·n·(dy,−dx).
//            Parent loses the branch length: count −= n. Always: count−−.
//   eraser:  skip line if NEITHER endpoint is on GROUND; sample round(0.0035·count)+1
//            points; each GROUND pixel → colour 0 (shows sky) with a Sound(500)/NoSound
//            PULSE (the rattling rumble); count>1000 → also (x+1,y),(x+1,y+1),(x,y+1).
// The reveal is queued as ops (one per strip line) with `cost` = sample count, so the
// animation replays at the original's CPU-bound pace (see EFFECT_SAMPLES_PER_SEC).
function effectEarthquake(vga, players, shooterIdx, impact, power, vel, rnd) {
  const W = vga.W, ops = [];
  const box = { minX: 635, maxX: 4, maxY: 63 };            // driver's bbox init
  let count = 20 * power;                                   // count = 20·power (0xc261)
  let vx = (vel && vel.x) || (impact.dx || 1);
  let vy = (vel && vel.y) || 0.5;
  const spd1 = Math.sqrt(vx * vx + vy * vy) || 1;
  vx = 0.7 * vx / spd1;
  const spd2 = Math.sqrt(vy * vy + vx * vx) || 1;           // original quirk: uses new vx
  vy = 0.7 * vy / spd2;
  let X0 = impact.x - count * 0.005 * vx / 2;
  let Y0 = impact.y + count * 0.005 * vy / 2;

  const isGround = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < FIELD.X0 || x > FIELD.X1 || y < FIELD.YTOP || y > FIELD.YBOT) return false;
    return vga.buf[y * W + x] === COL.GROUND;
  };
  // sub_2c0d: strip line from (x1,y1) to (x2,y2), interpolated with n+1 samples
  function stripLine(x1, y1, x2, y2, cur) {
    if (!isGround(x1, y1) && !isGround(x2, y2)) return;     // both endpoints off ground
    for (const [bx, by] of [[x1, y1], [x2, y2]]) {          // bbox tracking (min/max)
      const rx = Math.round(bx), ry = Math.round(by);
      if (rx < box.minX) box.minX = rx; if (rx > box.maxX) box.maxX = rx;
      if (ry > box.maxY) box.maxY = ry;
    }
    const n = Math.round(0.0035 * cur) + 1;
    const sx = (x2 - x1) / n, sy = (y2 - y1) / n;
    const px = [];
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x1 + i * sx), y = Math.round(y1 + i * sy);
      if (x < 4 || x > 635 || y < 63 || y > 475) continue;  // sub_2c0d clip window
      const idx = y * W + x;
      if (vga.buf[idx] !== COL.GROUND) continue;
      px.push(idx);
      if (cur > 1000) {                                      // thick 2x2 for big quakes
        if (x + 1 <= 635) px.push(idx + 1);
        if (x + 1 <= 635 && y + 1 <= 475) px.push(idx + W + 1);
        if (y + 1 <= 475) px.push(idx + W);
      }
    }
    ops.push({ px, f: 500, cost: n + 1 });
  }
  // sub_2f9a: recursive fissure walker
  function crack(cnt, cvy, cvx, Y, X) {
    let angle = (cvx === 0) ? Math.PI / 2 : Math.atan(cvy / cvx);
    if (cvx < 0) angle += Math.PI;
    let guard = 0;
    while (cnt > 0 && guard++ < 60000) {
      const dy = Math.sin(angle) * 0.7, dx = Math.cos(angle) * 0.7;
      const perpX = 0.005 * cnt * dy, perpY = -0.005 * cnt * dx;
      X += dx; Y += dy;
      angle += rnd.nextFloat() * 0.08 - 0.04;               // jitter ±0.04 rad
      stripLine(X, Y, X + perpX, Y + perpY, cnt);
      stripLine(X + dx, Y + dy, X + dx + perpX, Y + dy + perpY, cnt);
      if (rnd.next(20) === 0) {                             // 1/20: spawn a branch
        const k = Math.round(0.2 * cnt);
        const nb = k > 0 ? rnd.next(k) : 0;                 // branch length
        if (nb & 1) {                                       // odd → −45° twig
          const bx = X + 0.005 * (cnt - nb) * dy;
          const by = Y - 0.005 * (cnt - nb) * dx;
          crack(nb, (dy - dx) / Math.SQRT2, (dx + dy) / Math.SQRT2, by, bx);
        } else if (nb > 0) {                                // even → +45° twig
          const A = (dx + dy) / Math.SQRT2, C = (dx - dy) / Math.SQRT2;
          const bx = X + 0.005 * nb * (dy - A);
          const by = Y - 0.005 * nb * (dx - C);
          crack(nb, (dx + dy) / Math.SQRT2, (dx - dy) / Math.SQRT2, by, bx);
          X += 0.005 * nb * dy;                             // parent shifts (347c..34f9)
          Y -= 0.005 * nb * dx;
        }
        cnt -= nb;
      }
      cnt--;
    }
  }
  crack(count, vy, vx, Y0, X0);

  // damage: tanks inside the fissure's bbox lose 50% crew (unless Quake Protection),
  // plus the common direct blast at the epicentre.
  const minX = Math.max(box.minX, 4), maxX = Math.min(box.maxX, 635),
        maxY = Math.min(box.maxY, 475);
  let menKilled = 0;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    if (!t.alive || t.hasQuake) continue;
    if (t.x >= minX && t.x <= maxX && t.y <= maxY) {
      const before = t.crew;
      t.crew = Math.floor(t.crew / 2);                      // exact integer halve
      t.power = Math.min(t.power, 10 * t.crew);
      if (i !== shooterIdx) menKilled += (before - t.crew);
    }
  }
  menKilled += applyBlastDamage(players, shooterIdx, impact, 30);
  // dispatch (0xc394..0xc43c) expands the collapse box by ±B(=30) around the impact
  const cbox = {
    minX: Math.max(4, Math.min(minX, impact.x - 30)),
    maxX: Math.min(635, Math.max(maxX, impact.x + 30)),
    maxY: Math.min(475, Math.max(maxY, impact.y + 30)),
  };
  return { menKilled, anim: { kind: 'ops', ops }, box: cbox };
}

// ---- category 2: Ping Pong Jack — DECOMPILED 1:1 from sub_371d (all TP-real
// constants decoded). The routine has TWO loops:
//   LOOP 1 (descent, 0x37ef): vx,vy ÷ 3.0; per step pos += vel; if the Reflecting-Walls
//     flag [0xcf7] is set, bounce off x=635 (→625) / x=4 (→14) / ceiling y=63 (→64),
//     flipping the matching velocity; vy += 0.00012222 (=0.0011/9); erase a 21-px swath
//     (round(x)−10..+10) with Sound(1000−y). Runs until y ≥ 475 (floor). Busy-wait 1.0.
//   LOOP 2 (bounce-back, 0x3a6c): from the floor the ball carves straight UP through its
//     landing swath until it rises above the terrain there (while min_surface ≤ y: y−−,
//     erase swath). This is the "ping-pong" return and is NOT gated by the reflect flag.
//     Busy-wait 3.0 (3× slower than the descent).
// The direct blast (B=10) is at the ORIGINAL impact; the dug channel then collapses
// (sub_625d) and path casualties come from fall damage.
function effectPingPong(vga, players, shooterIdx, impact, vel, B, reflect) {
  const W = vga.W, ops = [];
  const box = { minX: 635, maxX: 4, maxY: 63 };
  let x = impact.x, y = impact.y;
  let vx = vel.x / 3.0, vy = vel.y / 3.0;               // velocities ÷ 3.0
  // erase the 21-px horizontal swath (round(x)−10..+10, clamped 4..635) at row round(y)
  const swath = (cx, cy, cost) => {
    const rx = Math.round(cx), ry = Math.round(cy);
    if (ry < 63 || ry > 475) { ops.push({ px: [], f: 0, cost }); return; }
    const xl = Math.max(4, rx - 10), xr = Math.min(635, rx + 10), px = [];
    for (let xx = xl; xx <= xr; xx++) { const idx = ry * W + xx; if (vga.buf[idx] === COL.GROUND) px.push(idx); }
    if (px.length) {
      if (xl < box.minX) box.minX = xl; if (xr > box.maxX) box.maxX = xr;
      if (ry > box.maxY) box.maxY = ry;
    }
    ops.push({ px, f: Math.max(0, 1000 - ry), cost });
  };
  // ---- LOOP 1 (0x37ef): parabolic descent to the floor (y ≥ 475). Wall/ceiling bounces
  // are gated by the Reflecting-Walls flag [0xcf7]; busy-wait factor 1.0/step.
  let guard = 0;
  while (Math.round(y) < 475 && guard++ < 12000) {
    x += vx; y += vy;                                   // RADD position
    if (reflect) {
      if (Math.round(x) + 10 >= 635) { x = 625; vx = -vx; }        // right wall
      else if (Math.round(x) - 10 <= 4) { x = 14; vx = -vx; }      // left wall
      if (Math.round(y) <= 63) { y = 64; vy = -vy; }               // ceiling
    }
    vy += 0.00012222;                                   // gravity (=0.0011/9)
    swath(x, y, 21);
  }
  // ---- LOOP 2 (0x3a6c): THE BOUNCE-BACK — from the floor the ball carves straight UP
  // through its landing swath until it rises above the terrain there. NOT gated by the
  // reflect flag (this is the ping-pong's defining behaviour); busy-wait factor 3.0/step.
  const rx = Math.round(x), xl = Math.max(4, rx - 10), xr = Math.min(635, rx + 10);
  let minSurf = 475;                                    // topmost stored ground in the swath
  for (let xx = xl; xx <= xr; xx++) { const s = surfaceYAt(vga, xx); if (s < minSurf) minSurf = s; }
  let ry = Math.round(y);
  guard = 0;
  while (minSurf <= ry && ry > 63 && guard++ < 600) {
    ry -= 1;                                            // rise one pixel
    swath(x, ry, 63);                                   // factor 3.0 ⇒ 3× the descent cost
  }
  const menKilled = applyBlastDamage(players, shooterIdx, impact, B);  // B=10 at ORIGINAL impact
  const cbox = {
    minX: Math.max(4, Math.min(box.minX, impact.x - B)),
    maxX: Math.min(635, Math.max(box.maxX, impact.x + B)),
    maxY: Math.min(475, Math.max(box.maxY, impact.y + B)),
  };
  return { menKilled, anim: { kind: 'ops', ops }, box: cbox };
}

// ---- category 3/4: CR-Inducer / Julia — DECOMPILED 1:1 from sub_2307 (recursive
// direction fractal, a space-filling-curve "eater") + driver sub_2b8c + dispatch:
//   size = B·64 (256/512), start = impact, dir = 2 (east) if vx>0 else 3 (west);
//   CR-Inducer: fractal flag = 1 (each expansion slot picks its ALT direction with
//   p=1/2 via Random(10) odd) — chaotic chain-reaction; Julia: flag = 0 → strictly
//   deterministic, self-similar. Base case (size==1): move 1 px (dirs 1,2:x+ 3,4:x−
//   5,6:y+ 7,8:y−), clip x∈[4,635], y≤475 (y≥63 when erasing), eat only GROUND
//   (continuous 500 Hz while eating). Production rules extracted from 0x2466..0x2b86:
//   each dir expands into 4 half-size sub-curves [alt|deterministic]:
const FRACTAL_RULES = {
  1: [[7, 8], [1, 2], [6, 5], [1, 2]],
  2: [[2, 1], [5, 6], [2, 1], [8, 7]],
  3: [[3, 4], [8, 7], [3, 4], [5, 6]],
  4: [[6, 5], [4, 3], [7, 8], [4, 3]],
  5: [[2, 1], [5, 6], [3, 4], [5, 6]],
  6: [[6, 5], [4, 3], [6, 5], [1, 2]],
  7: [[7, 8], [1, 2], [7, 8], [4, 3]],
  8: [[3, 4], [8, 7], [2, 1], [8, 7]],
};
const EATER_MOVE_COST = 0.5;   // integer-only work ≈ half a soft-float sample

function effectEater(vga, players, shooterIdx, impact, B, dirx, fractal, rnd) {
  const W = vga.W, size = B * 64;                       // 256 or 512 (B<<6 in 0xc56c)
  const ops = [];
  const box = { minX: 635, maxX: 4, maxY: 63 };
  const pos = { x: impact.x, y: impact.y };
  // batch base moves into ops so the queue stays manageable
  let batch = { px: [], f: 500, cost: 0 };
  const flush = () => { if (batch.cost > 0) { ops.push(batch); batch = { px: [], f: 500, cost: 0 }; } };
  function walk(sz, dir) {
    if (sz === 1) {                                      // base case: 1-px move + eat
      if (dir === 1 || dir === 2) pos.x++;
      else if (dir === 3 || dir === 4) pos.x--;
      else if (dir === 5 || dir === 6) pos.y++;
      else pos.y--;
      batch.cost += EATER_MOVE_COST;
      if (pos.x < 4 || pos.x > 635 || pos.y > 475 || pos.y < 63) return;   // clip (erase mode)
      const idx = pos.y * W + pos.x;
      if (vga.buf[idx] !== COL.GROUND) return;
      batch.px.push(idx);
      if (pos.x < box.minX) box.minX = pos.x; if (pos.x > box.maxX) box.maxX = pos.x;
      if (pos.y > box.maxY) box.maxY = pos.y;
      if (batch.px.length >= 48) flush();
      return;
    }
    const half = sz >> 1;
    for (const [alt, det] of FRACTAL_RULES[dir]) {
      const d = (fractal && (rnd.next(10) & 1)) ? alt : det;   // Random(10) odd → alt
      walk(half, d);
    }
  }
  walk(size, dirx > 0 ? 2 : 3);
  flush();
  const menKilled = applyBlastDamage(players, shooterIdx, impact, B);   // raw B (4/8)
  // dispatch expands the collapse box by ±B around the impact (0xc5d8ff)
  box.minX = Math.max(4, Math.min(box.minX, impact.x - B));
  box.maxX = Math.min(635, Math.max(box.maxX, impact.x + B));
  box.maxY = Math.min(475, Math.max(box.maxY, impact.y + B));
  return { menKilled, anim: { kind: 'ops', ops }, box };
}

// ---- category 5: Captain Caveman (sub_3bb7) ----
// Bores a horizontal TUNNEL at the shot's row through the hills in the shot direction,
// leaving a ~9px roof; stops at the first valley (surface at/below the shot row). Direct
// blast B=5 at the impact.
// ---- category 5: Captain Caveman — DECOMPILED 1:1 from sub_3bb7 (three walk phases +
// dig, all with the bounds test sub_3b4d = x∈[4,635] and the advance sub_3b7f = x±1 in
// the shot direction):
//   PHASE 1 (0x3bcb): advance from the impact until the pixel AT THE SHOT ROW is ground
//     (reach a hill face) — or run off the map.
//   PHASE 2 (0x3bee): keep advancing while the hill is shallow (surface+8 ≥ Y) and there
//     is still ground — i.e. skip low ground until a hill that rises >8 px above the row.
//   PHASE 3 (0x3c28): while surface+8 < Y (a tall hill), bore the column: erase rows
//     surface+9 .. Y (leaving a 9-px roof), Sound(700) per column; stop at the valley.
function effectCaveman(vga, players, shooterIdx, impact, dirx) {
  const W = vga.W, Y = impact.y, ops = [];
  const box = { minX: 635, maxX: 4, maxY: Math.min(475, Y + 1) };
  const inB = (x) => x >= 4 && x <= 635;
  const isGnd = (x, y) => (y >= 63 && y <= 475 && vga.buf[y * W + x] === COL.GROUND);
  let x = impact.x, g;
  // PHASE 1: walk to the hill face (first ground pixel at the shot row)
  g = 0; while (inB(x) && g++ < 2000 && !isGnd(x, Y)) x += dirx;
  // PHASE 2: skip shallow ground until a tall hill (surface+8 < Y); stop if no ground
  g = 0;
  while (inB(x) && g++ < 2000) {
    if (surfaceYAt(vga, x) + 8 < Y) break;               // tall hill reached -> dig
    if (!isGnd(x, Y)) break;                              // ran into open space -> stop
    x += dirx;
  }
  // PHASE 3: bore through the tall hill, leaving a 9-px roof, until the valley
  g = 0;
  while (inB(x) && g++ < 2000) {
    const s = surfaceYAt(vga, x);
    if (s + 8 >= Y) break;                                // no longer a tall hill -> stop
    const px = [];
    for (let yy = s + 9; yy <= Y; yy++) { const idx = yy * W + x; if (vga.buf[idx] === COL.GROUND) px.push(idx); }
    if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x;
    ops.push(op(vga, px, 700, (Y - s) * 0.5 + 1));       // pulsed 700 Hz per column
    x += dirx;
  }
  const menKilled = applyBlastDamage(players, shooterIdx, impact, 5);
  const cbox = {
    minX: Math.max(4, Math.min(box.minX, impact.x - 5)),
    maxX: Math.min(635, Math.max(box.maxX, impact.x + 5)),
    maxY: box.maxY,
  };
  return { menKilled, anim: { kind: 'ops', ops }, box: cbox };
}

// ---- terrain collapse — DECOMPILED 1:1 from sub_625d (runs after EVERY impact over
// the effect's bounding box): per column, the surface descends over eaten空 air; then
// repeated sweeps: scan `top` down through the solid block to the first gap, `bot` to
// the next ground below; while a gap exists, ONE pixel per sweep falls — the column's
// SURFACE pixel is erased and a ground pixel appears at the gap's top (the block sinks),
// with a Sound(500)/NoSound pulse per moved pixel — until nothing moves any more.
// Works on a scratch copy of the post-carve world layer; returns animation ops
// ({px: clear→sky, add: set→ground}) in the original's sweep order.
function simulateCollapse(buf, W, box) {
  const minX = Math.max(4, Math.min(635, box.minX));
  const maxX = Math.max(4, Math.min(635, box.maxX));
  const maxY = Math.max(63, Math.min(475, box.maxY));
  if (minX > maxX) return [];
  const G = COL.GROUND;
  const ops = [];
  const n = maxX - minX + 1;
  const surf = new Int32Array(n), top = new Int32Array(n), bot = new Int32Array(n);
  const done = new Uint8Array(n);
  for (let i = 0; i < n; i++) {                       // phase A: surface per column
    const x = minX + i;
    let s = FIELD.YTOP;
    while (s < maxY && buf[s * W + x] !== G) s++;
    surf[i] = s;
    if (s === maxY) { done[i] = 1; continue; }        // original: surf==maxY → done
    top[i] = s; bot[i] = s;
  }
  let scanCost = 0;
  for (let changed = true, guard = 0; changed && guard < 8192; guard++) {  // phase B
    changed = false;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const x = minX + i;
      if (top[i] >= bot[i]) {
        while (top[i] <= maxY && buf[top[i] * W + x] === G) { top[i]++; scanCost += 0.25; }
        if (top[i] > maxY) { done[i] = 1; continue; }
        bot[i] = top[i];
        while (bot[i] <= maxY && buf[bot[i] * W + x] !== G) { bot[i]++; scanCost += 0.25; }
        changed = true;
      } else {
        top[i]++;                                     // drop ONE pixel (sub_625d 63b6..640e)
        const clearIdx = surf[i] * W + x;
        surf[i]++;
        const setIdx = (top[i] - 1) * W + x;
        buf[clearIdx] = COL.SKY;
        buf[setIdx] = G;
        ops.push({ px: [clearIdx], add: [setIdx], f: 500, cost: 1 + scanCost });
        scanCost = 0;
        changed = true;
      }
    }
  }
  return ops;
}

export { WEAPON_TABLE, WPN, applyBlastDamage, effectCrater, effectEarthquake,
         effectPingPong, effectEater, effectCaveman, simulateCollapse };
