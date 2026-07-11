// game.js — the simulation engine: round setup, tank placement, the fire→flight→
// impact→settle→scoring cycle. Faithful to the turn/fire flow in the original
// (re/spec_rules.md §3/§5, spec_physics.md §1/§4, spec_graphics.md §3/§4).

import { COL, GAME_PALETTE, TANK_COLORS } from './palette.js';
import { generateTerrain, surfaceYAt, makeCrater, FIELD } from './terrain.js';
import { drawTank, drawDeadTank, eraseTank, applyTankBrightness, drawParachute, tankOccupies } from './tank.js';
import { drawStatusBar, frame3DThick } from './hud.js';
import { launch, step, generateWind } from './physics.js';
import { WEAPON_TABLE, WPN, effectCrater, effectEarthquake, effectPingPong,
         effectEater, effectCaveman, simulateCollapse } from './weapons.js';
import { computeMove } from './ai.js';
import { SND, SND_LIVE } from './sounds.js';

// Timing is driven by WALL-CLOCK time, not the display refresh rate, so the game
// runs at the original's speed on any monitor (60/120/144 Hz). The rates below were
// measured directly from TANK_ENG.EXE in DOSBox (cycles=fixed 20000):
//   * Flight: the original paces every integration step with a CPU-calibrated
//     busy-wait (sub_0a3a, factor 2.0 -> ~2.05 ms/step). Measured 487 steps/s by
//     tracking a shell and fitting y(t)=½·g·rate²·t² (g=0.0011 px/step²).
//   * Parachute fly-in (sub_7060): one VGA vertical-retrace per descent step
//     (~1 px / 60 Hz vsync). Measured 58 px/s (117 px in 2.00 s), strictly linear.
// Flight pacing — DECOMPILED from sub_b785's loop tail (0xbcd3-0xbd01): each VISIBLE step
// with y>0 busy-waits sub_0a3a(2.0) = 2 calibration units; 1 unit is designed as ≈5 ms
// (37·[0x175c]−550 empty loops, [0x175c] = CalibrateSpeed/100). → 10 ms/step = 100 steps/s.
// Steps while the shell is ABOVE the screen (y<0) have NO delay at all — the original
// fast-forwards there (that's the characteristic "vanishes up, rains down quickly" feel),
// reproduced in stepFlight below.
const FLIGHT_STEPS_PER_SEC = 100;
// Weapon 'ops' effects (quake/pingpong/eater/caveman) have NO delay loop in the
// original — their pace is the raw CPU pixel-work rate. Each op carries its sample
// count; this constant converts it to wall-clock. Calibrated against a DOSBox demo
// capture (cycles=20000): a Ping-Pong dug a 375-px channel in 10.37 s ≈ 2478 steps
// × 21 samples ⇒ ~5000 samples/s.
const EFFECT_SAMPLES_PER_SEC = 5000;
const INTRO_PX_PER_SEC     = 60;     // descent: 1 px per WaitVerticalRetrace (sub_64cc) = 60/s
const INTRO_FAST_PX_PER_SEC = 900;   // "press any key / click" skips the vsync wait
const FALL_PX_PER_SEC      = 240;    // animated tank-fall speed (sub_6d3c has no delay;
                                     // chosen visible-but-quick, tunable)

// ---- tank support tests (sub_6cbd/6b84/6b0c/6a93). `g(x,y)` returns true if that pixel
// is solid GROUND. They read the terrain (world) layer so a falling tank never "supports"
// itself or is fooled by the composited sprites.
// sub_6cbd: supported if ground under the centre 5 px (X-2..X+2, Y+1)
const centreSupp = (g, x, y) => g(x, y + 1) || g(x - 2, y + 1) || g(x - 1, y + 1) || g(x + 2, y + 1) || g(x + 1, y + 1);
// sub_6b84: supported if ground anywhere under the footprint (X-6..X+6, Y+1)
const footSupp = (g, x, y) => { for (let dx = -6; dx <= 6; dx++) if (g(x + dx, y + 1)) return true; return false; };
// sub_6b0c: left underside blocked (diagonal X-6..X-9) or against the left wall
const leftBlk = (g, x, y) => x <= 13 || g(x - 6, y + 1) || g(x - 7, y + 1) || g(x - 8, y) || g(x - 9, y - 1);
// sub_6a93: right underside blocked (diagonal X+6..X+9) or against the right wall
const rightBlk = (g, x, y) => x >= 626 || g(x + 6, y + 1) || g(x + 7, y + 1) || g(x + 8, y) || g(x + 9, y - 1);
const DEFAULT_STEPS_PER_FRAME = 8;   // fallback when no dt is supplied (debug/headless)

function makePlayer(idx) {
  const inv = new Array(14).fill(0);
  inv[WPN.HANDGRENADE] = 20;
  return {
    name: `Player ${idx + 1}`,
    isComputer: false,
    personality: 'Terminator',
    colorIndex: TANK_COLORS[idx],
    crew: 100, angle: 45, power: 250, weapon: WPN.HANDGRENADE,
    inventory: inv,
    x: 0, y: 0,
    points: 0, money: 0, wins: 0,
    alive: true,
    get hasParachute() { return (this.inventory[WPN.PARACHUTE] || 0) > 0; },
    get hasQuake()     { return (this.inventory[WPN.QUAKEPROT] || 0) > 0; },
    get hasShield()    { return (this.inventory[WPN.SHIELD] || 0) > 0; },
  };
}

class Game {
  constructor(vga, rnd, spk) {
    this.vga = vga;
    this.rnd = rnd;
    this.spk = spk;
    this.players = [];
    this.options = {
      soundFX: true, flightSFX: false, reflectWalls: 1, // 0 No,1 RND,2 Yes
      showTrace: true, useMouse: true, errorRate: 10, moneyStart: 0,
      gamesPerMatch: 10, numPlayers: 2, reflectActive: false,
    };
    this.currentGame = 1;
    this.wind = 0;
    this.current = 0;
    this.heightmap = null;
    this.projectile = null;
    this.errRateWork = 10;    // AI working error rate (halved each shot)
    this.onImpactDone = null; // callback set by front-end
  }

  setupPlayers(defs) {
    // defs: [{name, isComputer, personality}]
    this.options.numPlayers = defs.length;
    this.players = defs.map((d, i) => {
      const p = makePlayer(i);
      p.name = d.name;
      p.isComputer = d.isComputer;
      p.personality = d.personality || 'Terminator';
      p.money = this.options.moneyStart;
      return p;
    });
  }

  // ---- round setup ------------------------------------------------------------
  // per-GAME arsenal reset — decompiled from the original's new-game player init
  // (0x7924 / 0x84b9): crew=100, angle=45, current weapon = slot 1, HandGrenades = 20,
  // ALL other weapon slots = 0. The shop runs AFTER this reset, so purchases apply to
  // the upcoming game only — the arsenal does NOT carry over between games. (Without
  // this, everyone eventually runs dry and firing stops working.)
  resetPlayersForGame() {
    for (const p of this.players) {
      p.crew = 100; p.alive = true;
      p.angle = 45;
      p.weapon = WPN.HANDGRENADE;
      p.inventory = new Array(14).fill(0);
      p.inventory[WPN.HANDGRENADE] = 20;
      p.power = Math.min(p.power || 250, 1000);
    }
  }

  startRound() {
    // mouse aiming panel ([0x115f]): the preference [0x1775] is initialised to 0 at program
    // start (0x2051) — the panel is OFF until the player toggles it with a RIGHT CLICK
    // during aim (0xe228); it then persists across turns/rounds.
    if (this.mousePanel === undefined) this.mousePanel = false;
    this.spk.enabled = this.options.soundFX;
    this.vga.setPalette(GAME_PALETTE.map(c => c.slice()));  // fresh working palette
    // reflecting-walls per round (sub_da0c @0xda1f): NO=0 off, Yes=2 always on,
    // RND=1 -> on iff RandomN(20) is odd (50%, same draw semantics as the original).
    this.options.reflectActive = this.options.reflectWalls === 2 ||
      (this.options.reflectWalls === 1 && this.rnd.next(20) % 2 === 1);

    this.heightmap = generateTerrain(this.vga, this.rnd);
    // playfield 3-D frame (original: Frame3DThick(0,59,639,479)) — part of the world layer
    frame3DThick(this.vga, 0, FIELD.YTOP - 4, this.vga.W - 1, this.vga.H - 1, true);
    this.wind = generateWind(this.rnd);
    this.errRateWork = this.options.errorRate;   // P = [0x176e], reset from [0x1768] each round
    this.roundCycles = 1;                         // turn-rotation counter ([0x1776], inits 1; ends >20)

    // reset crew, decrement protections (per-round), place tanks
    const N = this.players.length;
    for (let i = 0; i < N; i++) {
      const p = this.players[i];
      p.crew = 100; p.alive = true;
      if (p.power === 0) p.power = 250;
      // protections last one round: decrement (floored at 0)
      for (const w of [WPN.PARACHUTE, WPN.QUAKEPROT, WPN.SHIELD]) {
        p.inventory[w] = Math.max(0, (p.inventory[w] || 0) - 0); // consumed at round END; keep here
      }
      applyTankBrightness(this.vga, p.colorIndex, 100);
    }
    // snapshot the persistent background (sky + terrain, no tanks) — the world layer.
    this.bg = this.vga.buf.slice();
    // place tanks spread across the field with jitter; they PARACHUTE in from the top
    // to their resting position on the surface (round-start insertion, like the original).
    const slotW = (FIELD.X1 - FIELD.X0 - 40) / N;
    for (let i = 0; i < N; i++) {
      const p = this.players[i];
      const base = FIELD.X0 + 20 + i * slotW;
      p.x = Math.round(base + this.rnd.next(Math.max(1, slotW - 24)));
      p.x = Math.max(20, Math.min(FIELD.X1 - 20, p.x));
      p.restY = surfaceYAt(this.vga, p.x) - 1;
      p.y = Math.min(p.restY - 8, FIELD.YTOP + 6);   // start high (below the status bar)
      p.chute = true;
    }
    this._introAcc = 0;                 // reset the wall-clock descent accumulator
    this.dyingTanks = [];               // active death-flash tanks (sub_6895)

    // Turn order — a RANDOM PERMUTATION of the players, DECOMPILED 1:1 from sub_da0c
    // (0xda43..0xdad3): slot 1 = RandomN(N)+1, each further slot re-rolled until it is not
    // a duplicate (rejection sampling). `this.order[slot]` = the tank index that shoots in
    // that slot; `this.turnSlot` is the current slot ([0x1774]) that the AI target walks use.
    const NP = this.players.length;
    this.order = [this.rnd.next(NP)];
    for (let m = 1; m < NP; m++) {
      let v, dup;
      do { v = this.rnd.next(NP); dup = this.order.includes(v); } while (dup);
      this.order[m] = v;
    }
    this.turnSlot = 0;
    this.current = this.order[0];       // all tanks alive at round start
    this.drawScene();
  }

  // advance the round-start parachute descent; returns true when all landed.
  // dtMs = real milliseconds since the last frame (refresh-independent). `fast` is
  // set once the player presses any key or mouse button, which in the original skips
  // the per-step vsync wait so the rest of the fly-in plays at full speed.
  stepRoundIntro(dtMs, fast) {
    let dpx;
    if (dtMs === undefined) {           // headless/debug: advance a fixed pixel per call
      dpx = 3;
    } else {
      const rate = fast ? INTRO_FAST_PX_PER_SEC : INTRO_PX_PER_SEC;
      this._introAcc = (this._introAcc || 0) + (dtMs / 1000) * rate;
      dpx = Math.floor(this._introAcc);
      this._introAcc -= dpx;
      if (dpx > 240) dpx = 240;         // clamp after a stalled/backgrounded tab
    }
    let anyFalling = false;
    for (const p of this.players) {
      if (!p.alive || !p.chute) continue;
      if (p.y < p.restY) { p.y = Math.min(p.restY, p.y + dpx); anyFalling = true; }
      else {  // sub_7060 [bp+6]==0: chirp, then armed→rising 100+5·i / unarmed→800→1500
        p.chute = false;
        let armed = false; for (let w = 1; w <= 10; w++) if ((p.inventory[w] || 0) > 0) { armed = true; break; }
        this.spk.play(SND.roundPlace(armed, p.angle), this.options.soundFX);
      }
    }
    this.drawScene();
    return !anyFalling;
  }

  firstAlive(from) {
    for (let k = 0; k < this.players.length; k++) {
      const i = (from + k) % this.players.length;
      if (this.players[i].alive) return i;
    }
    return from;
  }
  nextPlayer() {
    // Advance the turn-order slot pointer ([0x1774]) to the next tank that is ALIVE and
    // still ARMED — DECOMPILED from 0xd101..0xd123 (skip on sub_0225 unarmed OR sub_01bc
    // dead). When the pointer WRAPS past the end of the slot ring (one full turn-rotation),
    // HALVE the AI error rate and count the cycle (0xd0d0: [0x176e]/=2, inc [0x1776]).
    const N = this.players.length;
    let wrapped = false;
    for (let k = 0; k < N; k++) {
      if (this.turnSlot === N - 1) wrapped = true;
      this.turnSlot = (this.turnSlot + 1) % N;
      const t = this.order[this.turnSlot];
      if (this.players[t].alive && this._isArmed(t)) { this.current = t; break; }
    }
    if (wrapped) { this.errRateWork /= 2; this.roundCycles = (this.roundCycles || 0) + 1; }
  }
  // sub_0225 inverse: does tank idx still own any weapon 1..10?
  _isArmed(idx) {
    const inv = this.players[idx].inventory;
    for (let w = 1; w <= 10; w++) if ((inv[w] || 0) > 0) return true;
    return false;
  }

  // sub_0420 / sub_03da: next / previous ALIVE slot in the turn order (wrapping).
  nextAliveSlot(slot) {
    const N = this.players.length;
    for (let k = 0; k < N; k++) { slot = (slot + 1) % N; if (this.players[this.order[slot]].alive) return slot; }
    return slot;
  }
  prevAliveSlot(slot) {
    const N = this.players.length;
    for (let k = 0; k < N; k++) { slot = (slot - 1 + N) % N; if (this.players[this.order[slot]].alive) return slot; }
    return slot;
  }

  // Surface Y at column x from the clean world layer (mirrors the [0x119a] height array the
  // AI line-of-sight test reads). Returns the topmost GROUND row, or FIELD.YBOT if none.
  surfaceHeightAt(x) {
    x = Math.max(0, Math.min(this.vga.W - 1, x | 0));
    const buf = this.bg || this.vga.buf, W = this.vga.W;
    for (let y = FIELD.YTOP; y <= FIELD.YBOT; y++) if (buf[y * W + x] === COL.GROUND) return y;
    return FIELD.YBOT;
  }
  aliveCount() { return this.players.filter(p => p.alive).length; }
  // A tank is "armed" if it owns at least one weapon 1..10 (sub_0225 is the inverse).
  aliveArmedCount() {
    return this.players.filter(p => {
      if (!p.alive) return false;
      for (let w = 1; w <= 10; w++) if ((p.inventory[w] || 0) > 0) return true;
      return false;
    }).length;
  }
  // Round is over — the da0c turn-loop guards (0xd0b3..): at most one tank alive
  // (`[0x116c] < 2`), OR no alive tank still has a weapon (`sub_0273`), OR the 20th turn-
  // cycle has elapsed (`[0x1776] > 20`, incremented once per full rotation in nextPlayer).
  roundOver() {
    return this.aliveCount() <= 1 || this.aliveArmedCount() === 0 || (this.roundCycles || 0) > 20;
  }

  // ---- rendering --------------------------------------------------------------
  // Composite the frame from the persistent background: restore world (sky+terrain
  // +craters), then draw HUD and live tanks on top. This is why old barrels ("fan")
  // and flight traces never accumulate — every frame starts from the clean world.
  drawScene() {
    if (this.bg) this.vga.buf.set(this.bg);
    drawStatusBar(this.vga, this);
    for (const p of this.players) if (p.alive) {
      drawTank(this.vga, p, this.wind);
      if (p.chute) drawParachute(this.vga, p.x | 0, p.y | 0, p.colorIndex);
    }
    // tanks currently in their death-flash are still drawn (in their colour index; the
    // death animation drives that index's palette entry — sub_6895 draws then colour-cycles).
    if (this.dyingTanks) for (const d of this.dyingTanks) drawDeadTank(this.vga, d);
    this.vga.present();
  }

  // ---- firing -----------------------------------------------------------------
  fire() {
    const p = this.players[this.current];
    if ((p.inventory[p.weapon] || 0) <= 0) return false;
    this.spk.play(SND.launch(), this.options.soundFX);
    this._flightAcc = 0;               // reset the wall-clock step accumulator
    this.projectile = launch(p);
    this.projectile.shooter = this.current;
    this.projectile.weapon = p.weapon;
    // remember velocity direction for directional weapons
    this.projectile.dir = { x: Math.sign(this.projectile.vx), y: Math.sign(this.projectile.vy) };
    return true;
  }

  // advance the flight animation; returns 'flying' | 'impact'. dtMs = real ms since
  // the last frame -> the shell always flies at the original's ~487 steps/s, whatever
  // the monitor refresh rate is.
  stepFlight(dtMs) {
    const p = this.projectile;
    const opts = { reflect: this.options.reflectActive, wind: this.wind };
    let n;
    if (dtMs === undefined) {            // headless/debug fallback
      n = DEFAULT_STEPS_PER_FRAME;
    } else {
      this._flightAcc = (this._flightAcc || 0) + (dtMs / 1000) * FLIGHT_STEPS_PER_SEC;
      n = Math.floor(this._flightAcc);
      this._flightAcc -= n;
      if (n > 60) n = 60;               // clamp after a stall so the arc can't teleport
    }
    // Steps while the shell is ABOVE the screen (y<0) are FREE — the original's per-step
    // busy-wait is skipped there (0xbcf2 jbe), so the off-screen part of a high arc runs
    // at full CPU speed. We bound the free-running with a safety counter.
    let guard = 0;
    for (let s = 0; s < n && !p.done && guard < 25000; guard++) {
      // erase the exact previously-drawn marker (leaving a trace pixel if enabled)
      eraseLastMarker(this.vga, p, this.options.showTrace);
      step(this.vga, p, opts);
      if (!p.done) drawMarker(this.vga, p);
      if (p.y >= 0) s++;                 // only on-screen steps consume paced time
    }
    // in-flight whistle — f = 400 + Round(vy/4), NoSound below 100 Hz (0xb883-0xb8d0).
    // vy is tiny (±~1 px/step), so the original's whistle is a near-constant 400 Hz.
    if (this.options.flightSFX && !p.done) {   // gated by the flight-sound option ([0xcfa]) only
      const wf = SND_LIVE.flightWhistle(p.vy);
      if (wf > 0) this.spk.soundOn(wf); else this.spk.soundOff();
    }
    this.vga.present();
    if (p.done) { this.spk.soundOff(); return 'impact'; }
    return 'flying';
  }

  // resolve the impact: weapon effect + damage + deaths + settle. Returns result.
  resolveImpact() {
    const p = this.projectile;
    const shooter = this.players[p.shooter];
    const w = WEAPON_TABLE[p.weapon];
    // consume ammo; if the current weapon ran dry, auto-switch to the next owned one
    // (original rule: "leer ⇒ nächste vorhandene Waffe")
    shooter.inventory[p.weapon] = Math.max(0, (shooter.inventory[p.weapon] || 0) - 1);
    if ((shooter.inventory[shooter.weapon] || 0) <= 0) {
      for (let k = 1; k <= 13; k++) {
        const w2 = ((shooter.weapon - 1 + k) % 13) + 1;
        if ((shooter.inventory[w2] || 0) > 0) { shooter.weapon = w2; break; }
      }
    }

    let menKilled = 0;
    const impact = p.impact || { x: Math.round(p.x), y: Math.round(p.y) };
    impact.dx = p.dir.x;

    // Apply terrain-destroying effects to the CLEAN world layer (no tanks/trace),
    // then fold the result back into the background.
    if (this.bg) this.vga.buf.set(this.bg);

    // Build an ordered ANIMATION PHASE QUEUE that mirrors the original's post-impact
    // sequence exactly (sub_bd08 tail): weapon-dig → blast-death flashes → terrain
    // collapse → animated tank fall → fall-death flashes. Each phase animates wall-clock.
    // (The AI error rate is NOT halved here — the original decays it once per completed
    // turn-cycle in nextPlayer(), not per shot.)
    const phases = [];
    let res = null;
    // sub_bd08 tail @0xbf4c: a shot MISSES only if its final X is outside [4,635]. A shell
    // that falls to the arena floor (X in range, Y>475 — e.g. down a dug shaft) still
    // DETONATES at the bottom; only shells that left the side are duds.
    const missed = impact.x < FIELD.X0 || impact.x > FIELD.X1;
    if (impact.y > FIELD.YBOT) impact.y = FIELD.YBOT;
    if (missed) {
      this.spk.play(SND.miss, this.options.soundFX);
    } else {
      const vel = { x: p.vx, y: p.vy }, dir = p.dir.x || 1;
      switch (w.cat) {
        case 0: res = effectCrater(this.vga, this.players, p.shooter, impact, w.B); break;
        case 1: res = effectEarthquake(this.vga, this.players, p.shooter, impact, shooter.power, vel, this.rnd); break;
        case 2: res = effectPingPong(this.vga, this.players, p.shooter, impact, vel, w.B, this.options.reflectActive); break;
        case 3: res = effectEater(this.vga, this.players, p.shooter, impact, w.B, dir, true, this.rnd); break;
        case 4: res = effectEater(this.vga, this.players, p.shooter, impact, w.B, dir, false, this.rnd); break;
        case 5: res = effectCaveman(this.vga, this.players, p.shooter, impact, dir); break;
        default: break; // protections have no offensive effect
      }
      if (res) {
        menKilled = res.menKilled;
        // (1) weapon dig / crater flash
        if (res.anim) phases.push(res.anim.kind === 'crater' ? { ...res.anim } : { ...res.anim, i: 0 });
        // (2) blast-death flashes (tanks the blast reduced to 0 crew) — BEFORE the collapse,
        //     as in the original (the 0xc8ca damage loop calls sub_6895 immediately).
        const blastDead = this.reapDead();
        if (blastDead.length) phases.push({ kind: 'death', queue: blastDead, di: 0, t: 0, soundPlayed: false });
        // (3) terrain collapse (sub_625d) over the effect's box, simulated on the post-carve world
        if (res.box) {
          const scratch = this.bg.slice();
          if (res.anim && res.anim.kind === 'ops') for (const o of res.anim.ops) if (o.px) for (const idx of o.px) scratch[idx] = COL.SKY;
          else if (res.anim && res.anim.kind === 'crater') makeCrater({ W: this.vga.W, buf: scratch }, res.anim.x, res.anim.y, res.anim.B);
          const col = simulateCollapse(scratch, this.vga.W, res.box);
          if (col.length) phases.push({ kind: 'ops', ops: col, i: 0 });
        }
        // (4) animated tank fall (+ fall damage + fall-death flashes, queued at its end)
        phases.push({ kind: 'fall' });
      }
    }

    // per-man kill award: 50 pts + $50 per enemy man killed (shooter)
    if (menKilled > 0) { shooter.points += 50 * menKilled; shooter.money += 50 * menKilled; }

    this.projectile = null;
    this._menKilled = menKilled;
    this._shooterIdx = p.shooter;      // for crediting fall casualties during the animation
    this.phases = phases;
    this.anim = phases.shift() || null;
    if (this.anim) { this.drawScene(); return { menKilled, over: false, animating: true }; }
    this.bg = this.vga.buf.slice();
    return { menKilled, over: this.roundOver() };
  }

  // mark every alive tank whose crew hit 0 as dead and return death-flash snapshots.
  reapDead() {
    const dead = [];
    for (const t of this.players) {
      if (t.alive && t.crew <= 0) { t.alive = false; dead.push({ x: t.x, y: t.y, angle: t.angle, colorIndex: t.colorIndex, name: t.name }); }
    }
    return dead;
  }

  // called by the loop when the whole phase queue is finished — the terrain, deaths and
  // tank positions are already final. this.bg is the clean world layer, kept current by
  // the phases (crater/ops carve into it; fall moves only tanks), so we must NOT re-snap
  // it from vga.buf here — that buffer already has the tanks drawn on top.
  finishAnim() {
    return { menKilled: this._menKilled || 0, over: this.roundOver() };
  }

  // advance the weapon-effect animation; returns true when finished. dtMs = real
  // milliseconds since the last frame — all effect pacing is WALL-CLOCK so it matches
  // the original on any display refresh rate.
  //
  // 'crater' (impact code 0xbf8a..0xc0e1): the original paints the crater shape in
  // palette index 12 preset to the SKY colour, then ramps that entry sky→white→sky in
  // 15+16 vsync steps (SetRGBPalette + WaitVRetrace, ~0.52 s) — a crater-shaped white
  // FLASH — and finally carves with colour 0. Reproduced 1:1 via palette animation.
  //
  // 'ops' (quake/pingpong/eater/caveman): the original has NO delay in these loops —
  // the pace is CPU-bound pixel work. Each op carries `cost` (samples the original
  // touched); we consume ops at EFFECT_SAMPLES_PER_SEC and pulse the PC speaker per op
  // (Sound(f)/NoSound around each eaten pixel run) — the authentic rattling rumble.
  stepAnim(dtMs) {
    if (!this.anim) return true;
    const dt = (dtMs === undefined) ? 1000 / 60 : Math.min(100, dtMs);
    const done = this._stepPhase(this.anim, dt);
    if (done) {
      this.anim = this.phases.shift() || null;   // advance to the next queued phase
      this.drawScene();
      return this.anim === null;
    }
    return false;
  }

  // Advance ONE animation phase; returns true when THAT phase completes (the wrapper
  // then pops the next queued phase). Handlers must NOT touch this.anim/this.phases —
  // except the 'fall' handler, which QUEUES the fall-death flashes onto this.phases.
  _stepPhase(a, dt) {
    // ---- tank death flash (sub_6895): draws the dead tank, then colour-cycles its
    // palette index black→white→black→sky over 4 phases with a rising 300+20i tone,
    // then erases it and restores the tank's real colour. Tanks die one after another.
    if (a.kind === 'death') {
      const d = a.queue[a.di];
      // The original switches the HUD name box to the DYING tank during the flash: its name is
      // drawn in this tank's colour index, so the palette cycle below makes the name blink
      // (fade up to white) and then fade out — see drawStatusBar's use of _dyingHud.
      this._dyingHud = { name: d.name, colorIndex: d.colorIndex };
      const PH = 260;                                     // ms per phase (A/B/C); ~0.9s/tank
      if (!a.soundPlayed) {                               // rising tones + end sweep, once/tank
        this.dyingTanks.push(d);
        const notes = [];
        for (let i = 0; i <= 15; i++) notes.push({ f: 300 + 20 * i, d: PH / 16 });
        for (let i = 15; i >= 0; i--) notes.push({ f: 300 + 20 * i, d: PH / 16 });
        for (let s = 900; s >= 200; s -= 2) notes.push({ f: s, d: 1 });   // sub_5a48(900,200,2) — step 2, 1 ms/note
        this.spk.play(notes, this.options.soundFX);
        a.soundPlayed = true;
      }
      a.t += dt;
      const e = v => ((v << 2) | (v >> 4)) & 0xff;        // 6-bit DAC → 8-bit
      const ci = d.colorIndex;
      let col;
      if (a.t < PH) {                                     // phase A: grey 0→60
        const i = Math.min(15, Math.floor(a.t / PH * 16)); col = [e(i * 4), e(i * 4), e(i * 4)];
      } else if (a.t < 2 * PH) {                          // phase B: grey 60→0
        const i = Math.max(0, 15 - Math.floor((a.t - PH) / PH * 16)); col = [e(i * 4), e(i * 4), e(i * 4)];
      } else if (a.t < 3 * PH) {                          // phase C: black → sky (16,51,60)
        const i = Math.min(15, Math.floor((a.t - 2 * PH) / PH * 16));
        col = [e(Math.round(16 * i / 15)), e(Math.round(51 * i / 15)), e(i * 4)];
      } else {                                            // done with this tank: erase + restore
        this.dyingTanks.pop();
        this.vga.palette[ci] = GAME_PALETTE[ci].slice(); this.vga._syncPalette();
        a.di++; a.t = 0; a.soundPlayed = false;
        if (a.di >= a.queue.length) { this._dyingHud = null; this.drawScene(); return true; }
        this.drawScene();
        return false;
      }
      this.vga.palette[ci] = col; this.vga._syncPalette();
      this.drawScene();
      return false;
    }

    if (a.kind === 'crater') {
      const STEP = 1000 / 60, TOTAL = 31 * STEP;          // 15 up + 16 down vsyncs
      if (a.t === undefined) {
        a.t = 0;
        this.spk.play(SND.craterSeq(a.B), this.options.soundFX);
      } else a.t += dt;
      if (a.t >= TOTAL) {
        this.vga.buf.set(this.bg); makeCrater(this.vga, a.x, a.y, a.B); this.bg = this.vga.buf.slice();
        this.vga.palette[COL.NUKE_RED] = GAME_PALETTE[COL.NUKE_RED].slice(); // restore red
        this.vga._syncPalette();
        this.drawScene();
        return true;
      }
      // flash colour: index 12 ramps sky(16,51,63) → white(63,63,63) → sky (6-bit DAC)
      const i = Math.floor(a.t / STEP);
      const ph = i <= 15 ? i : Math.max(0, 31 - i);
      const e = v => ((v << 2) | (v >> 4)) & 0xff;
      this.vga.palette[COL.NUKE_RED] =
        [e(Math.round(47 * ph / 15) + 16), e(Math.round(12 * ph / 15) + 51), e(63)];
      this.vga._syncPalette();
      this.drawScene();                                    // bg + tanks
      // crater-shaped flash in index 12, clipped to the playfield (like sub_b044)
      const W = this.vga.W, r = a.B;
      for (let dy = -r; dy <= r; dy++) {
        const y = a.y + dy;
        if (y < FIELD.YTOP || y > FIELD.YBOT) continue;
        const half = Math.floor(Math.sqrt(r * r - dy * dy) + 1e-9);
        const x0 = Math.max(FIELD.X0, a.x - half), x1 = Math.min(FIELD.X1, a.x + half);
        if (x0 <= x1) this.vga.buf.fill(COL.NUKE_RED, y * W + x0, y * W + x1 + 1);
      }
      this.vga.present();
      return false;
    }

    // ---- animated tank fall + fall damage — DECOMPILED 1:1 from sub_6d3c, driven per
    // tank by sub_7060's loop (0x70a0..0x7132). SEQUENTIAL, exactly like the original:
    // each tank falls to completion, and if the fall kills it, sub_6d3c flashes it
    // (sub_6895 @0x6f08) BEFORE sub_7060 advances to the next tank — falls and their
    // death-flashes never overlap. A tank not supported at its centre (sub_6cbd) drops
    // one pixel per step, SLIDING toward the open side (sub_6b0c left / sub_6a93 right)
    // until its footprint finds ground (sub_6b84) or BOTH sides are blocked. sub_6d3c
    // has NO Sound call — the fall is SILENT (the 700 Hz tone nearby is the Caveman drill
    // sub_3bb7 @0x3c4c, not this). Fall damage (§4): fall>2·crew0 ⇒ crew 0; else
    // crew0−⌊fall/2⌋; power=min(power,10·crew), recomputed each step so the tank visibly
    // dims. Skipped for an active parachute (sub_02d4 ⇒ flag 0), but that tank still
    // settles. Terrain is untouched by the fall, so the tank order is result-irrelevant
    // (we process in player order — the original walks the 0x1161 order array).
    if (a.kind === 'fall') {
      const W = this.vga.W, bg = this.bg, players = this.players;
      // Support/blocked tests read the composited scene: sub_6cbd et al. use GetPixel != sky,
      // so GROUND *or any OTHER alive tank* supports (a tank can rest on top of another). The
      // tank whose own support we test (`excl`) is excluded so it can't support itself.
      let excl = null;
      const g = (x, y) => {
        if (x < 0 || x >= W || y < 0 || y >= 480) return false;
        if (bg[y * W + x] === COL.GROUND) return true;
        for (const o of players) { if (o === excl || !o.alive) continue; if (tankOccupies(o, x, y)) return true; }
        return false;
      };
      if (!a.tanks) {                                     // discover candidates once
        a.tanks = players.filter(t => t.alive);
        a.ti = 0; a.started = false; a.acc = 0;
      }
      // pick the next tank that actually needs to fall (sub_6cbd initial test @0x6d7b)
      while (a.ti < a.tanks.length && !a.started) {
        const t = a.tanks[a.ti];
        excl = t;
        if (t.alive && !centreSupp(g, t.x | 0, t.y | 0)) {
          t._startY = t.y | 0; t._crew0 = t.crew; a.started = true; a.acc = 0;
        } else a.ti++;
      }
      if (a.ti >= a.tanks.length) return true;            // no (more) tanks to fall
      const t = a.tanks[a.ti];
      excl = t;
      a.acc += (dt / 1000) * FALL_PX_PER_SEC;
      let steps = Math.floor(a.acc); a.acc -= steps;
      let landed = false;
      while (steps-- > 0 && !landed) {
        let x = t.x | 0, y = t.y | 0;
        // sub_6d3c @0x6dd4: BOTH edge tests read the ORIGINAL X (0x3b), then a copy is
        // shifted — so evaluate leftBlk/rightBlk before applying either shift.
        const lb = leftBlk(g, x, y), rb = rightBlk(g, x, y);
        if (lb) x++;                                      // sub_6b0c: slide off blocked left
        if (rb) x--;                                      // sub_6a93: slide off blocked right
        y++;                                              // drop one pixel
        t.x = x; t.y = y;
        if (!t.hasParachute) {                            // sub_6d3c damage branch (flag==1)
          const fall = y - t._startY;
          t.crew = (fall > 2 * t._crew0) ? 0 : t._crew0 - Math.floor(fall / 2);
          t.power = Math.min(t.power, 10 * Math.max(0, t.crew));
        }
        if (footSupp(g, x, y) || (leftBlk(g, x, y) && rightBlk(g, x, y)) || y >= FIELD.YBOT) landed = true;
      }
      this.drawScene();
      if (!landed) return false;                          // this tank is still falling
      // this tank settled. Credit any crew the FALL cost to the shooter — sub_6d3c adds
      // max(0, crew0−crew) to the kill counter [0x1692] (×50 for points AND money), for
      // every tank other than the shooter itself.
      const fallLoss = Math.max(0, (t._crew0 || 0) - t.crew);
      if (fallLoss > 0 && t !== this.players[this._shooterIdx]) {
        const sh = this.players[this._shooterIdx];
        if (sh) { sh.points += 50 * fallLoss; sh.money += 50 * fallLoss; }
        this._menKilled = (this._menKilled || 0) + fallLoss;
      }
      // advance; if the fall killed it, interleave its death flash NOW (before the next
      // tank falls), exactly as sub_6d3c → sub_6895 does inline.
      delete t._startY; delete t._crew0;
      a.ti++; a.started = false;
      if (t.alive && t.crew <= 0) {
        t.alive = false;
        const death = { kind: 'death', queue: [{ x: t.x, y: t.y, angle: t.angle, colorIndex: t.colorIndex, name: t.name }], di: 0, t: 0, soundPlayed: false };
        if (a.ti < a.tanks.length) this.phases.unshift(a);   // resume the remaining falls after…
        this.phases.unshift(death);                          // …flashing this tank first
        return true;
      }
      return a.ti >= a.tanks.length;                      // stay in phase if tanks remain
    }

    // 'ops': consume the op queue at the original's sample rate; carve into the world
    // layer and build this frame's speaker gating pattern (tone while eating ground,
    // silence while the strip lines cross already-open space).
    const ops = a.ops;
    a.budget = (a.budget || 0) + (dt / 1000) * EFFECT_SAMPLES_PER_SEC;
    const slots = [];
    while (a.i < ops.length) {
      const o = ops[a.i];
      const c = o.cost || (o.px.length + 1);
      if (c > a.budget) break;
      a.budget -= c;
      for (const idx of o.px) this.bg[idx] = COL.SKY;       // carve into world layer
      if (o.add) for (const idx of o.add) this.bg[idx] = COL.GROUND;  // collapse: pixel lands
      const f = (o.px.length || (o.add && o.add.length)) ? o.f : 0;
      const d = c / EFFECT_SAMPLES_PER_SEC;
      const last = slots[slots.length - 1];
      if (last && last.f === f) last.d += d; else slots.push({ f, d });
      a.i++;
    }
    if (slots.length) this.spk.gate(slots.slice(0, 160), this.options.soundFX);
    this.drawScene();
    if (a.i >= ops.length) { this.spk.soundOff(); return true; }
    return false;
  }

  // called at the end of a round: scoring pot + wins + consume protections
  endRoundScoring() {
    const survivors = this.aliveCount();
    const N = this.players.length;
    if (survivors > 0) {
      const bonus = Math.floor(((N - survivors) * 1000) / survivors);
      for (const p of this.players) {
        if (p.alive) { p.money += bonus; p.points += bonus; }
      }
    }
    if (survivors === 1) {
      const w = this.players.find(p => p.alive);
      if (w) w.wins++;
    }
    // protections are per-round: consume one unit of each owned protection
    for (const p of this.players) {
      for (const w of [WPN.PARACHUTE, WPN.QUAKEPROT, WPN.SHIELD]) {
        p.inventory[w] = Math.max(0, (p.inventory[w] || 0) - 1);
      }
    }
  }

  // AI move for the current player
  aiMove() {
    const p = this.players[this.current];
    const ctx = {
      order: this.order, slot: this.turnSlot,
      nextAliveSlot: (s) => this.nextAliveSlot(s),
      prevAliveSlot: (s) => this.prevAliveSlot(s),
      surfaceY: (x) => this.surfaceHeightAt(x),
    };
    const mv = computeMove(this.players, this.current, this.errRateWork, this.rnd, this.options.reflectActive, ctx);
    p.weapon = mv.weapon;
    p.angle = Math.max(0, Math.min(180, mv.angle));
    p.power = Math.max(0, Math.min(10 * p.crew, mv.power));
    // sub_b4a2: the aiming brains (Jack/Ballisto/Terminator-direct/-reflect) mark their
    // TARGET with a shrinking red ring before firing; random brains (Berti/Klaus) and the
    // super-blast / blind-lob branches do not (they return no ringTarget).
    this._aimRingTarget = (mv.ringTarget && mv.ringTarget.alive) ? mv.ringTarget : null;
  }

  // Draw one frame of the CPU aim ring (sub_b4a2): a red (colour 12) circle of the given
  // radius around the target tank, clipped to the play field, over the current scene.
  drawAimRing(tank, r) {
    this.drawScene();
    if (r <= 0) return;
    const W = this.vga.W, buf = this.vga.buf, cx = tank.x | 0, cy = tank.y | 0;
    const plot = (x, y) => {
      if (x >= FIELD.X0 && x <= FIELD.X1 && y >= FIELD.YTOP && y <= FIELD.YBOT) buf[y * W + x] = COL.NUKE_RED;
    };
    let x = r, y = 0, err = 1 - r;         // integer midpoint circle (like BGI Circle)
    while (x >= y) {
      plot(cx + x, cy + y); plot(cx - x, cy + y); plot(cx + x, cy - y); plot(cx - x, cy - y);
      plot(cx + y, cy + x); plot(cx - y, cy + x); plot(cx + y, cy - x); plot(cx - y, cy - x);
      y++; if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
    this.vga.present();
  }

  // Between-rounds CPU auto-shopping — DECOMPILED 1:1 from the CPU branch of sub_9d62
  // (0xa801..0xab34) + the affordable-list builder sub_9b05. The CPU repeatedly rebuilds
  // the list of AFFORDABLE weapons (price ≤ money, ascending w = 1..13, sub_9b05 @0x9b25)
  // and, per its personality brain, either buys one bundle (inventory[w] += lot,
  // money -= price, @0xaad6) or stops. Probabilistic brains stop the moment their die
  // roll says "no buy"; Berti buys until nothing is affordable. IMPORTANT: the field the
  // brains read as an "AI stat" (`es:[rec+0x1a]`, compared to 20) is simply inventory[2]
  // — the 5 kT Nuke count (inventory lives at rec+0x16+w·2, so w=2 → +0x1a); it is never
  // written elsewhere. Since the cheapest item (HandGrenade, 1000) is always list[0] when
  // anything is affordable, every downward cat-scan is guaranteed to terminate at index 0.
  cpuShop(p) {
    let guard = 0;
    while (guard++ < 5000) {
      const list = [];
      for (let w = 1; w <= 13; w++) if (WEAPON_TABLE[w].price <= p.money) list.push(w);
      if (!list.length) break;                       // nothing affordable (sub_9b05 count==0)
      const d = this._cpuShopDecide(p, list);        // {w, buy}
      if (!d.buy) break;
      p.inventory[d.w] = (p.inventory[d.w] || 0) + WEAPON_TABLE[d.w].lot;
      p.money -= WEAPON_TABLE[d.w].price;
    }
  }

  // One CPU purchase decision from the affordable `list` (ascending weapon ids). Returns
  // {w, buy}. Mirrors the five brains at 0xa811 (Berti), 0xa83e (Klaus), 0xa8a2 (Jack),
  // 0xa9a0 (Ballisto) and the default 0xaa59 (Terminator).
  _cpuShopDecide(p, list) {
    const R = this.rnd;
    const cat = w => WEAPON_TABLE[w].cat;
    const owns = w => (p.inventory[w] || 0) > 0;
    const n = list.length, last = n - 1;
    const name = p.personality;

    if (name === 'Berti')                             // Brain1: random affordable, always buy
      return { w: list[R.next(n)], buy: true };

    if (name === 'Klaus') {                           // Brain2: highest cat-0/6, 50%
      let k = last; while (k > 0 && cat(list[k]) !== 0 && cat(list[k]) !== 6) k--;
      return { w: list[k], buy: (R.next(10) & 1) === 1 };
    }

    if (name === 'Jack') {                            // Brain3
      if (!owns(WPN.PINGPONG)) {                      // owns no Ping-Pong → buy it if affordable
        const i = list.indexOf(WPN.PINGPONG);
        return i >= 0 ? { w: WPN.PINGPONG, buy: true } : { w: list[last], buy: false };
      }
      let k = last;                                   // else: highest cat-2 / owned cat-6, 70%
      while (k > 0 && !(cat(list[k]) === 2 || (cat(list[k]) === 6 && owns(list[k])) || list[k] <= 1)) k--;
      const c = cat(list[k]);
      return { w: list[k], buy: (c === 2 || c === 6) ? R.next(10) < 7 : false };
    }

    if (name === 'Ballisto') {                        // Brain4
      if ((p.inventory[2] || 0) < 20) {               // stock 5 kT Nukes up to 20
        const i = list.indexOf(2);
        return i >= 0 ? { w: 2, buy: true } : { w: list[last], buy: false };
      }
      let k = R.next(n);                              // else: random start → cat-0 / unowned cat-6, 50%
      while (k > 0 && !(cat(list[k]) === 0 || (cat(list[k]) === 6 && !owns(list[k])))) k--;
      return { w: list[k], buy: (R.next(10) & 1) === 1 };
    }

    // Terminator / default (Brain5)
    if ((p.inventory[2] || 0) < 20) {                 // stock 5 kT Nukes up to 20
      const i = list.indexOf(2);
      return i >= 0 ? { w: 2, buy: true } : { w: list[last], buy: false };
    }
    let k = R.next(n);                                // else: random start, skip cat-2, 70%
    while (k > 0 && cat(list[k]) === 2) k--;
    return { w: list[k], buy: R.next(10) < 7 };
  }
}

// ---- marker drawing helpers (2x2 block, colour 14; trace colour 15) -----------
// The exact integer position last drawn is stored on the projectile so the erase
// removes precisely those pixels (rounding is not reversible from the float pos).
// Each of the 2x2 pixels is CLIPPED to the playfield interior (x 4..635, y 63..475):
// with reflecting walls OFF the shell flies past the field edges, and without the clip
// its trace would draw over the surrounding 3-D frame (as the original never does — BGI
// draws inside the viewport). drawMarker/eraseLastMarker share the same clip so the erase
// removes exactly what was drawn.
function markerPix(vga, x, y, c) {
  if (x >= FIELD.X0 && x <= FIELD.X1 && y >= FIELD.YTOP && y <= FIELD.YBOT) vga.putPixel(x, y, c);
}
function drawMarker(vga, p) {
  const x = Math.round(p.x), y = Math.round(p.y);
  p.mx = x; p.my = y;
  markerPix(vga, x, y, COL.PROJECTILE);     markerPix(vga, x + 1, y, COL.PROJECTILE);
  markerPix(vga, x, y + 1, COL.PROJECTILE); markerPix(vga, x + 1, y + 1, COL.PROJECTILE);
}
function eraseLastMarker(vga, p, trace) {
  if (p.mx === undefined) return;
  const x = p.mx, y = p.my, c = trace ? COL.TRACE : COL.SKY;
  markerPix(vga, x, y, c);     markerPix(vga, x + 1, y, c);
  markerPix(vga, x, y + 1, c); markerPix(vga, x + 1, y + 1, c);
}

export { Game, makePlayer };
