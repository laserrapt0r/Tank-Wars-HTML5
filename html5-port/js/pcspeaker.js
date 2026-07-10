// pcspeaker.js — faithful PC-speaker emulation via WebAudio.
//
// The original drives the 8253 timer channel 2 through the CRT unit:
//   Sound(Hz)  -> square wave at Hz on the speaker
//   NoSound    -> silence
//   Delay(ms)  -> busy wait
// The speaker is a 1-bit square wave, reproduced with a 'square' OscillatorNode.
// Sound effects are note lists [{f:Hz, d:ms}, ...] scheduled on the audio clock.
//
// Robustness: every WebAudio call is wrapped so that an audio error can never
// break the game loop, the context is auto-resumed if it got suspended, and stale
// scheduled gain events are cleared before each new sound (prevents "stuck silent").

class PCSpeaker {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this._seq = 0;            // sequence token to supersede running effects
    this.enabled = true;      // master "SoundFX" gate
  }

  _ensure() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.ctx.destination);
      this.osc = this.ctx.createOscillator();
      this.osc.type = 'square';
      this.osc.frequency.value = 440;
      this.osc.connect(this.gain);
      this.osc.start();
    } catch (e) { this.ctx = null; return false; }
    return true;
  }

  // Resume the AudioContext if the browser suspended it (autoplay policy / tab switch).
  _resume() { try { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) {} }
  resume() { if (this._ensure()) this._resume(); }

  // Immediate primitives (mirror CRT.Sound / CRT.NoSound).
  soundOn(hz) {
    if (!this.enabled || !this._ensure()) return;
    this._resume();
    try {
      const t = this.ctx.currentTime;
      const g = this.gain.gain;
      g.cancelScheduledValues(t);
      if (hz > 0) {
        this.osc.frequency.cancelScheduledValues(t);
        this.osc.frequency.setValueAtTime(hz, t);
        g.setValueAtTime(0.18, t);
      } else {
        g.setValueAtTime(0, t);
      }
    } catch (e) {}
  }
  soundOff() {
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(0, t);
    } catch (e) {}
  }

  // Play a note list [{f,d}] on the audio clock. `gate` respects the SoundFX /
  // Flight-SoundFX option. Never throws.
  play(notes, gate = true) {
    if (!gate || !this.enabled || !notes || !notes.length || !this._ensure()) return Promise.resolve();
    this._resume();
    const myTok = ++this._seq;
    let totalMs = 0;
    try {
      const g = this.gain.gain, f = this.osc.frequency;
      let t = this.ctx.currentTime + 0.001;
      g.cancelScheduledValues(t);
      f.cancelScheduledValues(t);
      for (const n of notes) {
        const dur = Math.max(0, n.d) / 1000;
        if (n.f > 0) { f.setValueAtTime(n.f, t); g.setValueAtTime(0.18, t); }
        else g.setValueAtTime(0, t);
        t += dur;
      }
      g.setValueAtTime(0, t); // NoSound at end (scheduled on the AUDIO clock — authoritative)
      totalMs = (t - this.ctx.currentTime) * 1000;
    } catch (e) { return Promise.resolve(); }
    // The effect's END is already scheduled above on the audio clock. The timeout below is
    // only a safety net (and resolves the promise) — it must never cut the audible tail:
    // JS timers and the audio clock drift differently per OS/audio stack (Windows WASAPI
    // vs Linux PulseAudio), and an early soundOff() truncated short sweeps (e.g. the W/I
    // turret tones) to a barely-audible blip on some platforms. +80 ms margin fixes that.
    return new Promise(res => setTimeout(() => {
      if (myTok === this._seq) this.soundOff();
      res();
    }, totalMs + 80));
  }

  // Schedule a gated tone pattern within the current frame: slots = [{f, d}] with
  // d in SECONDS; f=0 -> silence. Mirrors the original's per-pixel Sound(f)/NoSound
  // pulsing (e.g. the earthquake's chopped 500 Hz rattle) at op granularity.
  gate(slots, gateFlag = true) {
    if (!gateFlag || !this.enabled || !slots || !slots.length || !this._ensure()) return;
    this._resume();
    try {
      const g = this.gain.gain, f = this.osc.frequency;
      let t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      f.cancelScheduledValues(t);
      for (const s of slots) {
        if (s.f > 0) { f.setValueAtTime(s.f, t); g.setValueAtTime(0.18, t); }
        else g.setValueAtTime(0, t);
        t += Math.max(0, s.d);
      }
      g.setValueAtTime(0, t);
    } catch (e) {}
  }

  // Cancel any running effect and silence immediately.
  stop() { this._seq++; this.soundOff(); }
}

export { PCSpeaker };
