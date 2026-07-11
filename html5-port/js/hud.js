// hud.js — status bar and 3-D UI frames, faithful to sub_5b69 / Frame3D
// (re/spec_graphics.md §1b, §2).

import { COL } from './palette.js';
import { WEAPON_TABLE } from './weapons.js';

// Frame3D: a bevelled box. raised=true -> light top/left, dark bottom/right.
function frame3D(vga, x1, y1, x2, y2, raised) {
  const light = COL.BEVEL_LIGHT, dark = COL.BEVEL_DARK;
  // Match the original's bevel: a "raised" (flag=1) box has DARK top/left and LIGHT
  // bottom/right (verified from the name box: top/left navy, bottom/right white).
  const a = raised ? dark : light;      // top/left
  const b = raised ? light : dark;      // bottom/right
  vga.line(x1, y2, x1, y1, a);          // left
  vga.line(x1, y1, x2, y1, a);          // top
  vga.line(x2, y1, x2, y2, b);          // right
  vga.line(x2, y2, x1, y2, b);          // bottom
}
function frame3DThick(vga, x1, y1, x2, y2, raised) {
  for (let i = 0; i < 4; i++) frame3D(vga, x1 + i, y1 + i, x2 - i, y2 - i, raised);
}

// wind/angle direction arrow chars (CP437): up 24, down 25, right 26, left 27.
function windArrow(wind) { return wind === 0 ? '↑' : (wind > 0 ? '→' : '←'); }

// ---- weapon icons (sub_4eae): hand-drawn pictograms in colour 14, centre cx = 235+38i ----
// CR/Julia icons (i=6..9) use sub_2b8c: a recursive space-filling-curve walker that plots
// only on background pixels. Production rules + 50% twin-substitution when randomized.
const CR_RULES = { 1: [8, 2, 5, 2], 2: [1, 6, 1, 7], 3: [4, 7, 4, 6], 4: [5, 3, 8, 3],
                   5: [1, 6, 4, 6], 6: [5, 3, 5, 2], 7: [8, 2, 8, 3], 8: [4, 7, 1, 7] };
const CR_TWIN = { 1: 2, 2: 1, 3: 4, 4: 3, 5: 6, 6: 5, 7: 8, 8: 7 };
function crIcon(vga, X, Y, S, seed) {
  let x = X, y = Y;
  const rndBit = () => {                       // TP7 LCG, Odd(Random(10)) twin coin-flip
    if (!seed) return false;
    seed.s = (Math.imul(seed.s, 134775813) + 1) >>> 0;
    return Math.floor(seed.s / 4294967296 * 10) % 2 === 1;   // Random(10) = (seed·10) shr 32
  };
  const step = (d, s) => {
    if (s > 1) { for (const nd of CR_RULES[d]) step(rndBit() ? CR_TWIN[nd] : nd, s >> 1); return; }
    if (d <= 2) x++; else if (d <= 4) x--; else if (d <= 6) y++; else y--;   // unit move
    if (x >= 4 && x <= 635 && y <= 475 && vga.buf[y * vga.W + x] === COL.SKY)
      vga.putPixel(x, y, COL.BEVEL_DARK);      // plot on background only (GetPixel guard)
  };
  step(1, S);
}
function circleOutline(vga, cx, cy, r, c) {    // midpoint circle (BGI Circle)
  let x = r, y = 0, err = 1 - r;
  while (x >= y) {
    for (const [px, py] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]])
      vga.putPixel(cx + px, cy + py, c);
    y++; if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
  }
}
function drawWeaponIcon(vga, n, cx, crSeed) {
  const c = COL.BEVEL_DARK;
  switch (n) {
    case 1:                                            // HandGrenade: 2×2 dot
      vga.bar(cx - 1, 42, cx, 43, c); break;
    case 2:                                            // 5 kT Nuke: solid disc r4
      vga.fillCircle(cx, 42, 4, c); break;
    case 3:                                            // 5 MT Nuke: solid disc r8
      vga.fillCircle(cx, 42, 8, c); break;
    case 4: {                                          // Earthquake: centre dot + 6 cracks
      vga.putPixel(cx, 42, c);
      for (const [pxo, lxo, ly1, ly2] of [[-7, -8, 45, 39], [-4, -5, 44, 40], [-1, -2, 43, 41],
                                          [1, 2, 43, 41], [4, 5, 44, 40], [7, 8, 45, 39]]) {
        vga.putPixel(cx + pxo, ly1 + 1, c);
        vga.line(cx + lxo, ly1, cx + lxo, ly2, c);
        vga.putPixel(cx + pxo, ly2 - 1, c);
      }
      break;
    }
    case 5:                                            // PingPongJack: dashes + 4-wide pole
      vga.line(cx - 10, 42, cx - 7, 42, c);
      vga.line(cx - 7, 43, cx - 4, 43, c);
      vga.line(cx - 5, 44, cx - 2, 44, c);
      vga.line(cx - 4, 45, cx - 1, 45, c);
      vga.line(cx - 3, 46, cx, 46, c);
      for (let x = cx - 2; x <= cx + 1; x++) vga.line(x, 38, x, 48, c);
      break;
    case 6: crIcon(vga, cx - 3, 45, 8, crSeed); break;   // CRInducer 256 (randomized)
    case 7: crIcon(vga, cx - 7, 45, 16, crSeed); break;  // CRInducer 512 (randomized)
    case 8: crIcon(vga, cx - 3, 45, 8, null); break;     // Julia 256 (deterministic)
    case 9: crIcon(vga, cx - 7, 45, 16, null); break;    // Julia 512 (deterministic)
    case 10: {                                         // Captain Caveman: circle + mound
      circleOutline(vga, cx, 43, 5, c);
      for (let k = 0; k <= 6; k++) vga.line(cx - 6 - k, 42 + k, cx + 6 + k, 42 + k, c);
      break;
    }
  }
}

// ---- the MOUSE AIMING PANEL (sub_557a), shown instead of the name/weapon boxes when the
// mouse-panel mode is active ([0x115f]; toggled by RIGHT CLICK during a human's aim turn).
// Decompiled 1:1: protractor dot-arc r=35 about (190,47), needle r4→r32 in white(15),
// ← → buttons, Fire / I / W / max / default-power buttons, +/− power group with readout.
// Click regions are stored on game._panel for the mouse handler.
function drawAimPanel(vga, game, p) {
  vga.bar(4, 5, 252, 55, COL.SKY);                     // Bar(...,0) = bg
  frame3D(vga, 6, 6, 250, 53, false);
  vga.outText(12, 8, p.name, 1, p.colorIndex);         // name, size 1
  frame3D(vga, 135, 9, 150, 50, false);                // ← button
  frame3D(vga, 152, 9, 228, 50, true);                 // protractor housing (style 1)
  frame3D(vga, 230, 9, 245, 50, false);                // → button
  vga.outText(140, 27, '\x1b', 1, COL.BEVEL_DARK);
  vga.outText(235, 27, '\x1a', 1, COL.BEVEL_DARK);
  vga.line(155, 48, 225, 48, COL.BEVEL_DARK);          // baseline
  for (let a = 0; a <= 180; a += 10) {                 // dot arc, r=35.0
    const r = a * Math.PI / 180;
    vga.putPixel(190 + Math.round(Math.cos(r) * 35), 47 - Math.round(Math.sin(r) * 35), COL.BEVEL_DARK);
  }
  const dot4 = (cx, cy, mid) => {                      // Circle(cx,cy,1) [+ centre pixel]
    vga.putPixel(cx - 1, cy, COL.BEVEL_DARK); vga.putPixel(cx + 1, cy, COL.BEVEL_DARK);
    vga.putPixel(cx, cy - 1, COL.BEVEL_DARK); vga.putPixel(cx, cy + 1, COL.BEVEL_DARK);
    if (mid) vga.putPixel(cx, cy, COL.BEVEL_DARK);
  };
  dot4(190, 47, true); dot4(225, 47); dot4(155, 47); dot4(190, 12);   // hub, 0°, 180°, 90°
  dot4(215, 22, true); dot4(165, 22, true);                            // 45°, 135°
  frame3D(vga, 9, 17, 55, 50, false);  vga.outText(18, 30, 'Fire', 1, COL.BEVEL_DARK);
  frame3D(vga, 57, 17, 73, 27, false); vga.outText(62, 19, 'I', 1, COL.BEVEL_DARK);
  frame3D(vga, 75, 17, 91, 27, false); vga.outText(80, 19, 'W', 1, COL.BEVEL_DARK);
  frame3D(vga, 57, 29, 91, 38, false); vga.outText(63, 30, 'max', 1, COL.BEVEL_DARK);
  frame3D(vga, 57, 40, 91, 50, false); vga.outText(63, 42, '250', 1, COL.BEVEL_DARK);
  frame3D(vga, 94, 17, 133, 50, true);                 // power group (style 1)
  frame3D(vga, 96, 19, 131, 28, false); vga.outText(110, 20, '+', 1, COL.BEVEL_DARK);
  frame3D(vga, 96, 39, 131, 48, false); vga.outText(110, 40, '-', 1, COL.BEVEL_DARK);
  // needle r4→r32 at the current angle, colour [0x1782]=15 (white in-game)
  const na = p.angle * Math.PI / 180;
  vga.line(190 + Math.round(4 * Math.cos(na)), 47 - Math.round(4 * Math.sin(na)),
           190 + Math.round(32 * Math.cos(na)), 47 - Math.round(32 * Math.sin(na)), 15);
  // power readout between +/− (sub_0c31: bg bar then text, colour 15)
  const pw = String(p.power).padStart(4);
  vga.bar(97, 30, 97 + pw.length * 8, 36, COL.SKY);
  vga.outText(97, 30, pw, 1, 15);
  game._panel = [                                      // click regions 11..19
    { id: 'angle+', x1: 135, y1: 9,  x2: 150, y2: 50 },
    { id: 'angle-', x1: 230, y1: 9,  x2: 245, y2: 50 },
    { id: 'power+', x1: 96,  y1: 19, x2: 131, y2: 28 },
    { id: 'power-', x1: 96,  y1: 39, x2: 131, y2: 48 },
    { id: 'invert', x1: 57,  y1: 17, x2: 73,  y2: 27 },
    { id: 'preset', x1: 75,  y1: 17, x2: 91,  y2: 27 },
    { id: 'pmax',   x1: 57,  y1: 29, x2: 91,  y2: 38 },
    { id: 'pdef',   x1: 57,  y1: 40, x2: 91,  y2: 50 },
    { id: 'fire',   x1: 9,   y1: 17, x2: 55,  y2: 50 },
  ];
}

// Draw the top status bar for the active player.
function drawStatusBar(vga, game) {
  const p = game.players[game.current];
  vga.bar(0, 0, vga.W - 1, 58, COL.SKY);
  frame3DThick(vga, 0, 0, 639, 58, true);

  // during a tank's death flash the HUD name box switches to the DYING tank (sub_6895): its
  // name rides that tank's palette index, so it blinks (fade up to white) then fades out.
  const dying = game._dyingHud;                        // {name, colorIndex} or null
  const panelOn = game.mousePanel && !p.isComputer && !dying;
  game._panel = null;
  if (panelOn) {
    drawAimPanel(vga, game, p);                        // sub_557a replaces both left boxes
  } else {
    // name box (the dying tank during a death flash, else the current player). Once the flash
    // has fully faded (dying.faded), draw the dead name in the sky colour so it stays gone
    // through the post-death pause instead of flashing the shooter's name back.
    frame3D(vga, 6, 6, 250, 28, true);
    vga.outText(10, 9, dying ? dying.name : p.name, 2,
      dying ? (dying.faded ? COL.SKY : dying.colorIndex) : p.colorIndex);

    // weapon box (2nd row, left): count navy + name white (plural-s), or "No Mun no Fun !"
    // when the tank owns nothing (sub_4eae @0x4f36).
    frame3D(vga, 6, 31, 250, 53, false);
    let armed = false; for (let k = 1; k <= 10; k++) if ((p.inventory[k] || 0) > 0) { armed = true; break; }
    if (!armed) {
      vga.outText(30, 38, 'No Mun no Fun !', 1, 15);
    } else {
      const w = WEAPON_TABLE[p.weapon];
      const ammo = p.inventory[p.weapon] || 0;
      vga.outText(10, 38, String(ammo).padStart(3, ' '), 1, COL.BEVEL_DARK);   // count (navy, w3)
      vga.outText(40, 38, w.name + (ammo === 1 ? '' : 's'), 1, 15);            // name (white)
    }
  }

  // arsenal selector strip (sub_4eae): buttons for every OWNED weapon 1..10 at x=217+38n..
  // 253+38n, y31..53; current weapon = inverted frame; each weapon gets its HAND-DRAWN icon
  // (see drawWeaponIcon). Click regions stored on the game for the mouse handler.
  game._arsenal = [];
  // CR-Inducer icons: the ORIGINAL re-randomizes them on EVERY strip redraw (sub_2b8c with
  // Randomize=1 pulls the global RNG) — i.e. whenever a weapon is (re)selected or a new
  // turn starts. Our HUD additionally redraws on every mouse move, so we reroll the seed
  // only when the selection/turn changes (weapon clicks force it via game._crKey = -1),
  // keeping the icon steady between events and leaving the game's RNG sequence untouched.
  const selKey = (game.current << 4) | p.weapon;
  if (game._crKey !== selKey) {
    game._crKey = selKey;
    game._crSeed = (Math.imul((game._crSeed ?? 0x1234567), 1103515245) + 12345) >>> 0;
  }
  const crSeed = { s: game._crSeed >>> 0 };
  for (let n = 1; n <= 10; n++) {
    if ((p.inventory[n] || 0) <= 0) continue;
    const x1 = 217 + 38 * n, x2 = 253 + 38 * n;
    frame3D(vga, x1, 31, x2, 53, p.weapon === n);
    drawWeaponIcon(vga, n, 235 + 38 * n, crSeed);
    game._arsenal.push({ w: n, x1, y1: 31, x2, y2: 53 });
  }

  // stats box (sub_5b69: Str field widths 6/6/3/3/2/4, rows at y=10/18)
  frame3D(vga, 255, 6, 633, 28, true);
  const c = COL.HUD_TEXT;
  vga.outText(263, 10, `${String(p.points).padStart(6)} Points`, 1, c);
  vga.outText(263, 18, `${String(p.wins).padStart(6)} Win${p.wins === 1 ? '' : 's'}`, 1, c); // plural-s
  vga.outText(385, 10, `${String(p.crew).padStart(3)} Men`, 1, c);
  vga.outText(385, 18, `Wind:${String(Math.abs(game.wind)).padStart(3)} ${windArrow(game.wind)}`, 1, c);
  const shownAngle = 90 - Math.abs(90 - p.angle);
  vga.outText(490, 10, `Angle:  ${String(shownAngle).padStart(2)}° ${p.angle < 90 ? '→' : (p.angle > 90 ? '←' : '↑')}`, 1, c);
  vga.outText(490, 18, `Power:${String(p.power).padStart(4)}`, 1, c);

  // reflecting-walls "R" indicator — red, SIZE 2 (sub_5b69: SetTextStyle size 2 at (613,11))
  frame3D(vga, 610, 8, 630, 26, false);
  if (game.options.reflectActive) vga.outText(613, 11, 'R', 2, COL.NUKE_RED);
}

export { frame3D, frame3DThick, drawStatusBar, windArrow };
