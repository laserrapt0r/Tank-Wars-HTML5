// vga.js — a 640x480, 16-colour indexed framebuffer that reproduces the Borland
// BGI (EGAVGA driver) drawing model the original game used. All game rendering
// goes through these primitives so the output is pixel-faithful to the DOS build.
//
//   - putPixel / getPixel : direct VRAM access (BGI PutPixel/GetPixel)
//   - line                : Bresenham (BGI Line, solid, thickness 1)
//   - bar / fillRect       : filled rectangle (BGI Bar with SolidFill)
//   - circle / fillCircle  : BGI Circle (integer midpoint) / filled disc
//   - floodFill            : BGI FloodFill (scanline, 4-connected, border mode)
//   - outText              : BGI OutTextXY with the 8x8 bitmap font, integer scale
//
// The indexed buffer is blitted to a canvas via the active 6-bit VGA palette.

class VGA {
  constructor(canvas, palette /* Uint8 array [16][3] 8-bit RGB */) {
    this.W = 640; this.H = 480;
    this.buf = new Uint8Array(this.W * this.H);   // colour index per pixel
    this.palette = palette;                       // [16] of [r,g,b] 0..255
    this.color = 15;                              // current draw colour (SetColor)
    this.font = null;                             // set via setFont()
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.img = this.ctx.createImageData(this.W, this.H);
    this.rgb = new Uint8Array(16 * 3);
    this._syncPalette();
  }

  setPalette(pal) { this.palette = pal; this._syncPalette(); }
  _syncPalette() {
    for (let i = 0; i < 16; i++) {
      this.rgb[i*3]   = this.palette[i][0];
      this.rgb[i*3+1] = this.palette[i][1];
      this.rgb[i*3+2] = this.palette[i][2];
    }
  }
  setColor(c) { this.color = c & 15; }
  setFont(font) { this.font = font; }

  clear(c) { this.buf.fill(c & 15); }

  putPixel(x, y, c) {
    x |= 0; y |= 0;
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    this.buf[y * this.W + x] = (c === undefined ? this.color : c) & 15;
  }
  getPixel(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return this.buf[y * this.W + x];
  }

  // Bresenham line (BGI-compatible endpoints, both inclusive).
  line(x0, y0, x1, y1, c) {
    c = (c === undefined ? this.color : c) & 15;
    x0|=0; y0|=0; x1|=0; y1|=0;
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.putPixel(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // Filled rectangle (BGI Bar: x1..x2, y1..y2 inclusive, current fill colour).
  bar(x1, y1, x2, y2, c) {
    c = (c === undefined ? this.color : c) & 15;
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    x1 = Math.max(0, x1|0); y1 = Math.max(0, y1|0);
    x2 = Math.min(this.W - 1, x2|0); y2 = Math.min(this.H - 1, y2|0);
    for (let y = y1; y <= y2; y++) {
      const row = y * this.W;
      this.buf.fill(c, row + x1, row + x2 + 1);
    }
  }

  // BGI Circle (midpoint, outline only, thickness 1).
  circle(cx, cy, r, c) {
    c = (c === undefined ? this.color : c) & 15;
    cx|=0; cy|=0; r|=0;
    let x = 0, y = r, d = 3 - 2 * r;
    const plot8 = (x, y) => {
      this.putPixel(cx+x, cy+y, c); this.putPixel(cx-x, cy+y, c);
      this.putPixel(cx+x, cy-y, c); this.putPixel(cx-x, cy-y, c);
      this.putPixel(cx+y, cy+x, c); this.putPixel(cx-y, cy+x, c);
      this.putPixel(cx+y, cy-x, c); this.putPixel(cx-y, cy-x, c);
    };
    while (y >= x) {
      plot8(x, y);
      x++;
      if (d > 0) { y--; d += 4 * (x - y) + 10; } else { d += 4 * x + 6; }
    }
  }

  // Filled disc (used for craters / explosions).
  fillCircle(cx, cy, r, c) {
    c = (c === undefined ? this.color : c) & 15;
    cx|=0; cy|=0; r|=0;
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r*r - dy*dy) + 1e-9);
      const y = cy + dy;
      if (y < 0 || y >= this.H) continue;
      let a = cx - dx, b = cx + dx;
      a = Math.max(0, a); b = Math.min(this.W - 1, b);
      if (a <= b) this.buf.fill(c, y*this.W + a, y*this.W + b + 1);
    }
  }

  // BGI FloodFill: 4-connected scanline flood that stops at `border` colour.
  floodFill(x, y, fill, border) {
    x|=0; y|=0; fill&=15; border&=15;
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    const start = this.buf[y*this.W + x];
    if (start === border || start === fill) return;
    const stack = [[x, y]];
    while (stack.length) {
      let [px, py] = stack.pop();
      let row = py * this.W;
      let xl = px;
      while (xl >= 0 && this.buf[row+xl] !== border && this.buf[row+xl] === start) xl--;
      xl++;
      let xr = px;
      while (xr < this.W && this.buf[row+xr] !== border && this.buf[row+xr] === start) xr++;
      xr--;
      for (let i = xl; i <= xr; i++) this.buf[row+i] = fill;
      for (const ny of [py-1, py+1]) {
        if (ny < 0 || ny >= this.H) continue;
        const nrow = ny * this.W;
        let i = xl;
        while (i <= xr) {
          if (this.buf[nrow+i] === start && this.buf[nrow+i] !== border) {
            stack.push([i, ny]);
            while (i <= xr && this.buf[nrow+i] === start) i++;
          } else i++;
        }
      }
    }
  }

  // Text: 8x8 bitmap font, integer scale (BGI SetTextStyle(DefaultFont,_,size)).
  outText(x, y, str, scale, c) {
    if (!this.font) return;
    c = (c === undefined ? this.color : c) & 15;
    scale = scale || 1;
    let cx = x|0;
    for (const ch of str) {
      const g = this.font[ch.charCodeAt(0)] || this.font[0];
      if (g) {
        for (let ry = 0; ry < 8; ry++) {
          const bits = g[ry];
          for (let rx = 0; rx < 8; rx++) {
            if (bits & (0x80 >> rx)) {
              if (scale === 1) this.putPixel(cx+rx, y+ry, c);
              else this.bar(cx+rx*scale, y+ry*scale, cx+rx*scale+scale-1, y+ry*scale+scale-1, c);
            }
          }
        }
      }
      cx += 8 * scale;
    }
  }

  // Blit indexed buffer through palette to the canvas.
  present() {
    const buf = this.buf, rgb = this.rgb, data = this.img.data;
    const n = this.W * this.H;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const ci = buf[i] * 3;
      data[j]   = rgb[ci];
      data[j+1] = rgb[ci+1];
      data[j+2] = rgb[ci+2];
      data[j+3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}

export { VGA };
