// ai.js — computer players, DECOMPILED from the aim brains and the CPU dispatcher in
// sub_da0c (re/spec_rules.md §5). Aim is CLOSED-FORM (no iteration):
//   * sub_d2c8  parabolic lob  — angle 45/135, ballistic power (Ballisto, Jack-no-PP)
//   * sub_d61a  direct fire     — arctan barrel, full power (Terminator, non-reflect)
//   * sub_d48a  reflection aim  — arctan to a mirrored target (Terminator, reflect walls)
//   * sub_d17a  Jack's PP lob   — parabolic but aimed at the FIELD BOTTOM, half error
// A single multiplicative range error (sub_0361) is applied. The error value P is the
// per-match "computer error rate" ([0x176e], default 10); it HALVES once per completed
// turn-cycle (sub at 0xd0d0), NOT per shot — the game loop drives that decay.
//
// Verified constants: gravity G = 0.0011 (real 1b77 e00d 102d), INV_C = 333.333 = 1/0.003
// (real ab89 aaaa 26aa), RAD2DEG = 57.2958 (real 1e86 e0d3 652e).

import { WEAPON_TABLE, WPN } from './weapons.js';

const G = 0.0011;
const INV_C = 1000 / 3;         // 333.333…
const RAD2DEG = 180 / Math.PI;  // 57.2958…
const FIELD_BOTTOM = 475;       // 0x1db — Jack lobs toward here (+16)

// sub_0361: range-error factor = (100 − arg + 2·arg·RandomR)/100 = 1 + (arg/100)·(2R−1).
// The caller passes the EXACT numerator `arg` the original feeds in: P+1 for the parabolic/
// direct/reflect brains (they RADD 1.0), P/2 for Jack's PP lob (RDIV 2.0).
function errFactor(arg, rnd) {
  return (100 - arg + 2 * arg * rnd.nextFloat()) / 100;
}

// sub_d2c8 — parabolic lob. angle 45 (target right) / 135 (left); dXe = |factor·(|Δx|−11)|;
// power = min(10·crew, round(333.333·√(0.0011·dXe² / (dXe + (Δy+11))))). denom≤0 ⇒ max power.
function solveParabolic(shooter, target, P, rnd) {
  const angle = target.x > shooter.x ? 45 : 135;
  const dXe = Math.abs(errFactor(P + 1, rnd) * (Math.abs(target.x - shooter.x) - 11));
  const denom = dXe + ((target.y - shooter.y) + 11);
  // denom ≤ 0 (target far above): sub_d2c8 @0xd444 gives up — full power AND forces the
  // weapon to 3 (5 MT Nuke); `giveUp` tells the caller to scan from 3 instead of 2.
  if (denom <= 0) return { angle, power: 10 * shooter.crew, giveUp: true };
  const power = Math.max(0, Math.min(10 * shooter.crew,
    Math.round(INV_C * Math.sqrt((G * dXe * dXe) / denom))));
  return { angle, power };
}

// sub_d17a — Jack's Ping-Pong lob: identical to the parabolic solve BUT the denominator
// uses the field bottom (491 − shooter.y) so the shot lobs the full width, and the error
// arg is P/2 (Jack aims WELL). Weapon forced to Ping-Pong.
function solveJack(shooter, target, P, rnd) {
  const angle = target.x > shooter.x ? 45 : 135;
  const dXe = Math.abs(errFactor(P / 2, rnd) * (Math.abs(target.x - shooter.x) - 11));
  const denom = dXe + (FIELD_BOTTOM + 16 - shooter.y);   // 491 − shooter.y (always > 0)
  const power = Math.max(0, Math.min(10 * shooter.crew,
    Math.round(INV_C * Math.sqrt((G * dXe * dXe) / denom))));
  return { angle, power, weapon: WPN.PINGPONG };
}

// sub_d61a — direct fire. K = factor·(Δx); K=0 ⇒ 90°; K>0 ⇒ round(atan((Sy−Ty)/K)·°);
// K<0 ⇒ 180 − round(atan((Ty−Sy)/K)·°). power = 10·crew.
function solveDirect(shooter, target, P, rnd) {
  const K = errFactor(P + 1, rnd) * (target.x - shooter.x);
  let angle;
  if (K === 0) angle = 90;
  else if (K > 0) angle = Math.round(Math.atan((shooter.y - target.y) / K) * RAD2DEG);
  else angle = 180 - Math.round(Math.atan((target.y - shooter.y) / K) * RAD2DEG);
  return { angle, power: 10 * shooter.crew };
}

// sub_d48a — reflection-mode aim. K = factor·(Δx); N = target.y + shooter.y − 126;
// target right ⇒ round(atan(N/K)·°); left ⇒ 180 − round(atan(N/(−K))·°). power = 10·crew.
function solveReflect(shooter, target, P, rnd) {
  const K = errFactor(P + 1, rnd) * (target.x - shooter.x);
  const N = target.y + shooter.y - 126;
  let angle;
  if (target.x > shooter.x) angle = (K === 0) ? 90 : Math.round(Math.atan(N / K) * RAD2DEG);
  else { const Kn = (K !== 0) ? -K : 1e-9; angle = 180 - Math.round(Math.atan(N / Kn) * RAD2DEG); }
  return { angle, power: 10 * shooter.crew };
}

// --- target selection ---------------------------------------------------------
// sub_086e: alive, non-self, NO parachute, minimum Y (highest on screen); if none
// unprotected, ignore protection; else any alive.
function pickLowestUnprotected(players, shooterIdx) {
  let best = null, bestY = Infinity;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    if (i === shooterIdx || !t.alive || t.hasParachute) continue;
    if (t.y < bestY) { bestY = t.y; best = t; }
  }
  if (best) return best;
  for (let i = 0; i < players.length; i++) {
    const t = players[i];
    if (i === shooterIdx || !t.alive) continue;
    if (t.y < bestY) { bestY = t.y; best = t; }
  }
  return best;
}

function nearestEnemy(players, shooterIdx) {
  const s = players[shooterIdx];
  let best = null, bestD = Infinity;
  for (let i = 0; i < players.length; i++) {
    if (i === shooterIdx || !players[i].alive) continue;
    const d = Math.abs(players[i].x - s.x);
    if (d < bestD) { bestD = d; best = players[i]; }
  }
  return best;
}

// sub_0467: among alive non-self SLOTS (turn-order), the one whose tank has MAX wins
// (priority byte +0x3a), tiebreak MAX points (+0x32). Returns a slot index.
function pickMostWinsSlot(players, ctx, selfSlot) {
  let bestSlot = selfSlot, bestWins = -1, bestPts = -1;
  for (let s = 0; s < players.length; s++) {
    const t = players[ctx.order[s]];
    if (s === selfSlot || !t.alive) continue;
    // NOTE: `>=` on points (not `>`) — sub_0467 @0x04fa updates on ties, keeping the LAST match.
    if (t.wins > bestWins || (t.wins === bestWins && t.points >= bestPts)) { bestWins = t.wins; bestPts = t.points; bestSlot = s; }
  }
  return bestSlot;
}

// sub_071a / sub_07c4: Σ(self.y − other.y) over alive tanks that stand HIGHER than self,
// scanning forward (nextAliveSlot) / backward (prevAliveSlot) through the turn order until
// the slot index wraps back past self. A big sum ⇒ many low targets on that side.
function heightSum(players, ctx, selfSlot, forward) {
  const self = players[ctx.order[selfSlot]];
  let sum = 0, s = forward ? ctx.nextAliveSlot(selfSlot) : ctx.prevAliveSlot(selfSlot);
  while (forward ? (s > selfSlot) : (s < selfSlot)) {
    const o = players[ctx.order[s]];
    if (o.y < self.y) sum += self.y - o.y;
    s = forward ? ctx.nextAliveSlot(s) : ctx.prevAliveSlot(s);
  }
  return sum;
}

// sub_0530: clear line of sight from tank `fromIdx` to `toIdx` across the terrain surface.
// Walks the straight barrel ray B→A one column at a time; blocked if the surface rises to/
// above the ray. Clear iff it reaches A's column with the ray within 5 px of A.
function hasLineOfSight(players, ctx, fromIdx, toIdx) {
  const B = players[fromIdx], A = players[toIdx];
  if (fromIdx === toIdx || !A.alive || !B.alive) return false;
  const xA = A.x | 0, xB = B.x | 0, yB = B.y | 0;
  const stepX = (xA > xB) ? 1 : -1;
  const slope = (xA === xB) ? 1000 : (A.y - B.y) / (xA - xB);
  let curX = xB, curY = yB;
  for (let g = 0; g < 2050; g++) {
    if (ctx.surfaceY(curX) <= curY) break;      // terrain surface at/above the ray → blocked
    if (curX === xA) break;                       // reached the target column
    curX += stepX;
    curY = (yB - 5) + Math.round(slope * (curX - xB));
  }
  // sub_0530 @0x06c1: clear iff the ray reached A's column AND the target is not far below
  // the SHOOTER — the original tests (A.y − B.y) < 5 (signed), NOT the ray height at A.
  return curX === xA && (A.y - B.y) < 5;
}

function ownsAny(t, weapons) { return weapons.find(w => (t.inventory[w] || 0) > 0) || null; }

// sub_d2c8 / sub_d48a / super-blast weapon pick: from `start`, scan DOWN to the first owned
// weapon (d2c8 wraps 1→10; d48a & the super-blast just decrement toward 1).
function scanWeaponDown(t, start, wrap) {
  let w = start;
  for (let k = 0; k < 13; k++) {
    if ((t.inventory[w] || 0) > 0) return w;
    w = (w === 1) ? (wrap ? 10 : 1) : w - 1;
  }
  return start;
}

// Decide this computer player's move — DECOMPILED 1:1 from the CPU dispatcher in sub_da0c
// (0xe4e4..0xe926). `P` is the live per-match error value ([0x176e]); `reflect` is this
// round's reflecting-walls flag ([0xcf7]); `ctx` carries the turn-order slots ([0x1161]),
// the shooter's slot ([0x1774]) and the terrain surface, for faithful target selection.
function computeMove(players, shooterIdx, P, rnd, reflect, ctx) {
  const t = players[shooterIdx];
  const name = t.personality;

  // Berti / Klaus (0xe411 / 0xe4ae) — first cycle the selected weapon: from the current
  // weapon, step 1→2→…→10→1 skipping unowned; at each OWNED weapon stop with a die roll
  // (Berti RandomN(10)>=8 ≈20 %; Klaus RandomN(10) even ≈50 %). Then pure random aim:
  // angle RandomN(181), power RandomN(5·crew+1).
  if (name === 'Berti' || name === 'Klaus') {
    let w = t.weapon;
    for (let k = 0; k < 40; k++) {
      if ((t.inventory[w] || 0) > 0) {
        const stop = name === 'Berti' ? (rnd.next(10) >= 8) : ((rnd.next(10) & 1) === 0);
        if (stop) break;
      }
      w = (w % 10) + 1;
    }
    return { weapon: w, angle: rnd.next(181), power: rnd.next(5 * t.crew + 1) };
  }

  const hasCtx = !!(ctx && ctx.order);
  const selfSlot = hasCtx ? ctx.slot : 0;
  const tankOf = (slot) => players[ctx.order[slot]];

  // Jack (0xe53b): owns Ping-Pong → sub_d17a (weapon 5) on the lowest UNPROTECTED enemy
  // (sub_086e). Else → sub_d2c8 with error temporarily DOUBLED (arg 2P+1), weapon scan-2.
  if (name === 'Jack') {
    if ((t.inventory[WPN.PINGPONG] || 0) > 0) {
      const target = pickLowestUnprotected(players, shooterIdx) || nearestEnemy(players, shooterIdx);
      if (!target) return { weapon: t.weapon, angle: t.angle, power: t.power };
      const sol = solveJack(t, target, P, rnd);
      return { weapon: WPN.PINGPONG, angle: sol.angle, power: sol.power, ringTarget: target };
    }
    // target: forward random-walk from self slot (0xe577) — stop when back at prev-of-self or 30%
    let target;
    if (!hasCtx) target = nearestEnemy(players, shooterIdx);
    else {
      let s = selfSlot; const stop = ctx.prevAliveSlot(selfSlot);
      while (s !== stop && rnd.next(10) < 7) s = ctx.nextAliveSlot(s);
      target = tankOf(s);
    }
    if (!target) return { weapon: t.weapon, angle: t.angle, power: t.power };
    const sol = solveParabolic(t, target, 3 * P, rnd);   // error TRIPLED (dispatcher 0xe5b3 ×3.0)
    return { weapon: scanWeaponDown(t, sol.giveUp ? 3 : 2, true), angle: sol.angle, power: sol.power, ringTarget: target };
  }

  // Ballisto (0xda02): 50% → most-wins slot (sub_0467); else forward walk (advance, 20% stop).
  if (name === 'Ballisto') {
    let target;
    if (!hasCtx) target = nearestEnemy(players, shooterIdx);
    else {
      let s;
      if ((rnd.next(10) & 1) === 1) s = pickMostWinsSlot(players, ctx, selfSlot);
      else {
        s = selfSlot; const stop = ctx.prevAliveSlot(selfSlot);
        do { s = ctx.nextAliveSlot(s); } while (s !== stop && rnd.next(10) <= 7);
      }
      target = tankOf(s);
    }
    if (!target) return { weapon: t.weapon, angle: t.angle, power: t.power };
    const sol = solveParabolic(t, target, P, rnd);
    return { weapon: scanWeaponDown(t, sol.giveUp ? 3 : 2, true), angle: sol.angle, power: sol.power, ringTarget: target };
  }

  // Terminator / default (0xe683).
  const superW = ownsAny(t, [WPN.EARTHQUAKE, WPN.CR256, WPN.CR512, WPN.JULIA256, WPN.JULIA512, WPN.CAVEMAN]);
  const fSum = hasCtx ? heightSum(players, ctx, selfSlot, true) : 0;
  const bSum = hasCtx ? heightSum(players, ctx, selfSlot, false) : 0;
  // (1) high ground + a directional super-weapon → horizontal blast toward the busier side.
  if ((fSum > 500 || bSum > 500) && superW)
    return { weapon: scanWeaponDown(t, 10, false), angle: (fSum > bSum) ? 0 : 180, power: 10 * t.crew };

  // (2) LOS walk (0xe76c): from a random alive slot, forward to the first target we can see.
  let target, los;
  if (!hasCtx) { target = nearestEnemy(players, shooterIdx); los = !reflect; }
  else {
    let start = rnd.next(players.length);
    while (!players[ctx.order[start]].alive) start = rnd.next(players.length);
    let s = start;
    do { s = ctx.nextAliveSlot(s); if (s === start) break; }
    while (!hasLineOfSight(players, ctx, shooterIdx, ctx.order[s]));
    target = tankOf(s);
    los = hasLineOfSight(players, ctx, shooterIdx, ctx.order[s]);
  }
  if (!target) return { weapon: t.weapon, angle: t.angle, power: t.power };
  // (2a) clear shot → direct fire (sub_d61a). d61a forces the weapon to 2 then scans DOWN
  // with NO wrap (0xd7a4) — same as d48a.
  if (los) {
    const sol = solveDirect(t, target, P, rnd);
    return { weapon: scanWeaponDown(t, 2, false), angle: sol.angle, power: sol.power, ringTarget: target };
  }
  // (2b) no clear shot + reflecting walls → sub_d48a at the most-decorated enemy.
  if (reflect) {
    const tgt = hasCtx ? tankOf(pickMostWinsSlot(players, ctx, selfSlot)) : target;
    const sol = solveReflect(t, tgt, P, rnd);
    return { weapon: scanWeaponDown(t, 2, false), angle: sol.angle, power: sol.power, ringTarget: tgt };
  }
  // (2c) no clear shot, no reflection → blind lob toward the near wall (0xe849). angle
  // 45/135 by slot-vs-random; power = min(10·crew, max(50, RandomN(min(10·crew, wall/2))))
  // — DECOMPILED from 0xe89e..0xe922 (both branches RandomN then MaxLong 50 then MinLong).
  const angle = (selfSlot > rnd.next(players.length)) ? 135 : 45;
  const wallDist = (angle === 45) ? (640 - (t.x | 0)) : (t.x | 0);
  const cap = Math.min(10 * t.crew, Math.floor(wallDist / 2));
  const power = Math.min(10 * t.crew, Math.max(50, rnd.next(Math.max(1, cap))));
  return { weapon: scanWeaponDown(t, 2, false), angle, power };
}

export { computeMove, solveParabolic, solveDirect, solveJack, solveReflect, errFactor };
