// tank.js — tank hull + barrel drawing, faithful to sub_64cc (hull) and sub_44a6
// (barrel) in the original (re/spec_graphics.md §4).
//
// Hull: 5 stacked horizontal Lines about the bottom-centre reference (cx,cy):
//   cy-4: cx-7..cx+7 (15)   cy-3: cx-8..cx+8 (17)   cy-2: cx-9..cx+9 (19)
//   cy-1: cx-8..cx+8 (17)   cy:   cx-7..cx+7 (15)
// -> 19x5 rounded body. Colour = the tank's palette index; brightness scales with
// crew: SetRGBPalette(color, R6*men/100, G6*men/100, B6*men/100).
//
// Barrel: 10-px Line from pivot (cx, cy-5) toward the aim angle. In the original
// 0x144f=Cos, 0x1462=Sin, so the tip is (cx + round(cos*10), (cy-5) - round(sin*10)).
// Angle is 0..180 degrees (0 = right, 90 = up, 180 = left).

import { COL, GAME6, expand6to8 } from './palette.js';

// Full tank = a raised TURRET (3 rows, widths 7/9/9) on top of the HULL (5 rows,
// 15/17/19/17/15). Measured pixel-exact from the original (game_landed.png). Reference
// point (cx,cy) is the bottom-centre; rows run cy-7 (turret top) .. cy (hull bottom).
const HULL_ROWS = [
  { dy: -7, hw: 3 },   // turret top   (width 7)
  { dy: -6, hw: 4 },   // turret       (width 9)
  { dy: -5, hw: 4 },   // turret base  (width 9)
  { dy: -4, hw: 7 },   // hull         (width 15)
  { dy: -3, hw: 8 },   //              (width 17)
  { dy: -2, hw: 9 },   //              (width 19)
  { dy: -1, hw: 8 },   //              (width 17)
  { dy:  0, hw: 7 },   // hull bottom  (width 15)
];
const BARREL_DRAW_LEN = 10;   // drawn barrel (sub_44a6)
const MUZZLE_LEN = 15;        // shot spawn distance (sub_bd08)

// Apply the per-tank health dimming to the tank's palette entry.
function applyTankBrightness(vga, colorIndex, crew) {
  const base = GAME6[colorIndex];
  const f = Math.max(0, Math.min(100, crew)) / 100;
  const r = expand6to8(Math.round(base[0] * f));
  const g = expand6to8(Math.round(base[1] * f));
  const b = expand6to8(Math.round(base[2] * f));
  vga.palette[colorIndex] = [r, g, b];
  vga._syncPalette();
}

// true if the tank owns no offensive weapon 1..10 (sub_0225) — it then flies a flag.
function tankUnarmed(tank) {
  const inv = tank.inventory;
  if (!inv) return false;
  for (let w = 1; w <= 10; w++) if ((inv[w] || 0) > 0) return false;
  return true;
}

// Decorations from sub_44a6: white surrender flag when unarmed (leaning by wind), a dotted
// shield bubble (radius 12 about (cx,cy-5)) when shielded, and a quake-protection dot band.
function drawSurrenderFlag(vga, cx, cy, c, wind) {
  const L = wind < 0 ? -1 : wind > 0 ? 1 : 0.2;      // sub_444c
  vga.line(cx, cy - 8, cx, cy - 13, c);              // pole (tank colour)
  const nx = Math.round(cx + L), fx = Math.round(cx + 6 * L);
  vga.line(nx, cy - 13, fx, cy - 12, 15);            // 3-px pennant (white)
  vga.line(nx, cy - 12, fx, cy - 11, 15);
  vga.line(nx, cy - 11, fx, cy - 10, 15);
}
function drawShieldBubble(vga, cx, cy, c) {
  const oy = cy - 5;                                 // ring of ~32 dots, radius 12
  for (let k = 0; k < 32; k++) {
    const a = k * Math.PI / 16;
    vga.putPixel(Math.round(cx + 12 * Math.cos(a)), Math.round(oy + 12 * Math.sin(a)), c);
  }
}
function drawQuakeDots(vga, cx, cy, c) {
  const pts = [[-6,2],[-5,3],[-4,3],[-3,2],[-2,2],[-1,3],[0,3],[6,2],[5,3],[4,3],[3,2],[2,2],[1,3]];
  for (const [dx, dy] of pts) vga.putPixel(cx + dx, cy + dy, c);
}

function drawTank(vga, tank, wind) {
  const cx = tank.x | 0, cy = tank.y | 0;
  applyTankBrightness(vga, tank.colorIndex, tank.crew);
  const c = tank.colorIndex;
  for (const row of HULL_ROWS) {
    vga.line(cx - row.hw, cy + row.dy, cx + row.hw, cy + row.dy, c);
  }
  const unarmed = tankUnarmed(tank);
  drawBarrel(vga, tank, unarmed ? 0 : c);            // sub_44a6: barrel BLACK when unarmed
  if (unarmed) drawSurrenderFlag(vga, cx, cy, c, wind || 0);
  const inv = tank.inventory || {};
  if ((inv[13] || 0) > 0) drawShieldBubble(vga, cx, cy, c);   // Protection Shield (inv[13])
  if ((inv[12] || 0) > 0) drawQuakeDots(vga, cx, cy, c);       // Quake Protection (inv[12])
}

// Draw the tank shape in its colour index WITHOUT touching the palette — used by the
// death-flash animation, which drives palette[colorIndex] itself (sub_6895).
function drawDeadTank(vga, tank) {
  const cx = tank.x | 0, cy = tank.y | 0, c = tank.colorIndex;
  for (const row of HULL_ROWS) vga.line(cx - row.hw, cy + row.dy, cx + row.hw, cy + row.dy, c);
  drawBarrel(vga, tank, c);
}

// Is pixel (x,y) inside this tank's drawn hull? Used by the fall support tests, which in
// the original read the composited screen (any non-sky pixel supports — sub_6cbd et al.),
// so a tank can come to rest on top of another tank.
function tankOccupies(tank, x, y) {
  const dy = (y | 0) - (tank.y | 0);
  if (dy < -7 || dy > 0) return false;
  return Math.abs((x | 0) - (tank.x | 0)) <= HULL_ROWS[dy + 7].hw;
}

function eraseTank(vga, tank) {
  const cx = tank.x | 0, cy = tank.y | 0;
  for (const row of HULL_ROWS) {
    vga.line(cx - row.hw, cy + row.dy, cx + row.hw, cy + row.dy, COL.SKY);
  }
  // erase barrel span too
  const { tx, ty } = barrelTip(tank);
  vga.line(cx, cy - 5, tx, ty, COL.SKY);
}

function barrelTip(tank) {
  const rad = tank.angle * Math.PI / 180;
  const tx = tank.x + Math.round(Math.cos(rad) * BARREL_DRAW_LEN);
  const ty = (tank.y - 5) - Math.round(Math.sin(rad) * BARREL_DRAW_LEN);
  return { tx, ty };
}

function drawBarrel(vga, tank, c) {
  const { tx, ty } = barrelTip(tank);
  vga.line(tank.x, tank.y - 5, tx, ty, c);
}

// Muzzle spawn point (barrel length 15) — where the shell is born.
function muzzle(tank) {
  const rad = tank.angle * Math.PI / 180;
  return {
    x: tank.x + Math.round(Math.cos(rad) * MUZZLE_LEN),
    y: (tank.y - 5) - Math.round(Math.sin(rad) * MUZZLE_LEN),
  };
}

// Parachute above the tank during the round-start descent — DECOMPILED from sub_4291:
// 7 solid canopy rows at cy-16..cy-22 (widths 15/15/15/13/13/11/7) with 3 suspension lines
// converging at (cx, cy-9) and fanning to (cx±5, cy-15) / (cx, cy-15).
function drawParachute(vga, cx, cy, color) {
  cx |= 0; cy |= 0;
  const hw = [7, 7, 7, 6, 6, 5, 3];                 // half-widths, bottom (cy-16) → top (cy-22)
  for (let i = 0; i < 7; i++) vga.line(cx - hw[i], cy - 16 - i, cx + hw[i], cy - 16 - i, color);
  vga.line(cx - 5, cy - 15, cx, cy - 9, color);      // suspension lines → (cx, cy-9)
  vga.line(cx,     cy - 15, cx, cy - 9, color);
  vga.line(cx + 5, cy - 15, cx, cy - 9, color);
}

export { drawTank, drawDeadTank, eraseTank, drawBarrel, barrelTip, muzzle, drawParachute,
         applyTankBrightness, tankOccupies, BARREL_DRAW_LEN, MUZZLE_LEN };
