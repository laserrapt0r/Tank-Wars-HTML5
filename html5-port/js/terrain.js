// terrain.js — landscape generation and destruction, faithful to sub_5e3f / sub_625d
// (see re/spec_graphics.md §3 and spec_physics.md §4).
//
// The original builds a segmented random-walk ("turtle") curve into a per-column
// height array (DS:0x119a, columns 4..635), draws vertical walls at x=4 and x=635,
// then solid-flood-fills ground-green below the surface. Because |theta| <= 1.2 rad
// (< pi/2), cos(theta) > 0 always, so the surface is single-valued in x.
//
// Trig note: in the original 0x144f = Cos, 0x1462 = Sin (see spec_physics §0). The
// segment step is  x += cos(theta)*amp ,  y += sin(theta)*amp .

import { COL } from './palette.js';

const FIELD = { X0: 4, X1: 635, YTOP: 63, YBOT: 475, YCLAMP_TOP: 88, YCLAMP_BOT: 470 };

// Generate terrain into the VGA buffer. Returns the heightmap (surface y per column).
function generateTerrain(vga, rnd) {
  // sky already implied; explicitly clear play area to sky, keep status bar untouched.
  vga.bar(0, FIELD.YTOP, vga.W - 1, vga.H - 1, COL.SKY);

  const height = new Int16Array(vga.W).fill(FIELD.YBOT);

  const stepRange = rnd.next(40) + 10;          // [10,49]
  const R1 = rnd.nextFloat() + 0.3;             // [0.3,1.3)
  let x = 4;
  let y = 445 - rnd.next(206);                  // [240,445]
  let theta = rnd.nextFloat() * (Math.PI / 2) - Math.PI / 4; // [-pi/4, pi/4)
  let amp = rnd.next(stepRange) + 5;            // [5, stepRange+4]

  // baseline + left wall (green), like the original draws before the walk.
  height[4] = y;

  const plotColumn = (col, ys) => {
    if (col < 0 || col >= vga.W) return;
    ys = Math.max(FIELD.YCLAMP_TOP, Math.min(FIELD.YCLAMP_BOT, ys)) | 0;
    height[col] = ys;
  };

  const limitX = 635 - stepRange - 5;
  let guard = 0;
  while (x < limitX && guard++ < 5000) {
    let nx = x + Math.round(Math.cos(theta) * amp);
    let ny = y + Math.round(Math.sin(theta) * amp);
    if (nx <= x) nx = x + 1;                     // guarantee forward progress
    if (ny < FIELD.YCLAMP_TOP) { ny = FIELD.YCLAMP_TOP; theta = 0; }
    else if (ny > FIELD.YCLAMP_BOT) { ny = FIELD.YCLAMP_BOT; theta = 0; }

    const dxs = nx - x;
    for (let col = x; col <= nx; col++) {
      const ys = y + Math.round((col - x) * (ny - y) / dxs);
      plotColumn(col, ys);
    }
    x = nx; y = ny;
    amp = rnd.next(stepRange) + 5;
    theta += rnd.nextFloat() * R1 - R1 / 2;
    if (theta > 1.2) theta = 1.0;
    else if (theta < -1.2) theta = -1.0;
  }
  // final closing segment to x=635 — sub_5e3f does ONE more turtle step (a fresh sloped
  // endpoint from the current heading), NOT a flat run: newY = y + round(sin·amp), clamped.
  {
    const nx = 635;
    const ny = Math.max(FIELD.YCLAMP_TOP, Math.min(FIELD.YCLAMP_BOT, y + Math.round(Math.sin(theta) * amp)));
    const dxs = Math.max(1, nx - x);
    for (let col = x; col <= nx; col++) {
      const ys = y + Math.round((col - x) * (ny - y) / dxs);
      plotColumn(col, ys);
    }
    y = ny;
  }
  // ensure columns 0..3 and 636..639 match the walls (edge columns solid to bottom)
  for (let col = 0; col < 4; col++) height[col] = height[4];
  for (let col = 636; col < vga.W; col++) height[col] = height[635];

  // paint ground: fill each column from its surface y down to the bottom.
  for (let col = 0; col < vga.W; col++) {
    const ys = height[col];
    for (let yy = ys; yy <= FIELD.YBOT; yy++) vga.buf[yy * vga.W + col] = COL.GROUND;
  }
  return height;
}

// Surface y at column x from the live pixel buffer (first ground pixel top-down).
function surfaceYAt(vga, x) {
  x |= 0;
  if (x < 0 || x >= vga.W) return FIELD.YBOT;
  for (let y = FIELD.YTOP; y <= FIELD.YBOT; y++) {
    if (vga.buf[y * vga.W + x] === COL.GROUND) return y;
  }
  return FIELD.YBOT + 1; // no ground in this column (hole)
}

// Remove ground in a filled circle (crater), setting it to sky. Used by explosions.
function makeCrater(vga, cx, cy, r) {
  cx|=0; cy|=0; r|=0;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < FIELD.YTOP || y > FIELD.YBOT) continue;
    const dx = Math.floor(Math.sqrt(r*r - dy*dy) + 1e-9);
    for (let x = cx - dx; x <= cx + dx; x++) {
      if (x < FIELD.X0 || x > FIELD.X1) continue;
      const idx = y * vga.W + x;
      if (vga.buf[idx] === COL.GROUND) vga.buf[idx] = COL.SKY;
    }
  }
}

export { generateTerrain, surfaceYAt, makeCrater, FIELD };
