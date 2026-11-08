// Stem Keys: polyphonic AudioWorklet running the fitted synth voice and its echo.
import { Voice, Echo } from "./synth-core.js";

class StemSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: 24 }, () => new Voice(sampleRate));
    this.echo = new Echo(sampleRate);
    this.p = null;
    this.echoOn = true;
    this.gain = 1;
    this.tune = 1;
    this.queue = [];
    this.buf = new Float32Array(128);
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === "params") { this.p = m.params; this.gain = m.gain ?? this.gain; this.tune = Math.pow(2, (m.tune || 0) / 1200); }
    else if (m.type === "echo") this.echoOn = m.on;
    else if (m.type === "panic") { this.queue = []; this.voices.forEach((v) => (v.active = false)); this.echo = new Echo(sampleRate); }
    else if (m.type === "on" || m.type === "off") {
      if (!m.at || !this.p) {
        if (this.p) m.type === "on" ? this.noteOn(m.midi, m.vel) : this.noteOff(m.midi);
        return;
      }
      this.queue.push(m);
      this.queue.sort((a, b) => a.at - b.at);
    }
  }

  noteOn(midi, vel) {
    for (const v of this.voices) if (v.active && v.midi === midi && v.gate) v.release();
    let v = this.voices.find((x) => !x.active);
    if (!v) v = this.voices.reduce((a, b) => (a.level < b.level ? a : b));
    v.start(midi, vel);
    v.f *= this.tune;
  }

  noteOff(midi) {
    for (const v of this.voices) if (v.active && v.midi === midi && v.gate) v.release();
  }

  process(_, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.p) return true;
    const blockEnd = currentTime + n / sampleRate;
    while (this.queue.length && this.queue[0].at < blockEnd) {
      const m = this.queue.shift();
      if (m.type === "on") this.noteOn(m.midi, m.vel);
      else this.noteOff(m.midi);
    }
    const b = this.buf;
    b.fill(0);
    for (const v of this.voices) if (v.active) v.render(this.p, b, 0, n);
    if (this.echoOn) this.echo.process(this.p, b, 0, n);
    for (let i = 0; i < n; i++) b[i] *= this.gain;
    for (const ch of out) ch.set(b);
    return true;
  }
}

registerProcessor("stem-synth", StemSynth);
