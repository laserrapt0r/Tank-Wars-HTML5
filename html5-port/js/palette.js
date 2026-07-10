// palette.js — the exact 16-colour VGA palette, reverse-engineered from the
// SetRGBPalette calls in the original (see re/spec_graphics.md §1).
//
// The game stores 6-bit DAC values (0..63) and the VGA hardware expands them to
// 8-bit with  v8 = (v6<<2) | (v6>>4)  (NOT v*255/63) — this matches the DOS output
// bit-for-bit. We keep both the menu palette and the in-game overrides.

// 6-bit master table (index -> [r,g,b], 0..63), from routine 0x1dfb-0x1f32.
const MASTER6 = [
  [0, 0, 0],    // 0  black
  [63, 0, 0],   // 1  red (title, tank red)
  [0, 0, 43],   // 2  dark navy (button text/shadow)
  [63, 63, 0],  // 3  yellow (tank)
  [0, 36, 16],  // 4  dark green (tank)
  [36, 16, 12], // 5  brown (tank)
  [63, 63, 63], // 6  white (tank/text)
  [44, 0, 55],  // 7  purple (tank)
  [63, 28, 0],  // 8  orange (tank)
  [35, 54, 0],  // 9  lime (tank)
  [59, 0, 47],  // 10 magenta/pink (tank)
  [10, 20, 63], // 11 menu background blue -> becomes SKY in game
  [63, 0, 0],   // 12 red (tank / nuke flash highlight)
  [0, 63, 0],   // 13 GROUND green
  [0, 0, 0],    // 14 black -> becomes navy bevel in game
  [48, 48, 48], // 15 UI grey -> becomes white bevel in game
];

function expand6to8(v6) { return ((v6 << 2) | (v6 >> 4)) & 0xff; }
function toRGB8(tbl) { return tbl.map(c => c.map(expand6to8)); }

// Menu / default palette (8-bit RGB).
const MENU_PALETTE = toRGB8(MASTER6);

// In-game palette: master with index 11 -> sky (16,51,63), 15 -> white (63,63,63),
// 14 -> navy (0,0,32). (spec_graphics §1c, routine 0xdbc7.)
const GAME6 = MASTER6.map((c, i) => {
  if (i === 11) return [16, 51, 63];
  if (i === 15) return [63, 63, 63];
  if (i === 14) return [0, 0, 32];
  return c;
});
const GAME_PALETTE = toRGB8(GAME6);

// Colour-role indices (spec_graphics §1b/§1c and spec_physics §0).
const COL = {
  BLACK: 0,
  SKY: 11,          // background / sky in game (ClearScreen colour = [0x177b]=11)
  GROUND: 13,       // terrain green
  TRACE: 15,        // white trajectory breadcrumb
  PROJECTILE: 14,   // flying shell marker
  NUKE_RED: 12,     // "red highlighted area"
  BEVEL_LIGHT: 15,  // Frame3D light edge (game: white)
  BEVEL_DARK: 14,   // Frame3D dark edge  (game: navy)
  HUD_TEXT: 14,     // stat text colour ([0x177f]=14)
  RED: 1,
};

// Player -> tank colour index (byte table at DS:0x1161). Verified from captures:
// player 2's tank core pixel is (0,0,174) = index 2 and player 1 is index 1 (red),
// i.e. player p simply uses palette index p (1..10). These indices never collide
// with sky(11)/ground(13)/bevel(14,15), which is why per-tank palette dimming
// (SetRGBPalette(color, R*men/100,...)) never corrupts the sky or UI.
const TANK_COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export { MASTER6, MENU_PALETTE, GAME_PALETTE, GAME6, MASTER6 as MASTER6_TABLE,
         COL, TANK_COLORS, expand6to8 };
