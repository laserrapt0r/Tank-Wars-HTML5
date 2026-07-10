// physics.js — the projectile integrator, faithful to sub_bd08 (launch) and
// sub_b785 (step loop) in the original (re/spec_physics.md §1, §6).
//
// Equations of motion (explicit Euler, dt = 1 per step, position accumulated in
// full precision, only a rounded copy used for pixel tests):
//   VX0 =  0.003 * Power * cos(Angle°)
//   VY0 = -0.003 * Power * sin(Angle°)      (y-down, so -sin = upward)
//   each step:  X += VX;  Y += VY;
//               [reflecting-walls bounce];
//               VX += Wind * 1e-6;  VY += 0.0011 (gravity)
// Collision: leading-corner pixel not in {0 sky, 15 trace} and inside the field.
//
// Trig: original 0x144f=Cos, 0x1462=Sin (spec_physics §0).

import { COL } from './palette.js';
import { FIELD } from './terrain.js';
import { muzzle } from './tank.js';

const V_SCALE = 0.003;
const GRAVITY = 0.0011;
const WIND_SCALE = 1e-6;
const STEP_CAP = 20000;

// Create a projectile state from a firing tank.
function launch(tank) {
  const rad = tank.angle * Math.PI / 180;
  const m = muzzle(tank);
  return {
    x: m.x, y: m.y,
    vx:  V_SCALE * tank.power * Math.cos(rad),
    vy: -V_SCALE * tank.power * Math.sin(rad),
    prevX: m.x, prevY: m.y,
    steps: 0,
    done: false,
    impact: null,     // {x,y} rounded, set on terrain/tank hit
    offArena: false,  // fell off bottom / stepcap without hitting
  };
}

// Test whether the rounded (x,y) is a solid impact pixel. Ignores sky, the trajectory
// trace, and the projectile's own marker colour (never self-collide).
function impactAt(vga, x, y) {
  const rx = Math.round(x), ry = Math.round(y);
  if (!(rx > FIELD.X0 && rx < FIELD.X1 && ry > FIELD.YTOP && ry < FIELD.YBOT)) return false;
  const c = vga.getPixel(rx, ry);
  return c !== COL.SKY && c !== COL.TRACE && c !== COL.PROJECTILE;
}

// Advance one integration step. Mutates `p`. Handles bounce/collision/termination.
// `opts`: {reflect:bool, wind:int}. Does NOT draw (caller draws marker/trace).
function step(vga, p, opts) {
  if (p.done) return;
  p.steps++;

  // 1-2: position update (dt = 1), pre-gravity velocity.
  p.prevX = p.x; p.prevY = p.y;
  p.x += p.vx;
  p.y += p.vy;

  // reflecting-walls bounce (after position, before gravity)
  if (opts.reflect) {
    if (p.x + 1 >= FIELD.X1) { p.x = FIELD.X1 - 1; p.vx = -p.vx; }
    else if (p.x <= FIELD.X0) { p.x = FIELD.X0; p.vx = -p.vx; }
    if (p.y + 1 >= FIELD.YBOT) { p.y = FIELD.YBOT - 1; p.vy = -p.vy; }
    else if (p.y <= FIELD.YTOP) { p.y = FIELD.YTOP; p.vy = -p.vy; }
  }

  // accelerations
  p.vx += opts.wind * WIND_SCALE;
  p.vy += GRAVITY;

  // leading-corner pixel selection by velocity signs
  let cx = p.x, cy = p.y;
  if (p.vx > 0) cx = p.x + 1;
  if (p.vy > 0) cy = p.y + 1;

  if (impactAt(vga, cx, cy)) {
    p.impact = { x: Math.round(p.x), y: Math.round(p.y) };
    p.done = true;
    return;
  }
  // termination: fell off the bottom, or safety cap
  if (p.y >= FIELD.YBOT) { p.offArena = true; p.done = true; return; }
  if (p.steps > STEP_CAP) { p.offArena = true; p.done = true; return; }
}

export { launch, step, impactAt, V_SCALE, GRAVITY, WIND_SCALE };

// Wind generation, faithful to db1f..db98: Wind = round(1000*(2*RandomR-1)^5),
// integer in [-1000,1000], calm-biased. Sign = direction.
export function generateWind(rnd) {
  const r = 2 * rnd.nextFloat() - 1;
  return Math.round(1000 * Math.pow(r, 5));
}
