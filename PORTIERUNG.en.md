# TankWars V2.07 — Reverse Engineering & faithful HTML5 port

**Author of the original:** Marko Lindner (TU Chemnitz), 1995/96.
**Original files:** `TANK_ENG.EXE` (106,048 bytes, English version), `TANK_ENG.DOC`, `TANKWARS.ICO`.
**Goal of this project:** A **native** HTML5 port (Canvas + WebAudio, no emulator),
whose graphics, sound, game physics and timing were **reconstructed from the disassembled machine code**
— not guessed from screenshots. Screenshots of the original running in DOSBox‑X
served solely for cross‑checking.

**To play:** The easiest way is to open the standalone single file [`index.html`](index.html)
(in the project's main folder) **by double‑clicking** it (works offline, without a server), then click the page
(enables sound). This file is built from the modules under [`html5-port/`](html5-port/)
(`cd html5-port && node build.mjs`). Alternatively, start the modular version via a
local server (ES modules do **not** run via `file://`):
`cd html5-port && python3 -m http.server` → `http://localhost:8000`.

---

## 0. Game mechanics (short overview for players)

Turn‑based artillery duel (2–10 tanks) on destructible terrain. In turn, each
tank aims (angle + power) and fires a weapon; the goal is to take out all the others.

**Crew = life energy.** Each tank has **0–100 men** (starting at 100). The crew is
at the same time its "health": at **0 men the tank explodes**. The crew also limits the
**maximum power to `10 × crew`** (full = 1000), and the **brightness** of the tank drops
with the crew. Crew is lost through explosion and fall damage.

**Damage**
- **Explosion damage:** A hit within the radius `B` of a weapon costs `80·B/D` men, where
  `D = max(1, distance−3)`. A **shield** reduces this to `B/D` (the factor of 80 removed).
- **Fall damage:** If the ground beneath a tank is destroyed, it falls. Per **2 fallen pixels
  1 man dies** (`Crew −= ⌊fall height/2⌋`); if the **fall height is greater than `2 × crew`, the
  entire crew is dead**. A full tank (100) therefore survives falls up to ~200 px (heavily
  weakened) and dies above that. A **parachute** prevents fall damage completely (the tank
  still falls down). After damage the power is re‑clamped to `10 × crew`.

**Weapons & shop** (buyable between rounds; sold at half price):

| # | Weapon | Effect | Radius B | Price | Quantity |
|---|---|---|---|---|---|
| 1 | Hand Grenade | crater + explosion | 4 | 1000 | 100 (start 20) |
| 2 | 5 kT Nuke | large crater | 30 | 2000 | 10 |
| 3 | 5 MT Nuke | huge crater (white flash) | 100 | 10000 | 1 |
| 4 | Earthquake | crack fissure with ±45° branches | 30 | 5000 | 1 |
| 5 | Ping Pong Jack | bouncing projectile, digs a track + bounces back | 10 | 5000 | 5 |
| 6 / 7 | Chain‑Reaction‑Inducer 256 / 512 | "eats" terrain fractally in the shot direction | 4 / 8 | 5000 / 10000 | 1 |
| 8 / 9 | Julia 256 / 512 | like the CR‑Inducer, different fractal pattern | 4 / 8 | 5000 / 10000 | 1 |
| 10 | Captain Caveman | drills a tunnel along the surface | 5 | 20000 | 1 |
| 11 | Parachute | **protection:** no fall damage (1 round) | – | 10000 | 1 |
| 12 | Quake Protection | **protection:** against Earthquake (1 round) | – | 20000 | 1 |
| 13 | Protection Shield | **protection:** explosion damage ÷80 (1 round) | – | 20000 | 1 |

Protection items (11–13) last **one round** and are consumed at the end of the round.

**Wind:** random per round (`round(1000·(2·R−1)⁵)`, range ±1000, strongly weighted toward calm); deflects
projectiles horizontally (`vx += Wind·1e‑6` per step). **Reflecting walls** (option: No / RND
/ Yes) make projectiles bounce off the field edges.

**End of round & points:** A round ends when ≤ 1 tank is alive, no one is armed anymore, or
after 20 turn rotations. Each **survivor** receives `(players − survivors) × 1000 ÷ survivors`
as **money and points**; whoever kills an enemy man additionally gets **+50 points/$ per
man** (including those caused by fall damage). The sole winner of a round receives **+1 win**.

**Controls:** ◄/► angle ±1°, ▲/▼ power ±1, PgUp/PgDn power ±100, Home = max power,
End = 250; **Enter or mouse click = fire**, **Tab = switch weapon**, spacebar = status display,
F1 = help, Esc = quit. The AI opponents have
personalities (Berti/Klaus random, Jack a Ping‑Pong specialist, Ballisto/Terminator ballistic)
— all rebuilt 1:1 from the original (see §11).

**Audio/visual cues:** At the start of a round each tank "chirps" as it is set down (400→700 Hz
sweep, `sub_5a48` in `sub_7060`). When a ballistic AI (Jack/Ballisto/Terminator) aims, a
**shrinking red ring** briefly appears around its **target** just before firing (`sub_b4a2`,
colour 12) — from the attacked player's point of view, around their own tank.

> All the values/formulas above are **reconstructed 1:1 from the machine code**; the technical
> details, addresses and derivations are in the following sections.

---

## 1. Approach (methodology)

1. **File analysis.** `TANK_ENG.EXE` is a DOS MZ executable, produced with **Turbo
   Pascal 7.0** (real mode, 16‑bit). It contains the **Borland EGAVGA BGI graphics driver**
   embedded (signature "BGI Device Driver (EGAVGA) 2.00 - Mar 21 1988"). Graphics mode:
   **VGA 640×480, 16 colors**, single video page.
2. **Loader rebuilt.** A custom Python script reads the MZ header, applies all
   **2171 relocations** (base 0) and produces the load image `image.bin`
   (linear = segment·16 + offset).
3. **Disassembled** with *capstone* (16‑bit). Segment layout (paragraph values):
   `0000` = game code (entry `0000:EA58`), `0EB0` = custom graphics/UI/mouse unit incl.
   embedded BGI driver, `1129` = clock unit (centiseconds), `1138` = DOS unit,
   `1140` = **CRT**, `11A3` = **GRAPH**, `1509` = **SYSTEM**, `16F3` = data segment.
4. **RTL symbol map.** All **124 far‑call targets** into the units were identified
   (fingerprints: port accesses 0x42/0x43/0x61 for `Sound`, `0x1234DD div f`, INT 16h,
   the Real48 arithmetic, the LCG `×0x08088405+1` for `Random`). With this the game code was
   **fully symbolically** annotated (`game_disasm.txt`): every `Sound`, `PutPixel`,
   `Sin`, `Round` etc. is readable in plain text.
5. **Game logic decompiled.** From the annotated code, palette, terrain generation,
   tank sprite, ballistics, wind, damage, weapons, shop, AI, sounds and timing were
   extracted as exact formulas/constants (each constant is addressably documented in the code).
6. **Port implemented** in modular ES6 JavaScript, 1:1 following these formulas.
7. **Verified** against screenshots of the original (DOSBox‑X headless via Xvfb).

> **Important insight (Sin/Cos):** In the TP7 SYSTEM unit, `1509:0x144f` = **Cos**,
> `1509:0x1462` = **Sin** (the Cos routine adds π/2 and falls into the Sin core). Only with
> this assignment are **ballistics, barrel direction and terrain generation simultaneously
> consistent** — it also resolves the single open uncertainty of the terrain analysis.

---

## 2. Graphics

### 2.1 Resolution & framebuffer
VGA 640×480, 16 colors, indexed, single page. The port reproduces the **BGI drawing model**
in [`js/vga.js`](html5-port/js/vga.js): an indexed 640×480 buffer with
`putPixel/getPixel`, Bresenham `line`, `bar` (filled rectangle), midpoint `circle`,
`fillCircle`, scanline `floodFill` and `outText` (8×8 bitmap font, integer scaling).
The output is blitted into a canvas via the active palette.

### 2.2 Palette (exactly from `SetRGBPalette`, routine 0x1dfb–0x1f32)
The game sets 16 colors with **6‑bit DAC values (0..63)**; the VGA hardware expands
them with the rule **`v8 = (v6<<2) | (v6>>4)`** (not `v*255/63` — only this way do the
DOSBox samples match exactly, e.g. 12→48, 48→195).

| Idx | 6‑bit | 8‑bit | Menu role | Game role |
|----:|-------|-------|-----------|-------------|
| 0 | 0,0,0 | 0,0,0 | black | black |
| 1 | 63,0,0 | 255,0,0 | title/red | **Tank 1 / red** |
| 2 | 0,0,43 | 0,0,174 | button text | **Tank 2 (navy)** |
| 3 | 63,63,0 | 255,255,0 | | Tank 3 (yellow) |
| 4 | 0,36,16 | 0,146,65 | | Tank 4 (dark green) |
| 5 | 36,16,12 | 146,65,48 | | Tank 5 (brown) |
| 6 | 63,63,63 | 255,255,255 | | Tank 6 (white) |
| 7 | 44,0,55 | 178,0,223 | | Tank 7 (violet) |
| 8 | 63,28,0 | 255,113,0 | | Tank 8 (orange) |
| 9 | 35,54,0 | 142,219,0 | | Tank 9 (lime) |
| 10 | 59,0,47 | 239,0,190 | | Tank 10 (magenta) |
| 11 | 10,20,63 | 40,81,255 | **menu blue** | **sky** (→16,51,63 = 65,207,255) |
| 12 | 63,0,0 | 255,0,0 | red | **nuke red zone** |
| 13 | 0,63,0 | 0,255,0 | | **ground green** |
| 14 | 0,0,0 | 0,0,0 | black | **bevel dark** (→0,0,32 = navy) |
| 15 | 48,48,48 | 195,195,195 | **UI gray** | **bevel light** (→ white) |

On entering a game (0xdbc7) the indices 11→sky, 15→white, 14→navy
are remapped. **Player p uses color index p (1..10)** — verified against the original (player 2 =
core pixel 0,0,174 = index 2). These indices never collide with sky/ground/bevel,
which is why the **health‑dependent darkening** of the tank (`SetRGBPalette(color,
R·men/100, …)`) never corrupts sky or UI. Implemented in
[`js/palette.js`](html5-port/js/palette.js).

### 2.3 Screen layout (routine sub_5b69)
Status line y 0..58 (`Frame3DThick(0,0,639,58)`), playfield (0,59)–(639,479).
Text positions: Points (263,10), Wins (263,18), Men (385,10), Wind (385,18),
Angle° (490,10), Power (490,18); name box (6,6,250,28), weapon box (6,32,250,54),
"R" box (610,8,630,26). Implemented in [`js/hud.js`](html5-port/js/hud.js).

### 2.4 Terrain (sub_5e3f)
Segmented random walk ("turtle") into a height array per column (original DS:0x119a),
then a ground‑green fill. Since |θ| ≤ 1.2 rad (< π/2), cos θ > 0, so the surface is
unambiguous in x. Step: `x += cos(θ)·amp`, `y += sin(θ)·amp`. Parameters (all from the code):
`stepRange = RandomN(40)+10`, `R1 = RandomR+0.3`, start `x=4`, `y=445−RandomN(206)`,
`θ = RandomR·π/2 − π/4`, `amp = RandomN(stepRange)+5`; θ random walk `θ += RandomR·R1 − R1/2`,
clamped to ±1.2 (reset to ∓1.0), y clamped [88,470]. New for each game (`Randomize`).
Implemented in [`js/terrain.js`](html5-port/js/terrain.js).

### 2.5 Tank sprite (sub_64cc hull/turret, sub_44a6 barrel)
Full tank = **turret + hull**, measured pixel‑exact against the original (game_landed.png), 8 rows of
horizontal lines around the base center point (cx,cy): **turret** (3 rows, widths 7/9/9 at
cy−7…cy−5) on top of the **hull** (5 rows, 15/17/19/17/15 at cy−4…cy). Barrel = line of length 10 from the
pivot point (cx, cy−5) in the direction `(cos θ, −sin θ)`; muzzle (shot origin) length 15.
Brightness ∝ crew/100. Implemented in [`js/tank.js`](html5-port/js/tank.js).

**Trajectory clipping & software cursor:** Markers/trace are clipped to the playfield
(y ≥ 63) — never drawn into the status line (as in the original). Menu/names/shop use a
drawn **software mouse cursor** (OS cursor hidden over the canvas): it follows the
mouse and **jumps to the selected element on keyboard selection** (like MouseGlideTo/
MouseToMenuItem in the original).

### 2.6 Font
The original draws text with the BGI default bitmap font **8×8**, integer‑scaled
(status line scale 1, menu/title scale 2). Verified: text sits on 8‑px cell boundaries,
baseline = row 6, descenders (g, y, p, j, q) in row 7.

**The complete character set was extracted pixel‑exact from the running original**
([`js/font8x8.js`](html5-port/js/font8x8.js)): all A–Z, a–z, 0–9 as well as `: . ! % $ - ©`.
Method — the ×2‑scaled menu texts were gray‑isolated and downsampled onto the 8×8 base;
characters not appearing in the menu were typed into the name input field and captured there.
Arrows/degree signs (`↑ ← → °`) for the HUD are retained.

**Menu style (measured from the original):** blue background (index 11), buttons **unfilled**
with 3D bevel (light top/left = index 15 grey, dark bottom/right = index 14), text **gray
embossed** (1‑px shadow), title red with a red underline, corner "©1995 ML" white,
full-screen `Frame3DThick`. Implemented in `drawMenu`/`embText`
([`js/main.js`](html5-port/js/main.js)). In the original, palette index 0 is **the
background colour** (not black).

---

## 3. Physics / ballistics (sub_bd08 launch, sub_b785 loop)

Explicit Euler method, **dt = 1 per step**, position accumulated in full precision,
only a rounded copy for pixel tests:

```
Arad = angle° · π/180
VX0 =  0.003 · Power · cos(Arad)
VY0 = -0.003 · Power · sin(Arad)          (y downward ⇒ −sin = upward)
Muzzle: (tankX + round(15·cos), tankY − 5 − round(15·sin))

per step:
  X += VX ;  Y += VY
  [Reflecting Walls: elastic bounce at x∈[4,634], y∈[63,474]]
  VX += Wind · 1e-6
  VY += 0.0011                            (gravity)
```

**Constants** (Real48, addressed in the code): velocity scale `0.003` @0xbe6d,
gravity `0.0011` @0xba8c, wind scale `1e‑6` @0xba4f, π/180 @0xbd7a, barrel length 15 @0xbdca.

**Collision** (sub_b560): the front corner pixel of the 2×2 marker (according to the VX/VY sign)
counts as a hit if its color ∉ {0 sky, 15 trace} and within x∈(4,635),
y∈(63,475). Ground = 13, tank = 1..12, marker = 14, trace = 15. Also aborts at
Y≥475 (ground edge) or step counter > 20000. Without reflecting walls the shot leaves
the field sideways and falls out. Reference (45°/250/wind 0): clean parabola, apex
≈128 px, range ≈527 px, ≈994 steps. Implemented in
[`js/physics.js`](html5-port/js/physics.js).

**Wind** (db1f): `Wind = round(1000·(2·RandomR−1)^5)`, integer [−1000,1000], strongly
calm‑biased (fifth power). Sign = direction (arrow), magnitude displayed.

**Power/angle:** angle 0..180° (0=right, 90=up, 180=left), display `90−|90−angle|`.
Power 0..**10·crew** (starting crew 100 ⇒ max 1000); default 250, "End"=250, "Home"=max,
±1 (arrows) / ±100 (PgUp/PgDn). After damage, power re‑clamped to 10·crew.

**Fall damage** (sub_6d3c): if the ground beneath a tank falls away, it falls (pixel by pixel,
with a sideways slide into the open side) until it finds footing again;
`crew −= fall height div 2` (1 man per 2 px); `fall height > 2·crew` ⇒ crew dead; then
`power = min(power, 10·crew)`. The fall is **silent** (sub_6d3c has no `Sound` instruction).
**Parachute** (item) ⇒ the tank still settles, but damage 0 (flag 0 from sub_7060/sub_02d4).
In the port implemented as a visible animation phase `stepAnim 'fall'` (see §11).

**Timing / animations (measured in DOSBox, cycles=fixed 20000):** The original
clocks **every** integration step of the flight via a CPU‑calibrated **busy‑wait**
(`sub_0a3a`, factor 2.0 → ~2.05 ms/step), not by VSync. By tracking a
projectile and fitting `y(t)=½·g·rate²·t²` (g=0.0011 px/step²), the
step rate works out to **487 steps/s**. The **parachute descent** (`sub_7060`) in contrast waits
**1 VGA vertical retrace per descent step** (~1 px / 60‑Hz vsync) — measured **58 px/s**
(strictly linear, 117 px in 2.00 s).

The port drives both processes **time‑based** (wall clock, not framerate): `stepFlight(dt)`
runs at `FLIGHT_STEPS_PER_SEC = 487`, `stepRoundIntro(dt)` at `INTRO_PX_PER_SEC = 58`
(each with a fractional accumulator). This makes the pace **independent of the refresh
rate** (60/120/144 Hz play identically).

**Speeding up the parachute:** As in the original, **every key / every mouse click**
during the descent skips the vsync wait time (in the original via `KeyPressed`/`MouseButtonDown` before
`WaitVRetrace`; globally also through the demo parameter `D`, which sets `[0x116e]=1`). In the port
`keydown`/`mousedown` sets the flag `introFast` → the rest of the descent runs at full
speed (`INTRO_FAST_PX_PER_SEC`).

**All weapon effects are — as in the original — progressively animated** (not instant), with
sound, via `game.stepAnim(dt)` (WALL CLOCK, refresh‑independent):
- **Crater/nukes (code 0xbf8a..0xc0e1):** the original draws the crater shape in
  palette index 12 (previously set via `SetRGBPalette` to the SKY COLOR) and then ramps
  this entry **sky→white→sky** in 15+16 vsync steps (each `WaitVRetrace`,
  ≈0.52 s) — a crater‑shaped **white flash** —, after which it is carved with color 0.
  Reproduced 1:1 in the port as a palette animation (duration independent of B).
- **Earthquake/Ping‑Pong/CR/Julia/Caveman:** these loops have **no delay at all** in the original —
  their pace is the raw CPU pixel work. The port prices each sub‑operation
  by its "samples" (touched pixels) and plays them back at `EFFECT_SAMPLES_PER_SEC = 5000`
  — **calibrated against a DOSBox measurement** (cycles=20000): a Ping‑Pong dug a
  375‑px channel in 10.37 s ≈ 2478 steps × 21 samples ⇒ ~5000 samples/s. An earthquake
  thus takes — as in the original — several seconds.
- **Sounds of the effects:** the original pulses **per eaten ground pixel** `Sound(f)` and
  immediately `NoSound` (earthquake f=500) → a **rattling clatter**, not a continuous tone. The port
  reproduces this via `pcspeaker.gate()`: tone on while ground is being eaten, gaps
  when the lines cross already‑open space (Ping‑Pong `1000−y`, eater 500, Caveman 700).

Flight and parachute pace are **measured directly against the original** (see above), the effect pace
via the Ping‑Pong measurement. Since everything is slightly cycles‑dependent,
`FLIGHT_STEPS_PER_SEC`/`INTRO_PX_PER_SEC`/`EFFECT_SAMPLES_PER_SEC` are laid out in `game.js` as
individual adjustment knobs, in case a different DOSBox configuration is compared.

---

## 4. Weapons, damage, scoring (sub_bd08 dispatch, rules §2/§3)

**Weapon table** (init 0x2000–0x2306), price per **lot**, lot size = pieces per purchase:

| # | Name | Cat | Price $ | Lot | B (radius/param) |
|--:|------|:--:|--:|--:|--:|
| 1 | HandGrenade | 0 | 1000 | 100 | 4 |
| 2 | 5 kT Nuke | 0 | 2000 | 10 | 30 |
| 3 | 5 MT Nuke | 0 | 10000 | 1 | 100 |
| 4 | Earthquake | 1 | 5000 | 1 | 30 |
| 5 | Ping Pong Jack | 2 | 5000 | 5 | 10 |
| 6 | CR‑Inducer 256 | 3 | 5000 | 1 | 4 (→256 px) |
| 7 | CR‑Inducer 512 | 3 | 10000 | 1 | 8 (→512 px) |
| 8 | Julia 256 | 4 | 5000 | 1 | 4 |
| 9 | Julia 512 | 4 | 10000 | 1 | 8 |
| 10 | Captain Caveman | 5 | 20000 | 1 | 5 |
| 11 | Parachute | 6 | 10000 | 1 | 0 |
| 12 | Quake Protection | 6 | 10000 | 1 | 0 |
| 13 | Protection Shield | 6 | 20000 | 1 | 0 |

Start: **20 HandGrenades**. Categories: 0 crater bomb, 1 earthquake, 2 Ping‑Pong,
3 CR‑Inducer, 4 Julia, 5 Caveman, 6 protection.

**Arsenal reset per game** (decompiled from 0x7924/0x84b9): At the start of **every** game
all players are reset — crew=100, angle=45, current weapon=1,
**HandGrenades=20, all other weapon slots=0**; the shop runs afterwards (purchases apply
only to the upcoming game, the arsenal does not carry over). If the current weapon
runs out during the game, it automatically switches to the next available one.

**Effects** (implemented in [`js/weapons.js`](html5-port/js/weapons.js)):
- **Crater (0):** filled circle of radius B removes ground; nuke "red zone" radius B.
- **Direct explosion damage** (shared loop 0xc8ca): `dx=tankX−impX`,
  `dy=(tankY−impY)−4`, `dist=√(dx²+dy²)`, `D=max(1,round(dist−3))`; if **B > D**:
  `damage = (80·B) div D` (with shield `B div D`), `= min(damage, crew)`.
  **Important:** this blast is computed for ALL categories at the **original impact point**
  with the weapon's own B (the effect routines receive the impact as a value).
  Damage along the path traversed by the effect arises **not** from the blast,
  but from **settling/fall damage** when the ground beneath tanks breaks away.
- **Earthquake (1) — decompiled 1:1** (sub_3511 → sub_2f9a recursive → sub_2c0d):
  `count = 20·power`; direction normalized to length 0.7 (with the original quirk that
  the vy normalization reuses the already normalized vx); start = impact −
  `(0.005·count·vx/2, −0.005·count·vy/2)`. Per step: `(dx,dy)=0.7·(cos α, sin α)`,
  position += (dx,dy), `α += rand·0.08 − 0.04`; **two cross lines** are drawn
  from the path line to their perpendicular offset `0.005·count·(dy,−dx)` → a **wedge**,
  at the epicenter `0.0035·count` px wide, tapering to 0 at the tip. With **1/20 per step**:
  `n = Random(0.2·count)`; n odd → branch at **−45°**, n even → branch at **+45°**
  (with parent cross offset `0.005·n·(dy,−dx)`); the parent loses the branch length
  (`count −= n`) → the characteristic **small ramifications**. sub_2c0d checks per
  line both endpoints (only continues if ground), samples `0.0035·count+1` points
  (clip x∈[4,635], y∈[63,475]), replaces only GROUND pixels with color 0 (shows sky),
  at `count>1000` additionally as a **2×2 block**; **per pixel `Sound(500)`/`NoSound`**
  (rattling rumble). `Randomize` per call — every crack is different. Tanks in the
  crack bounding box lose `crew div 2` (except with **Quake Protection**), plus the
  shared direct blast (B=30) at the epicenter.
- **Ping‑Pong (2) — decompiled 1:1** (sub_371d, all TP Real constants decoded). The
  routine has **TWO loops**:
  - **Loop 1 (descent, 0x37ef):** initial vx,vy **÷ 3.0**; per step `pos += vel`; with
    the Reflect flag `[0xcf7]` set, bounce at **x=635→625 / x=4→14 / ceiling y=63→64**
    (sign of the matching velocity flipped); then `vy += 0.00012222` (=0.0011/9);
    clear a 21‑px swath (round(x)−10..+10) with `Sound(1000−y)`. Runs until **y ≥ 475**.
    Busy‑wait 1.0.
  - **Loop 2 (the "bouncing back", 0x3a6c):** from the ground the ball mills itself **straight
    back up** through its landing swath, until it rises above the terrain
    (`while min_surface ≤ y: y−−, clear swath`). **Not** coupled to the Reflect flag
    (this is the eponymous Ping‑Pong behavior). Busy‑wait 3.0 (3× slower).

  Direct blast B=10 at the original impact; the dug channel then **collapses**
  (sub_625d), path victims via fall damage.
- **CR‑Inducer/Julia (3/4) — decompiled 1:1** (sub_2307, recursive direction fractal,
  + driver sub_2b8c): `size = B·64` (256/512), start = impact, direction **2 (east)**
  if vx>0, otherwise **3 (west)**. 8 directions (1,2:x+ · 3,4:x− · 5,6:y+ · 7,8:y−); each
  expands into **4 half‑size sub‑curves** according to the production rules extracted from
  0x2466..0x2b86 (e.g. dir 1 → [7|8],[1|2],[6|5],[1|2]). **CR** (flag 1) chooses per
  slot with p=1/2 (`Random(10)` odd) the alternative direction → chaotic
  chain reaction; **Julia** (flag 0) is strictly deterministic/self‑similar. Base case
  (size 1): 1‑px step, clip x∈[4,635]/y∈[63,475], eats only GROUND (continuous tone 500 Hz).
- **Captain Caveman (5) — 1:1** (sub_3bb7, **3 phases**, each with bounds test sub_3b4d
  = x∈[4,635] and advance sub_3b7f = x±1 in the shot direction):
  **Phase 1 (0x3bcb)** — advance from the impact until the pixel **on the shot row** is
  ground (hillside reached); **Phase 2 (0x3bee)** — skip over flat terrain
  as long as `surface+8 ≥ Y` and there is ground (until a hill begins >8 px above the row);
  **Phase 3 (0x3c28)** — as long as `surface+8 < Y` drill the column: clear rows `surface+9..Y`
  (a 9‑px roof remains), `Sound(700)` per column; stop at the valley. Direct blast **B=5**.
- **Protection (6):** no attack effect.

**Terrain settling (sub_625d) — runs after EVERY impact** over the effect's bounding box
(tracked per weapon and expanded by ±B around the impact): per column the surface sinks
over eaten air; then repeated sweeps — `top` moves through the solid block down to the first gap,
`bot` to the next ground below it; as long as a gap exists, **1 pixel falls per sweep**
(the topmost ground pixel of the column disappears, one appears at the gap head — the block
sinks), with a `Sound(500)` pulse per moved pixel,
until nothing falls anymore. This causes e.g. the roof over the earthquake fissure to collapse and
the eater's excavations to slump into craters. The port pre‑simulates the collapse on
impact and plays it back as a continuation of the effect animation (tank settling
+ fall damage follow as before at the conclusion).

**Color of the removed terrain (not a real deviation):** the original draws sky,
crater, tunnel etc. as pixel value **0**. The BGI driver maps, via `SetBkColor`, the display
of pixel value 0 to the background color (sky) and `ClearDevice` fills the playfield
with 0 — the sky therefore *is* pixel value 0, displayed as sky blue. The collision
(`sub_b560`) treats pixel values 0 and 15 (trace) as passable; projectiles fly through
sky and craters. The port internally uses a different index for "sky/removed", but displays
the same sky blue and the same passable collision → **visually and behaviorally
identical**.

**Scoring:** per killed enemy man **50 points + $50** to the shooter (⇒ 5000 per
100‑man tank). End‑of‑round pot: each survivor receives `(players−survivors)·1000 /
survivors` to points **and** money. 1 point = $1. Win counter +1 if exactly one
survivor. Ammo −1 per shot; empty ⇒ next available weapon.

**Protection systems** are inventory holdings of weapons 11/12/13 and act **per round**
(1 consumed at the end of the round each). Parachute 100% against falling, Quake 100% against earthquake,
Shield reduces direct damage to `B/D` instead of `80·B/D` (factor 1/80 ≈ 98.75% — the code
has **no** literal "95%" value; the manual rounds).

---

## 5. Computer AI (rules §5)

**No iterative trial shooting** — the AI **inverts the ballistics analytically**
([`js/ai.js`](html5-port/js/ai.js)):
- Parabolic (Ballisto/Jack): fixed angle 45°/135°,
  `power = round( 333.333 · √( 0.0011 · dX² / (dX+dY) ) )` (333.333 = 1/0.003 = 1/C,
  0.0011 = gravity — exact inversion of the engine).
- Direct fire (Terminator super weapons): `angle = round( arctan(dHeight/dX) · 180/π )`, max power.

**Error rate** (default 10%, menu 0..100): multiplicative random error on the distance
`1 + ((rate+1)/100)·(2·RandomR−1)` (≈ ±(rate+1)%), **halved after each shot** (÷2).

**5 personalities:** Berti (purely random, holds weapon ~20%), Klaus (random, ~50%),
Jack (prefers Ping‑Pong; ballistic but deliberately less accurate, ×3 error),
Ballisto (precise ballistics), Terminator (super‑weapon aware, otherwise max power + direction).
**20‑shot interrupt:** after 20 shots the game aborts. **Esc/surrender** sets an
abort flag ⇒ no winner (the original has no "Winner" string at all).

---

## 6. Sound (PC speaker → WebAudio)

Square wave. `Sound(Hz)`/`NoSound`/`Delay(ms)` → oscillator/gain/scheduling in
[`js/pcspeaker.js`](html5-port/js/pcspeaker.js); all effects as exact (Hz,ms) recipes in
[`js/sounds.js`](html5-port/js/sounds.js). All **27 `Sound` call sites** were decoded.
Examples (from the code): launch sweep 1000→400 Hz (step 8, 1 ms/step), flight whistle
`400 + round(y/4)` Hz (only with "Flight SoundFX"), impact 400→100, explosion 300→600→300 +
boom sweep 900→200, blast circle `200 + 2·r`, menu blips 300–500 Hz, option values encode
their value in the pitch. Gate: "SoundFX" switches almost everything, "Flight SoundFX" only the
flight whistle. **No separate melody Easter egg** — the "music" of the manual is the
shot→flight→explosion sequence itself (verified in the code: no note table present).

---

## 7. Options / flow (rules §6)

Menu defaults (init 0x2004–0x2051): SoundFX=on, Flight SoundFX=off, Reflecting Walls=RND
(0=No/1=RND/2=Yes), Show Trace=on, Use Mouse=on, Computer Error Rate=10% (0..100),
Money from Start=0 (0..100000, step 1000), Games per Match=10 (1..50), Number of
Players=2 (2..10). Flow: main menu → "The names please" (human/computer + name /
computer type; **first human/computer, then name**) → **parachute descent** of the tanks →
rounds (aiming → flight → impact → settling) → shop between games → rankings
(sorted by wins, then points). Command line (original): `D` demo (10 computers, 2 per
type), `Fx` error rate x%, `M` mouse off, `?` syntax.

**Purchase menu (sub_9d62, verified against real original screenshots):** appears **before every
game per human player** (computers and penniless players with nothing to sell are
skipped). 3‑column layout as in the original: at the top a **status line** (name, Men/Wins/
Points/Dollar, current inventory of the 10 attack weapons in 2 columns); on the left a **weapon list**
of all 13 items `"<lot> <name>………"` (upper box = 10 attack, lower = 3 protection weapons); center
**"Buy these"** with 13 price buttons `"<price> $"` (empty if price > money); on the right **"For Sale"**
with `"<price/2> $"` (empty if inventory < lot). Red headers "You have N $ ( M Games to go )"
and "Go to next Window using [Tab].". **Done = click on the red bar "Start the N. Game,
<name> !"** at the bottom. Operated by mouse (click on a button buys/sells) or keyboard (Tab
switches column, ↑↓ row, Enter buys/sells, Esc done). Purchase: inventory +lot / money −price;
sale: inventory −lot / money +price/2.

---

## 8. Project structure of the port

```
html5-port/
├── index.html         Canvas + start overlay
├── package.json       ("type":"module" — for tests/ESM)
└── js/
    ├── rtl.js         TP7 random generator (LCG ×0x08088405+1)
    ├── pcspeaker.js   PC speaker emulation (WebAudio, square wave)
    ├── sounds.js      all sound effect recipes (Hz/ms)
    ├── vga.js         640×480×16 BGI framebuffer + primitives
    ├── palette.js     exact 16‑color palette (menu/game)
    ├── font8x8.js     faithful 8×8 bitmap font
    ├── terrain.js     terrain generation & destruction
    ├── tank.js        hull + barrel + parachute, brightness
    ├── physics.js     ballistics integration + wind
    ├── weapons.js     weapon table + effects + damage
    ├── ai.js          AI (ballistic inversion, 5 types)
    ├── hud.js         status line + 3D frame
    ├── markdown.js    small Markdown→HTML renderer (for the doc viewer)
    ├── doctext.js     this documentation as a string (embedded by the build)
    ├── game.js        simulation engine (round/fire/scoring)
    └── main.js        frontend: state machine, input, mouse, loop, doc viewer
```

On the start page the button **"📖 Show documentation"** opens this text directly in the
browser (embedded, also works offline via `file://`).

## 9. Controls

**Keyboard:** ← → angle · ↑ ↓ power ±1 · PgUp/PgDn power ±100 · Home power=max ·
End power=250 · Tab next weapon · Enter fire · spacebar game status · F1 help ·
Esc surrender.

**Mouse:** menu/names/shop operable by click (left click selects/changes, right click in the
menu changes backwards). In the game the **left click fires with the current angle** — it does
**not** aim at the click point (the original never reads the click position, `sub_bd08`); the
**right click** toggles the aiming panel (`[0x115f]`).

**Bouncing off the edges** is tied to the option **"Reflecting Walls"** (default
**RND** = random on/off per game; when active recognizable by the red **"R"** on the right in the
status line). When active, the projectile bounces elastically off top/left/right — exactly
as in the original (code: gated via `[0xCF7]`).

## 10. Deliberate deviations / open points

- **Timing:** flight (487 steps/s) and parachute (58 px/s) are **measured directly against the
  original in DOSBox** and reproduced in the port time‑based (refresh‑independent). The
  original busy‑wait is slightly cycles‑dependent; the rates are laid out as adjustment knobs in
  `game.js`.
**Decompiled 1:1:** Earthquake (sub_3511/2f9a/2c0d),
CR‑Inducer/Julia fractal (sub_2307, production rules extracted from the code), Ping‑Pong
(sub_371d), Caveman (sub_3bb7), terrain settling (sub_625d), terrain generation
(sub_5e3f), **tank death animation (sub_6895)**, as well as the complete bitmap font.

**Tank death animation (sub_6895) — 1:1:** on destruction the tank is drawn and
its palette index is then cycled through: phase A gray **0→60** (6‑bit) with rising tone
**300+20·i** (i=0..15), a brief hold on white, phase B **60→0**, phase C ramp **black→
sky color** (16,51,60 ≈ Sky) + a final tone sweep 900→200 Hz; then the tank is
erased and the palette reset to the real player color. Multiple dead tanks flash
one after another. Implemented as `stepAnim` child `'death'` (wall clock, ~0.8 s per tank).
During the flash the **HUD name box switches to the DYING tank**: its name is drawn in that
tank's palette index, so it blinks (fades up to white) and then fades out with the tank —
even when the enemy dies rather than the current player (`game.js` `_dyingHud` →
`hud.js drawStatusBar`).

**Not bit/pixel exact (deliberate deviations):**
- **Random seed:** the port uses the **exact Turbo Pascal 7 generator**
  (`RandSeed := RandSeed·134775813+1`, `Random(N)=(RandSeed·N) shr 32`,
  `Random`‑Real = `RandSeed/2³²`; verified in [`js/rtl.js`](html5-port/js/rtl.js)) — the
  algorithm is therefore identical. Only the **seed** is time‑based as in the original
  (`Randomize`), so concrete sequences (terrain shape, wind, random shooters,
  CR fractal spread) are **not reproducible** — nor are they in the original, since it re‑`Randomize`s
  per effect anyway.
- **Results/ranking screen & help/intro:** the **logic** is documented (round pot
  `(players−survivors)·1000/survivors` to each survivor on points+money,
  win counter; sorting by wins/points); **layout** is rebuilt from screenshots/specs,
  not verified field by field against the code (purely cosmetic interstitial
  screens).
- **Mouse control/menu glide:** the original uses the DOS mouse driver's click‑region/
  `MouseGlideTo` framework; the port reproduces this functionally (cursor, click regions,
  aiming panel, selection glide) — via Pointer Lock instead of the driver, so equivalent
  but not the same internal framework.
- **Menu/shop blip sounds:** core frequencies verified against the code (menu move/names/shop
  = **400 Hz** `[0x190]`, weapon change **300**, effect tones 500/700/1000); individual
  detail blips are style‑matched recipes.

All core values (palette, physics constants, weapon algorithms & parameters,
damage/scoring formulas, sound frequencies, AI mathematics, timing) are documented **directly from the
machine code**; the detail specifications with address evidence are stored as
`spec_*.md` in the analysis working directory.

---

## 11. Sub‑call porting status

Full mapping **original routine → port location → status**. "1:1" = decompiled from the
machine code and (Node/headless) verified; "≈" = behavior/formula documented,
detail (pattern/layout/seed) inherently approximated; "—" = deliberately not ported.
Verified among other things by a **loop audit** (all back‑jumps counted per routine).

### Physics / flight / collision
| Original | Purpose | Port | Status |
|---|---|---|---|
| `sub_bd08` | fire shot (VX0/VY0 from angle·power) + flight orchestration | `game.js fire/stepFlight` | 1:1 |
| `sub_b785` | flight single step (Euler dt=1, wind, drawing) | `physics.js step` | 1:1 |
| `sub_b560` | collision (pixel passable 0/15) | `physics.js impactAt` | 1:1 |
| `sub_0a3a` | busy‑wait (factor 2.0/step) = flight pace | `game.js` wall clock (487 steps/s, measured) | 1:1‑equiv. |

### Weapon effects
| Original | Purpose | Port | Status |
|---|---|---|---|
| `sub_b044` (caller 0xbfe7) | crater + **white flash** (palette 12 sky→white→sky) | `game.js stepAnim 'crater'` | 1:1 |
| Blast loop `0xc8ca` | direct damage `80·B/D` (shield `B/D`) | `weapons.js applyBlastDamage` | 1:1 |
| `sub_3511/2f9a/2c0d` | Earthquake (wedge fissure, ±45° branches, 2×2) | `weapons.js effectEarthquake` | 1:1 |
| `sub_371d` | Ping‑Pong (**2 loops**: descent + bounce back) | `weapons.js effectPingPong` | 1:1 |
| `sub_2307/2b8c` | CR‑Inducer/Julia (8‑direction fractal, rules extracted) | `weapons.js effectEater` | 1:1 (seed ≈) |
| `sub_3bb7/3b4d/3b7f` | Caveman (**3 phases**: run‑up/skip/drill, 9‑px roof) | `weapons.js effectCaveman` | 1:1 |
| `sub_625d` | terrain settling (columns sink pixel by pixel) | `weapons.js simulateCollapse` | 1:1 |

### Tank: fall, death, protection
| Original | Purpose | Port | Status |
|---|---|---|---|
| `sub_6d3c` | fall **animated** + fall damage (`fall÷2`, `>2·crew→0`), **silent** (no `Sound` instruction) | `game.js stepAnim 'fall'` | 1:1 |
| `sub_6cbd` | support test center (X−2..X+2) | `game.js centreSupp` | 1:1 |
| `sub_6b84` | support test base area (X−6..X+6) | `game.js footSupp` | 1:1 |
| `sub_6b0c`/`sub_6a93` | support left/right → **sideways slide** | `game.js leftBlk/rightBlk` | 1:1 |
| `sub_7060` | driver: round‑start descent **and** fall (+parachute gate 0x70ba ⇒ fall flag=0 = no damage) | `game.js stepRoundIntro` + `stepAnim 'fall'` | 1:1 |
| `sub_6895` | tank death animation (palette flash) | `game.js stepAnim 'death'` | 1:1 |
| `sub_02d4` | parachute? `inv[11]>0` | `player.hasParachute` | 1:1 |
| `sub_0303` | shield? `inv[13]>0` | `player.hasShield` | 1:1 |
| `sub_0332` | quake protection? `inv[12]>0` | `player.hasQuake` | 1:1 |
| `sub_01bc` | dead? `crew==0` | `!t.alive` | 1:1 |

### World / RTL / AI / sound
| Original | Purpose | Port | Status |
|---|---|---|---|
| `sub_5e3f` | terrain generation (random walk, θ clamp ±1.2→±1.0) | `terrain.js generateTerrain` | 1:1 (seed ≈) |
| `Random/RandomN/RandomR` | TP7 LCG | `rtl.js TPRandom` | 1:1 (seed time‑based) |
| BGI DefaultFont | 8×8 bitmap font | `font8x8.js` | 1:1 (extracted) |
| `Frame3D`, `OutTextXY` | 3D frame, text (+emboss) | `hud.js`, `vga.js outText/embText` | 1:1 |
| `sub_d2c8` | AI parabolic lob: 45/135, `power=min(10·crew, round(333.333·√(0.0011·dXe²/(dXe+Δy+11))))`, `dXe=|f·(|Δx|−11)|` | `ai.js solveParabolic` | 1:1 |
| `sub_d61a` | AI direct shot: `K=f·Δx`, `angle=round(atan((Sy−Ty)/K)·57.2958)` or `180−…` | `ai.js solveDirect` | 1:1 |
| `sub_d17a` | AI Jack PP lob: like parabolic, but denominator `dXe+(491−Sy)` (to the field bottom), error `P/2`, weapon 5 | `ai.js solveJack` | 1:1 |
| `sub_d48a` | AI reflection aim: `angle=round(atan((Ty+Sy−126)/K)·57.2958)` or `180−…` | `ai.js solveReflect` | 1:1 |
| `sub_0361` | error jitter `f=(100−arg+2·arg·RandomR)/100` (arg = `P+1` / `P/2` / `2P+1`) | `ai.js errFactor` | 1:1 |
| error decay `0xd0d0` | `P=[0x176e]` starts = rate (10), halved **per full turn rotation** | `game.js nextPlayer` | 1:1 |
| `sub_086e`/`sub_0467` | AI target selection min‑Y unprotected (Jack) / most wins (Ballisto, slot) | `ai.js pickLowestUnprotected/pickMostWinsSlot` | 1:1 |
| `sub_0530`/`sub_071a`/`sub_07c4` | line of sight over terrain / height sums forward+back | `ai.js hasLineOfSight/heightSum` | 1:1 |
| `[0x1161]` (`sub_da0c` 0xda43) | turn order = random permutation (rejection sampling) | `game.js startRound` (`this.order`) | 1:1 |
| `[0x1774]` target walk + default branch `0xe683` | persistent slot pointer; default: height sum→super‑weapon horizontal blast / LOS walk→direct shot / no‑LOS+reflection→d48a / no‑LOS→blind lob | `ai.js computeMove` (`this.turnSlot`) | 1:1 |
| `sub_d7d8`/`sub_d8f4` | angle (`>180→0/<0→180`) & power clamp (`0..10·crew`) + tones (`500−|90−a|`, `power+100`) | `main.js wrapAngle/clampPow`, `sounds.js` | 1:1 |
| `sub_0273`/`sub_0225` + `[0x1776]` | end of round: ≤1 alive **or** no living tank armed **or** > 20 turn rotations | `game.js roundOver` | 1:1 |
| `sub_da0c` (wind) | `Wind = round(1000·(2·RandomR−1)^5)`, calm‑weighted | `physics.js generateWind` | 1:1 |
| `sub_da0c` (reflection) | per round: `[0xcf6]` NO/RND/YES → `[0xcf7]` (RND: `RandomN(20)` odd) | `game.js` reflectActive | 1:1 |
| `sub_1ff5`/`sub_7801` | weapon/shop catalog (price/quantity/radius/type), starting values (crew 100, angle 45, 20 grenades) | `weapons.js WEAPON_TABLE`, `game.js resetPlayersForGame` | 1:1 |
| `sub_9d62` (human) | shop: purchase (`+quantity`, `−price`), sale (`−quantity`, `+price÷2`) | `main.js shopBuy/shopSell` | 1:1 |
| `sub_9d62` (CPU) + `sub_9b05` | CPU restocks between rounds personality‑based (5 brains, affordable list w=1..13) | `game.js cpuShop/_cpuShopDecide` | 1:1 |
| `sub_5a48`, `Sound/NoSound` | sweeps + effect tones | `sounds.js`, `pcspeaker.js` | 1:1 |
| round pot/scoring | `(players−survivors)·1000/survivors`, 50 pts/man | `game.js endRoundScoring` | 1:1 |

### Fall animation & event order
The tank fall is played back **visibly** as its own animation phase (pixel‑by‑pixel
fall with sideways slide; the tank darkens progressively as it loses crew, because
`sub_6d3c` recomputes the crew each step and redraws the hull). `sub_6d3c` contains
**no** `Sound` instruction — the gameplay fall is
**silent** in the original; the driver `sub_7060` also skips the score sweep tone in settle mode
(flag=1, @0xcb68). The 700‑Hz tone (`0x2bc`) in this code region belongs **not** to the
fall, but to the **Caveman drill phase** (`sub_3bb7` @0x3c4c), ported there 1:1.
`sub_3b7f` is the ±1‑x advance helper of the Caveman, and
`GetPixel==0xD` checks **ground** — color index 13 —, not a falling tank.

The **event order** follows exactly the impact handler (`0xca..0xcb72`):
**blast damage → death flash (per tank immediately at crew≤0, `sub_6895` @0xcafa) →
terrain collapse (`sub_625d` @0xcb65) → fall/settle (`sub_7060`→`sub_6d3c` @0xcb72) →
fall death flash** (`sub_6d3c` calls `sub_6895` @0x6f08/0x6fe1 for lethal falls).
Implemented as a phase queue in `resolveImpact` (builds `this.phases`) + `stepAnim`
(works through it). Damage is skipped with an active parachute (`sub_02d4` ⇒
`sub_7060` passes flag 0), but the tank still settles.

The fall runs **sequentially** as in the original: `sub_7060` calls `sub_6d3c` tank by
tank; each falls completely, and a **lethal fall flashes (`sub_6895`) immediately**, before
the next tank falls. The port reproduces this exactly — the fall phase handles one
tank after another and, on a lethal fall, pushes the death flash phase
**before** the continuation of the remaining falls (never overlapping, verified:
max. 1 tank dying at a time). The tank order (original: array `0x1161`)
is irrelevant to the result, since the fall does not change any terrain.

### Complete routine audit (current state)
All **101 game‑specific routines** of the disassembly are classified (the 108
far‑calls are standard TP7 library: `Round`, `Line`, `Sound`, `OutTextXY`,
`PutPixel`, `RandomN` … — no hidden game logic, fully covered by the port primitives
in `vga.js`/`pcspeaker.js`/`rtl.js`). Result: **all gameplay‑relevant
routines (physics, collision, wind, weapons, terrain, collapse, fall, death, protection, damage,
angle/power clamps, end of round, scoring, shop‑human, starting values, weapon catalog) are
ported 1:1** — there are **no** gameplay‑relevant deviations left open.

**Ported 1:1:**
- **Fall animation & event order** (see above).
- **CPU shopping** (`game.js cpuShop`): "AI stat" `[+0x1a]` decoded as `inventory[2]` (5‑kT‑Nuke count);
  all 5 brains incl. affordable list, category preferences and
  purchase probabilities (50%/70%).
- **AI aiming** (`ai.js`): all four brains (`d2c8/d61a/d17a/d48a`), the error jitter
  (`sub_0361`, arg `P+1` normal / `P/2` Jack‑PP / `3P` Jack‑without‑PP) and the error decay
  (halved per turn rotation, not per shot).
- **AI target selection** (`ai.js`): random turn order (`[0x1161]`), persistent slot pointer
  (`[0x1774]`), target random walks per personality, line‑of‑sight test (`sub_0530`),
  height sums (`sub_071a/07c4`) and the complete 4‑way default branch
  (super‑weapon horizontal blast / LOS direct shot / reflection aim / blind lob).
- **20‑turn‑rotation limit** (`roundOver()` via `roundCycles > 20`).

### AI, turn-order and fall specifics
Exact behaviors of the AI, turn-order and fall routines, verified against the disassembly:
- **LOS test** (`sub_0530`): end condition `(A.y−B.y)<5` (target not clearly below the shooter); used by the Terminator direct shot.
- **Jack without Ping‑Pong**: error multiplier **`×3`** (`0xe5b3`).
- **`sub_d61a` weapon**: weapon 2, downward scan **without** wrap (`0xd7a4`).
- **Blind lob power**: `min(10·crew, max(50, RandomN(min(10·crew, wall/2))))`.
- **Berti/Klaus**: weapon cycle (random owned weapon, stop 20%/50%).
- **`sub_0467` tiebreak**: `>=` (last hit on a point tie).
- **Error decay/turn limit**: keyed to the **turn rotation** (halved/counted once per full round of living+armed tanks).
- **Turn advance**: skips **dead OR unarmed** tanks (`sub_0225`, `0xd10c`).
- **Fall slide**: both edges tested at the original X (`0x6dd4`).
- **Fall credit**: `+50 pts/$` per fallen man credited to the shooter (`[0x1692]` @0x7020).
- **Hit criterion**: miss only on a final **X ∉ [4,635]**; an impact into a shaft detonates at the ground (`0xbf4c`).
- **Round counter init**: `[0x1776]` starts at **1** (limit ends after 20 rotations).

Earthquake fissure step (pixel access in `sub_2c0d`): `X += Cos·0.7, Y += Sin·0.7`; the
disassembly annotation swaps `Sin`/`Cos`.

All **101** game‑specific routines with game logic are ported 1:1.

Three further behaviors are 1:1: (a) `sub_d2c8` chooses weapon 3 instead of 2 when the denominator ≤ 0 (`giveUp` path);
(b) the last terrain segment on the far right is **inclined** (one more turtle step,
`sub_5e3f`); (c) the support tests count **any non‑sky pixel** as footing (ground
**or another living tank**, `tankOccupies`) — a tank can **land on another
tank** (`sub_6cbd` reads `GetPixel != 0`; the falling tank itself is excluded).
Only cosmetic/UX aspects are not 1:1 (below).

### Additional 1:1 elements
The following are rebuilt **1:1**:
- **Tank decorations** (`sub_44a6`): white surrender flag + black barrel when out of ammo
  (leaning by the wind), shield bubble (ring r=12 about (X,Y-5)), quake-protection dot band
  — `tank.js`.
- **Arsenal strip** (`sub_4eae`): a 10-weapon selector (owned only, current highlighted)
  with **mouse weapon-select in the aiming panel** + "No Mun no Fun !" — `hud.js`, `main.js onAimClick`.
- **Per-player status via digit keys 1–0** (`sub_3d21`) and the faithful **"View Game
  Status"** (`sub_907f`: Game N of M / Attempt / Error Rate, turn order, dead struck
  through) — `main.js`.
- **`A` gag screen** (`sub_95a0`): a framed bg banner with a red size-2 title "TankWars
  V2.07" (212,12) and a white line "They will take control.  ©1995 ML" (205,40); the ©
  glyph comes from font glyph 169 (original: a `DrawMarker` ring). Reachable in-game via
  `A`, auto-dismisses after ~2 s (or on any key) — `main.js`.
- **Farewell screen** (`sub_116c`): a text-mode typewriter monologue (yellow/gray/white on
  black, a 200 Hz click per character, the play-time "You played …", one of four comments by
  minutes played, WWW/e-mail); byte-exact text, any key fast-forwards — `main.js`. Reachable
  via **Esc in the main menu**; stays until the page is reloaded (a browser has no program exit).
- **High scores "The Lucky Shots"** (`sub_96f4`) with **`localStorage` persistence** and the
  'L' key (in-game) — `main.js`.
- **Rankings after every game** (`sub_abdc`): "Rankings after N of M Games", the encouraging
  line, scale-1 columns, 3 frames — `main.js`.
- **Audio:** round-start tones at round start (chirp 400→700 + per
  tank a rising `100+5·i` resp. `800→1500`, `sub_7060`); no end-of-round tally tone;
  the crater does not boom; death boom step 2; `buyConfirm` 400; large-step tones
  (PgUp/PgDn/Home/End, W/I); flight tone gated on the flight option only.
- **Quit default:** Enter cancels (the safe option); only `y`/`j` confirms.
- **Parachute geometry** exact (`sub_4291`).

### Automated faithfulness audits (`html5-port/tools/`)
An **automated audit suite** (`tools/audit.sh`, see `tools/README.md`) differentially checks the port
against the **original** (EXE image + disassembly):
1. **`audit_strings.py`** — every EXE string vs the port + font character coverage
   (glyphs `= @ #` included); baseline clean.
2. **`audit_input.py`** — all cursor/click-region calls (`MouseGlideTo`/`SetRange`/…) with
   coordinates + the in-game key dispatch (DOS codes → browser key), including
   **Ins/Del = angle ±45°** (`min(180,a+45)`/`max(0,a-45)`).
3. **`invariants.mjs`** — plays many seeded all-CPU matches headless, asserting value
   bounds, round termination, crashes, **RNG variance** and **arsenal persistence**.
   → 0 violations.
4. **`pixel_diff.py`** (+ `capture_dosbox.sh`) — golden-master: renders each screen headless
   and diffs against DOSBox references (native 640×480 via nearest-neighbour). Covers the
   selected menu item's **white text** (`[0x177e]=6`), the status **`Error Rate 10.0 %`**
   format (`Str(:4:1)`) + header field widths `Str(:2)`, shop paddings (money `:6`,
   prices `:7`) and the "Buy these/For Sale" y (75).
5. **`audit_font.py`** — the EXE's own 8×8 letter table (at 0x1067b, `A-Z [ ] _ a-z`)
   byte-for-byte against `font8x8.js`: **55/55 identical**. Digits/punctuation are not
   stored as plain bitmaps in the EXE (BGI driver stream); they are validated end-to-end
   via the pixel goldens.
6. **`audit_sounds.py`** — the original's complete sound inventory (27 `Sound()` sites +
   11 sweep callers, byte-extracted with frequency formulas and delays) as 29 checks
   against the port sources: **flight whistle follows `vy/4`** (a
   near-constant 400 Hz, NoSound ≤ −1200), **angle/power
   tones 150 ms** (`sub_0a3a(30)`), **miss tone 300 ms** (`sub_0aa1(30)`),
   the **death-flash ladder** (ramps in 5 ms units, 500 ms white hold, staccato descent),
   **ring pacing** (16 ms/ring only for radius < 50). WebAudio robustness: the effect
   end is scheduled purely on the audio clock; the `setTimeout` fallback has an +80 ms
   margin (against timer/audio-clock drift — Firefox Windows vs Linux).

**Mouse cursor (Pointer Lock):** the original moves the DOS mouse driver's cursor on
`MouseGlideTo`/`MouseToMenuItem`; a browser cannot move the OS pointer. On the mouse-driven
screens (menu/names/shop and the aim turn) the mouse is therefore **captured via the Pointer
Lock API** and the software cursor is driven by **relative motion** (`movementX/Y`) — so the
motion is **unbounded** (the real OS pointer can never hit a screen edge and freeze the
in-game cursor). A click captures the pointer, **Esc/Tab/tab-switch** release it, the next
click re-captures. Clicks act at the **software-cursor** position; in the aiming panel the
cursor stays confined to the HUD strip (`MouseSetRange(3,3,633,52)`).

**"The Lucky Shots" timing (`sub_bd08`):** the high-score table does **NOT** appear
after every match — it appears **mid-game on a qualifying
shot**: `[0x1692]=0` at shot start, `+= enemy men killed` while resolving (direct/chain/fall,
self excluded, `0xcb0f/0xc322/0x7020`); then **score = 50·[0x1692]** (`0xcbb7`), and if it
beats the 10th table row (`0xcbc0`) the entry (shooter name + score) is inserted and "The
Lucky Shots" is shown **immediately over the play scene** (`0xccbe`) until a key, after which
the turn resumes. Implemented in `afterImpact`/`recordLuckyShot`; it does not appear after the
match (after the last game → main menu). The associated whole-program "New Match, new
Luck ?" dialog (`sub_8ac5`) stays deliberately unported.

**Trajectory clipping:** with reflecting walls off the shell flies past the field edges; every marker pixel
is clipped to the field interior (x 4–635, y 63–475), as BGI draws inside its viewport —
draw and erase share the same clip.

**Pacing classes (disassembly):** the original uses **three pacing classes** —
(a) calibrated busy-waits `sub_0a3a(u)`, 1 u ≈ 5 ms by design (`37·[0x175c]−550` empty
loops, `[0x175c]` = CalibrateSpeed/100, **re-calibrated every turn**); (b)
`WaitVerticalRetrace` = exactly 60 Hz; (c) **none at all** (CPU-bound). In the port:
**flight = 2 u/step → 100 steps/s plus free-running
above the screen edge** (y<0 without delay — the characteristic "vanishes up, rains down
quickly" feel); **intro descent = 60 px/s** (retrace). Importantly: terrain settling
(`sub_625d`), earthquake cracks and the post-shot fall are **unpaced** in the original —
their DOSBox speed is an artifact of the cycles setting (20000), not a design value; the
port picks deliberate rates for them (documented approximation).

### Pixel-exact screen layouts
All main screens match **pixel-for-pixel** against DOSBox captures of the original
(edge scan-lines/bounding boxes via image analysis, colours via pixel sampling):

- **Palette index 0:** in the original, **index 0 is the background colour**, not
  black (`[0x177b]=0`; the game points `SetRGBPalette` at index 0 for sky / menu blue).
  Every "fill 0" area (status/help/quit banners `sub_907f`/`sub_8f25`/`sub_8b7f`, the
  `sub_0c31` erase-bars in rankings/shop/HUD) therefore renders as **background**. The port
  keeps index 0 = black and fills those areas with `COL.SKY` — pixel-verified: in-game bg
  srgb(65,207,255), menu bg srgb(40,81,255).
- **Font:** includes the CP437 glyphs (`, ' ( ) [ ] \ / ; < > ? | « » * + _`).
- **Randomness:** `Randomize` at program start (time-based, as in TP7).
- **Weapon persistence:** the arsenal is rebuilt only **once per match** (`sub_7801`,
  20 HandGrenades); purchases persist between games.
- **Rankings** (`sub_abdc`) byte-exact: rank + 45 leader dots (white), cells via bg
  erase-bar, plural-s, the closing hint as **one** string with 20 embedded spaces before
  "( ...key ! )" (offset 0xab98, length 67).
- **Shop** (`sub_9d62`/`sub_3d21`) 1:1: name on its own line (10,6) in tank colour, 4
  right-aligned stat lines (x=25, `Str(:6)`, navy), inventory 2×5 grey(15) with dot
  leaders, red shadowed headers, column boxes (321/477..630), buttons raised → pressed,
  start bar (10,450)-(630,473).
- **Two-tone help** (`sub_8f25`): every row is drawn **twice** — white(15) for the key
  names + `|` separators, navy(14) for the descriptions (spaces are transparent). All 8
  row strings byte-exact from the EXE (0x8cef–0x8eda).
- **Main menu** (`sub_7801`): full-screen `Frame3DThick(0,0,639,479)`, title y=20 with
  red underline y=40 (x 205–433), boxes (40,50+40·i)-(508,85+40·i),
  labels x=60, values right-aligned to x2−16, **"Go for it !" set off** at (40,430)-(508,465),
  `©1995 ML` at (550,459), initial selection = "Go for it !".
- **Option popups** (`0x7afc`/`0x7d55`/`0x7f79`/`0x813b`) 1:1: rows 6–9 open a 5-button
  window (max / ↑ / ↓ / min / **"Yo!"**) with a red underlined title; "Yo!" pre-highlighted
  + cursor glide; Esc/outside click snaps to "Yo!" (does not close); limits: error 0–100
  (±1), money 0–100000 (±1000), games 1–50 (±1), players 2–10 (±1); value-pitched beep.
- **Protractor aiming panel** (`sub_557a`) 1:1: dot arc r=35 about (190,47) (19 dots every
  10°), marker circles (hub/0°/45°/90°/135°/180°), white needle r4→r32, ◄/► buttons,
  Fire/I/W/max/250 buttons, +/− power group with `Str(:4)` readout; all 9 click regions;
  **right click** toggles the panel (`[0x115f]`), the preference starts as "Use your Mouse".
- **Mouse cursor** extracted pixel-exact: grey arrow (index 15, white in-game) with an
  outline in **colour 0 = background** — invisible on the bg, but "punching through" text
  and frames it passes over.
- **HUD stats** (`sub_5b69`): `Str` field widths (points:6, wins:6, men:3, wind:3,
  angle:2, power:4), rows at y=10/18.

### Deliberately **not** 1:1 (omitted / approximated)
| Area | Original | Port state |
|---|---|---|
| **Farewell screen** (`sub_116c`) | typewriter monologue on **program exit** | **implemented**, but reachable via **Esc in the main menu** and stays until the page is reloaded — a browser has no program exit — `≈` |
| **INI persistence** (`sub_1648`/`sub_1a2a`) | save/load options in `Tankwars.ini` | **omitted** — options reset to defaults each load (could be added via `localStorage`) — `—` |
| **Command line/usage** (`sub_1459`/`sub_15d8`) | `-D/-F/-M/-?` switches, stdout help | **omitted** — meaningless for a browser build — `—` |
| **Second quit dialog** (`sub_8ac5`, whole-program exit) | separate exit dialog | **omitted** — no program exit in a browser — `—` |
| **Mouse positioning** (`MouseGlideTo`/`MouseToMenuItem`) | moves the real mouse-driver cursor | **approximated** — a browser cannot set the OS pointer, so the mouse is **captured via the Pointer Lock API** (unbounded relative motion; Esc/dialogs release it, the next click re-captures) and warps move the captured software cursor. The **confinement** `MouseSetRange(3,3,633,52)` is thereby **1:1** — `≈` |
| **CR-Inducer icons** (`sub_2b8c`, Randomize=1) | re-scribbled from the game RNG on **every** strip redraw | **approximated** — stable per turn/weapon-select (own LCG), since the HUD also redraws on mouse-move (would otherwise flicker) and the game RNG stays untouched — `≈` |
| **Animation speeds with no original pacing** (terrain settling `sub_625d`, earthquake cracks, post-shot fall) | **unpaced** in the original (CPU-bound → depends on the DOSBox cycles setting) | a **deliberate rate** is chosen, as there is no fixed original reference — `≈` |
