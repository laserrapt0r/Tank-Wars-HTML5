// sounds.js — every PC-speaker effect, reproduced note-for-note from the original
// (see re/spec_sound.md; all frequencies in Hz, durations in ms; square wave).
//
// Two categories:
//  * Sequenced effects (fire launch, explosion, results, menu blips) -> note lists
//    played on the audio clock via spk.play().
//  * Live/continuous effects that track physics state (flight whistle, blast circle,
//    angle/power key tones) -> driven directly with spk.soundOn()/soundOff() by the
//    caller, using the frequency formulas below.
//
// Gating: `sfx` = "SoundFX" option (default on); `flightSfx` = "Flight SoundFX"
// (default off, gates ONLY the in-flight whistle). The intro typewriter click is
// ungated in the original.

// Build a descending/ascending glissando note list (mirror of sub_5a48: 1 ms/step).
function sweep(start, end, step) {
  const notes = [];
  const dir = start <= end ? 1 : -1;
  let cur = start;
  if (dir > 0) for (; cur <= end; cur += step) notes.push({ f: cur, d: 1 });
  else         for (; cur >= end; cur -= step) notes.push({ f: cur, d: 1 });
  return notes;
}

const SND = {
  // #1 intro typewriter click — Sound(200) Delay(1) per printable char (ungated).
  introClick: [{ f: 200, d: 1 }],

  // Launch of the shell (sub_5a48(1000,400,8)).
  launch: () => sweep(1000, 400, 8),

  // Impact pre-blast (sub_5a48(400,100,1)).
  impact: () => sweep(400, 100, 1),

  // End-of-explosion boom (sub_5a48(900,200,2)).
  boom: () => sweep(900, 200, 2),

  // Round-start per-tank placement sequence — DECOMPILED 1:1 from sub_7060 ([bp+6]==0):
  // the drop chirp sub_5a48(400,700,10) @0x714d, then (armed) a rising Sound(100+5·i),
  // i=1..angle, one note per vsync while the barrel rotates up (@0x71e6); an UNARMED tank
  // instead gets the sub_5a48(800,1500,10) fanfare (@0x7255).
  roundPlace: (armed, angle) => {
    const n = sweep(400, 700, 10);
    if (armed) { for (let i = 1; i <= (angle | 0); i++) n.push({ f: 100 + 5 * i, d: 16 }); }
    else n.push(...sweep(800, 1500, 10));
    return n;
  },

  // Full crater impact sequence (as the original plays it, in order): impact pre-blast
  // 400→100, then the blast circle rising Sound(200+2r) as it grows. Ring pacing (0xc13a):
  // 1 WaitVerticalRetrace (≈16 ms) per ring, but ONLY while the total radius is < 50 —
  // bigger blasts run their rings unpaced. NO boom — the crater never booms in the
  // original (only the tank-death flash does, sub_6895).
  craterSeq: (B) => {
    const n = sweep(400, 100, 1);
    const d = B < 50 ? 16 : 1;
    for (let r = 1; r <= B; r += 2) n.push({ f: 200 + 2 * r, d });
    return n;
  },

  // Shot flew off the arena — Sound(200) held for sub_0aa1(30) = 30 centiseconds (0xcb82).
  miss: [{ f: 200, d: 300 }],

  // Tank explosion flash tune (sub_6895) — delays are sub_0a3a units, 1 unit ≈ 5 ms by
  // design (37·[0x175c]−550 empty loops): up 300..600 with i units per step, hold at
  // WHITE for 100 units (silent), down 600..300 staccato (i/2 tone + i/2 silence),
  // then the 900→200 boom sweep.
  explosion: () => {
    const n = [];
    for (let i = 0; i <= 15; i++) n.push({ f: 300 + 20 * i, d: Math.max(1, 5 * i) });
    n.push({ f: 0, d: 500 });                            // white hold, sub_0a3a(100.0)
    for (let i = 15; i >= 0; i--) {
      n.push({ f: 300 + 20 * i, d: Math.max(1, Math.round(2.5 * i)) });
      n.push({ f: 0, d: Math.max(1, Math.round(2.5 * i)) });
    }
    return n.concat(sweep(900, 200, 2));
  },

  // (No end-of-round score tally exists in the original — the 100+5·i / 400→700 / 800→1500
  // tones are all ROUND-START sounds, see roundPlace above.)

  // Menu / shop blips.
  menuMove:   [{ f: 400, d: 20 }],           // main menu cursor move (#17)
  optMove:    [{ f: 400, d: 8 }],            // options list cursor (#16)
  weaponCycle:[{ f: 300, d: 12 }],           // next/prev weapon (#25/#26/#27)
  shopEnter:  [{ f: 400, d: 20 }],           // enter buy window (#18)
  buyConfirm: () => [{ f: 500, d: 50 }].concat(sweep(500, 400, 2)), // (#19) sub_9a18: 500,Delay,500→400 DESC

  // Options value blips (#12-#15) — encode the value in the pitch.
  optErrorRate: (rate)    => [{ f: 200 + 5 * Math.round(rate), d: 12 }],
  optMoney:     (money)   => [{ f: 200 + Math.floor(money / 100), d: 12 }],
  optGames:     (games)   => [{ f: 300 + 10 * games, d: 12 }],
  optPlayers:   (players) => [{ f: 300 + 20 * players, d: 12 }],

  // Aim tones on W/I keys (set angle 45/135 resp. mirror 180−a).
  turretFlip:   () => sweep(600, 300, 5),    // key W (0xe0a5): 600→300 DESC
  turretMirror: () => sweep(300, 600, 10),   // key I (0xe150): 300→600 ASC
};

// Live frequency formulas (called each physics tick / key repeat).
const SND_LIVE = {
  // In-flight whistle (0xb883-0xb8d0): f = 400 + Round(vy/4), NoSound (return 0) when
  // vy ≤ −1200. vy is the shell's Y-VELOCITY (px/step, tiny) — NOT its height; the
  // original whistle is therefore a near-constant 400 Hz with a very slow drift.
  flightWhistle: (vy) => (vy <= -1200 ? 0 : 400 + Math.round(vy / 4)),
  // Blast circle expanding: f = 200 + 2*radius.
  blast: (r) => 200 + 2 * r,
  // Angle key-repeat tone: f = 500 - |90 - angle|.
  angleTone: (angle) => 500 - Math.abs(90 - angle),
  // Power key-repeat tone: f = power + 100.
  powerTone: (power) => power + 100,
  // Terrain landslide 500 Hz per falling dirt pixel (sub_625d). NOTE: the tank FALL
  // (sub_6d3c) has NO sound in the original — the nearby 700 Hz tone is the Caveman
  // drill (sub_3bb7), not the fall — so there is deliberately no tank-fall tone here.
  landslide: 500,
};

export { SND, SND_LIVE, sweep };
