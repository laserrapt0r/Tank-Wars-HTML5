// main.js — front-end: boot, screen state machine, input, and the animation loop.
// Screen flow mirrors the original: main options menu -> name/player setup ->
// play rounds (aim -> flight -> impact -> settle) -> shop between games -> rankings.

import { VGA } from './vga.js';
import { MENU_PALETTE, GAME_PALETTE, COL, TANK_COLORS } from './palette.js';
import { TPRandom } from './rtl.js';
import { PCSpeaker } from './pcspeaker.js';
import { SND, SND_LIVE } from './sounds.js';
import { Game } from './game.js';
import { frame3D, frame3DThick } from './hud.js';
import { WEAPON_TABLE, WPN } from './weapons.js';
import { FONT8X8 } from './font8x8.js';
import { mdToHtml } from './markdown.js';
import { DOC_EN, DOC_DE } from './doctext.js';

const CPU_NAMES = ['Terminator', 'Ballisto', 'Jack', 'Klaus', 'Berti'];

const canvas = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const vga = new VGA(canvas, MENU_PALETTE.map(c => c.slice()));
vga.setFont(FONT8X8);
const rnd = new TPRandom();
rnd.randomize();   // TP7 `Randomize` at program start: time-based seed so terrain/wind/shooters
                   // differ every session. (Without this the seed stayed 0 → identical first world.)
                   // The ?seed= debug path below overrides this for reproducible screenshots.
const spk = new PCSpeaker();
const game = new Game(vga, rnd, spk);

// fit canvas to viewport, integer-scaled, 4:3.
function resize() {
  const s = Math.max(1, Math.min(Math.floor(innerWidth / 640), Math.floor(innerHeight / 480)));
  canvas.style.width = (640 * s) + 'px';
  canvas.style.height = (480 * s) + 'px';
}
addEventListener('resize', resize); resize();

// ------------------------------------------------------------------ state ----
const S = { MENU: 'menu', NAMES: 'names', AIM: 'aim', FLIGHT: 'flight',
  IMPACT: 'impact', ANIM: 'anim', BETWEEN: 'between', SHOP: 'shop', RANK: 'rank',
  HELP: 'help', QUIT: 'quit', STATUS: 'status', ROUNDINTRO: 'roundintro', HISCORE: 'hiscore',
  INFO: 'info', FAREWELL: 'farewell' };
let state = S.MENU;
let prevState = S.AIM;

// main menu model
const MENU_ITEMS = [
  { key: 'soundFX',      label: 'SoundFX',            type: 'bool' },
  { key: 'flightSFX',    label: 'Flight SoundFX',     type: 'bool' },
  { key: 'reflectWalls', label: 'Reflecting Walls',   type: 'refl' },
  { key: 'showTrace',    label: 'Show Trace',         type: 'bool' },
  { key: 'useMouse',     label: 'Use your Mouse',     type: 'bool' },
  { key: 'errorRate',    label: 'Computer Error Rate',type: 'pct'  },
  { key: 'moneyStart',   label: 'Money from Start : $',type: 'money'},
  { key: 'gamesPerMatch',label: 'Games per Match',    type: 'games'},
  { key: 'numPlayers',   label: 'Number of Players',  type: 'players'},
];
let menuSel = MENU_ITEMS.length;   // original: "Go for it !" is pre-highlighted (MenuSelect last)

// name-setup model
let nameSetup = null;

// shop model
let shop = null;
let farewell = null;   // active shareware farewell screen (sub_116c), set on Esc-in-menu
let _startMs = Date.now();   // program-start timestamp, for the farewell's "You played N…"
let infoTimer = 0;           // 'A' info screen auto-dismiss countdown (sub_95a0: ~200 cs = 2 s)

// impact pause timer
let impactTimer = 0;
let introTimer = 0;
// set once the player presses any key / mouse button during the parachute fly-in,
// which (as in the original) skips the per-step vsync wait and runs it at full speed.
let introFast = false;
// wall-clock timestamp of the previous animation frame (for refresh-independent timing)
let lastFrameTs = 0;

// ---- software mouse cursor (like the original: the OS cursor is hidden, we draw an
// arrow that follows the mouse AND jumps onto the selected element on keyboard input) ---
const cursor = { x: 320, y: 240, show: false };
let kbSelect = false;   // true => cursor snaps to the keyboard selection; false => follows mouse
// Original arrow, extracted PIXEL-EXACT from a DOSBox capture: solid body in index 15
// (grey in the menu palette, white in-game) with an outline drawn in colour 0 — which in
// the original IS the background colour, so the outline is invisible on the bg and only
// "punches through" text/frames the cursor passes over. We reproduce that with COL.SKY.
const CURSOR_BMP = [
  'X.......',
  'XX......',
  'XXX.....',
  'XXXX....',
  'XXXXX...',
  'XXXXXX..',
  'XXXXXXX.',
  'XXXXXXXX',
  'XXXXX...',
  'XX.XX...',
  'X...XX..',
  '....XX..',
  '.....XX.',
  '.....XX.',
];
function drawCursor() {
  if (!cursor.show) return;
  const ox = cursor.x | 0, oy = cursor.y | 0;
  const at = (rx, ry) => ry >= 0 && ry < CURSOR_BMP.length && CURSOR_BMP[ry][rx] === 'X';
  for (let ry = -1; ry <= CURSOR_BMP.length; ry++) {
    for (let rx = -1; rx <= 8; rx++) {
      if (at(rx, ry)) { vga.putPixel(ox + rx, oy + ry, 15); continue; }   // body (index 15)
      let touch = false;                                   // colour-0 outline around the body
      for (let dy = -1; dy <= 1 && !touch; dy++)
        for (let dx = -1; dx <= 1 && !touch; dx++) touch = at(rx + dx, ry + dy);
      if (touch) vga.putPixel(ox + rx, oy + ry, COL.SKY);
    }
  }
}
// warp the software cursor onto a screen element (like MouseGlideTo/MouseToMenuItem)
function warpCursor(x, y) { cursor.x = x; cursor.y = y; cursor.show = true; }
// redraw whatever screen is currently visible (used after a mouse move)
function redrawCurrent() {
  if (state === S.MENU) drawMenu();
  else if (state === S.NAMES) drawNames();
  else if (state === S.SHOP) drawShop();
}
// position the software cursor over the current keyboard selection (per screen)
function warpToSelection() {
  if (state === S.MENU) {
    if (popup) {                                     // MouseToMenuItem: glide onto the popup button
      const b = popup.def.btn;
      warpCursor(((b.x1 + b.x2) >> 1) - 4, b.ys[popup.sel] + 4);
      return;
    }
    const { x2, top, h, goY } = MENU_LAYOUT;
    if (menuSel < MENU_ITEMS.length) warpCursor(x2 - 74, top + menuSel * h + 8);
    else warpCursor(360, goY + 12);
  } else if (state === S.NAMES && nameSetup) {
    if (nameSetup.phase === 'hc') warpCursor(505, nameSetup.isComputer ? 138 : 106);
    else if (nameSetup.phase === 'cpu') warpCursor(505, 244 + nameSetup.cpuSel * 40);
    else warpCursor(70, 82 + nameSetup.idx * 24);   // typing: point at the row
  } else if (state === S.SHOP && shop) {
    const col = shop.side === 0 ? SHOP_BUY : SHOP_SELL;
    warpCursor((col.x1 + col.x2) / 2 - 40, SHOP_ROWY(shop.sel) + 2);
  }
}

// ---------------------------------------------------------------- rendering --
function valueText(item) {
  const o = game.options;
  switch (item.type) {
    case 'bool': return o[item.key] ? 'Yes' : 'No';
    case 'refl': return ['No', 'RND', 'Yes'][o.reflectWalls];
    case 'pct':  return o.errorRate + ' %';
    case 'money':return '' + o.moneyStart;
    default:     return '' + o[item.key];
  }
}

// Menu colour roles (MENU_PALETTE): 11 blue bg, 15 grey text/bevel-light, 0 black
// text-shadow/bevel-dark, 1 red title, 6 white. The original draws all ×2 menu text
// EMBOSSED: a 1-px black drop-shadow under the main colour (measured from the original).
const MENU_TEXT = 15;   // grey (195,195,195)
function drawMenu() {
  // Geometry pixel-measured from a DOSBox capture of the original menu: full-screen raised
  // Frame3DThick, red size-2 title at y=20 with a red underline at y=40 (x 205..433), item
  // boxes (40,y)-(508,y+35) at y = 50 + i*40, labels at x=58 (+9 into the box), values
  // right-aligned to x2-16, and the "Go for it !" box SET OFF at y=430..465 (25 px gap).
  vga.setPalette(MENU_PALETTE.map(c => c.slice()));
  vga.clear(COL.SKY);                              // menu blue background
  frame3DThick(vga, 0, 0, 639, 479, false);        // full-screen raised frame (was missing)
  embCenter('TankWars V2.07', 20, 2, COL.RED);     // red title, embossed
  vga.line(206, 41, 434, 41, COL.BLACK);           // underline shadow
  vga.line(205, 40, 433, 40, COL.RED);             // red underline
  const x1 = 40, x2 = 508, top = 50, h = 40;
  // MenuDrawItem label colour: [0x177c]=15 grey normally, [0x177e]=6 WHITE when highlighted
  const itemCol = (i) => (i === menuSel ? 6 : MENU_TEXT);
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const y = top + i * h;
    drawButton(x1, y, x2, y + 35, i === menuSel);
    embText(60, y + 9, MENU_ITEMS[i].label, 2, itemCol(i));   // MenuDrawItem: f5+10·size = 60
    const v = valueText(MENU_ITEMS[i]);
    embText(x2 - 16 - v.length * 16, y + 9, v, 2, itemCol(i));
  }
  const gy = 430;                                  // original: clearly separated from the items
  const goSel = menuSel === MENU_ITEMS.length;
  drawButton(x1, gy, x2, gy + 35, goSel);
  // original label is "       Go for it !" (7 leading spaces) drawn at x=60 like every menu
  // item → text starts at 60+7*16 = 172 (NOT box-centred); measured x=172 in the golden.
  embText(172, gy + 9, 'Go for it !', 2, goSel ? 6 : MENU_TEXT);   // white when selected
  vga.outText(550, 459, '©1995 ML', 1, 6);         // white copyright (measured 550,459)
  if (popup) drawPopup();                          // active options popup on top
  if (kbSelect) warpToSelection();
  drawCursor();
  vga.present();
}

// Menu button: blue interior (no fill), raised 3-D bevel (grey top/left, black
// bottom/right). The selected item is drawn sunken (inverted bevel).
function drawButton(x1, y1, x2, y2, sel) {
  frame3DThick(vga, x1, y1, x2, y2, sel);
}
// Embossed text: 1-px black drop-shadow under the main colour (final-pixel offset,
// independent of scale) — matches the original's OutTextXY menu styling.
function embText(x, y, str, scale, color) {
  vga.outText(x + 1, y + 1, str, scale, COL.BLACK);
  vga.outText(x, y, str, scale, color);
}
function embCenter(str, y, scale, color) {
  const w = str.length * 8 * scale;
  embText((640 - w) >> 1, y, str, scale, color);
}
function centerText(str, y, scale, color) {
  const w = str.length * 8 * scale;
  vga.outText((640 - w) >> 1, y, str, scale, color);
}

// ------------------------------------------------------------------- input ---
function changeMenuValue(dir) {
  const o = game.options;
  const it = MENU_ITEMS[menuSel];
  switch (it.type) {
    case 'bool': o[it.key] = !o[it.key]; break;
    case 'refl': o.reflectWalls = (o.reflectWalls + (dir > 0 ? 1 : 2)) % 3; break;
    case 'pct':  o.errorRate = Math.max(0, Math.min(100, o.errorRate + dir)); spk.play(SND.optErrorRate(o.errorRate), o.soundFX); break;
    case 'money':o.moneyStart = Math.max(0, Math.min(100000, o.moneyStart + dir * 1000)); spk.play(SND.optMoney(o.moneyStart), o.soundFX); break;
    case 'games':o.gamesPerMatch = Math.max(1, Math.min(50, o.gamesPerMatch + dir)); spk.play(SND.optGames(o.gamesPerMatch), o.soundFX); break;
    case 'players':o.numPlayers = Math.max(2, Math.min(10, o.numPlayers + dir)); spk.play(SND.optPlayers(o.numPlayers), o.soundFX); break;
  }
}

function beginNames() {
  // original order: choose Human/Computer first, THEN enter a name (human) or pick a
  // computer opponent — so the phase starts at 'hc'.
  nameSetup = { count: game.options.numPlayers, idx: 0, defs: [], phase: 'hc',
                buffer: '', isComputer: false, cpuSel: 0 };
  state = S.NAMES;
  kbSelect = true;
  drawNames();
}

function drawNames() {
  // Geometry pixel-measured from a DOSBox golden: full-screen frame + a nested inner frame,
  // red size-2 title at y=20, the player list box (50,70)-(400,440), and the right-hand
  // "Player Nr." box (420,70)-(580,170) with Human/Computer buttons. List rows: pitch 35,
  // first row y≈88, number at x≈92 (scale 2).
  vga.setPalette(MENU_PALETTE.map(c => c.slice()));
  vga.clear(COL.SKY);
  frame3DThick(vga, 0, 0, 639, 479, false);        // outer screen frame (raised)
  frame3DThick(vga, 20, 50, 619, 460, true);       // inner panel frame (sunken, measured)
  vga.outText(180, 20, 'The names please', 2, COL.RED);   // fixed x=180 (measured, not centred)
  frame3D(vga, 50, 70, 400, 440, false);           // player-list box
  const rowY = (i) => 88 + i * 35;
  for (let i = 0; i < nameSetup.defs.length; i++) {
    vga.outText(92, rowY(i), `${i + 1} ${nameSetup.defs[i].name}`, 2, TANK_COLORS[i]);
  }
  const i = nameSetup.idx;
  vga.outText(72, rowY(i), '→', 2, COL.RED);       // cursor arrow on the current row
  if (nameSetup.phase === 'type') {
    vga.outText(92, rowY(i), `${i + 1} ${nameSetup.buffer}_`, 2, TANK_COLORS[i]);
  } else {
    vga.outText(92, rowY(i), `${i + 1}`, 2, TANK_COLORS[i]);
  }
  if (nameSetup.phase === 'hc') {
    frame3DThick(vga, 420, 70, 580, 170, true);    // thick frame (measured 4px)
    centerTextIn(420, 580, 80, `Player Nr. ${i + 1}`, 1, COL.RED);
    drawButton(445, 105, 555, 125, !nameSetup.isComputer);
    centerTextIn(445, 555, 110, 'Human', 1, COL.BEVEL_DARK);
    drawButton(445, 130, 555, 150, nameSetup.isComputer);
    centerTextIn(445, 555, 135, 'Computer', 1, COL.BEVEL_DARK);
  } else if (nameSetup.phase === 'cpu') {
    frame3D(vga, 420, 200, 580, 450, true);
    centerTextIn(420, 580, 210, 'Computerplayer', 1, COL.RED);
    for (let k = 0; k < CPU_NAMES.length; k++) {
      drawButton(445, 230 + k * 40, 555, 262 + k * 40, k === nameSetup.cpuSel);
      vga.outText(455, 238 + k * 40, '■' + CPU_NAMES[k], 1, COL.BEVEL_DARK);
    }
  }
  if (kbSelect) warpToSelection();
  drawCursor();
  vga.present();
}
function centerTextIn(x1, x2, y, str, scale, color) {
  const w = str.length * 8 * scale;
  vga.outText(x1 + ((x2 - x1 - w) >> 1), y, str, scale, color);
}

// commit a finished player definition and advance
function commitPlayer(def) {
  // CPU players keep the leading ■ (0xfe) in their display name, as the original stores it
  // (personality stays plain for the AI dispatcher).
  if (def.isComputer && def.name && def.name[0] !== '■') def = { ...def, name: '■' + def.name };
  spk.play(SND.shopEnter, game.options.soundFX);   // per-player commit beep (Sound 400 + Delay 20)
  nameSetup.defs.push(def);
  nameSetup.idx++;
  if (nameSetup.idx >= nameSetup.count) {
    game.setupPlayers(nameSetup.defs);
    // The original main loop (0xeaa3-0xeac7) runs the SHOP before EVERY game — including
    // game 1. With the default $0 nobody passes the can-buy-or-sell test (sub_9a18) and the
    // shop is skipped invisibly; with "Money from Start" > 0 it appears before round 1.
    game.currentGame = 1;
    beginShop();
  } else {
    nameSetup.phase = 'hc'; nameSetup.buffer = ''; nameSetup.isComputer = false;
    drawNames();
  }
}

// ------------------------------------------------------------- game control --
function startNewGame() {
  game.currentGame = game.currentGame || 1;
  spk.enabled = game.options.soundFX;
  game.startRound();
  introFast = false;            // fresh fly-in: full-speed skip not yet requested
  state = S.ROUNDINTRO;          // parachute the tanks in, then start aiming
}

function maybeAITurn() {
  const p = game.players[game.current];
  if (p.isComputer) {
    state = S.AIM;
    setTimeout(() => {
      game.aiMove();
      game.drawScene();
      aimRingThenFire();
    }, 500);
  }
}

// sub_b4a2: before a CPU with an aiming brain fires, a red ring collapses around its target
// (radius 50 → 0). Random brains set no ringTarget and fire after a short pause.
function aimRingThenFire() {
  const doFire = () => { if (game.fire()) state = S.FLIGHT; else endTurn(); };
  const tgt = game._aimRingTarget;
  if (!tgt) { setTimeout(doFire, 400); return; }
  let r = 50;
  (function step() {
    if (state !== S.AIM) return;                 // aborted (e.g. window/state changed)
    if (r <= 1) { game.drawScene(); setTimeout(doFire, 120); return; }
    game.drawAimRing(tgt, r);
    r -= Math.max(1, Math.floor(r / 6));         // proportional shrink, like sub_b4a2
    setTimeout(step, 22);
  })();
}

function endTurn() {
  if (game.aliveCount() <= 1) { finishRound(); return; }
  game.nextPlayer();
  state = S.AIM;
  // panel preference persists ([0x1775]): a new HUMAN turn re-shows the confined cursor
  // and glides it onto the protractor (sub_557a tail: MouseCursor(1)+MouseGlideTo(190,30))
  const np = game.players[game.current];
  if (game.mousePanel && np && !np.isComputer) { warpCursor(190, 30); redrawAim(); }
  else { cursor.show = false; game.drawScene(); }
  maybeAITurn();
}

function finishRound() {
  game.endRoundScoring();
  // (No end-of-round tally sound in the original — those tones play at ROUND START, see
  // game.js stepRoundIntro / SND.roundPlace.) Rankings are shown after EVERY game (sub_abdc),
  // BEFORE advancing the game counter, so the title reads "after <currentGame> of <M>".
  beginRankings();
}

// Leave the rankings screen: after the LAST game return to the main menu, otherwise advance
// to the next game's shop (original main loop 0xeaa3-0xeac7). There is NO post-match Lucky
// Shots screen — that table is shown mid-game on a qualifying shot (see afterImpact). The
// original's end-of-match "New Match, new Luck ?" dialog (sub_8ac5) is deliberately unported.
function advanceAfterRankings() {
  if (game.currentGame >= game.options.gamesPerMatch) {
    game.currentGame = 1; state = S.MENU; drawMenu();
  } else {
    game.currentGame++;
    // NO arsenal reset here. The original (main loop 0xeaa3-0xeac7) only rebuilds the arsenal
    // ONCE per match in sub_7801 (0x7924); between games it keeps every purchased weapon. The
    // per-round reset (0xe9e7) touches only crew/power/protections — handled by startRound()
    // and endRoundScoring(). Resetting the arsenal here made bought weapons vanish unused.
    beginShop();
  }
}

// ---- shop (faithful 3-column layout: status bar + weapon list + Buy/For-Sale columns) ----
const WHITE = 6;
const SHOP_ROWY = (i) => 81 + 26 * i;              // y of weapon row / button i (1..13)
const SHOP_BUY = { x1: 327, x2: 470 };
const SHOP_SELL = { x1: 482, x2: 625 };

function canShop(p) {
  for (let w = 1; w <= 13; w++) {
    if (WEAPON_TABLE[w].price <= p.money) return true;                 // something to buy
    if ((p.inventory[w] || 0) >= WEAPON_TABLE[w].lot) return true;     // something to sell
  }
  return false;
}
function beginShop() {
  shop = { player: -1, side: 0, sel: 1 };
  nextShopPlayer();                                  // find first human who can shop
}
function nextShopPlayer() {
  let i = shop.player + 1;
  // CPU players auto-shop (sub_9d62 CPU branch) and are then skipped for the UI; humans
  // who can buy/sell get the interactive shop.
  while (i < game.players.length) {
    const pl = game.players[i];
    if (pl.isComputer) { game.cpuShop(pl); i++; continue; }
    if (canShop(pl)) break;
    i++;
  }
  if (i >= game.players.length) { startNewGame(); return; }
  shop.player = i; shop.side = 0; shop.sel = 1;
  spk.play(SND.shopEnter, game.options.soundFX);
  state = S.SHOP;
  kbSelect = true;
  drawShop();
}
function shopAdvancePlayer() { nextShopPlayer(); }

// build "name....right" padded to width with dots
function dotFill(left, right, width) {
  const r = String(right);
  const n = Math.max(1, width - left.length - r.length);
  return left + '.'.repeat(n) + r;
}

// centre a string within [x1,x2] and return the left x (8 px per char, size 1)
function centerX(x1, x2, str) { return x1 + (((x2 - x1) - str.length * 8) >> 1); }

function drawShop() {
  const p = game.players[shop.player];
  vga.setPalette(MENU_PALETTE.map(c => c.slice()));
  vga.clear(COL.SKY);                                 // ClearScreen([0x177b]) = bg blue (index 11)

  // --- frames (sub_9d62). The original's Frame3D "style 0" = raised (light top-left) and
  //     "style 1" = sunken (dark top-left); verified against the DOSBox bevels (top-bar top
  //     edge grey/195, bottom black/0 → raised). In our frame3D, raised=false = light-top-left. ---
  frame3DThick(vga, 0, 0, 639, 58, false);           // top status-bar border (raised)
  frame3DThick(vga, 0, 59, 639, 479, false);         // main outer frame (raised)
  frame3D(vga, 10, 65, 317, 447, true);              // left weapon-list window (sunken)
  frame3D(vga, 15, 98, 312, 355, false);             // upper box (10 offensive weapons)
  frame3D(vga, 15, 358, 312, 437, false);            // lower box (3 protections)
  frame3DThick(vga, 321, 65, 474, 447, false);       // "Buy these" column box
  frame3DThick(vga, 477, 65, 630, 447, false);       // "For Sale" column box

  // --- top panel (sub_3d21): NAME on its own line (10,6) in the tank colour, then FOUR
  //     right-aligned stat lines (x=25, y=16/26/36/46) in black (14) — Str(value:6)+label. ---
  vga.outText(10, 6, p.name, 1, p.colorIndex);
  vga.outText(25, 16, `${String(p.crew).padStart(6)} Men`, 1, 14);
  vga.outText(25, 26, `${String(p.wins).padStart(6)} Win${p.wins === 1 ? '' : 's'}`, 1, 14);
  vga.outText(25, 36, `${String(p.points).padStart(6)} Points`, 1, 14);
  vga.outText(25, 46, `${String(p.money).padStart(6)} Dollar`, 1, 14);
  // inventory: two columns of 5, GREY (15), name + dotted leader + count (cols at x=145/356)
  for (let k = 0; k < 5; k++) {
    const wa = k + 1, wb = k + 6, y = 6 + k * 10;
    vga.outText(145, y, dotFill(WEAPON_TABLE[wa].name, p.inventory[wa] || 0, 18), 1, 15);
    vga.outText(356, y, dotFill(WEAPON_TABLE[wb].name, p.inventory[wb] || 0, 27), 1, 15);
  }

  // headers — RED (12) with black shadow via emb; "Go to next…" is black (14) with a white outline
  const togo = game.options.gamesPerMatch - game.currentGame + 1;   // " Game"/" Games" plural (sub_10d23)
  // "You have <money> $ ( <N> Games to go )": money Str(:6), games-to-go Str(:3) (sub_9d62)
  emb(21, 72, `You have ${String(p.money).padStart(6)} $ ( ${String(togo).padStart(3)} Game${togo === 1 ? '' : 's'} to go )`, 1, 12);
  const gt = 'Go to next Window using [Tab].';
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) vga.outText(50 + dx, 85 + dy, gt, 1, 6);
  vga.outText(50, 85, gt, 1, 14);
  emb(centerX(SHOP_BUY.x1, SHOP_BUY.x2, 'Buy these'), 75, 'Buy these', 1, 12);   // measured y=75
  emb(centerX(SHOP_SELL.x1, SHOP_SELL.x2, 'For Sale'), 75, 'For Sale', 1, 12);

  // --- weapon rows (WHITE 6 + black shadow) + buy/sell buttons (GREY 15 prices) ---
  for (let w = 1; w <= 13; w++) {
    const y = SHOP_ROWY(w);
    const t = WEAPON_TABLE[w], lot = t.lot;
    const plural = lot === 1 ? '' : 's';
    const row = dotFill(`${String(lot).padStart(3)} ${t.name}${plural}`, '', 32);
    emb(21, y, row, 1, 6);

    // buy/sell prices: Str(price:7)+" $" (sub_9d62), a fixed-width 9-char field right-set in the button
    const buyable = t.price <= p.money;
    drawShopBtn(SHOP_BUY.x1, y, SHOP_BUY.x2, shop.side === 0 && shop.sel === w);
    if (buyable) vga.outText(SHOP_BUY.x2 - 8 - 9 * 8, y, `${String(t.price).padStart(7)} $`, 1, 15);
    const sellable = (p.inventory[w] || 0) >= lot;
    drawShopBtn(SHOP_SELL.x1, y, SHOP_SELL.x2, shop.side === 1 && shop.sel === w);
    if (sellable) vga.outText(SHOP_SELL.x2 - 8 - 9 * 8, y, `${String(t.price >> 1).padStart(7)} $`, 1, 15);
  }

  // --- bottom "start" bar ---
  frame3D(vga, 10, 450, 630, 473, false);
  const startTxt = `Start the ${game.currentGame}. Game, ${p.name} !`;
  emb(centerX(10, 630, startTxt), 460, startTxt, 1, 12);
  if (kbSelect) warpToSelection();
  drawCursor();
  vga.present();
}
function drawShopBtn(x1, y, x2, hot) {
  // blue interior (background) + grey 3-D bevel: RAISED normally, SUNKEN when selected
  // (agent: buttons style 0 raised / style 1 sunken → frame3D false / true).
  frame3D(vga, x1, y - 4, x2, y + 14, hot);
}

// ---- rankings ----
// emboss: navy shadow at (x+1,y+1) under the coloured text (like the original's OutTextXY pairs)
function emb(x, y, s, scale, color) { vga.outText(x + 1, y + 1, s, scale, COL.BEVEL_DARK); vga.outText(x, y, s, scale, color); }

function beginRankings() { state = S.RANK; drawRankings(); }
function drawRankings() {
  vga.setPalette(MENU_PALETTE.map(c => c.slice()));
  vga.clear(11);
  frame3DThick(vga, 0, 0, 639, 479, false);   // 3 nested bevels (sub_abdc 0xad12/0xae15/0xae2d)
  frame3DThick(vga, 20, 50, 619, 460, true);
  frame3DThick(vga, 30, 60, 609, 280, false);
  const M = game.options.gamesPerMatch, N = game.currentGame;   // "after N of M Games"
  emb(50, 20, `Rankings after ${N} of ${M} Games`, 2, COL.RED);   // shadow(14)+red(1), size 2
  // Each row is a leader-dot line ("<rank> " + 45 dots, white) with the name/wins/points
  // overprinted via sub_0c31, which fills a BLACK bar (colour 0) sized to the text and then
  // draws the text on it — punching the dots into clean separators between the columns.
  const order = [...game.players].sort((a, b) => b.wins - a.wins || b.points - a.points);
  order.forEach((p, k) => {
    const rank = k + 1;
    const y = rank * 20 + 55;                                    // sub_abdc: y = rank*20 + 55
    vga.outText(50, y, String(rank).padStart(2) + '.'.repeat(45), 1, WHITE);  // rank + leader dots
    rankCell(77,  y, p.name, p.colorIndex);                      // name (tank colour)
    rankCell(400, y, `${p.wins} Win${p.wins === 1 ? '' : 's'}`, WHITE);       // plural-s (sub_0d23)
    rankCell(480, y, `${p.points} Points`, WHITE);
  });
  // Trailing hint (only when NOT the last game, [0xf74] < [0xcfb]): a SINGLE string with
  // "( ...key ! )" pushed to the right by 20 embedded spaces (di=0xab98, length 67) — it is
  // not a separate right-aligned draw. This is what fixes the "…key" alignment.
  if (N < M) vga.outText(50, 443,
    "Well, not bad. But let's go on now." + ' '.repeat(20) + "( ...key ! )", 1, WHITE);
  vga.present();
}
// sub_0c31: an erase-bar sized to the text, then the text on top. The original fills with
// colour 0, which at runtime = the BACKGROUND colour (index 0 is the screen bg, NOT black —
// verified pixel-for-pixel against DOSBox: fill-0 renders as the menu blue srgb(40,81,255)).
// So we erase to the background (index 11) — the dots vanish behind the text, no black bars.
function rankCell(x, y, text, color) {
  vga.bar(x, y, x + text.length * 8, y + 6, COL.SKY);
  vga.outText(x, y, text, 1, color);
}

// ---- high scores: "The Lucky Shots" (sub_96f4) + localStorage persistence ----
const HS_KEY = 'tw_hiscores';
function loadHighScores() {
  try { const j = JSON.parse(localStorage.getItem(HS_KEY)); if (Array.isArray(j) && j.length === 10) return j; } catch (e) {}
  const def = [];                                    // sub_1ff5 default table: 11000 − 1000·i
  for (let i = 0; i < 10; i++) def.push({ name: 'M. Lindner', score: 11000 - 1000 * i });
  return def;
}
function saveHighScores(hs) { try { localStorage.setItem(HS_KEY, JSON.stringify(hs)); } catch (e) {} }
// "The Lucky Shots" is a table of the best SINGLE-SHOT results: score = 50 × enemy men
// killed by one shot (sub_bd08: [0x1692] accumulates men killed in non-self tanks across
// direct/chain/fall, then 0xcbb7 score = 50·[0x1692], compared to the table's lowest at
// 0xcbc0). Insert only if it beats the 10th entry; returns true if it made the table.
function recordLuckyShot(name, score) {
  const hs = loadHighScores();
  if (score <= hs[hs.length - 1].score) return false;   // 0xcbc8/0xcbd1: not high enough
  hs.push({ name, score });
  hs.sort((a, b) => b.score - a.score);
  hs.length = 10;
  saveHighScores(hs);
  return true;
}
// Modes: 'peek' = in-game 'L' key (0xdebd), returns to aiming; 'lucky' = a qualifying shot
// mid-game (0xccbe), then resumes the turn via _hsResume. Both draw over the game scene.
let _hsMode = 'peek', _hsPrev = S.MENU, _hsResume = null;
function beginHighScores(mode) { _hsMode = mode; _hsPrev = state; state = S.HISCORE; drawHighScores(); }
function leaveHighScores() {
  if (_hsMode === 'lucky') { const r = _hsResume; _hsResume = null; state = S.AIM; if (r) r(); }
  else { state = (_hsPrev === S.HISCORE) ? S.AIM : _hsPrev; game.drawScene(); }
}
function drawHighScores() {
  // sub_96f4: a top banner (fill 0 = bg) drawn OVER the running game — both the in-game 'L'
  // peek (arg 1 @0xdebd) and the qualifying-shot display (arg 0 @0xccbe) overlay the play
  // scene; there is NO post-match Lucky Shots screen in this build (verified in DOSBox).
  // Two columns of 5: col 1 rank+name at (130, n·10−4), score at 274 (n=1..5); col 2 at
  // (385, n·10−54)/529 (n=6..10). Entry = Str(n:2)+"."+name + leader dots + Str(score:6)+" Points".
  game.drawScene();
  vga.bar(4, 4, 635, 54, COL.SKY);
  vga.outText(10, 13, 'The Lucky Shots', 1, COL.NUKE_RED);   // colour 12
  const hs = loadHighScores();
  for (let n = 1; n <= 10; n++) {
    const left = n <= 5, y = left ? n * 10 - 4 : n * 10 - 54;
    const nx = left ? 130 : 385, px = left ? 274 : 529;
    const name = hs[n - 1].name, score = hs[n - 1].score;
    vga.outText(nx, y, `${String(n).padStart(2)}.${name}`, 1, 15);
    const dots = Math.max(0, 21 - name.length - String(score).length);
    if (dots) vga.outText(nx + 24 + name.length * 8, y, '.'.repeat(dots), 1, 15);
    vga.outText(px, y, `${String(score).padStart(6)} Points`, 1, 15);
  }
  vga.present();
}

// ---- help / status / quit overlays ----
function drawHelp() {
  // sub_8f25: bg-coloured top banner, red title, then a TWO-TONE key table. Each row is
  // drawn TWICE at the same (10,y): pass 1 white(15) = key names + '|' separators, pass 2
  // navy(14) = descriptions. Spaces are transparent, so the passes interleave. All eight
  // row strings are BYTE-EXACT from the EXE (0x8cef..0x8eda).
  game.drawScene();
  vga.bar(4, 4, 635, 54, COL.SKY);   // Bar(4,4,635,54, 0) — fill 0 = the screen bg (sky)
  vga.outText(80, 6, '\xbb \xbb \xbb The HELP - Page  (Some interesting keys for playing) \xab \xab \xab', 1, COL.NUKE_RED);
  const white = [
    'Tab                                 |  \x18                |  Page\x18',
    '1..0                                |  \x19                |  Page\x19',
    'Space                               |  \x1a                |  Home',
    'Esc                                 |  \x1b                |  End',
  ];
  const dp = String(250).padStart(3);   // Str([0x1160]:3) — default power appended to row 4
  const navy = [
    '       Next Weapon                        Power + 1               Power + 100',
    '       See Player Number 1..10            Power - 1               Power - 100',
    '       View Game Status                   Angle \x1a                 Power \x1a max',
    '       Quit this one Game                 Angle \x1b                 Power = ' + dp,
  ];
  for (let r = 0; r < 4; r++) vga.outText(10, 16 + r * 10, white[r], 1, 15);
  for (let r = 0; r < 4; r++) vga.outText(10, 16 + r * 10, navy[r], 1, COL.BEVEL_DARK);
  vga.present();
}
// 'A' key gag screen (sub_95a0): a bg banner over the game, framed, with a red size-2 title
// and a white line; a small marker sits near the "1995 ML". Dismissed by any key (like help).
function drawInfoScreen() {
  game.drawScene();
  vga.bar(4, 4, 635, 54, COL.SKY);                         // Bar(4,4,635,54,0) = bg
  frame3D(vga, 6, 6, 633, 52, false);                      // Frame3D(6,6,633,52, style 0)
  vga.outText(212, 12, 'TankWars V2.07', 2, COL.NUKE_RED); // size 2, red(12), @ (212,12)
  vga.outText(205, 40, '    They will take control.                  1995 ML', 1, 15);
  vga.outText(555, 40, '\xa9', 1, 15);                     // © — DrawMarker(555,40,15): small ring
  vga.present();
}

// ---- shareware farewell screen (sub_116c): a TEXT-MODE typewriter monologue shown on
// "quit" (Esc in the main menu). Pure text — yellow/light-gray/white on black, a 200 Hz
// click per character, the play-time, and one of four comments by minutes played. A browser
// has no program exit, so it returns to the main menu when done; any key/click fast-forwards
// the typing (as the original does). All strings are byte-exact from the EXE (0x0f32..0x114b).
const FW = { x0: 0, y0: 12, cols: 80, cw: 8, lh: 16 };   // DOS text mode: 80 cols from x=0
// DOS text-mode 16-colour palette (7 = light gray, 14 = yellow, 15 = white, on 0 = black).
const TEXT_PALETTE = [
  [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170], [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
  [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255], [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
];
function buildFarewellOps(overrideSec) {
  const totalSec = overrideSec != null ? overrideSec : Math.max(0, Math.floor((Date.now() - _startMs) / 1000));
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const totalMin = h * 60 + m;
  const pl = (v) => (v === 1 ? '' : 's');          // plural "s" (sub_0d23) — 1 → "", else "s"
  const w = (v, n) => String(v).padStart(n);       // Str(v:n) — right-justified, space-padded
  const Y = 14, G = 7, W = 15;
  const seg = [[Y, '\n']];
  seg.push([Y, 'You played']);
  if (h > 0) seg.push([Y, w(h, 2) + ' hour' + pl(h) + ',']);
  if (m > 0) seg.push([Y, w(m, 3) + ' minute' + pl(m)]);
  if (s > 0 && (h > 0 || m > 0)) seg.push([Y, ' and']);
  if (s > 0) seg.push([Y, w(s, 3) + ' second' + pl(s)]);
  seg.push([Y, ' TankWars V2.07\n\r']);
  if (totalMin <= 5) seg.push([Y, 'Not your game ?']);
  else if (totalMin <= 59) seg.push([Y, "Nice game, isn't it ?"]);
  else if (totalMin <= 119) seg.push([Y, 'It seems to me that you like it.']);
  else seg.push([Y, 'Well, you could have done your homework, washed the dishes, cleaned the windows, \n\rmade your flat looking like the polished chrome of a Harley Davidson \n\r. . . and in between ' + w(Math.floor(totalMin / 3), 3) + ' times have pleased your wife (husband ?) !\n\r\n\rBut boy, you chose the right thing.']);
  seg.push([G, '\n\r\n\rVisit TankWars on WWW  : ']);
  seg.push([W, 'http://www.tu-chemnitz.de/~mali/tankwars/download.htm']);
  seg.push([G, '\n\rOr send me some e-mail : ']);
  seg.push([W, 'marko.lindner@hrz.tu-chemnitz.de']);
  const ops = [];
  for (const [c, t] of seg) for (const ch of t) ops.push([c, ch]);
  return ops;
}
function fwPaint(f, color, ch) {                   // advance the text cursor, drawing printables
  if (ch === '\n') { f.row++; f.col = 0; }
  else if (ch === '\r') { f.col = 0; }
  else {
    vga.outText(FW.x0 + f.col * FW.cw, FW.y0 + f.row * FW.lh, ch, 1, color);
    if (++f.col >= FW.cols) { f.col = 0; f.row++; }
    return true;                                   // printable → caller clicks
  }
  return false;
}
function beginFarewell() {
  vga.setPalette(TEXT_PALETTE.map(c => c.slice()));
  vga.clear(0);
  if (pointerLocked) { try { document.exitPointerLock(); } catch (e) {} }
  farewell = { ops: buildFarewellOps(), i: 0, acc: 0, col: 0, row: 0, skip: false, endAcc: 0, caret: null };
  state = S.FAREWELL;
  vga.present();
}
function stepFarewell(dt) {
  const f = farewell; if (!f || f.done) return;        // once finished, the screen stays (until reload)
  if (f.caret) { vga.bar(f.caret.x, f.caret.y, f.caret.x + 7, f.caret.y + 13, 0); f.caret = null; }
  f.acc += dt;
  while (f.i < f.ops.length) {
    const [color, ch] = f.ops[f.i];
    const cost = (ch === '\n' || ch === '\r') ? 10 : (f.skip ? 5 : 61);   // per-char typewriter timing
    if (f.acc < cost) break;
    f.acc -= cost; f.i++;
    if (fwPaint(f, color, ch)) spk.play(SND.introClick, game.options.soundFX);  // 200 Hz click
  }
  if (f.i < f.ops.length) {                        // block caret at the next cell
    const x = FW.x0 + f.col * FW.cw, y = FW.y0 + f.row * FW.lh;
    vga.bar(x, y, x + 7, y + 13, 15); f.caret = { x, y };
  } else {
    f.done = true;                                 // typing finished — the text stays on screen
  }                                                // (browser has no program exit; reload to leave)
  vga.present();
}
function drawQuit() {
  // sub_8b7f: black banner, question in a small raised box (embossed), two buttons; the
  // SAFE option is default (Enter cancels), only an explicit yes confirms.
  game.drawScene();
  vga.bar(4, 4, 635, 54, COL.SKY);   // in the original, "fill 0" = the screen bg (sky), not black
  frame3D(vga, 10, 6, 390, 52, true);
  emb(30, 22, 'Would you like to quit this one game ?', 1, COL.NUKE_RED);
  frame3D(vga, 430, 6, 632, 26, true);  vga.outText(440, 10, 'I think so.  (y)', 1, COL.BEVEL_DARK);
  frame3D(vga, 430, 30, 632, 50, true); vga.outText(440, 34, 'Ooops, wrong key! (Enter)', 1, COL.BEVEL_DARK);
  vga.present();
}
// Space "View Game Status" — sub_907f: a compact BLACK top banner over the running game,
// with a Game/Attempt/Error-Rate header and every player in turn order (name in tank colour,
// dead players struck through, "N Men").
function drawStatus() {
  game.drawScene();
  vga.bar(4, 4, 635, 54, COL.SKY);                             // sky banner (0x90b0; fill-0 = sky bg)
  vga.outText(20, 6, 'View Game Status', 1, COL.NUKE_RED);     // colour 12
  vga.line(20, 16, 156, 16, COL.NUKE_RED);                     // red underline (0x90de)
  // header field widths from sub_907f: game/M/attempt = Str(:2), error = Str(:4:1) float
  const w2 = (n) => String(n).padStart(2);
  vga.outText(28, 22, `Game ${w2(game.currentGame)} of ${w2(game.options.gamesPerMatch)}`, 1, COL.BEVEL_DARK);
  vga.outText(28, 32, `Attempt Nr. ${w2(game.roundCycles || 1)}`, 1, COL.BEVEL_DARK);
  vga.outText(17, 42, `Error Rate ${game.errRateWork.toFixed(1).padStart(4)} %`, 1, COL.BEVEL_DARK);
  const order = game.order || game.players.map((_, i) => i);
  order.forEach((idx, slot) => {
    const p = game.players[idx];
    const col = slot < 5 ? 0 : 1, row = slot % 5;
    const nx = col ? 415 : 190, y = 6 + row * 10, menX = nx + 136;
    vga.outText(nx, y, p.name, 1, p.colorIndex);                    // name in tank colour
    const dotsStart = nx + p.name.length * 8;                       // white leader dots to the Men column
    const nDots = Math.max(0, (menX - dotsStart) >> 3);
    if (nDots) vga.outText(dotsStart, y, '.'.repeat(nDots), 1, 15);
    vga.outText(menX, y, `${p.crew} Men`, 1, p.alive ? 15 : COL.BEVEL_DARK);   // "N Men" white (15)
    if (!p.alive) vga.line(nx, y + 3, nx + 8 * p.name.length, y + 3, COL.NUKE_RED);  // strike dead
  });
  vga.present();
}

// Digit key 1..0 peek — sub_3d21: one player's panel in the top bar (name in tank colour,
// Men/Win/Points/$ stacked, owned-weapon list, protection markers).
function drawPlayerPeek(idx) {
  const p = game.players[idx];
  game.drawScene();
  vga.bar(4, 4, 635, 54, COL.SKY);   // in the original, "fill 0" = the screen bg (sky), not black
  vga.outText(10, 6, p.name, 1, p.colorIndex);
  vga.outText(25, 16, `${p.crew} Men`, 1, COL.BEVEL_DARK);
  vga.outText(25, 26, `${p.wins} Win`, 1, COL.BEVEL_DARK);
  vga.outText(25, 36, `${p.points} Points`, 1, COL.BEVEL_DARK);
  vga.outText(25, 46, `${p.money} $`, 1, COL.BEVEL_DARK);
  let a = 0, b = 0;                                            // owned weapons, two columns
  for (let w = 1; w <= 13; w++) {
    if ((p.inventory[w] || 0) <= 0) continue;
    const line = `${WEAPON_TABLE[w].name.slice(0, 16)} ${p.inventory[w]}`;
    if (w <= 6) vga.outText(150, 6 + (a++) * 10, line, 1, 15);
    else vga.outText(360, 6 + (b++) * 10, line, 1, 15);
  }
  if (p.hasParachute) vga.outText(150, 46, 'Para', 1, 15);
  if (p.hasShield)    vga.outText(220, 46, 'Shield', 1, 15);
  if (p.hasQuake)     vga.outText(320, 46, 'Quake', 1, 15);
  vga.present();
}

// ------------------------------------------------------------------ mouse ----
// Map a mouse event to 640x480 game coordinates (canvas is integer-scaled).
function canvasToGame(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - r.left) / r.width * 640),
    y: Math.round((e.clientY - r.top) / r.height * 480),
  };
}
// ---- option POPUPS (sub_7801): rows 6-9 open a small 5-button sub-menu (set-max / + / − /
// set-min / "Yo!" to close) instead of inline editing. Geometry/labels/limits decompiled
// 1:1 (windows at 0x7afc/0x7d55/0x7f79/0x813b). "Yo!" is pre-highlighted; the cursor glides
// onto it; a value-pitched beep plays on every change; Esc snaps to Yo! (does NOT close).
let popup = null;                                  // { def, sel }
const POPUP_DEFS = {
  errorRate: {
    title: 'Error Rate', win: [512, 155, 633, 285],
    btn: { x1: 540, x2: 600, tx: 550, ys: [185, 200, 215, 230, 255] },
    labels: ['100 %', '  \x18', '  \x19', '  0 %', ' Yo!'],
    apply(o, i) {                                  // max 100 / +1 / −1 / min 0 (0x7bf1..0x7cbd)
      if (i === 0) o.errorRate = 100;
      else if (i === 1) o.errorRate = Math.min(100, o.errorRate + 1);
      else if (i === 2) o.errorRate = Math.max(0, o.errorRate - 1);
      else o.errorRate = 0;
      return Math.round(o.errorRate) * 5 + 200;    // Sound(Round(v)·5+200)
    },
  },
  moneyStart: {
    title: '$-Money-$', win: [515, 195, 630, 325],
    btn: { x1: 527, x2: 618, tx: 537, ys: [225, 240, 255, 270, 295] },
    labels: ['$ 100000', '    \x18', '    \x19', '$      0', '   Yo!'],
    apply(o, i) {                                  // max 100000 / +1000 / −1000 / min 0
      if (i === 0) o.moneyStart = 100000;
      else if (i === 1) o.moneyStart = Math.min(100000, o.moneyStart + 1000);
      else if (i === 2) o.moneyStart = Math.max(0, o.moneyStart - 1000);
      else o.moneyStart = 0;
      return ((o.moneyStart / 100) | 0) + 200;     // Sound(v div 100 + 200)
    },
  },
  gamesPerMatch: {
    title: 'Games', win: [520, 235, 620, 365],
    btn: { x1: 540, x2: 600, tx: 550, ys: [265, 280, 295, 310, 335] },
    labels: [' 50', '  \x18', '  \x19', '  1', ' Yo!'],
    apply(o, i) {                                  // max 50 / +1 / −1 / min 1
      if (i === 0) o.gamesPerMatch = 50;
      else if (i === 1) o.gamesPerMatch = Math.min(50, o.gamesPerMatch + 1);
      else if (i === 2) o.gamesPerMatch = Math.max(1, o.gamesPerMatch - 1);
      else o.gamesPerMatch = 1;
      return o.gamesPerMatch * 10 + 300;           // Sound(v·10+300)
    },
  },
  numPlayers: {
    title: 'Players', win: [520, 275, 620, 405],
    btn: { x1: 540, x2: 600, tx: 550, ys: [305, 320, 335, 350, 375] },
    labels: [' 10', '  \x18', '  \x19', '  2', ' Yo!'],
    apply(o, i) {                                  // max 10 / +1 / −1 / min 2
      if (i === 0) o.numPlayers = 10;
      else if (i === 1) o.numPlayers = Math.min(10, o.numPlayers + 1);
      else if (i === 2) o.numPlayers = Math.max(2, o.numPlayers - 1);
      else o.numPlayers = 2;
      return o.numPlayers * 20 + 300;              // Sound(v·20+300)
    },
  },
};
function drawPopup() {
  const { def, sel } = popup;
  const [wx1, wy1, wx2, wy2] = def.win;
  vga.bar(wx1, wy1, wx2, wy2, COL.SKY);            // MenuErase: Bar fill 0 = bg
  frame3DThick(vga, wx1, wy1, wx2, wy2, false);    // raised window frame
  // centred red title with navy shadow + double underline (MenuDraw, size 1)
  const tX = wx1 + (((wx2 - wx1) - def.title.length * 8) >> 1), tY = wy1 + 10;
  vga.outText(tX + 1, tY + 1, def.title, 1, COL.BEVEL_DARK);
  vga.outText(tX, tY, def.title, 1, COL.RED);
  vga.line(tX - 1, wy1 + 23, tX + 8 * def.title.length + 3, wy1 + 23, COL.BEVEL_DARK);
  vga.line(tX - 2, wy1 + 22, tX + 8 * def.title.length + 2, wy1 + 22, COL.RED);
  const b = def.btn;
  for (let i = 0; i < 5; i++) {
    const y = b.ys[i];
    frame3D(vga, b.x1, y, b.x2, y + 12, sel === i);              // pressed when highlighted
    vga.outText(b.tx + 1, y + 3, def.labels[i], 1, COL.BEVEL_DARK);
    vga.outText(b.tx, y + 2, def.labels[i], 1, sel === i ? 6 : 15);
  }
}
function popupActivate(i) {
  const { def } = popup;
  if (i === 4) { popup = null; drawMenu(); return; }             // "Yo!" closes
  popup.sel = i;
  const f = def.apply(game.options, i);
  spk.play([{ f, d: 3 }], game.options.soundFX);
  drawMenu();
}

const MENU_LAYOUT = { x1: 40, x2: 508, top: 50, h: 40, goY: 430 };   // measured (drawMenu)
function menuItemAt(gx, gy) {
  const { x1, x2, top, h, goY } = MENU_LAYOUT;
  if (gx < x1 || gx > x2) return -1;
  for (let i = 0; i <= MENU_ITEMS.length; i++) {
    const y0 = i < MENU_ITEMS.length ? top + i * h : goY;
    if (gy >= y0 && gy <= y0 + 35) return i;
  }
  return -1;
}
// Move the software cursor by the mouse's RELATIVE motion, clamped to the screen. The
// original's MouseGlideTo/MouseToMenuItem repositions the DOS mouse driver's cursor; a
// browser page cannot move the OS pointer, so after such a warp absolute tracking would
// make the cursor JUMP to the (unrelated) real-pointer position on the next move. Tracking
// deltas instead keeps the warp and continues smoothly from it.
function cursorByDelta(e, x0 = 3, y0 = 3, x1 = 636, y1 = 476) {
  const r = canvas.getBoundingClientRect();
  cursor.x = Math.round(Math.max(x0, Math.min(x1, cursor.x + (e.movementX || 0) / r.width * 640)));
  cursor.y = Math.round(Math.max(y0, Math.min(y1, cursor.y + (e.movementY || 0) / r.height * 480)));
  cursor.show = true;
}

// --- Pointer Lock: on the mouse-driven screens we CAPTURE the mouse so its relative motion
// (movementX/Y) is UNBOUNDED — otherwise the real OS pointer can hit a screen edge and the
// in-game cursor freezes. This mirrors the DOS mouse driver, which owned a single captured
// cursor. Esc / Tab / a tab-switch releases the lock; the next click re-captures. The lock
// engages only on the mouse-driven screens, never during flight/animation/dialogs.
let pointerLocked = false;
document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === canvas; });
document.addEventListener('pointerlockerror', () => {});
function wantsCursor() {
  if (state === S.MENU || state === S.NAMES || state === S.SHOP) return true;
  const p = game.players[game.current];
  return state === S.AIM && p && !p.isComputer;
}
function maybeLock() {                            // call from a click (user gesture required)
  if (wantsCursor() && !pointerLocked && canvas.requestPointerLock) {
    try { canvas.requestPointerLock(); } catch (e) {}
  }
}
addEventListener('mousemove', (e) => {
  if (overlay.style.display !== 'none') return;
  const g = canvasToGame(e);
  // the software cursor follows the real mouse (relative) on the menu-like screens
  if (state === S.MENU || state === S.NAMES || state === S.SHOP) {
    kbSelect = false; cursorByDelta(e);
    if (state === S.MENU && !popup) {       // hovering also moves the menu selection
      const i = menuItemAt(cursor.x, cursor.y);
      if (i >= 0) menuSel = i;
    }
    redrawCurrent();
    return;
  }
  // aiming: the DOS mouse cursor is visible during a human turn.
  if (state === S.AIM && game.players[game.current] && !game.players[game.current].isComputer) {
    kbSelect = false;
    if (game.mousePanel) {
      // panel mode: cursor visible, CONFINED to the HUD strip (MouseSetRange(3,3,633,52)).
      const r = canvas.getBoundingClientRect();
      const c = clampToPanel({
        x: cursor.x + (e.movementX || 0) / r.width * 640,
        y: cursor.y + (e.movementY || 0) / r.height * 480,
      });
      cursor.x = Math.round(c.x); cursor.y = Math.round(c.y);
      cursor.show = true;
    } else {
      // keyboard mode: the original hides the mouse cursor here (MouseCursor(0)) — moving
      // the mouse does nothing. A left click still FIRES with the current angle and a right
      // click toggles the panel (both handled in mousedown/onAimClick); there is no free
      // aiming cursor, so nothing tracks the pointer.
      cursor.show = false;
    }
    redrawAim();
  }
});
// mouse WHEEL during a human aim turn: power ±1 (DOSBox maps the wheel to ↑/↓, which are
// the original's power keys — this reproduces the behaviour the DOS version shows there)
addEventListener('wheel', (e) => {
  if (overlay.style.display !== 'none' || state !== S.AIM) return;
  const p = game.players[game.current];
  if (!p || p.isComputer) return;
  e.preventDefault();
  const d = e.deltaY < 0 ? 1 : -1;
  p.power = Math.max(0, Math.min(10 * p.crew, p.power + d));
  spk.play([{ f: SND_LIVE.powerTone(p.power), d: 150 }], game.options.soundFX);
  redrawAim();
}, { passive: false });
addEventListener('mousedown', (e) => {
  if (overlay.style.display !== 'none') return;   // start overlay handles its own click
  const rightBtn = e.button === 2;
  if (state === S.ROUNDINTRO) { introFast = true; return; }   // any click speeds up the fly-in
  // Pointer Lock: capture the mouse on the cursor-driven screens (unbounded relative motion);
  // release it on non-game screens so the OS cursor returns.
  if (wantsCursor()) maybeLock();
  else if (pointerLocked) { try { document.exitPointerLock(); } catch (e) {} }
  // On the cursor-driven screens the click acts at the SOFTWARE cursor position (the OS
  // pointer is captured/hidden and its raw coords are meaningless under lock).
  const g = wantsCursor() ? { x: cursor.x, y: cursor.y } : canvasToGame(e);
  if (state === S.MENU) {
    if (popup) {                                        // popup captures all menu clicks
      const b = popup.def.btn, [wx1, wy1, wx2, wy2] = popup.def.win;
      for (let i = 0; i < 5; i++) {
        if (g.x >= b.x1 && g.x <= b.x2 && g.y >= b.ys[i] && g.y <= b.ys[i] + 12) { popupActivate(i); return; }
      }
      // click outside the window: snap the highlight to "Yo!" (the original does NOT close)
      if (g.x < wx1 || g.x > wx2 || g.y < wy1 || g.y > wy2) { popup.sel = 4; drawMenu(); }
      return;
    }
    const i = menuItemAt(g.x, g.y);
    if (i < 0) return;
    menuSel = i;
    if (i === MENU_ITEMS.length) { beginNames(); return; }
    const key = MENU_ITEMS[i].key;
    if (POPUP_DEFS[key]) { popup = { def: POPUP_DEFS[key], sel: 4 }; kbSelect = true; drawMenu(); return; }
    changeMenuValue(rightBtn ? -1 : +1);   // left = +, right = -
    drawMenu();
  } else if (state === S.NAMES) {
    onNamesClick(g);
  } else if (state === S.SHOP) {
    onShopClick(g);
  } else if (state === S.AIM) {
    onAimClick(g, rightBtn);
  } else if (state === S.RANK) { advanceAfterRankings(); }
  else if (state === S.HISCORE) { leaveHighScores(); }
  else if (state === S.HELP || state === S.STATUS || state === S.INFO) { state = prevState; game.drawScene(); }
  else if (state === S.FAREWELL && farewell) { farewell.skip = true; }
  else if (state === S.QUIT) { state = S.AIM; finishRound(); }
});
addEventListener('contextmenu', (e) => { if (overlay.style.display === 'none') e.preventDefault(); });

function onNamesClick(g) {
  const ns = nameSetup;
  if (ns.phase === 'hc') {
    if (g.x >= 440 && g.x <= 590) {
      // As in the original: choosing a player type glides the cursor onto the next
      // element (the name row for Human, the first computer name for Computer), even
      // when the choice was made with the mouse.
      if (g.y >= 96 && g.y <= 120) { ns.phase = 'type'; ns.buffer = ''; kbSelect = true; drawNames(); return; }
      if (g.y >= 128 && g.y <= 152) { ns.phase = 'cpu'; ns.cpuSel = 0; kbSelect = true; drawNames(); return; }
    }
  } else if (ns.phase === 'type') {
    // clicking commits the typed (or default) name
    const nm = ns.buffer.trim() === '' ? `Player ${ns.idx + 1}` : ns.buffer;
    commitPlayer({ name: nm, isComputer: false });
  } else if (ns.phase === 'cpu') {
    for (let k = 0; k < CPU_NAMES.length; k++) {
      if (g.x >= 440 && g.x <= 590 && g.y >= 230 + k * 40 && g.y <= 262 + k * 40) {
        commitPlayer({ name: CPU_NAMES[k], isComputer: true, personality: CPU_NAMES[k] });
        return;
      }
    }
  }
}
// map a shop y to a weapon row index 1..13 (buttons at SHOP_ROWY(w) ± ~10)
function shopRowAt(y) {
  for (let w = 1; w <= 13; w++) { const ry = SHOP_ROWY(w); if (y >= ry - 5 && y <= ry + 15) return w; }
  return 0;
}
function shopBuy(p, w) {
  if (WEAPON_TABLE[w].price <= p.money) {
    p.inventory[w] += WEAPON_TABLE[w].lot; p.money -= WEAPON_TABLE[w].price;
    spk.play(SND.buyConfirm(), game.options.soundFX);
  }
}
function shopSell(p, w) {
  if ((p.inventory[w] || 0) >= WEAPON_TABLE[w].lot) {
    p.inventory[w] -= WEAPON_TABLE[w].lot; p.money += WEAPON_TABLE[w].price >> 1;
    spk.play(SND.buyConfirm(), game.options.soundFX);
  }
}
function onShopClick(g) {
  const p = game.players[shop.player];
  if (g.y >= 450 && g.y <= 476) { shopAdvancePlayer(); return; }        // "Start the N. Game" bar = done
  const w = shopRowAt(g.y);
  if (w) {
    if (g.x >= SHOP_BUY.x1 && g.x <= SHOP_BUY.x2) { shop.side = 0; shop.sel = w; shopBuy(p, w); drawShop(); return; }
    if (g.x >= SHOP_SELL.x1 && g.x <= SHOP_SELL.x2) { shop.side = 1; shop.sel = w; shopSell(p, w); drawShop(); return; }
  }
}
// Gameplay mouse: left-click in the playfield aims the barrel toward the click and
// fires; right-click only aims (matches the original's click-to-adjust feel).
// confine a point to the HUD strip, like the original's MouseSetRange(3,3,633,52)
function clampToPanel(g) { return { x: Math.max(3, Math.min(633, g.x)), y: Math.max(3, Math.min(52, g.y)) }; }
// redraw the aim scene with the mouse cursor on top (panel mode: confined; keyboard mode:
// free-roaming DOS cursor used to pick the shot direction)
function redrawAim() { game.drawScene(); if (cursor.show) drawCursor(); vga.present(); }

// apply one aiming-panel button action (sub_557a regions; dispatch 0xe1eb..0xe3d8).
// Returns false when the action ends the turn (Fire) — no redraw wanted then.
function panelAction(id, p) {
  const pmax = 10 * p.crew;
  switch (id) {
    case 'angle+': p.angle = wrapAngle(p.angle + 1); spk.play([{ f: SND_LIVE.angleTone(p.angle), d: 150 }], game.options.soundFX); break;
    case 'angle-': p.angle = wrapAngle(p.angle - 1); spk.play([{ f: SND_LIVE.angleTone(p.angle), d: 150 }], game.options.soundFX); break;
    case 'power+': p.power = Math.min(pmax, p.power + 1); spk.play([{ f: SND_LIVE.powerTone(p.power), d: 150 }], game.options.soundFX); break;
    case 'power-': p.power = Math.max(0, p.power - 1); spk.play([{ f: SND_LIVE.powerTone(p.power), d: 150 }], game.options.soundFX); break;
    case 'invert': p.angle = wrapAngle(180 - p.angle); spk.play(SND.turretMirror, game.options.soundFX); break;   // I
    case 'preset': p.angle = p.angle > 90 ? 135 : 45; spk.play(SND.turretFlip, game.options.soundFX); break;      // W
    case 'pmax':   p.power = pmax; spk.play([{ f: SND_LIVE.powerTone(p.power), d: 150 }], game.options.soundFX); break;
    case 'pdef':   p.power = Math.min(pmax, 250); spk.play([{ f: SND_LIVE.powerTone(p.power), d: 150 }], game.options.soundFX); break;
    case 'fire':   cursor.show = false; if (game.fire()) state = S.FLIGHT; return false;   // firing hides the cursor (0xbd17)
  }
  return true;
}
// press-and-hold auto-repeat: the original's input loop POLLS the mouse button, so holding
// it on ◄/►/+/− keeps stepping the value. We re-apply the action while the button is held
// and the confined cursor stays on the button.
let panelHold = null;
function stopPanelHold() { if (panelHold) { clearInterval(panelHold); panelHold = null; } }
addEventListener('mouseup', stopPanelHold);
const PANEL_REPEAT = { 'angle+': 1, 'angle-': 1, 'power+': 1, 'power-': 1 };
function startPanelHold(b) {
  stopPanelHold();
  panelHold = setInterval(() => {
    const p = game.players[game.current];
    if (state !== S.AIM || !game.mousePanel || !p || p.isComputer) { stopPanelHold(); return; }
    if (cursor.x < b.x1 || cursor.x > b.x2 || cursor.y < b.y1 || cursor.y > b.y2) return;   // slid off: pause
    panelAction(b.id, p);
    redrawAim();
  }, 33);
}

function onAimClick(g, rightBtn) {
  const p = game.players[game.current];
  if (p.isComputer) return;
  // RIGHT CLICK toggles the mouse aiming panel ([0x115f] flip at 0xe228). Turning it on
  // shows the mouse cursor and glides it onto the protractor (MouseCursor(1) +
  // MouseGlideTo(190,30)); turning it off hides the cursor (MouseCursor(0)).
  if (rightBtn) {
    game.mousePanel = !game.mousePanel;
    if (game.mousePanel) warpCursor(190, 30); else cursor.show = false;
    redrawAim();
    return;
  }
  if (game.mousePanel) {
    // The original locks the mouse into the top strip (MouseSetRange(3,3,633,52)), so all
    // clicks act at the VIRTUAL (delta-tracked, confined) cursor position — the raw click
    // coordinates are ignored, and the battlefield can never be clicked.
    const c = clampToPanel(cursor);
    cursor.show = true; kbSelect = false;
    // arsenal strip (sub_4eae regions live inside the strip)
    if (game._arsenal) {
      for (const b of game._arsenal) {
        if (c.x >= b.x1 && c.x <= b.x2 && c.y >= b.y1 && c.y <= b.y2) {
          p.weapon = b.w; game._crKey = -1;   // weapon click: strip redraw → CR icons reroll
          spk.play(SND.weaponCycle, game.options.soundFX); redrawAim(); return;
        }
      }
    }
    // aiming-panel buttons (sub_557a click regions, dispatch 0xe1eb..0xe3d8)
    if (game._panel) {
      for (const b of game._panel) {
        if (c.x < b.x1 || c.x > b.x2 || c.y < b.y1 || c.y > b.y2) continue;
        if (!panelAction(b.id, p)) return;               // Fire: turn ends, no redraw
        redrawAim();
        if (PANEL_REPEAT[b.id]) startPanelHold(b);       // hold ◄/►/+/− to keep stepping
        return;
      }
    }
    redrawAim();                          // click on empty strip: just move the cursor there
    return;
  }
  // ---- keyboard mode ([0x115f]=0): no panel, no click regions ----
  // The original clears every click region on entering this mode (ClearClickRegions at
  // 0xe248), so a LEFT click simply FIRES with the CURRENT angle/power: sub_bd08 reads
  // the stored angle field ([player+0xcd2]) and power ([player+0xcd4]) and never touches
  // the click coordinates. It does NOT aim at the click point, and the arsenal strip is
  // not mouse-clickable here — use the aiming panel (right-click) or Tab to pick a weapon.
  if (game.fire()) state = S.FLIGHT;
}

// ------------------------------------------------------------------ keys -----
addEventListener('keydown', (e) => {
  kbSelect = true;   // a keyboard selection snaps the software cursor onto the element
  if (state === S.ROUNDINTRO) { introFast = true; return; }   // any key speeds up the fly-in
  if (state === S.MENU) return onMenuKey(e);
  if (state === S.NAMES) return onNamesKey(e);
  if (state === S.SHOP) return onShopKey(e);
  if (state === S.RANK) { e.preventDefault(); advanceAfterRankings(); return; }
  if (state === S.HISCORE) { e.preventDefault(); leaveHighScores(); return; }
  if (state === S.HELP || state === S.STATUS || state === S.INFO) { e.preventDefault(); state = prevState; game.drawScene(); return; }
  if (state === S.FAREWELL) { e.preventDefault(); if (farewell) farewell.skip = true; return; }
  if (state === S.QUIT) return onQuitKey(e);
  if (state === S.AIM) return onAimKey(e);
  // ignore keys during flight/impact
});

function onMenuKey(e) {
  e.preventDefault();
  if (popup) {                                       // MenuHandleKey inside a popup
    switch (e.key) {
      case 'ArrowUp':   popup.sel = Math.max(0, popup.sel - 1); break;
      case 'ArrowDown': popup.sel = Math.min(4, popup.sel + 1); break;
      case 'PageUp':    popup.sel = Math.max(0, popup.sel - 2); break;
      case 'PageDown':  popup.sel = Math.min(4, popup.sel + 2); break;
      case 'Home':      popup.sel = 0; break;
      case 'End':       popup.sel = 4; break;
      case 'Enter': case ' ': popupActivate(popup.sel); return;
      case 'Escape': case 'Tab': popup.sel = 4; break;   // snaps to Yo!, does NOT close
      default: return;
    }
    drawMenu();
    return;
  }
  const n = MENU_ITEMS.length + 1;
  switch (e.key) {
    case 'ArrowUp': menuSel = (menuSel + n - 1) % n; spk.play(SND.menuMove, game.options.soundFX); break;
    case 'ArrowDown': menuSel = (menuSel + 1) % n; spk.play(SND.menuMove, game.options.soundFX); break;
    case 'ArrowLeft': if (menuSel < MENU_ITEMS.length) changeMenuValue(-1); break;
    case 'ArrowRight': if (menuSel < MENU_ITEMS.length) changeMenuValue(+1); break;
    case 'Enter': case ' ':
      if (menuSel === MENU_ITEMS.length) { beginNames(); return; }
      if (POPUP_DEFS[MENU_ITEMS[menuSel].key]) { popup = { def: POPUP_DEFS[MENU_ITEMS[menuSel].key], sel: 4 }; break; }
      changeMenuValue(1);
      break;
    case 'Escape': beginFarewell(); return;   // "quit" (menu Esc → sub_116c farewell → back to menu)
  }
  drawMenu();
}

function onNamesKey(e) {
  e.preventDefault();
  const ns = nameSetup;
  if (ns.phase === 'hc') {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { ns.isComputer = !ns.isComputer; drawNames(); return; }
    if (e.key === 'Enter') {
      if (!ns.isComputer) { ns.phase = 'type'; ns.buffer = ''; drawNames(); }
      else { ns.phase = 'cpu'; ns.cpuSel = 0; drawNames(); }
    }
    return;
  }
  if (ns.phase === 'type') {
    if (e.key === 'Enter') {
      const nm = ns.buffer.trim() === '' ? `Player ${ns.idx + 1}` : ns.buffer;
      commitPlayer({ name: nm, isComputer: false });
      return;
    }
    if (e.key === 'Backspace') { ns.buffer = ns.buffer.slice(0, -1); drawNames(); return; }
    if (e.key.length === 1 && ns.buffer.length < 14) { ns.buffer += e.key; drawNames(); }
    return;
  }
  if (ns.phase === 'cpu') {
    if (e.key === 'ArrowUp') { ns.cpuSel = (ns.cpuSel + CPU_NAMES.length - 1) % CPU_NAMES.length; drawNames(); }
    else if (e.key === 'ArrowDown') { ns.cpuSel = (ns.cpuSel + 1) % CPU_NAMES.length; drawNames(); }
    else if (e.key === 'Enter') {
      const nm = CPU_NAMES[ns.cpuSel];
      commitPlayer({ name: nm, isComputer: true, personality: nm });
    }
    return;
  }
}

function onAimKey(e) {
  const p = game.players[game.current];
  if (p.isComputer) return;
  let handled = true;
  switch (e.key) {
    case 'ArrowRight': p.angle = wrapAngle(p.angle - 1); spk.play([{f:SND_LIVE.angleTone(p.angle),d:150}], game.options.soundFX); break;
    case 'ArrowLeft':  p.angle = wrapAngle(p.angle + 1); spk.play([{f:SND_LIVE.angleTone(p.angle),d:150}], game.options.soundFX); break;
    case 'ArrowUp':    p.power = clampPow(p, p.power + 1); spk.play([{f:SND_LIVE.powerTone(p.power),d:150}], game.options.soundFX); break;
    case 'ArrowDown':  p.power = clampPow(p, p.power - 1); spk.play([{f:SND_LIVE.powerTone(p.power),d:150}], game.options.soundFX); break;
    case 'PageUp':     p.power = clampPow(p, p.power + 100); spk.play([{f:SND_LIVE.powerTone(p.power),d:150}], game.options.soundFX); break;
    case 'PageDown':   p.power = clampPow(p, p.power - 100); spk.play([{f:SND_LIVE.powerTone(p.power),d:150}], game.options.soundFX); break;
    case 'Home':       p.power = 10 * p.crew; spk.play([{f:SND_LIVE.powerTone(p.power),d:150}], game.options.soundFX); break;
    case 'End':        p.power = Math.min(250, 10 * p.crew); spk.play([{f:SND_LIVE.powerTone(p.power),d:150}], game.options.soundFX); break;
    // Ins/Del = angle ±45°, CLAMPED to [0,180] (not wrapped): 0xe0d5 MinLong(a+45,180),
    // 0xe106 MaxLong(a-45,0), each then SetAngle (0xd7d8) with its angle tone.
    case 'Insert':     p.angle = Math.min(180, p.angle + 45); spk.play([{f:SND_LIVE.angleTone(p.angle),d:150}], game.options.soundFX); break;
    case 'Delete':     p.angle = Math.max(0, p.angle - 45); spk.play([{f:SND_LIVE.angleTone(p.angle),d:150}], game.options.soundFX); break;
    // W = flip to the 45°/135° preset (0xe0a5), I = mirror 180−a (0xe150), each with its tone
    case 'w': case 'W': p.angle = (p.angle <= 90) ? 135 : 45; spk.play(SND.turretFlip(), game.options.soundFX); break;
    case 'i': case 'I': p.angle = wrapAngle(180 - p.angle); spk.play(SND.turretMirror(), game.options.soundFX); break;
    case 'Tab':        nextWeapon(p); spk.play(SND.weaponCycle, game.options.soundFX); break;
    case 'Enter':      if (game.fire()) { state = S.FLIGHT; } handled = true; break;
    case ' ':          prevState = S.AIM; state = S.STATUS; drawStatus(); return;
    case 'l': case 'L': beginHighScores('peek'); return;   // in-game "Lucky Shots" peek (0xdebd)
    case 'a': case 'A': prevState = S.AIM; state = S.INFO; infoTimer = 0; drawInfoScreen(); return;   // gag screen (sub_95a0)
    case '1': case '2': case '3': case '4': case '5':
    case '6': case '7': case '8': case '9': case '0': {    // 1..0 = peek at player N's status (sub_3d21)
      const d = e.key === '0' ? 10 : (e.key.charCodeAt(0) - 48);
      if (d <= game.players.length) { prevState = S.AIM; state = S.STATUS; drawPlayerPeek(d - 1); }
      return;
    }
    case 'F1':         prevState = S.AIM; state = S.HELP; drawHelp(); return;
    case 'Escape':     prevState = S.AIM; state = S.QUIT; drawQuit(); return;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); if (state === S.AIM) redrawAim(); }
}

function onShopKey(e) {
  e.preventDefault();
  const p = game.players[shop.player];
  switch (e.key) {
    case 'Tab': shop.side ^= 1; break;                                  // switch Buy/For-Sale column
    case 'ArrowUp': shop.sel = shop.sel <= 1 ? 13 : shop.sel - 1; break;
    case 'ArrowDown': shop.sel = shop.sel >= 13 ? 1 : shop.sel + 1; break;
    case 'Enter': case ' ':
      if (shop.side === 0) shopBuy(p, shop.sel); else shopSell(p, shop.sel); break;
    case 'Escape': shopAdvancePlayer(); return;                         // done -> next player/game
  }
  drawShop();
}

function onQuitKey(e) {
  e.preventDefault();
  // sub_8b7f defaults the highlight to the SAFE option ("Ooops, wrong key !"), so ENTER
  // CANCELS. Only an explicit yes (y/j) confirms the quit.
  if (e.key === 'y' || e.key === 'Y' || e.key === 'j' || e.key === 'J') {
    state = S.AIM;
    finishRound();
  } else {
    state = S.AIM; game.drawScene();
  }
}

function wrapAngle(a) { if (a > 180) return 0; if (a < 0) return 180; return a; }
function clampPow(p, v) { return Math.max(0, Math.min(10 * p.crew, v)); }
function nextWeapon(p) {
  for (let k = 1; k <= 13; k++) {
    const w = ((p.weapon - 1 + k) % 13) + 1;
    if ((p.inventory[w] || 0) > 0) { p.weapon = w; return; }
  }
}

// ------------------------------------------------------------- animation -----
function afterImpact(res) {
  const cont = () => { if (res.over) finishRound(); else endTurn(); };
  // "The Lucky Shots": if this shot's score (50 × enemy men killed) beats the persistent
  // top-10, insert it and show the table NOW, mid-game (sub_bd08 @0xcbb7/0xccbe), resuming
  // the turn when dismissed. Only when the shooter actually killed enemy men.
  const kills = res.menKilled || 0;
  const shooter = game.players[game._shooterIdx];
  if (kills > 0 && shooter && recordLuckyShot(shooter.name, 50 * kills)) {
    _hsResume = cont;
    beginHighScores('lucky');
    return;
  }
  state = S.BETWEEN;
  setTimeout(cont, 600);
}
function loop(ts) {
  // wall-clock delta since the last frame -> animation speed is independent of the
  // monitor refresh rate (60/120/144 Hz all play at the original's pace).
  if (!lastFrameTs) lastFrameTs = ts || 0;
  const dt = Math.min(100, (ts || 0) - lastFrameTs);   // ms, clamped against stalls
  lastFrameTs = ts || 0;
  // wrapped so a weapon-effect error can never kill the RAF loop (which would
  // freeze the game and stop all sound).
  try {
    if (state === S.ROUNDINTRO) {
      if (game.stepRoundIntro(dt, introFast)) {
        state = S.AIM;
        const fp = game.players[game.current];
        if (game.mousePanel && fp && !fp.isComputer) { warpCursor(190, 30); redrawAim(); }
        maybeAITurn();
      }
    } else if (state === S.FLIGHT) {
      const r = game.stepFlight(dt);
      if (r === 'impact') { state = S.IMPACT; impactTimer = 0; }
    } else if (state === S.IMPACT) {
      impactTimer++;
      if (impactTimer === 1) {
        const res = game.resolveImpact();
        if (res.animating) state = S.ANIM;   // e.g. earthquake fissure reveal
        else afterImpact(res);
      }
    } else if (state === S.ANIM) {
      // step the post-impact phase queue (dig → blast-death → collapse → fall → fall-death);
      // returns true only when the WHOLE queue is drained.
      if (game.stepAnim(dt)) afterImpact(game.finishAnim());
    } else if (state === S.FAREWELL) {
      stepFarewell(dt);                 // typewriter monologue on "quit"
    } else if (state === S.INFO) {
      // 'A' gag screen auto-dismisses after ~2 s (sub_95a0: ~200 centiseconds) or on a key.
      infoTimer += dt;
      if (infoTimer >= 2000) { state = prevState; game.drawScene(); }
    }
  } catch (err) {
    console.error('game loop error:', err);
    try { spk.soundOff(); } catch (e) {}
    state = S.AIM;
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------- language + doc viewer --
// Start-screen text and the in-game documentation are bilingual. Default follows the
// browser (German if navigator.language starts with "de", else English) and is switchable;
// the choice is remembered in localStorage.
const I18N = {
  en: {
    desc: 'Faithful HTML5 port of the DOS game by Marko Lindner (1995/96).',
    start: '<b>Click to start</b> (enables sound).',
    keys: '← → angle · ↑ ↓ power ±1 · PgUp/PgDn ±100 · Home max · End 250 · ' +
          'Tab weapon · Enter fire · Space status · F1 help · Esc give up · mouse in menus',
    doc: '📖 Show documentation', close: '✕ Close', toggle: 'Deutsch', doclang: 'Deutsch',
  },
  de: {
    desc: 'Originalgetreuer HTML5-Port des DOS-Spiels von Marko Lindner (1995/96).',
    start: '<b>Klicken zum Starten</b> (aktiviert Ton).',
    keys: '← → Winkel · ↑ ↓ Power ±1 · Bild↑/↓ ±100 · Pos1 max · Ende 250 · ' +
          'Tab Waffe · Enter Feuern · Leertaste Status · F1 Hilfe · Esc Aufgeben · Maus im Menü',
    doc: '📖 Dokumentation anzeigen', close: '✕ Schließen', toggle: 'English', doclang: 'English',
  },
};
function detectLang() {
  const saved = (() => { try { return localStorage.getItem('tw_lang'); } catch (e) { return null; } })();
  if (saved === 'de' || saved === 'en') return saved;
  return (navigator.language || navigator.userLanguage || '').toLowerCase().startsWith('de') ? 'de' : 'en';
}
let uiLang = detectLang();

const docbtn = document.getElementById('docbtn');
const docview = document.getElementById('docview');
const docclose = document.getElementById('docclose');
const doccontent = document.getElementById('doccontent');
const doclang = document.getElementById('doclang');
const langtoggle = document.getElementById('langtoggle');
let docRendered = false;

function setText(id, html, asHtml) {
  const el = document.getElementById(id);
  if (!el) return;
  if (asHtml) el.innerHTML = html; else el.textContent = html;
}
function applyLang(lang) {
  uiLang = (lang === 'de') ? 'de' : 'en';
  try { localStorage.setItem('tw_lang', uiLang); } catch (e) {}
  try { document.documentElement.lang = uiLang; } catch (e) {}
  const t = I18N[uiLang];
  setText('ovDesc', t.desc);
  setText('ovStart', t.start, true);
  setText('ovKeys', t.keys);
  setText('docbtn', t.doc);
  setText('langtoggle', t.toggle);
  setText('docclose', t.close);
  setText('doclang', t.doclang);
  if (docRendered && doccontent) doccontent.innerHTML = mdToHtml(uiLang === 'de' ? DOC_DE : DOC_EN);
}
function renderDoc() {
  if (doccontent) { doccontent.innerHTML = mdToHtml(uiLang === 'de' ? DOC_DE : DOC_EN); docRendered = true; }
}
applyLang(uiLang);   // set the start-screen text on load

if (langtoggle) langtoggle.addEventListener('click', (e) => { e.stopPropagation(); applyLang(uiLang === 'de' ? 'en' : 'de'); });
if (doclang) doclang.addEventListener('click', (e) => { e.stopPropagation(); applyLang(uiLang === 'de' ? 'en' : 'de'); });
if (docbtn && docview) {
  docbtn.addEventListener('click', (e) => {
    e.stopPropagation();                       // don't start the game
    if (!docRendered) renderDoc();
    docview.style.display = 'block';
  });
  docclose.addEventListener('click', (e) => { e.stopPropagation(); docview.style.display = 'none'; });
}

// ------------------------------------------------------------------- boot -----
let started = false;
function startApp() {
  if (started) return;
  started = true;
  overlay.style.display = 'none';
  canvas.style.cursor = 'none';    // hide the OS cursor; we draw a software one
  spk.resume();
  state = S.MENU;
  kbSelect = true;                 // show the software cursor on the current selection
  drawMenu();
  maybeLock();                     // capture the mouse right away — the start click is a
                                   // valid user gesture, so no second click is needed
  requestAnimationFrame(loop);
}
overlay.addEventListener('click', () => {
  if (docview && docview.style.display === 'block') return; // ignore clicks while doc open
  startApp();
});

// ---- debug auto-render for headless verification: ?shot=menu|names|game|flight|shop|rank ----
(function debugMode() {
  const params = new URLSearchParams(location.search);
  const shot = params.get('shot');
  if (!shot) return;
  overlay.style.display = 'none';
  spk.enabled = false;                 // no audio in headless
  const seed = parseInt(params.get('seed') || '12345', 10);
  rnd.randomize(seed);
  window.__ready = false;
  try {
    if (shot === 'doc') { renderDoc(); docview.style.display = 'block'; }
    else if (shot === 'intro') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'T', isComputer: true }]);
      game.startRound();
      const n = parseInt(params.get('n') || '6', 10);
      for (let i = 0; i < n; i++) game.stepRoundIntro();   // partial descent -> chutes visible
    }
    else if (shot === 'menu') {
      // clean=1 (pixel-diff mode): reproduce the original's fresh-entry state — "Go for it !"
      // pre-highlighted (menuSel=last), software cursor hidden. Otherwise a demo highlight.
      const clean = params.get('clean');
      state = S.MENU; kbSelect = !clean; menuSel = clean ? MENU_ITEMS.length : 3;
      const pk = params.get('popup');
      if (pk && POPUP_DEFS[pk]) { menuSel = MENU_ITEMS.findIndex(m => m.key === pk); popup = { def: POPUP_DEFS[pk], sel: 4 }; }
      drawMenu();
      if (clean) { cursor.show = false; drawMenu(); }
    }
    else if (shot === 'names') { game.options.numPlayers = 2; beginNames(); nameSetup.buffer = 'Tommy';
      const ph = params.get('phase'); if (ph === 'cpu') { onNamesClick({ x: 500, y: 140 }); } else drawNames();
      if (params.get('clean')) { kbSelect = false; cursor.show = false; drawNames(); } }
    else if (shot === 'game' || shot === 'flight') {
      game.setupPlayers([
        { name: 'Tommy', isComputer: false },
        { name: 'Terminator', isComputer: true, personality: 'Terminator' },
      ]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      state = S.AIM;
      if (shot === 'flight') {
        const p = game.players[0]; p.angle = 45; p.power = 250;
        game.fire();
        for (let i = 0; i < 60 && game.projectile && !game.projectile.done; i++) game.stepFlight();
      }
    }
    else if (shot === 'bounce') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'T', isComputer: true }]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      game.options.reflectActive = true;          // force reflecting walls ON
      const p = game.players[0]; p.angle = 75; p.power = 700; game.current = 0;
      game.fire();
      for (let i = 0; i < 400 && game.projectile && !game.projectile.done; i++) game.stepFlight();
    }
    else if (shot === 'fan') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'T', isComputer: true }]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      const p = game.players[0]; game.current = 0;
      for (const a of [20, 45, 70, 110, 160]) { p.angle = a; game.drawScene(); } // must leave ONE barrel
    }
    else if (shot === 'traceclear') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'T', isComputer: true }]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      const p = game.players[0]; p.angle = 45; p.power = 250; game.current = 0;
      game.fire();
      for (let i = 0; i < 400 && game.projectile && !game.projectile.done; i++) game.stepFlight();
      game.resolveImpact();
      for (let i = 0; i < 400 && game.anim; i++) game.stepAnim();   // after impact: trace gone
    }
    else if (shot === 'quake') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'T', isComputer: true }]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      game.wind = 0;
      const p = game.players[0];
      p.inventory[WPN.EARTHQUAKE] = 1; p.weapon = WPN.EARTHQUAKE;
      p.angle = 72; p.power = 180; game.current = 0;
      game.fire();
      for (let i = 0; i < 600 && game.projectile && !game.projectile.done; i++) game.stepFlight();
      game.resolveImpact();
      for (let i = 0; i < 4000 && game.anim; i++) game.stepAnim(100);  // run the fissure reveal (fast dt)
    }
    else if (shot === 'wpn') {
      // ?shot=wpn&w=<idx>&ang=<deg>&pow=<n>&refl=1 — fire weapon w and resolve+animate
      const wi = parseInt(params.get('w') || '5', 10);
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'T', isComputer: true }]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      game.wind = 0;
      if (params.get('refl')) game.options.reflectActive = true;
      const p = game.players[0];
      p.inventory[wi] = 5; p.weapon = wi;
      p.angle = parseInt(params.get('ang') || '72', 10);
      p.power = parseInt(params.get('pow') || '180', 10);
      game.current = 0;
      game.fire();
      for (let i = 0; i < 800 && game.projectile && !game.projectile.done; i++) game.stepFlight();
      game.resolveImpact();
      const maxF = parseInt(params.get('frames') || '4000', 10);
      for (let i = 0; i < maxF && game.anim; i++) game.stepAnim(100);   // fast dt for headless
    }
    else if (shot === 'crater') {
      game.setupPlayers([
        { name: 'Tommy', isComputer: false },
        { name: 'Terminator', isComputer: true, personality: 'Terminator' },
      ]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      const p = game.players[0];
      p.inventory[3] = 1; p.weapon = 3;   // 5 MT Nuke
      p.angle = 70; p.power = 300;
      game.current = 0; game.fire();
      for (let i = 0; i < 400 && game.projectile && !game.projectile.done; i++) game.stepFlight();
      game.resolveImpact();
      for (let i = 0; i < 400 && game.anim; i++) game.stepAnim();   // grow + carve crater
    }
    else if (shot === 'death') {
      // fire a 5 MT nuke right next to the enemy so it dies, then step into the flash
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Boom', isComputer: true }]);
      game.startRound(); while (!game.stepRoundIntro()) {}
      const p = game.players[0], q = game.players[1];
      game.projectile = { x: q.x, y: q.y - 2, done: true, shooter: 0, weapon: 3,
        dir: { x: 1, y: 1 }, impact: { x: q.x, y: q.y - 2 } };
      p.inventory[3] = 1; p.weapon = 3;
      game.resolveImpact();
      // run through the crater anim; stop partway into the death flash (white peak)
      let guard = 0;
      while (game.anim && guard++ < 20000) {
        if (game.anim.kind === 'death' && game.anim.t >= 220) break;   // ~end of phase A (white)
        game.stepAnim(30);
      }
    }
    else if (shot === 'shop') {
      // reproduce the golden DOSBox capture's exact state for a clean pixel diff:
      // Tommy, 100 Men / 1 Win / 6000 Points / 6000 $, game 5 of 10, only 10 HandGrenades.
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Jack', isComputer: true, personality: 'Jack' }]);
      const sp = game.players[0];
      sp.money = 6000; sp.points = 6000; sp.wins = 1; sp.crew = 100;
      for (let w = 1; w <= 13; w++) sp.inventory[w] = 0;
      sp.inventory[1] = 10;
      game.currentGame = 5; game.options.gamesPerMatch = 10;
      beginShop();
    }
    else if (shot === 'rank') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Terminator', isComputer: true }]);
      game.players[0].wins = 3; game.players[0].points = 15000;
      game.players[1].wins = 1; game.players[1].points = 8000;
      beginRankings();
    }
    else if (shot === 'lucky') {          // "The Lucky Shots" table over the game scene (as 'L' peek shows it)
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Ballisto', isComputer: true }]);
      game.startRound();
      game.players.forEach(p => { p.chute = false; if (p.restY) p.y = p.restY; });
      state = S.AIM;
      beginHighScores('peek');
    }
    else if (shot === 'status') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Ballisto', isComputer: true }]);
      game.currentGame = 5; game.options.gamesPerMatch = 10;
      game.startRound();
      game.players.forEach(p => { p.chute = false; if (p.restY) p.y = p.restY; });
      game.errRateWork = 10;
      state = S.AIM; prevState = S.AIM;
      drawStatus();
    }
    else if (shot === 'help') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Ballisto', isComputer: true }]);
      game.startRound();
      game.players.forEach(p => { p.chute = false; if (p.restY) p.y = p.restY; });
      state = S.AIM; prevState = S.AIM;
      drawHelp();
    }
    else if (shot === 'info') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Ballisto', isComputer: true }]);
      game.startRound();
      game.players.forEach(p => { p.chute = false; if (p.restY) p.y = p.restY; });
      state = S.INFO; prevState = S.AIM;
      drawInfoScreen();
    }
    else if (shot === 'farewell') {          // full render (no animation) for inspection; ?min=N
      vga.setPalette(TEXT_PALETTE.map(c => c.slice())); vga.clear(0);
      const mn = params.get('min');
      const f = { col: 0, row: 0 };
      for (const [color, ch] of buildFarewellOps(mn != null ? parseInt(mn, 10) * 60 + 30 : undefined)) fwPaint(f, color, ch);
      farewell = null; state = S.FAREWELL;   // FAREWELL + farewell=null → loop won't overwrite
      vga.present();
    }
    else if (shot === 'panel') {
      game.setupPlayers([{ name: 'Tommy', isComputer: false }, { name: 'Ballisto', isComputer: true }]);
      game.startRound();
      game.players.forEach(p => { p.chute = false; if (p.restY) p.y = p.restY; });
      game.current = game.players.findIndex(p => !p.isComputer);
      game.players[game.current].angle = parseInt(params.get('angle') || '60', 10);
      if (params.get('all')) for (let w = 1; w <= 10; w++) game.players[game.current].inventory[w] = Math.max(1, game.players[game.current].inventory[w] || 0);
      game.mousePanel = params.get('nopanel') ? false : true;
      state = S.AIM;
      warpCursor(190, 30);              // MouseGlideTo target — cursor visible on the panel
      redrawAim();
    }
  } catch (err) {
    document.title = 'ERR: ' + err.message; console.error(err);
    try {   // paint the error into the canvas so headless screenshots show it
      const c2 = canvas.getContext('2d');
      c2.fillStyle = '#fff'; c2.fillRect(0, 200, 640, 60);
      c2.fillStyle = '#c00'; c2.font = '12px monospace';
      c2.fillText(('ERR: ' + err.message).slice(0, 90), 8, 220);
      c2.fillText(String(err.stack || '').split('\n')[1] || '', 8, 240);
    } catch (e2) {}
  }
  window.__ready = true;
})();
