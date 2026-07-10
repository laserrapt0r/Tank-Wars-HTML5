# TankWars V2.07 — Reverse Engineering & originalgetreue HTML5‑Portierung

**Autor des Originals:** Marko Lindner (TU Chemnitz), 1995/96.
**Original‑Dateien:** `TANK_ENG.EXE` (106 048 Bytes, englische Fassung), `TANK_ENG.DOC`, `TANKWARS.ICO`.
**Ziel dieses Projekts:** Ein **nativer** HTML5‑Port (Canvas + WebAudio, kein Emulator),
dessen Grafik, Sound, Spielphysik und Timing **aus dem disassemblierten Maschinencode**
rekonstruiert wurden — nicht aus Screenshots geraten. Screenshots des in DOSBox‑X
laufenden Originals dienten ausschließlich zur Gegenprüfung.

**Zum Spielen:** Am einfachsten die eigenständige Einzeldatei [`index.html`](index.html)
(im Projekt-Hauptordner) **per Doppelklick** öffnen (funktioniert offline, ohne Server), dann die Seite anklicken
(aktiviert den Ton). Diese Datei wird aus den Modulen unter [`html5-port/`](html5-port/)
gebaut (`cd html5-port && node build.mjs`). Alternativ die modulare Fassung über einen
lokalen Server starten (ES‑Module laufen **nicht** per `file://`):
`cd html5-port && python3 -m http.server` → `http://localhost:8000`.

---

## 0. Spielmechanik (Kurzüberblick für Spieler)

Rundenbasiertes Artillerie‑Duell (2–10 Panzer) auf zerstörbarem Terrain. Reihum zielt jeder
Panzer (Winkel + Stärke) und feuert eine Waffe; Ziel ist, alle anderen auszuschalten.

**Mannschaft (Crew) = Lebensenergie.** Jeder Panzer hat **0–100 Mann** (Start 100). Die Crew ist
zugleich seine „Gesundheit": Bei **0 Mann explodiert der Panzer**. Die Crew begrenzt außerdem die
**maximale Schuss‑Stärke auf `10 × Crew`** (voll = 1000), und die **Helligkeit** des Panzers sinkt
mit der Crew. Mannschaft geht durch Explosions‑ und Fallschaden verloren.

**Schaden**
- **Explosionsschaden:** Ein Treffer im Radius `B` einer Waffe kostet `80·B/D` Mann, wobei
  `D = max(1, Abstand−3)`. Ein **Schutzschild** reduziert das auf `B/D` (Faktor 80 weg).
- **Fallschaden:** Wird der Boden unter einem Panzer zerstört, fällt er. Pro **2 gefallene Pixel
  stirbt 1 Mann** (`Crew −= ⌊Fallhöhe/2⌋`); ist die **Fallhöhe größer als `2 × Crew`, ist die
  gesamte Mannschaft tot**. Ein voller Panzer (100) überlebt also Stürze bis ~200 px (stark
  geschwächt) und stirbt darüber. Ein **Fallschirm** verhindert Fallschaden komplett (der Panzer
  fällt trotzdem herab). Nach Schaden wird die Stärke auf `10 × Crew` nachgeklemmt.

**Waffen & Shop** (zwischen den Runden kaufbar; Verkauf zum halben Preis):

| # | Waffe | Wirkung | Radius B | Preis | Menge |
|---|---|---|---|---|---|
| 1 | Hand Grenade | Krater + Explosion | 4 | 1000 | 100 (Start 20) |
| 2 | 5 kT Nuke | großer Krater | 30 | 2000 | 10 |
| 3 | 5 MT Nuke | riesiger Krater (Weiß‑Blitz) | 100 | 10000 | 1 |
| 4 | Earthquake | Riss‑Fissur mit ±45°‑Verästelungen | 30 | 5000 | 1 |
| 5 | Ping Pong Jack | hüpfendes Geschoss, gräbt Bahn + bounct zurück | 10 | 5000 | 5 |
| 6 / 7 | Chain‑Reaction‑Inducer 256 / 512 | „frisst" Terrain fraktal in Schussrichtung | 4 / 8 | 5000 / 10000 | 1 |
| 8 / 9 | Julia 256 / 512 | wie CR‑Inducer, anderes Fraktalmuster | 4 / 8 | 5000 / 10000 | 1 |
| 10 | Captain Caveman | bohrt einen Tunnel entlang der Oberfläche | 5 | 20000 | 1 |
| 11 | Parachute | **Schutz:** kein Fallschaden (1 Runde) | – | 10000 | 1 |
| 12 | Quake Protection | **Schutz:** gegen Earthquake (1 Runde) | – | 20000 | 1 |
| 13 | Protection Shield | **Schutz:** Explosionsschaden ÷80 (1 Runde) | – | 20000 | 1 |

Schutz‑Items (11–13) halten **eine Runde** und werden am Rundenende verbraucht.

**Wind:** pro Runde zufällig (`round(1000·(2·R−1)⁵)`, Bereich ±1000, stark ruhe‑gewichtet); lenkt
Geschosse horizontal ab (`vx += Wind·1e‑6` je Schritt). **Reflektierende Wände** (Option: Nein / RND
/ Ja) lassen Geschosse an den Feldrändern abprallen.

**Rundenende & Punkte:** Eine Runde endet, wenn ≤ 1 Panzer lebt, niemand mehr bewaffnet ist, oder
nach 20 Zug‑Rotationen. Jeder **Überlebende** erhält `(Spieler − Überlebende) × 1000 ÷ Überlebende`
als **Geld und Punkte**; wer einen gegnerischen Mann tötet, bekommt zusätzlich **+50 Punkte/$ pro
Mann** (auch durch Fallschaden verursachte). Der alleinige Sieger einer Runde erhält **+1 Sieg**.

**Steuerung:** ◄/► Winkel ±1°, ▲/▼ Stärke ±1, Bild↑/Bild↓ Stärke ±100, Pos1 = max Stärke,
Ende = 250; **Enter oder Mausklick = Feuern**, **Tab = Waffe wechseln**, Leertaste = Status‑Anzeige,
F1 = Hilfe, Esc = Beenden. Die KI‑Gegner haben
Persönlichkeiten (Berti/Klaus zufällig, Jack Ping‑Pong‑Spezialist, Ballisto/Terminator ballistisch)
— alle 1:1 aus dem Original nachgebaut (siehe §11).

**Audio/visuelle Hinweise:** Beim Rundenstart „chirpt" jeder Panzer beim Absetzen (400→700‑Hz‑Sweep,
`sub_5a48` in `sub_7060`). Zielt eine KI mit Ballistik (Jack/Ballisto/Terminator), erscheint kurz
vor dem Schuss ein **schrumpfender roter Ring** um ihr **Ziel** (`sub_b4a2`, Farbe 12) — aus Sicht
des angegriffenen Spielers also um den eigenen Panzer.

> Alle obigen Werte/Formeln sind **1:1 aus dem Maschinencode** rekonstruiert; die technischen
> Details, Adressen und Herleitungen stehen in den folgenden Abschnitten.

---

## 1. Vorgehen (Methodik)

1. **Datei‑Analyse.** `TANK_ENG.EXE` ist ein DOS‑MZ‑Executable, erzeugt mit **Turbo
   Pascal 7.0** (Real‑Mode, 16‑Bit). Es enthält den **Borland EGAVGA‑BGI‑Grafiktreiber**
   eingebettet (Signatur „BGI Device Driver (EGAVGA) 2.00 - Mar 21 1988"). Grafikmodus:
   **VGA 640×480, 16 Farben**, eine Bildseite.
2. **Loader nachgebaut.** Ein eigenes Python‑Skript liest den MZ‑Header, wendet alle
   **2171 Relocations** an (Basis 0) und erzeugt das Ladeabbild `image.bin`
   (linear = Segment·16 + Offset).
3. **Disassembliert** mit *capstone* (16‑Bit). Segmentaufteilung (Paragraph‑Werte):
   `0000` = Spielcode (Entry `0000:EA58`), `0EB0` = eigene Grafik/UI/Maus‑Unit inkl.
   eingebettetem BGI‑Treiber, `1129` = Uhr‑Unit (Centisekunden), `1138` = DOS‑Unit,
   `1140` = **CRT**, `11A3` = **GRAPH**, `1509` = **SYSTEM**, `16F3` = Datensegment.
4. **RTL‑Symbolkarte.** Alle **124 Far‑Call‑Ziele** in die Units wurden identifiziert
   (Fingerabdrücke: Portzugriffe 0x42/0x43/0x61 für `Sound`, `0x1234DD div f`, INT 16h,
   die Real48‑Arithmetik, der LCG `×0x08088405+1` für `Random`). Damit wurde der Spielcode
   **vollständig symbolisch** annotiert (`game_disasm.txt`): jeder `Sound`, `PutPixel`,
   `Sin`, `Round` usw. ist im Klartext lesbar.
5. **Spiellogik dekompiliert.** Aus dem annotierten Code wurden Palette, Terrain‑Erzeugung,
   Tank‑Sprite, Ballistik, Wind, Schaden, Waffen, Shop, KI, Sounds und Timing als exakte
   Formeln/Konstanten extrahiert (jede Konstante ist im Code adressiert belegt).
6. **Port implementiert** in modularem ES6‑JavaScript, 1:1 nach diesen Formeln.
7. **Verifiziert** gegen Screenshots des Originals (DOSBox‑X headless via Xvfb).

> **Wichtige Erkenntnis (Sin/Cos):** In der TP7‑SYSTEM‑Unit ist `1509:0x144f` = **Cos**,
> `1509:0x1462` = **Sin** (die Cos‑Routine addiert π/2 und fällt in den Sin‑Kern). Erst mit
> dieser Zuordnung sind **Ballistik, Rohr‑Richtung und Terrain‑Generierung gleichzeitig
> konsistent** — sie löst zugleich die einzige offene Unsicherheit der Terrain‑Analyse.

---

## 2. Grafik

### 2.1 Auflösung & Framebuffer
VGA 640×480, 16 Farben, indiziert, eine Seite. Der Port bildet das **BGI‑Zeichenmodell**
in [`js/vga.js`](html5-port/js/vga.js) nach: ein indizierter 640×480‑Puffer mit
`putPixel/getPixel`, Bresenham‑`line`, `bar` (gefülltes Rechteck), Midpoint‑`circle`,
`fillCircle`, scanline‑`floodFill` und `outText` (8×8‑Bitmapschrift, Integer‑Skalierung).
Die Ausgabe wird über die aktive Palette in ein Canvas geblittet.

### 2.2 Palette (exakt aus `SetRGBPalette`, Routine 0x1dfb–0x1f32)
Das Spiel setzt 16 Farben mit **6‑Bit‑DAC‑Werten (0..63)**; die VGA‑Hardware expandiert
mit der Regel **`v8 = (v6<<2) | (v6>>4)`** (nicht `v*255/63` — nur so stimmen die
DOSBox‑Samples exakt, z. B. 12→48, 48→195).

| Idx | 6‑Bit | 8‑Bit | Menü‑Rolle | Spiel‑Rolle |
|----:|-------|-------|-----------|-------------|
| 0 | 0,0,0 | 0,0,0 | schwarz | schwarz |
| 1 | 63,0,0 | 255,0,0 | Titel/rot | **Tank 1 / rot** |
| 2 | 0,0,43 | 0,0,174 | Knopftext | **Tank 2 (navy)** |
| 3 | 63,63,0 | 255,255,0 | | Tank 3 (gelb) |
| 4 | 0,36,16 | 0,146,65 | | Tank 4 (dkl. grün) |
| 5 | 36,16,12 | 146,65,48 | | Tank 5 (braun) |
| 6 | 63,63,63 | 255,255,255 | | Tank 6 (weiß) |
| 7 | 44,0,55 | 178,0,223 | | Tank 7 (violett) |
| 8 | 63,28,0 | 255,113,0 | | Tank 8 (orange) |
| 9 | 35,54,0 | 142,219,0 | | Tank 9 (limette) |
| 10 | 59,0,47 | 239,0,190 | | Tank 10 (magenta) |
| 11 | 10,20,63 | 40,81,255 | **Menü‑Blau** | **Himmel** (→16,51,63 = 65,207,255) |
| 12 | 63,0,0 | 255,0,0 | rot | **Nuke‑Rotzone** |
| 13 | 0,63,0 | 0,255,0 | | **Boden‑Grün** |
| 14 | 0,0,0 | 0,0,0 | schwarz | **Bevel dunkel** (→0,0,32 = navy) |
| 15 | 48,48,48 | 195,195,195 | **UI‑Grau** | **Bevel hell** (→ weiß) |

Beim Betreten eines Spiels (0xdbc7) werden die Indizes 11→Himmel, 15→weiß, 14→navy
umgesetzt. **Spieler p benutzt Farbindex p (1..10)** — verifiziert am Original (Spieler 2 =
Kern‑Pixel 0,0,174 = Index 2). Diese Indizes kollidieren nie mit Himmel/Boden/Bevel,
weshalb die **gesundheitsabhängige Abdunklung** des Panzers (`SetRGBPalette(color,
R·men/100, …)`) niemals Himmel oder UI verfälscht. Implementiert in
[`js/palette.js`](html5-port/js/palette.js).

### 2.3 Bildschirm‑Layout (Routine sub_5b69)
Statuszeile y 0..58 (`Frame3DThick(0,0,639,58)`), Spielfeld (0,59)–(639,479).
Textpositionen: Points (263,10), Wins (263,18), Men (385,10), Wind (385,18),
Angle° (490,10), Power (490,18); Namensbox (6,6,250,28), Waffenbox (6,32,250,54),
„R"‑Box (610,8,630,26). Umgesetzt in [`js/hud.js`](html5-port/js/hud.js).

### 2.4 Terrain (sub_5e3f)
Segmentierter Zufalls‑Walk („Turtle") in ein Höhen‑Array je Spalte (Original DS:0x119a),
danach Boden‑Grün‑Füllung. Da |θ| ≤ 1.2 rad (< π/2) ist cos θ > 0, die Oberfläche also
eindeutig in x. Schritt: `x += cos(θ)·amp`, `y += sin(θ)·amp`. Parameter (alle aus dem Code):
`stepRange = RandomN(40)+10`, `R1 = RandomR+0.3`, Start `x=4`, `y=445−RandomN(206)`,
`θ = RandomR·π/2 − π/4`, `amp = RandomN(stepRange)+5`; θ‑Random‑Walk `θ += RandomR·R1 − R1/2`,
geklemmt auf ±1.2 (Reset auf ∓1.0), y geklemmt [88,470]. Jedes Spiel neu (`Randomize`).
Umgesetzt in [`js/terrain.js`](html5-port/js/terrain.js).

### 2.5 Panzer‑Sprite (sub_64cc Rumpf/Turm, sub_44a6 Rohr)
Voller Panzer = **Turm + Rumpf**, pixelgenau am Original vermessen (game_landed.png), 8 Zeilen
horizontaler Linien um den Bodenmittelpunkt (cx,cy): **Turm** (3 Zeilen, Breiten 7/9/9 bei
cy−7…cy−5) auf dem **Rumpf** (5 Zeilen, 15/17/19/17/15 bei cy−4…cy). Rohr = Linie Länge 10 vom
Drehpunkt (cx, cy−5) in Richtung `(cos θ, −sin θ)`; Mündung (Schuss‑Ursprung) Länge 15.
Helligkeit ∝ crew/100. Umgesetzt in [`js/tank.js`](html5-port/js/tank.js).

**Flugbahn‑Clipping & Software‑Cursor:** Marker/Spur werden auf das Spielfeld begrenzt
(y ≥ 63) — nie in die Statuszeile gezeichnet (wie im Original). Menü/Namen/Shop nutzen einen
gezeichneten **Software‑Mauszeiger** (OS‑Cursor über dem Canvas ausgeblendet): er folgt der
Maus und **springt bei Tastaturauswahl auf das gewählte Element** (wie MouseGlideTo/
MouseToMenuItem im Original).

### 2.6 Schrift
Das Original zeichnet Text mit der BGI‑Default‑Bitmapschrift **8×8**, ganzzahlig skaliert
(Statuszeile Scale 1, Menü/Titel Scale 2). Verifiziert: Text sitzt auf 8‑px‑Zellgrenzen,
Grundlinie = Zeile 6, Unterlängen (g, y, p, j, q) in Zeile 7.

**Der komplette Zeichensatz ist pixelgenau aus dem laufenden Original extrahiert**
([`js/font8x8.js`](html5-port/js/font8x8.js)): alle A–Z, a–z, 0–9 sowie `: . ! % $ - ©`.
Methode — die ×2‑skalierten Menü‑Texte grau‑isoliert und auf die 8×8‑Basis heruntergerechnet;
im Menü nicht vorkommende Zeichen wurden im Namens‑Eingabefeld getippt und dort abgegriffen.
Damit sind der frühere Fehler (Querstrich über dem „w", abgeschnittene Unterlängen) und die
falschen Ersatz‑Glyphen behoben. Pfeile/Gradzeichen (`↑ ← → °`) für das HUD bleiben erhalten.

**Menü‑Stil (aus dem Original gemessen):** blauer Grund (Index 11), Buttons **ungefüllt**
mit 3D‑Bevel (hell oben/links = Index 15 grau, dunkel unten/rechts = Index 14), Text **grau
embossed** (1‑px Schatten), Titel rot mit roter Unterstreichung, Ecke „©1995 ML" weiß,
Vollbild‑`Frame3DThick`. Umgesetzt in `drawMenu`/`embText`
([`js/main.js`](html5-port/js/main.js)). **Achtung, Laufzeit‑Erkenntnis:** Palette‑Index 0
ist im Original **die Hintergrundfarbe** (nicht Schwarz) — Details im „Dritten
Umsetzungs‑Durchgang" (§10).

---

## 3. Physik / Ballistik (sub_bd08 Abschuss, sub_b785 Schleife)

Explizites Euler‑Verfahren, **dt = 1 pro Schritt**, Position in voller Genauigkeit
akkumuliert, nur eine gerundete Kopie für Pixeltests:

```
Arad = Winkel° · π/180
VX0 =  0.003 · Power · cos(Arad)
VY0 = -0.003 · Power · sin(Arad)          (y nach unten ⇒ −sin = aufwärts)
Mündung: (tankX + round(15·cos), tankY − 5 − round(15·sin))

pro Schritt:
  X += VX ;  Y += VY
  [Reflecting‑Walls: elastischer Abprall an x∈[4,634], y∈[63,474]]
  VX += Wind · 1e-6
  VY += 0.0011                            (Gravitation)
```

**Konstanten** (Real48, im Code adressiert): Geschwindigkeitsskala `0.003` @0xbe6d,
Gravitation `0.0011` @0xba8c, Wind‑Skala `1e‑6` @0xba4f, π/180 @0xbd7a, Rohrlänge 15 @0xbdca.

**Kollision** (sub_b560): Der vordere Eckpixel des 2×2‑Markers (nach VX/VY‑Vorzeichen)
zählt als Treffer, wenn seine Farbe ∉ {0 Himmel, 15 Spur} und innerhalb x∈(4,635),
y∈(63,475). Boden = 13, Panzer = 1..12, Marker = 14, Spur = 15. Abbruch außerdem bei
Y≥475 (Bodenrand) oder Schrittzähler > 20000. Ohne Reflecting‑Walls verlässt der Schuss
seitlich das Feld und fällt heraus. Referenz (45°/250/Wind 0): saubere Parabel, Scheitel
≈128 px, Reichweite ≈527 px, ≈994 Schritte. Umgesetzt in
[`js/physics.js`](html5-port/js/physics.js).

**Wind** (db1f): `Wind = round(1000·(2·RandomR−1)^5)`, ganzzahlig [−1000,1000], stark
flau‑lastig (fünfte Potenz). Vorzeichen = Richtung (Pfeil), Betrag angezeigt.

**Power/Winkel:** Winkel 0..180° (0=rechts, 90=hoch, 180=links), Anzeige `90−|90−Winkel|`.
Power 0..**10·crew** (Start‑crew 100 ⇒ max 1000); Default 250, „End"=250, „Home"=max,
±1 (Pfeile) / ±100 (PgUp/PgDn). Nach Schaden Power auf 10·crew neu geklemmt.

**Fallschaden** (sub_6d3c): fällt der Boden unter einem Panzer weg, fällt er (pixelweise,
mit seitlichem Rutschen in die offene Seite) bis er wieder Halt findet;
`crew −= Fallhöhe div 2` (1 Mann je 2 px); `Fallhöhe > 2·crew` ⇒ Crew tot; danach
`power = min(power, 10·crew)`. Der Fall ist **stumm** (sub_6d3c hat keinen `Sound`‑Befehl).
**Fallschirm** (Item) ⇒ Panzer settled trotzdem, aber Schaden 0 (Flag 0 aus sub_7060/sub_02d4).
Im Port als sichtbare Animations‑Phase `stepAnim 'fall'` umgesetzt (siehe §11).

**Timing / Animationen (in DOSBox nachgemessen, cycles=fixed 20000):** Das Original
taktet **jeden** Integrationsschritt des Fluges über einen CPU‑kalibrierten **Busy‑Wait**
(`sub_0a3a`, Faktor 2.0 → ~2,05 ms/Schritt), nicht per VSync. Durch Verfolgen eines
Geschosses und Fitten von `y(t)=½·g·rate²·t²` (g=0,0011 px/Schritt²) ergibt sich die
Schrittrate zu **487 Schritten/s**. Der **Fallschirm‑Einflug** (`sub_7060`) wartet dagegen
**1 VGA‑Vertikalrücklauf pro Abstiegsschritt** (~1 px / 60‑Hz‑vsync) — gemessen **58 px/s**
(streng linear, 117 px in 2,00 s).

Der Port treibt beide Abläufe **zeitbasiert** (Wall‑Clock, nicht Framerate): `stepFlight(dt)`
läuft mit `FLIGHT_STEPS_PER_SEC = 487`, `stepRoundIntro(dt)` mit `INTRO_PX_PER_SEC = 58`
(je mit Nachkomma‑Akkumulator). Dadurch ist das Tempo **unabhängig von der Bildwiederhol‑
rate** (60/120/144 Hz spielen identisch). Zuvor war die Simulation an `requestAnimationFrame`
gekoppelt (`STEPS_PER_FRAME = 8`, 3 px/Frame) → auf >60‑Hz‑Monitoren lief alles zu schnell.

**Fallschirm beschleunigen:** Wie im Original überspringt **jede Taste / jeder Mausklick**
während des Einflugs die vsync‑Wartezeit (im Original via `KeyPressed`/`MouseButtonDown` vor
`WaitVRetrace`; global auch durch den Demo‑Parameter `D`, der `[0x116e]=1` setzt). Im Port
setzt `keydown`/`mousedown` das Flag `introFast` → der Rest des Einflugs läuft mit voller
Geschwindigkeit (`INTRO_FAST_PX_PER_SEC`).

**Alle Waffeneffekte sind — wie im Original — progressiv animiert** (nicht instant), mit
Ton, über `game.stepAnim(dt)` (WALL‑CLOCK, refresh‑unabhängig):
- **Krater/Nukes (Code 0xbf8a..0xc0e1):** das Original zeichnet die Kraterform in
  Palettenindex 12 (vorher per `SetRGBPalette` auf die HIMMELSFARBE gesetzt) und rampt
  diesen Eintrag dann **himmel→weiß→himmel** in 15+16 vsync‑Schritten (je `WaitVRetrace`,
  ≈0,52 s) — ein kraterförmiger **Weiß‑Blitz** —, danach wird mit Farbe 0 gecarvt.
  Im Port 1:1 als Palettenanimation nachgebildet (Dauer unabhängig von B).
- **Earthquake/Ping‑Pong/CR/Julia/Caveman:** diese Schleifen haben im Original **keinerlei
  Delay** — ihr Tempo ist die rohe CPU‑Pixelarbeit. Der Port bepreist jede Teiloperation
  mit ihren „Samples" (angefasste Pixel) und spielt sie mit `EFFECT_SAMPLES_PER_SEC = 5000`
  ab — **kalibriert an einer DOSBox‑Messung** (cycles=20000): ein Ping‑Pong grub einen
  375‑px‑Kanal in 10,37 s ≈ 2478 Schritte × 21 Samples ⇒ ~5000 Samples/s. Ein Erdbeben
  dauert damit — wie im Original — mehrere Sekunden.
- **Sounds der Effekte:** Das Original pulst **pro gefressenem Bodenpixel** `Sound(f)` und
  sofort `NoSound` (Erdbeben f=500) → ein **ratterndes Knattern**, kein Dauerton. Der Port
  bildet das über `pcspeaker.gate()` nach: Ton an, solange Boden gefressen wird, Lücken,
  wenn die Linien bereits offenen Raum queren (Ping‑Pong `1000−y`, Eater 500, Caveman 700).

Flug‑ und Fallschirm‑Tempo sind **direkt am Original gemessen** (s. o.), das Effekt‑Tempo
über die Ping‑Pong‑Messung. Da alles leicht cycles‑abhängig ist, sind
`FLIGHT_STEPS_PER_SEC`/`INTRO_PX_PER_SEC`/`EFFECT_SAMPLES_PER_SEC` in `game.js` als
einzelne Stellschrauben ausgelegt, falls eine andere DOSBox‑Konfiguration verglichen wird.

---

## 4. Waffen, Schaden, Scoring (sub_bd08‑Dispatch, Regeln §2/§3)

**Waffentabelle** (init 0x2000–0x2306), Preis pro **Los**, Los‑Größe = Stück je Kauf:

| # | Name | Kat | Preis $ | Los | B (Radius/Param) |
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

Start: **20 HandGrenades**. Kategorien: 0 Krater‑Bombe, 1 Erdbeben, 2 Ping‑Pong,
3 CR‑Inducer, 4 Julia, 5 Caveman, 6 Schutz.

**Arsenal‑Reset pro Spiel** (dekompiliert aus 0x7924/0x84b9): Zu Beginn **jedes** Spiels
werden alle Spieler zurückgesetzt — crew=100, Winkel=45, aktuelle Waffe=1,
**HandGrenades=20, alle anderen Waffen‑Slots=0**; der Shop läuft danach (Käufe gelten
nur für das kommende Spiel, das Arsenal überträgt sich nicht). Läuft die aktuelle Waffe
im Spiel leer, wird automatisch auf die nächste vorhandene umgeschaltet.

**Effekte** (umgesetzt in [`js/weapons.js`](html5-port/js/weapons.js)):
- **Krater (0):** gefüllter Kreis Radius B entfernt Boden; Nuke‑„Rotzone" Radius B.
- **Direkter Explosionsschaden** (gemeinsame Schleife 0xc8ca): `dx=tankX−impX`,
  `dy=(tankY−impY)−4`, `dist=√(dx²+dy²)`, `D=max(1,round(dist−3))`; falls **B > D**:
  `Schaden = (80·B) div D` (mit Schutzschild `B div D`), `= min(Schaden, crew)`.
  **Wichtig:** Dieser Blast wird bei ALLEN Kategorien am **ursprünglichen Einschlagpunkt**
  mit dem eigenen B berechnet (die Effekt-Routinen bekommen den Einschlag als Wert).
  Schaden entlang des vom Effekt durchlaufenen Weges entsteht **nicht** durch den Blast,
  sondern durch **Nachrutschen/Fall-Schaden**, wenn der Boden unter Panzern wegbricht.
- **Earthquake (1) — 1:1 dekompiliert** (sub_3511 → sub_2f9a rekursiv → sub_2c0d):
  `count = 20·power`; Richtung auf Länge 0,7 normiert (mit dem Original‑Quirk, dass die
  vy‑Normierung das bereits normierte vx wiederverwendet); Start = Einschlag −
  `(0.005·count·vx/2, −0.005·count·vy/2)`. Pro Schritt: `(dx,dy)=0.7·(cos α, sin α)`,
  Position += (dx,dy), `α += rand·0.08 − 0.04`; gezeichnet werden **zwei Quer‑Linien**
  von der Pfadlinie zu ihrem Senkrecht‑Versatz `0.005·count·(dy,−dx)` → ein **Keil**, am
  Epizentrum `0.0035·count` px breit, zur Spitze auf 0 verjüngt. Mit **1/20 pro Schritt**:
  `n = Random(0.2·count)`; n ungerade → Zweig bei **−45°**, n gerade → Zweig bei **+45°**
  (mit Parent‑Querversatz `0.005·n·(dy,−dx)`); der Parent verliert die Zweiglänge
  (`count −= n`) → die charakteristischen **kleinen Verästelungen**. sub_2c0d prüft je
  Linie beide Endpunkte (nur weiter, wenn Boden), sampelt `0.0035·count+1` Punkte
  (Clip x∈[4,635], y∈[63,475]), ersetzt nur BODEN‑Pixel durch Farbe 0 (zeigt Himmel),
  bei `count>1000` zusätzlich als **2×2‑Block**; **pro Pixel `Sound(500)`/`NoSound`**
  (Ratter‑Rumble). `Randomize` pro Aufruf — jeder Riss ist anders. Panzer in der
  Riss‑Bounding‑Box verlieren `crew div 2` (außer **Quake Protection**), plus der
  gemeinsame Direkt‑Blast (B=30) am Epizentrum.
- **Ping‑Pong (2) — 1:1 dekompiliert** (sub_371d, alle TP‑Real‑Konstanten dekodiert). Die
  Routine hat **ZWEI Schleifen** (die zweite hatte ich zunächst übersehen — korrigiert):
  - **Schleife 1 (Abstieg, 0x37ef):** Start‑vx,vy **÷ 3.0**; je Schritt `pos += vel`; bei
    gesetztem Reflect‑Flag `[0xcf7]` Abprall an **x=635→625 / x=4→14 / Decke y=63→64**
    (Vorzeichen der passenden Geschwindigkeit gedreht); dann `vy += 0.00012222` (=0.0011/9);
    21‑px‑Schneise (round(x)−10..+10) löschen mit `Sound(1000−y)`. Läuft bis **y ≥ 475**.
    Busy‑Wait 1.0.
  - **Schleife 2 (das „Zurückbouncen", 0x3a6c):** vom Boden fräst sich der Ball **senkrecht
    wieder nach oben** durch seine Landungs‑Schneise, bis er über das Terrain steigt
    (`while min_surface ≤ y: y−−, Schneise löschen`). **Nicht** an das Reflect‑Flag gekoppelt
    (das ist das namensgebende Ping‑Pong‑Verhalten). Busy‑Wait 3.0 (3× langsamer).

  Direkt‑Blast B=10 am ursprünglichen Einschlag; der gegrabene Kanal **kollabiert**
  anschließend (sub_625d), Weg‑Opfer via Fallschaden.
- **CR‑Inducer/Julia (3/4) — 1:1 dekompiliert** (sub_2307, rekursives Richtungs‑Fraktal,
  + Treiber sub_2b8c): `size = B·64` (256/512), Start = Einschlag, Richtung **2 (Ost)**
  bei vx>0, sonst **3 (West)**. 8 Richtungen (1,2:x+ · 3,4:x− · 5,6:y+ · 7,8:y−); jede
  expandiert in **4 Halbgrößen‑Teilkurven** nach den aus 0x2466..0x2b86 extrahierten
  Produktionsregeln (z. B. dir 1 → [7|8],[1|2],[6|5],[1|2]). **CR** (Flag 1) wählt pro
  Slot mit p=1/2 (`Random(10)` ungerade) die Alternativ‑Richtung → chaotische
  Kettenreaktion; **Julia** (Flag 0) ist strikt deterministisch/selbstähnlich. Basisfall
  (size 1): 1‑px‑Schritt, Clip x∈[4,635]/y∈[63,475], frisst nur BODEN (Dauerton 500 Hz).
- **Captain Caveman (5) — 1:1** (sub_3bb7, **3 Phasen**, je mit Bounds‑Test sub_3b4d
  = x∈[4,635] und Vorschub sub_3b7f = x±1 in Schussrichtung):
  **Phase 1 (0x3bcb)** — vom Einschlag vorlaufen, bis das Pixel **auf der Schusszeile**
  Boden ist (Hügelwand erreicht); **Phase 2 (0x3bee)** — flaches Terrain überspringen,
  solange `surface+8 ≥ Y` und Boden da ist (bis ein Hügel >8 px über der Zeile beginnt);
  **Phase 3 (0x3c28)** — solange `surface+8 < Y` die Spalte bohren: Zeilen `surface+9..Y`
  löschen (9‑px‑Dach bleibt), `Sound(700)` je Spalte; Stopp am Tal. Direkt‑Blast **B=5**.
- **Schutz (6):** kein Angriffseffekt.

**Terrain‑Nachrutschen (sub_625d) — läuft nach JEDEM Einschlag** über die Bounding‑Box
des Effekts (je Waffe getrackt und um ±B um den Einschlag erweitert): pro Spalte sinkt
die Oberfläche über gefressener Luft; dann wiederholte Sweeps — `top` wandert durch den
festen Block bis zur ersten Lücke, `bot` zum nächsten Boden darunter; solange eine Lücke
existiert, fällt **1 Pixel pro Sweep** (oberstes Bodenpixel der Spalte verschwindet, am
Lückenkopf erscheint eines — der Block sinkt), mit `Sound(500)`‑Puls pro bewegtem Pixel,
bis nichts mehr fällt. Dadurch stürzt z. B. das Dach über der Erdbeben‑Fissur ein und
Ausgrabungen der Eater sacken zu Kratern zusammen. Der Port simuliert den Kollaps beim
Einschlag vor und spielt ihn als Fortsetzung der Effekt‑Animation ab (Panzer‑Nachrutschen
+ Fallschaden folgen wie gehabt beim Abschluss).

**Farbe des entfernten Terrains (keine echte Abweichung):** Das Original zeichnet Himmel,
Krater, Tunnel usw. in Pixelwert **0**. Der BGI‑Treiber bildet per `SetBkColor` die Anzeige
von Pixelwert 0 auf die Hintergrundfarbe (Himmel) ab und `ClearDevice` füllt das Spielfeld
mit 0 — der Himmel *ist* also Pixelwert 0, angezeigt als Himmelblau. Die Kollision
(`sub_b560`) behandelt Pixelwert 0 und 15 (Spur) als durchlässig; Geschosse fliegen durch
Himmel und Krater. Der Port nutzt intern einen anderen Index für „Himmel/entfernt", zeigt
aber dasselbe Himmelblau und dieselbe durchlässige Kollision → **optisch und im Verhalten
identisch**.

**Scoring:** Pro getötetem gegnerischen Mann **50 Punkte + $50** an den Schützen (⇒ 5000 je
100‑Mann‑Panzer). Rundenende‑Pot: jeder Überlebende erhält `(Spieler−Überlebende)·1000 /
Überlebende` auf Punkte **und** Geld. 1 Punkt = $1. Sieg‑Zähler +1, wenn genau ein
Überlebender. Munition −1 je Schuss; leer ⇒ nächste vorhandene Waffe.

**Schutzsysteme** sind Inventar‑Bestände der Waffen 11/12/13 und wirken **pro Runde**
(am Rundenende je 1 verbraucht). Fallschirm 100 % gegen Fall, Quake 100 % gegen Erdbeben,
Shield reduziert Direktschaden auf `B/D` statt `80·B/D` (Faktor 1/80 ≈ 98,75 % — im Code
steht **kein** literaler „95 %"‑Wert; das Handbuch rundet.).

---

## 5. Computer‑KI (Regeln §5)

**Kein iteratives Probeschießen** — die KI **invertiert die Ballistik analytisch**
([`js/ai.js`](html5-port/js/ai.js)):
- Parabolisch (Ballisto/Jack): fester Winkel 45°/135°,
  `power = round( 333.333 · √( 0.0011 · dX² / (dX+dY) ) )` (333.333 = 1/0.003 = 1/C,
  0.0011 = Gravitation — exakte Umkehrung der Engine).
- Direktfeuer (Terminator‑Superwaffen): `Winkel = round( arctan(dHöhe/dX) · 180/π )`, max Power.

**Fehlerrate** (Default 10 %, Menü 0..100): multiplikativer Zufallsfehler auf die Distanz
`1 + ((rate+1)/100)·(2·RandomR−1)` (≈ ±(rate+1) %), **nach jedem Schuss halbiert** (÷2).

**5 Persönlichkeiten:** Berti (rein zufällig, hält Waffe ~20 %), Klaus (zufällig, ~50 %),
Jack (bevorzugt Ping‑Pong; ballistisch aber absichtlich ungenauer, ×3‑Fehler),
Ballisto (präzise Ballistik), Terminator (Superwaffen‑bewusst, sonst max Power + Richtung).
**20‑Schuss‑Interrupt:** nach 20 Schüssen bricht das Spiel ab. **Esc/Aufgeben** setzt ein
Abbruch‑Flag ⇒ kein Sieger (das Original hat gar keinen „Winner"‑String).

---

## 6. Sound (PC‑Speaker → WebAudio)

Rechteckwelle. `Sound(Hz)`/`NoSound`/`Delay(ms)` → Oszillator/Gain/Zeitplanung in
[`js/pcspeaker.js`](html5-port/js/pcspeaker.js); alle Effekte als exakte (Hz,ms)‑Rezepte in
[`js/sounds.js`](html5-port/js/sounds.js). Alle **27 `Sound`‑Aufrufstellen** wurden dekodiert.
Beispiele (aus dem Code): Abschuss‑Sweep 1000→400 Hz (Schritt 8, 1 ms/Schritt), Flug‑Pfeifen
`400 + round(y/4)` Hz (nur bei „Flight SoundFX"), Einschlag 400→100, Explosion 300→600→300 +
Boom‑Sweep 900→200, Blast‑Kreis `200 + 2·r`, Menü‑Blips 300–500 Hz, Options‑Werte kodieren
ihren Wert in der Tonhöhe. Gate: „SoundFX" schaltet fast alles, „Flight SoundFX" nur das
Flug‑Pfeifen. **Kein separates Melodie‑Easter‑Egg** — die „Musik" des Handbuchs ist die
Schuss→Flug→Explosion‑Sequenz selbst (im Code verifiziert: keine Notentabelle vorhanden).

---

## 7. Optionen / Ablauf (Regeln §6)

Menü‑Defaults (init 0x2004–0x2051): SoundFX=an, Flight SoundFX=aus, Reflecting Walls=RND
(0=No/1=RND/2=Yes), Show Trace=an, Use Mouse=an, Computer Error Rate=10 % (0..100),
Money from Start=0 (0..100000, Schritt 1000), Games per Match=10 (1..50), Number of
Players=2 (2..10). Ablauf: Hauptmenü → „The names please" (Mensch/Computer + Name /
Computer‑Typ; **erst Mensch/Computer, dann Name**) → **Fallschirm‑Einflug** der Panzer →
Runden (Zielen → Flug → Einschlag → Nachrutschen) → Shop zwischen den Spielen → Rankings
(sortiert nach Wins, dann Points). Kommandozeile (Original): `D` Demo (10 Computer, 2 je
Typ), `Fx` Fehlerrate x %, `M` Maus aus, `?` Syntax.

**Kauf‑Menü (sub_9d62, gegen echte Original‑Screenshots verifiziert):** Erscheint **vor jedem
Spiel je menschlichem Spieler** (Computer und mittellose Spieler ohne Verkaufbares werden
übersprungen). 3‑Spalten‑Layout wie im Original: oben eine **Statuszeile** (Name, Men/Wins/
Points/Dollar, aktuelles Inventar der 10 Angriffswaffen in 2 Spalten); links eine **Waffenliste**
aller 13 Items `"<Los> <Name>………"` (obere Box = 10 Angriffs‑, untere = 3 Schutzwaffen); Mitte
**„Buy these"** mit 13 Preis‑Knöpfen `"<Preis> $"` (leer, wenn Preis > Geld); rechts **„For Sale"**
mit `"<Preis/2> $"` (leer, wenn Inventar < Los). Rote Kopfzeilen „You have N $ ( M Games to go )"
und „Go to next Window using [Tab].". **Fertig = Klick auf die rote Leiste „Start the N. Game,
<Name> !"** unten. Bedienung per Maus (Klick auf Knopf kauft/verkauft) oder Tastatur (Tab
wechselt Spalte, ↑↓ Zeile, Enter kauft/verkauft, Esc fertig). Kauf: Inventar +Los / Geld −Preis;
Verkauf: Inventar −Los / Geld +Preis/2.

---

## 8. Projektstruktur des Ports

```
html5-port/
├── index.html         Canvas + Start‑Overlay
├── package.json       ("type":"module" — für Tests/ESM)
└── js/
    ├── rtl.js         TP7‑Zufallsgenerator (LCG ×0x08088405+1)
    ├── pcspeaker.js   PC‑Speaker‑Emulation (WebAudio, Rechteck)
    ├── sounds.js      alle Soundeffekt‑Rezepte (Hz/ms)
    ├── vga.js         640×480×16 BGI‑Framebuffer + Primitive
    ├── palette.js     exakte 16‑Farben‑Palette (Menü/Spiel)
    ├── font8x8.js     originalgetreue 8×8‑Bitmapschrift
    ├── terrain.js     Terrain‑Erzeugung & ‑Zerstörung
    ├── tank.js        Rumpf + Rohr + Fallschirm, Helligkeit
    ├── physics.js     Ballistik‑Integration + Wind
    ├── weapons.js     Waffentabelle + Effekte + Schaden
    ├── ai.js          KI (ballistische Inversion, 5 Typen)
    ├── hud.js         Statuszeile + 3D‑Rahmen
    ├── markdown.js    kleiner Markdown→HTML‑Renderer (für den Doku‑Viewer)
    ├── doctext.js     diese Doku als String (vom Build eingebettet)
    ├── game.js        Simulations‑Engine (Runde/Feuern/Scoring)
    └── main.js        Frontend: Zustandsmaschine, Input, Maus, Loop, Doku‑Viewer
```

Auf der Startseite öffnet der Button **„📖 Dokumentation anzeigen"** diesen Text direkt im
Browser (eingebettet, funktioniert auch offline per `file://`).

## 9. Steuerung

**Tastatur:** ← → Winkel · ↑ ↓ Power ±1 · Bild↑/Bild↓ Power ±100 · Pos1 Power=max ·
Ende Power=250 · Tab nächste Waffe · Enter Feuern · Leertaste Spielstatus · F1 Hilfe ·
Esc Aufgeben.

**Maus:** Menü/Namen/Shop per Klick bedienbar (Linksklick wählt/ändert, Rechtsklick im
Menü ändert rückwärts). Im Spiel: Linksklick ins Feld richtet das Rohr zum Klickpunkt und
feuert, Rechtsklick richtet nur.

**Abprallen an den Rändern** ist an die Option **„Reflecting Walls"** gekoppelt (Default
**RND** = pro Spiel zufällig an/aus; aktiv erkennbar am roten **„R"** rechts in der
Statuszeile). Ist es aktiv, prallt das Geschoss elastisch an oben/links/rechts ab — genau
wie im Original (Code: gated über `[0xCF7]`).

## 10. Bewusste Abweichungen / offene Punkte

- **Timing:** Flug (487 Schritte/s) und Fallschirm (58 px/s) sind **direkt am Original in
  DOSBox gemessen** und werden im Port zeitbasiert (refresh‑unabhängig) reproduziert. Der
  Original‑Busy‑Wait ist leicht cycles‑abhängig; die Raten sind als Stellschrauben in
  `game.js` ausgelegt.
**Inzwischen 1:1 dekompiliert** (früher genähert): Earthquake (sub_3511/2f9a/2c0d),
CR‑Inducer/Julia‑Fraktal (sub_2307, Produktionsregeln aus dem Code extrahiert), Ping‑Pong
(sub_371d), Caveman (sub_3bb7), Terrain‑Nachrutschen (sub_625d), Terrain‑Erzeugung
(sub_5e3f), **Panzer‑Todesanimation (sub_6895)**, sowie die komplette Bitmap‑Schrift.

**Panzer‑Todesanimation (sub_6895) — 1:1:** Beim Zerstören wird der Panzer gezeichnet und
sein Paletten‑Index dann durchzyklt: Phase A Grau **0→60** (6‑Bit) mit steigendem Ton
**300+20·i** (i=0..15), kurzes Halten auf Weiß, Phase B **60→0**, Phase C Rampe **schwarz→
Himmelfarbe** (16,51,60 ≈ Sky) + abschließender Ton‑Sweep 900→200 Hz; danach wird der Panzer
gelöscht und die Palette auf die echte Spielerfarbe zurückgesetzt. Mehrere Tote flashen
nacheinander. Umgesetzt als `stepAnim`‑Kind `'death'` (wall‑clock, ~0,8 s je Panzer).

**Noch nicht bit‑/pixelgetreu (bewusste Rest‑Abweichungen):**
- **Zufalls‑Seed:** Der Port nutzt den **exakten Turbo‑Pascal‑7‑Generator**
  (`RandSeed := RandSeed·134775813+1`, `Random(N)=(RandSeed·N) shr 32`,
  `Random`‑Real = `RandSeed/2³²`; verifiziert in [`js/rtl.js`](html5-port/js/rtl.js)) — der
  Algorithmus ist also identisch. Nur der **Seed** ist wie im Original zeitbasiert
  (`Randomize`), daher sind konkrete Folgen (Terrainform, Wind, Zufallsschützen,
  CR‑Fraktal‑Streuung) **nicht reproduzierbar** — beim Original ebenso wenig, da es ohnehin je
  Effekt neu `Randomize`t.
- **Ergebnis‑/Ranglisten‑Screen & Hilfe/Intro:** die **Logik** ist belegt (Rundenpott
  `(Spieler−Überlebende)·1000/Überlebende` an jeden Überlebenden auf Punkte+Geld,
  Sieg‑Zähler; Sortierung nach Wins/Punkten); **Layout** ist aus Screenshots/Specs
  nachgebaut, nicht Feld‑für‑Feld gegen den Code verifiziert (rein kosmetische
  Zwischenbild‑Screens).
- **Maus‑Steuerung/Menü‑Glide:** Das Original nutzt ein Klick‑Region‑/`MouseGlideTo`‑Framework;
  der Port ist Tastatur‑fokussiert (mit nachgebautem Cursor‑Sprung bei Auswahl, s. Namens‑
  Screen). Funktional gleichwertig, aber nicht dasselbe interne Framework.
- **Menü/Shop‑Blip‑Sounds:** Kern‑Frequenzen gegen den Code verifiziert (Menü‑Move/Namen/Shop
  = **400 Hz** `[0x190]`, Waffenwechsel **300**, Effekt‑Töne 500/700/1000); einzelne
  Detail‑Blips sind stilgleiche Rezepte.

Alle Kern‑Werte (Palette, Physik‑Konstanten, Waffen‑Algorithmen & ‑Parameter,
Schadens‑/Scoring‑Formeln, Sound‑Frequenzen, KI‑Mathematik, Timing) sind **direkt aus dem
Maschinencode** belegt; die Detail‑Spezifikationen mit Adressnachweisen liegen als
`spec_*.md` im Analyse‑Arbeitsverzeichnis.
```

---

## 11. Sub‑Call‑Portierungsstatus (Prüfprotokoll)

Vollständige Zuordnung **Original‑Routine → Port‑Ort → Status**. „1:1" = aus dem
Maschinencode dekompiliert und (Node/headless) verifiziert; „≈" = Verhalten/Formel belegt,
Detail (Muster/Layout/Seed) prinzipbedingt genähert; „—" = bewusst nicht portiert.
Geprüft wurde u. a. durch einen **Schleifen‑Audit** (alle Rücksprünge je Routine gezählt),
nachdem beim Ping‑Pong eine zweite Schleife übersehen worden war.

### Physik / Flug / Kollision
| Original | Zweck | Port | Status |
|---|---|---|---|
| `sub_bd08` | Schuss abfeuern (VX0/VY0 aus Winkel·Power) + Flug‑Orchestrierung | `game.js fire/stepFlight` | 1:1 |
| `sub_b785` | Flug‑Einzelschritt (Euler dt=1, Wind, Zeichnen) | `physics.js step` | 1:1 |
| `sub_b560` | Kollision (Pixel durchlässig 0/15) | `physics.js impactAt` | 1:1 |
| `sub_0a3a` | Busy‑Wait (Faktor 2.0/Schritt) = Flugtempo | `game.js` wall‑clock (487 Schr./s, gemessen) | 1:1‑äquiv. |

### Waffen‑Effekte
| Original | Zweck | Port | Status |
|---|---|---|---|
| `sub_b044` (Aufrufer 0xbfe7) | Krater + **Weiß‑Blitz** (Palette 12 sky→weiß→sky) | `game.js stepAnim 'crater'` | 1:1 |
| Blast‑Loop `0xc8ca` | Direktschaden `80·B/D` (Schild `B/D`) | `weapons.js applyBlastDamage` | 1:1 |
| `sub_3511/2f9a/2c0d` | Earthquake (Keil‑Fissur, ±45°‑Zweige, 2×2) | `weapons.js effectEarthquake` | 1:1 |
| `sub_371d` | Ping‑Pong (**2 Schleifen**: Abstieg + Zurückbouncen) | `weapons.js effectPingPong` | 1:1 |
| `sub_2307/2b8c` | CR‑Inducer/Julia (8‑Richtungs‑Fraktal, Regeln extrahiert) | `weapons.js effectEater` | 1:1 (Seed ≈) |
| `sub_3bb7/3b4d/3b7f` | Caveman (**3 Phasen**: Anlauf/Skip/Bohren, 9‑px‑Dach) | `weapons.js effectCaveman` | 1:1 |
| `sub_625d` | Terrain‑Nachrutschen (Spalten sinken pixelweise) | `weapons.js simulateCollapse` | 1:1 |

### Panzer: Fall, Tod, Schutz
| Original | Zweck | Port | Status |
|---|---|---|---|
| `sub_6d3c` | Fall **animiert** + Fallschaden (`fall÷2`, `>2·Crew→0`), **stumm** (kein `Sound`‑Befehl) | `game.js stepAnim 'fall'` | 1:1 |
| `sub_6cbd` | Support‑Test Mitte (X−2..X+2) | `game.js centreSupp` | 1:1 |
| `sub_6b84` | Support‑Test Grundfläche (X−6..X+6) | `game.js footSupp` | 1:1 |
| `sub_6b0c`/`sub_6a93` | Support links/rechts → **seitliches Rutschen** | `game.js leftBlk/rightBlk` | 1:1 |
| `sub_7060` | Treiber: Rundenstart‑Einflug **und** Fall (+Fallschirm‑Gate 0x70ba ⇒ Fall‑Flag=0 = kein Schaden) | `game.js stepRoundIntro` + `stepAnim 'fall'` | 1:1 |
| `sub_6895` | Panzer‑Todesanimation (Palettenblitz) | `game.js stepAnim 'death'` | 1:1 |
| `sub_02d4` | Fallschirm? `inv[11]>0` | `player.hasParachute` | 1:1 |
| `sub_0303` | Schild? `inv[13]>0` | `player.hasShield` | 1:1 |
| `sub_0332` | Quake‑Schutz? `inv[12]>0` | `player.hasQuake` | 1:1 |
| `sub_01bc` | tot? `crew==0` | `!t.alive` | 1:1 |

### Welt / RTL / KI / Sound
| Original | Zweck | Port | Status |
|---|---|---|---|
| `sub_5e3f` | Terrain‑Erzeugung (Random‑Walk, θ‑Clamp ±1.2→±1.0) | `terrain.js generateTerrain` | 1:1 (Seed ≈) |
| `Random/RandomN/RandomR` | TP7‑LCG | `rtl.js TPRandom` | 1:1 (Seed zeitbasiert) |
| BGI‑DefaultFont | 8×8‑Bitmapschrift | `font8x8.js` | 1:1 (extrahiert) |
| `Frame3D`, `OutTextXY` | 3D‑Rahmen, Text (+Emboss) | `hud.js`, `vga.js outText/embText` | 1:1 |
| `sub_d2c8` | KI Parabel‑Lob: 45/135, `power=min(10·crew, round(333.333·√(0.0011·dXe²/(dXe+Δy+11))))`, `dXe=|f·(|Δx|−11)|` | `ai.js solveParabolic` | 1:1 |
| `sub_d61a` | KI Direktschuss: `K=f·Δx`, `angle=round(atan((Sy−Ty)/K)·57.2958)` bzw. `180−…` | `ai.js solveDirect` | 1:1 |
| `sub_d17a` | KI Jack‑PP‑Lob: wie Parabel, aber Nenner `dXe+(491−Sy)` (zum Feldboden), Fehler `P/2`, Waffe 5 | `ai.js solveJack` | 1:1 |
| `sub_d48a` | KI Reflexions‑Aim: `angle=round(atan((Ty+Sy−126)/K)·57.2958)` bzw. `180−…` | `ai.js solveReflect` | 1:1 |
| `sub_0361` | Fehler‑Jitter `f=(100−arg+2·arg·RandomR)/100` (arg = `P+1` / `P/2` / `2P+1`) | `ai.js errFactor` | 1:1 |
| Fehler‑Zerfall `0xd0d0` | `P=[0x176e]` startet = Rate (10), halbiert **pro voller Zug‑Rotation** | `game.js nextPlayer` | 1:1 |
| `sub_086e`/`sub_0467` | KI‑Zielwahl min‑Y‑ungeschützt (Jack) / meiste Siege (Ballisto, Slot) | `ai.js pickLowestUnprotected/pickMostWinsSlot` | 1:1 |
| `sub_0530`/`sub_071a`/`sub_07c4` | Sichtlinie über Terrain / Höhensummen vor+zurück | `ai.js hasLineOfSight/heightSum` | 1:1 |
| `[0x1161]` (`sub_da0c` 0xda43) | Zug‑Reihenfolge = Zufallspermutation (Rejection‑Sampling) | `game.js startRound` (`this.order`) | 1:1 |
| `[0x1774]`‑Ziel‑Walk + Default‑Zweig `0xe683` | Persistenter Slot‑Zeiger; Default: Höhensumme→Super‑Waffen‑Horizontal‑Blast / LOS‑Walk→Direktschuss / kein‑LOS+Reflexion→d48a / kein‑LOS→Blind‑Lob | `ai.js computeMove` (`this.turnSlot`) | 1:1 |
| `sub_d7d8`/`sub_d8f4` | Winkel‑ (`>180→0/<0→180`) & Power‑Klemme (`0..10·crew`) + Töne (`500−|90−a|`, `power+100`) | `main.js wrapAngle/clampPow`, `sounds.js` | 1:1 |
| `sub_0273`/`sub_0225` + `[0x1776]` | Rundenende: ≤1 lebt **oder** kein Lebender bewaffnet **oder** > 20 Zug‑Rotationen | `game.js roundOver` | 1:1 |
| `sub_da0c` (Wind) | `Wind = round(1000·(2·RandomR−1)^5)`, ruhe‑gewichtet | `physics.js generateWind` | 1:1 |
| `sub_da0c` (Reflexion) | Pro Runde: `[0xcf6]` NO/RND/JA → `[0xcf7]` (RND: `RandomN(20)` ungerade) | `game.js` reflectActive | 1:1 |
| `sub_1ff5`/`sub_7801` | Waffen‑/Shop‑Katalog (Preis/Menge/Radius/Typ), Startwerte (crew 100, Winkel 45, 20 Granaten) | `weapons.js WEAPON_TABLE`, `game.js resetPlayersForGame` | 1:1 |
| `sub_9d62` (Mensch) | Shop: Kauf (`+Menge`, `−Preis`), Verkauf (`−Menge`, `+Preis÷2`) | `main.js shopBuy/shopSell` | 1:1 |
| `sub_9d62` (CPU) + `sub_9b05` | CPU kauft zwischen Runden personality‑basiert nach (5 Brains, bezahlbare Liste w=1..13) | `game.js cpuShop/_cpuShopDecide` | 1:1 |
| `sub_5a48`, `Sound/NoSound` | Sweeps + Effekt‑Töne | `sounds.js`, `pcspeaker.js` | 1:1 |
| Rundenpott/Scoring | `(Spieler−Überlebende)·1000/Überlebende`, 50 Pkt/Mann | `game.js endRoundScoring` | 1:1 |

### Fall‑Animation & Ereignis‑Reihenfolge — jetzt 1:1
Der Panzer‑Fall wird jetzt als eigene Animations‑Phase **sichtbar** abgespielt (pixelweiser
Fall mit seitlichem Rutschen; der Panzer dunkelt beim Crew‑Verlust fortlaufend ab, weil
`sub_6d3c` die Crew jeden Schritt neu berechnet und den Rumpf neu zeichnet). **Wichtige
Korrektur:** `sub_6d3c` enthält **keinen** `Sound`‑Befehl — der Gameplay‑Fall ist im
Original **stumm**; auch der Treiber `sub_7060` überspringt im Settle‑Modus (Flag=1, @0xcb68)
den Score‑Sweep‑Ton. Der 700‑Hz‑Ton (`0x2bc`) in dieser Code‑Region gehört **nicht** zum
Fall, sondern zur **Caveman‑Bohrphase** (`sub_3bb7` @0x3c4c) und ist dort bereits 1:1
portiert. (Die frühere Annahme einer „Tank‑fällt‑in‑Krater"‑Routine beruhte auf einer
Fehlbeschriftung: `sub_3b7f` ist bloß der ±1‑x‑Vorschub‑Helfer des Caveman, und
`GetPixel==0xD` prüft **Boden** — Farbindex 13 —, keinen fallenden Panzer.)

Die **Ereignis‑Reihenfolge** folgt jetzt exakt dem Impact‑Handler (`0xca..0xcb72`):
**Blast‑Schaden → Tod‑Blitz (pro Panzer sofort bei Crew≤0, `sub_6895` @0xcafa) →
Terrain‑Kollaps (`sub_625d` @0xcb65) → Fall/Settle (`sub_7060`→`sub_6d3c` @0xcb72) →
Fall‑Tod‑Blitz** (`sub_6d3c` ruft `sub_6895` @0x6f08/0x6fe1 für tödliche Stürze).
Umgesetzt als Phasen‑Queue in `resolveImpact` (baut `this.phases`) + `stepAnim`
(arbeitet sie ab). Damage wird bei aktivem Fallschirm übersprungen (`sub_02d4` ⇒
`sub_7060` übergibt Flag 0), der Panzer settled aber trotzdem.

Der Fall läuft **sequentiell** wie im Original: `sub_7060` ruft `sub_6d3c` Panzer für
Panzer; jeder fällt komplett, und ein **tödlicher Fall blitzt (`sub_6895`) sofort**, bevor
der nächste Panzer fällt. Der Port bildet das exakt ab — die Fall‑Phase behandelt einen
Panzer nach dem anderen und schiebt bei einem tödlichen Sturz die Death‑Blitz‑Phase
**vor** die Fortsetzung der restlichen Fälle (nie überlappend, verifiziert:
max. 1 gleichzeitig sterbender Panzer). Die Panzer‑Reihenfolge (Original: Array `0x1161`)
ist für das Ergebnis irrelevant, da der Fall kein Terrain verändert.

### Vollständiges Routinen‑Audit (Stand jetzt)
Alle **101 spieleigenen Routinen** der Disassembly wurden klassifiziert (die 108
Far‑Calls sind Standard‑TP7‑Bibliothek: `Round`, `Line`, `Sound`, `OutTextXY`,
`PutPixel`, `RandomN` … — keine versteckte Spiellogik, komplett durch die Port‑Primitive
in `vga.js`/`pcspeaker.js`/`rtl.js` abgedeckt). Ergebnis: **alle gameplay‑relevanten
Routinen (Physik, Kollision, Wind, Waffen, Terrain, Kollaps, Fall, Tod, Schutz, Schaden,
Winkel/Power‑Klemmen, Rundenende, Scoring, Shop‑Mensch, Startwerte, Waffen­katalog) sind
1:1 portiert** — es sind **keine** gameplay‑relevanten Abweichungen mehr offen.

**Inzwischen zusätzlich auf 1:1 gebracht** (zuvor `—`/`≈`):
- **Fall‑Animation & Ereignis‑Reihenfolge** (voriger Abschnitt).
- **CPU‑Shopping** (`game.js cpuShop`): „AI‑Stat" `[+0x1a]` als `inventory[2]` (5‑kT‑Nuke‑Anzahl)
  entschlüsselt; alle 5 Brains inkl. bezahlbarer Liste, Kategorie‑Präferenzen und
  Kauf‑Wahrscheinlichkeiten (50 %/70 %) exakt nachgebaut.
- **KI‑Zielen** (`ai.js`): alle vier Brains (`d2c8/d61a/d17a/d48a`), der Fehler‑Jitter
  (`sub_0361`, arg `P+1` normal / `P/2` Jack‑PP / `3P` Jack‑ohne‑PP) und der Fehler‑Zerfall
  (pro Zug‑Rotation halbiert, nicht pro Schuss) — gegen handberechnete Sollwerte verifiziert.
- **KI‑Zielwahl** (`ai.js`): Zufalls‑Zugreihenfolge (`[0x1161]`), persistenter Slot‑Zeiger
  (`[0x1774]`), Ziel‑Random‑Walks je Personality, Sichtlinien‑Test (`sub_0530`),
  Höhensummen (`sub_071a/07c4`) und der komplette 4‑Wege‑Default‑Zweig
  (Super‑Waffen‑Horizontal‑Blast / LOS‑Direktschuss / Reflexions‑Aim / Blind‑Lob).
- **20‑Zug‑Rotations‑Limit** (`roundOver()` via `roundCycles > 20`).

### Code‑Review (Zweit‑Durchgang) — gefundene & behobene Abweichungen
Ein adversariales Gegenlesen (Port ↔ Disassembly) fand mehrere subtile Fehler in den
zuletzt portierten Routinen, alle inzwischen **behoben** und gegen die Bytes verifiziert:
- **LOS‑Test** (`sub_0530`): Endbedingung war `|A.y−curY|<5` (traf fast nie) → korrekt
  `(A.y−B.y)<5` (Ziel nicht deutlich unter dem Schützen). Betraf den Terminator‑Direktschuss.
- **Jack ohne Ping‑Pong**: Fehler‑Multiplikator war `×2` → korrekt **`×3`** (`0xe5b3`).
- **`sub_d61a`‑Waffe**: hielt die aktuelle Waffe → korrekt Waffe 2, Abwärts‑Scan **ohne** Wrap (`0xd7a4`).
- **Blind‑Lob‑Power**: war deterministisch → korrekt `min(10·crew, max(50, RandomN(min(10·crew, Wand/2))))`.
- **Berti/Klaus**: Waffen‑Zyklus (zufällige besessene Waffe, Stopp 20 %/50 %) fehlte → ergänzt.
- **`sub_0467`‑Tiebreak**: `>` (erster) → `>=` (letzter Treffer bei Punktegleichstand).
- **Fehler‑Zerfall/Zug‑Limit**: waren an Gesamt‑Spielerzahl gekoppelt → korrekt an die
  **Zug‑Rotation** (halbiert/zählt einmal je voller Runde lebender+bewaffneter Panzer).
- **Zug‑Advance**: übersprang nur tote → korrekt **tot ODER unbewaffnet** (`sub_0225`, `0xd10c`).
- **Fall‑Slide**: `rightBlk` wurde am schon verschobenen X getestet → beide Kanten am Original‑X (`0x6dd4`).
- **Fall‑Gutschrift**: Sturz‑Opfer wurden dem Schützen **nicht** gutgeschrieben → jetzt `+50 Pkt/$` je
  gefallenem Mann (`[0x1692]` @0x7020).
- **Treffer‑Kriterium**: „unten angekommen" galt als Fehlschuss → Fehlschuss nur bei finaler
  **X ∉ [4,635]**; Einschlag in einen Schacht detoniert am Boden (`0xbf4c`).
- **Rundenzähler‑Init**: `[0x1776]` startet mit **1** (Limit endet nach 20 statt 21 Rotationen).

Falsch‑Alarm des Reviews (geprüft, **kein** Fehler): der Earthquake‑Fissur‑Schritt ist **nicht**
X↔Y‑vertauscht — bis zum Pixel‑Zugriff in `sub_2c0d` verfolgt: `X += Cos·0.7, Y += Sin·0.7`
(die Disassembly‑Annotation vertauscht `Sin`/`Cos`, der Port ist korrekt).

Damit sind alle **101** spieleigenen Routinen mit Spiellogik 1:1 portiert.

Die zuvor als „bewusste Mini‑Abweichungen" gelisteten drei Punkte sind inzwischen **ebenfalls
1:1 angeglichen**: (a) `sub_d2c8` wählt bei Nenner ≤ 0 nun Waffe 3 statt 2 (`giveUp`‑Pfad);
(b) das letzte Terrain‑Segment ganz rechts ist jetzt **geneigt** (ein weiterer Turtle‑Schritt,
`sub_5e3f`); (c) die Support‑Tests werten nun **jedes Nicht‑Himmel‑Pixel** als Halt (Boden
**oder anderer lebender Panzer**, `tankOccupies`) — ein Panzer kann jetzt **auf einem anderen
Panzer landen** (`sub_6cbd` liest `GetPixel != 0`; der fallende Panzer selbst ist ausgenommen).
Nicht 1:1 bleiben nur kosmetische/UX‑Aspekte (unten).

### Zweiter Umsetzungs-Durchgang (Vollständigkeits-/Kosmetik-Review) — umgesetzt
Nach dem Vollständigkeits-/Kosmetik-Review wurden zusätzlich **1:1 nachgebaut**:
- **Panzer-Dekorationen** (`sub_44a6`): weiße Kapitulationsflagge + schwarzes Rohr bei
  Munitionslosigkeit (windabhängig geneigt), Schild-Blase (Ring r=12 um (X,Y-5)),
  Quake-Punktband — `tank.js`.
- **Arsenal-Leiste** (`sub_4eae`): 10-Waffen-Auswahlstreifen (nur besessene, aktuelle
  hervorgehoben) mit **Maus-Waffenwahl** + „No Mun no Fun !" — `hud.js`, `main.js onAimClick`.
- **Spieler-Status per Zifferntaste 1–0** (`sub_3d21`) und die faithful **„View Game
  Status"**-Anzeige (`sub_907f`: Game N of M / Attempt / Error Rate, Zug-Reihenfolge, tote
  durchgestrichen) — `main.js`.
- **Highscores „The Lucky Shots"** (`sub_96f4`) mit **`localStorage`-Persistenz**,
  'L'-Taste (in-game) und Post-Match-Anzeige — `main.js`.
- **Rangliste nach jeder Runde** (`sub_abdc`): „Rankings after N of M Games", Trosttext,
  Scale-1-Spalten, 3 Rahmen — `main.js`.
- **Audio-Korrekturen:** Rundenstart-Töne an den Rundenstart verlegt (Chirp 400→700 + je
  Panzer aufsteigend `100+5·i` bzw. `800→1500`, `sub_7060`); kein erfundener
  End-of-Round-Tally mehr; Krater ohne Boom; Death-Boom Schritt 2; `buyConfirm` 500→400;
  Groß-Schritt-Töne (Bild↑/↓/Pos1/Ende, W/I); Flug-Ton nur an Flug-Option gegated.
- **Quit-Default** invertiert (Enter bricht ab, sichere Option; nur `y`/`j` bestätigt).
- **Fallschirm-Geometrie** exakt (`sub_4291`).

### Vierter Durchgang (automatisierte Faithfulness-Audits) — `html5-port/tools/`
Nachdem manuelle Code-Reviews mehrere Klassen von Abweichungen übersehen hatten, wurde eine
**automatisierte Audit-Suite** gebaut (`tools/audit.sh`, Details in `tools/README.md`), die
den Port differenziell gegen das **Original** (EXE-Image + Disassembly) prüft:
1. **`audit_strings.py`** — jeder EXE-String gegen den Port + Font-Zeichenabdeckung. → fand
   fehlende Glyphen `= @ #` (ergänzt); Baseline jetzt sauber.
2. **`audit_input.py`** — alle Cursor-/Klick-Region-Aufrufe (`MouseGlideTo`/`SetRange`/…)
   mit Koordinaten + der In-Game-Tasten-Dispatch (DOS-Codes → Browser-Taste). → fand
   fehlende **Ins/Del = Winkel ±45°** (`min(180,a+45)`/`max(0,a-45)`, ergänzt).
3. **`invariants.mjs`** — spielt viele geseedete Rein-CPU-Matches headless durch und prüft
   Wertgrenzen, Rundenterminierung, Crashes, **RNG-Varianz** und **Arsenal-Persistenz**
   (deterministische Regression, feuert nachweislich beim alten Reset-Bug). → 0 Verletzungen.
4. **`pixel_diff.py`** (+ `capture_dosbox.sh`) — Golden-Master: rendert jeden Screen headless
   und difft gegen DOSBox-Referenzen (native 640×480 via Nearest-Neighbor). → fand die
   fehlende **weiße Schrift des selektierten Menüpunkts** (`[0x177e]=6`), das Status-Format
   **`Error Rate 10.0 %`** (`Str(:4:1)`) + Header-Feldbreiten `Str(:2)`, sowie Shop-Paddings
   (money `:6`, Preise `:7`) und die „Buy these/For Sale"-Höhe (y=75).
5. **`audit_font.py`** — die EXE-eigene 8×8-Buchstabentabelle (bei 0x1067b, `A-Z [ ] _ a-z`)
   byte-für-byte gegen `font8x8.js`: **55/55 identisch**. Ziffern/Interpunktion liegen nicht
   als Klartext-Bitmaps in der EXE (BGI-Treiber-Stream) und sind über die Pixel-Goldens
   end-to-end validiert.
6. **`audit_sounds.py`** — das komplette Sound-Inventar des Originals (27 `Sound()`-Sites +
   11 Sweep-Aufrufer, byte-extrahiert mit Frequenz-Formeln und Delays) als 29 Checks gegen
   die Port-Quellen. → fand & fixte: **Flug-Pfeifton folgt `vy/4`** (quasi konstant 400 Hz,
   NoSound ≤ −1200; vorher fälschlich höhenabhängig), **Winkel/Power-Töne 150 ms**
   (`sub_0a3a(30)`; vorher 8 ms), **Miss-Ton 300 ms** (`sub_0aa1(30)`), **Death-Flash-Leiter**
   (Rampen in 5-ms-Einheiten, 500 ms Weiß-Halt, Staccato-Abstieg), **Ring-Pacing** (16 ms/Ring
   nur bei Radius < 50). Zusätzlich WebAudio-Robustheit: das Effekt-Ende ist allein
   audio-clock-geplant; der `setTimeout`-Fallback bekam +80 ms Marge (vorher schnitt
   Timer/Audio-Clock-Drift kurze Sweeps plattformabhängig ab — Firefox Win vs. Linux).

**Maus-Cursor (relatives Tracking):** Das Original verschiebt bei `MouseGlideTo`/
`MouseToMenuItem` den echten Maustreiber-Cursor mit; im Browser ist das unmöglich. Absolutes
Tracking ließ den In-Game-Cursor nach einem Auto-Warp (Spielerauswahl etc.) beim ersten
Move zur unabhängigen Systemcursor-Position **springen**. Behoben: Menü/Names/Shop **und**
das Ziel-Panel tracken jetzt **relative Bewegung** (`movementX/Y`), auf den Bildschirm
geklemmt; Klicks wirken an der **Software-Cursor-Position**, nicht an der rohen OS-Position.

**„The Lucky Shots" — korrektes Timing (`sub_bd08`):** Die Hi-Score-Tabelle erscheint im
Original **NICHT nach jedem Match** (empirisch in DOSBox verifiziert), sondern **mitten im
Spiel bei einem wertungswürdigen Schuss**: bei Schussbeginn wird `[0x1692]=0` gesetzt,
während der Auflösung `+= getötete gegnerische Männer` (Direkt-/Ketten-/Fall-Kills, Selbst
ausgeschlossen, `0xcb0f/0xc322/0x7020`); danach **Score = 50·[0x1692]** (`0xcbb7`), und wenn
das die 10. Tabellenzeile schlägt (`0xcbc0`), wird der Eintrag (Schützenname + Score)
einsortiert und „The Lucky Shots" **sofort über der Spielszene** gezeigt (`0xccbe`), bis eine
Taste kommt; dann läuft der Zug weiter. Umgesetzt in `afterImpact`/`recordLuckyShot`; die
Nach-Match-Anzeige wurde entfernt (nach dem letzten Spiel → Hauptmenü). Der zugehörige
Ganzprogramm-Dialog „New Match, new Luck ?" (`sub_8ac5`) bleibt bewusst weggelassen.

**Flugbahn-Clipping:** Bei ausgeschalteten Reflecting Walls fliegt das Geschoss über die
Feldränder hinaus; der 2×2-Marker/die Spur wurde dabei auf den umgebenden 3D-Rahmen
gezeichnet. Behoben: jedes Marker-Pixel wird auf den Feld-Innenbereich (x 4–635, y 63–475)
geclippt (wie BGI innerhalb des Viewports zeichnet) — Draw und Erase teilen denselben Clip.

**Timing-Wurzelanalyse (Disassembly):** Das Original nutzt **drei Pacing-Klassen** —
(a) kalibrierte Busy-Waits `sub_0a3a(u)`, 1 u ≈ 5 ms Design (`37·[0x175c]−550` Leerschleifen,
`[0x175c]` = CalibrateSpeed/100, **pro Zug neu kalibriert**); (b) `WaitVerticalRetrace` =
exakt 60 Hz; (c) **gar keins** (CPU-gebunden). Daraus abgeleitet und im Port korrigiert:
**Flug = 2 u/Schritt → 100 Schritte/s** (statt 487) **plus Freilauf über dem Bildschirmrand**
(y<0 ohne Delay — das charakteristische „verschwindet oben, regnet schnell herab");
**Intro-Abstieg = 60 px/s** (Retrace). Wichtig: Terrain-Nachrutschen (`sub_625d`),
Erdbeben-Risse und der Post-Schuss-Fall sind im Original **ungetaktet** — ihre Geschwindigkeit
in DOSBox ist ein Artefakt der Cycles-Einstellung (20000), keine Design-Größe; der Port
wählt dafür bewusste Raten (dokumentierte Näherung).

### Dritter Umsetzungs-Durchgang (Pixel-Vergleich gegen DOSBox) — umgesetzt
Alle Haupt-Screens wurden **pixelgenau** gegen DOSBox-Captures des Originals verglichen
(Scan-Linien/Bounding-Boxen per Bildanalyse, Farben per Pixel-Sampling). Ergebnisse:

- **Zentrale Palette-Erkenntnis:** Im Original ist **Index 0 die Hintergrundfarbe**, nicht
  Schwarz (`[0x177b]=0`; das Spiel setzt per `SetRGBPalette` Index 0 auf Sky bzw. Menü-Blau).
  Jede „Fill 0"-Fläche (Status-/Hilfe-/Quit-Banner `sub_907f`/`sub_8f25`/`sub_8b7f`,
  Erase-Bars `sub_0c31` in Rankings/Shop/HUD) rendert daher als **Hintergrund**. Der Port
  behält Index 0 = Schwarz und füllt diese Flächen mit `COL.SKY` — pixel-verifiziert:
  In-Game-BG srgb(65,207,255), Menü-BG srgb(40,81,255).
- **Font:** fehlende CP437-Glyphen ergänzt (`, ' ( ) [ ] \ / ; < > ? | « » * + _`) — vorher
  Lücken im Text („Well, not bad…", „[Tab]", „( …key ! )").
- **Zufall:** `Randomize` beim Programmstart (zeitbasiert wie TP7). Vorher wurde der
  LCG mit festem Seed 0 gestartet → die erste Welt war immer identisch.
- **Waffen-Persistenz:** Das Arsenal wird nur **einmal pro Match** aufgebaut (`sub_7801`,
  20 HandGrenades); zwischen den Spielen bleibt jeder Kauf erhalten. Der Port hatte
  fälschlich vor jedem Spiel resettet → gekaufte Waffen „verschwanden".
- **Rankings** (`sub_abdc`) byte-exakt: Rang + 45 Leader-Punkte (weiß), Zellen via
  bg-Erase-Bar, Plural-s, Trosttext als **ein** String mit 20 eingebetteten Leerzeichen
  vor „( ...key ! )" (Offset 0xab98, Länge 67).
- **Shop** (`sub_9d62`/`sub_3d21`) 1:1: Name eigene Zeile (10,6) in Panzerfarbe, 4
  rechtsbündige Stat-Zeilen (x=25, `Str(:6)`, navy), Inventar 2×5 grau(15) mit
  Punkt-Leadern, Header rot mit Schatten, Spalten-Boxen (321/477..630), Buttons raised →
  gedrückt, Start-Balken (10,450)-(630,473).
- **Zweifarb-Hilfe** (`sub_8f25`): jede Zeile wird **zweimal** gezeichnet — weiß(15) die
  Tastennamen + `|`-Trenner, navy(14) die Beschreibungen (Leerzeichen transparent).
  Alle 8 Zeilen-Strings byte-exakt aus der EXE (0x8cef–0x8eda).
- **Hauptmenü** (`sub_7801`) vermessen: Vollbild-`Frame3DThick(0,0,639,479)` (fehlte),
  Titel y=20 mit roter Unterstreichung y=40 (x 205–433), Boxen (40,50+40·i)-(508,85+40·i),
  Labels x=60, Werte rechtsbündig auf x2−16, **„Go for it !" abgesetzt** bei (40,430)-(508,465),
  `©1995 ML` bei (550,459), initiale Auswahl = „Go for it !".
- **Options-Popups** (`0x7afc`/`0x7d55`/`0x7f79`/`0x813b`) 1:1: Zeilen 6–9 öffnen ein
  5-Button-Fenster (Max / ↑ / ↓ / Min / **„Yo!"**) mit rotem unterstrichenem Titel;
  „Yo!" vorselektiert + Cursor-Glide; Esc/Klick außerhalb springt auf „Yo!" (schließt
  nicht); Limits: Error 0–100 (±1), Money 0–100000 (±1000), Games 1–50 (±1), Players
  2–10 (±1); wertabhängiger Beep.
- **Protraktor-Ziel-Panel** (`sub_557a`) 1:1: Punktbogen r=35 um (190,47) (19 Punkte alle
  10°), Marker-Kreise (Hub/0°/45°/90°/135°/180°), weiße Nadel r4→r32, ◄/►-Buttons,
  Fire/I/W/max/250-Buttons, +/−-Power-Gruppe mit Readout `Str(:4)`; alle 9 Klick-Regionen;
  **Rechtsklick** schaltet das Panel um (`[0x115f]`), Präferenz startet mit „Use your Mouse".
- **Maus-Cursor** pixel-exakt extrahiert: grauer Pfeil (Index 15, im Spiel weiß) mit
  Outline in **Farbe 0 = Hintergrund** — auf dem BG unsichtbar, „stanzt" aber Text/Rahmen.
- **HUD-Stats** (`sub_5b69`): `Str`-Feldbreiten (Points:6, Wins:6, Men:3, Wind:3,
  Angle:2, Power:4), Zeilen y=10/18.

### Bewusst **nicht** 1:1 (bewusst weggelassen / angenähert)
| Bereich | Original | Port‑Stand |
|---|---|---|
| **Shareware-Abschieds-/Registrierungs-Screen** (`sub_116c`) | Spielzeit-Countdown + Registrierungstext beim Beenden | **weggelassen** — im Browser kein „Programm-Ende"; Inhalte stehen in dieser Doku — `—` |
| **INI-Persistenz** (`sub_1648`/`sub_1a2a`) | Optionen in `Tankwars.ini` speichern/laden | **weggelassen** — Optionen setzen sich pro Laden auf Defaults zurück (ließe sich per `localStorage` nachrüsten) — `—` |
| **Kommandozeile/Usage** (`sub_1459`/`sub_15d8`) | `-D/-F/-M/-?`-Schalter, stdout-Hilfe | **weggelassen** — für den Browser gegenstandslos — `—` |
| **Zweiter Quit-Dialog** (`sub_8ac5`, Ganzprogramm-Ende) | separater Beenden-Dialog | **weggelassen** — kein Programm-Ende im Browser — `—` |
| In-Engine-Info-Popups (`sub_95a0`) | geboxte Textschirme | durch den HTML-Startschirm/Doku-Viewer ersetzt — `≈` |
| Maus-Confinement (`MouseSetRange(3,3,633,52)`) | Cursor während des Ziel-Zugs in die HUD-Leiste eingesperrt | **weggelassen** — im Browser unüblich/übergriffig; alle Panel-Klicks sind 1:1 — `≈` |
