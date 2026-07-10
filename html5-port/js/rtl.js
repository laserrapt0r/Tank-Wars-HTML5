// rtl.js — faithful re-implementations of the Turbo Pascal 7 runtime pieces the
// game relies on. Everything here mirrors the exact behaviour found in the
// original TANK_ENG.EXE units (see docs/PORTIERUNG.md §RTL).

// ---------------------------------------------------------------------------
// Turbo Pascal 7 pseudo-random generator (SYSTEM unit).
//   RandSeed : LongInt (32-bit, stored at DS:0x0CE2 in the original)
//   Random(N) : Word  ->  (RandSeed * 0x08088405 + 1) mod 2^32, take high dword
//                          of (seed * N) ... actually TP does: seed := seed*k+1;
//                          result := (seed_hi16 * N) >> 16 style. We reproduce the
//                          documented TP7 algorithm exactly.
// TP7 Random(word) returns  (Int64(RandSeed_unsigned) * N) shr 32.
// ---------------------------------------------------------------------------
class TPRandom {
  constructor(seed = 0) { this.seed = seed >>> 0; }

  // Randomize: TP uses the DOS clock (INT 21/2C: CX=hh mm? , DX=ss hundredths).
  // We seed from performance/clock; exact value is irrelevant to fairness.
  randomize(seedOverride) {
    if (seedOverride !== undefined) { this.seed = seedOverride >>> 0; return; }
    // mimic: RandSeed := (hour*... ) — but any entropy is fine for play.
    const d = new Date();
    this.seed = (((d.getSeconds() * 100 + d.getMilliseconds() / 10) | 0)
                 ^ (d.getMinutes() << 16) ^ (d.getHours() << 24)) >>> 0;
  }

  // advance LCG: seed := seed * 134775813 + 1  (mod 2^32)
  _next() {
    // 32-bit multiply without precision loss
    const lo = this.seed & 0xffff, hi = this.seed >>> 16;
    const k = 0x8088405;
    const klo = k & 0xffff, khi = k >>> 16;
    let low = lo * klo;
    let mid = (lo * khi + hi * klo) & 0xffffffff;
    let res = (low + ((mid & 0xffff) << 16)) >>> 0;
    res = (res + 1) >>> 0;
    this.seed = res;
    return res;
  }

  // Random(N): word in [0, N)
  next(N) {
    const s = this._next();
    // (s * N) >> 32  — use float-safe 64-bit
    return Math.floor((s * N) / 0x100000000);
  }

  // Random real in [0,1)
  nextFloat() {
    const s = this._next();
    return s / 0x100000000;
  }
}

export { TPRandom };
