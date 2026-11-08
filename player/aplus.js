// Stem Keys: A+ instrument, every key rebuilt additively from the harmonic model measured in the recording.
const APLUS_TS = 4096;
const APLUS_SIN = new Float32Array(APLUS_TS + 1);
for (let i = 0; i <= APLUS_TS; i++) APLUS_SIN[i] = Math.sin((2 * Math.PI * i) / APLUS_TS);

function aplusDecode(n) {
  const raw = atob(n.amps);
  const db = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) db[i] = (raw.charCodeAt(i) / 255) * 90 - 90;
  return { midi: n.midi, f0: n.f0, K: n.K, F: n.frames, db, decay: n.decay, slopes: n.slopes || [] };
}

function aplusEnvDb(n, frame, freq, hop) {
  const p = freq / n.f0;
  if (p > n.K + 0.5) return -120;
  const fi = Math.min(frame, n.F - 1);
  const row = fi * n.K;
  let v;
  if (p <= 1) v = n.db[row];
  else {
    const i = Math.floor(p), fr = p - i;
    v = i >= n.K ? n.db[row + n.K - 1] : n.db[row + i - 1] + fr * (n.db[row + i] - n.db[row + i - 1]);
  }
  if (frame > n.F - 1) {
    if (n.slopes.length) {
      const k = Math.min(n.K, Math.max(1, Math.round(p))) - 1;
      v += n.slopes[k] * (frame - (n.F - 1)) * hop;
    }
  }
  return v;
}

function aplusLoopLength(f0, sr) {
  let best = null;
  for (let n = Math.max(1, Math.round(0.24 * f0)); n <= Math.round(0.34 * f0); n++) {
    const samples = (n * sr) / f0;
    const err = Math.abs(samples - Math.round(samples));
    if (!best || err < best.err) best = { n, err, samples: Math.round(samples) };
    if (err < 0.02) break;
  }
  return best.samples / sr;
}

class AplusInstrument {
  constructor(ctx, cand, tune) {
    this.ctx = ctx;
    this.hop = cand.aplus.hop;
    this.notes = cand.aplus.notes.map(aplusDecode).sort((a, b) => a.midi - b.midi);
    this.tune = tune;
    const dec = this.notes.filter((n) => n.decay && n.slopes.length);
    this.decay = dec.length * 2 > this.notes.length;
    const avg = new Float32Array(48);
    if (dec.length) {
      for (let k = 0; k < 48; k++) {
        let s = 0, c = 0;
        for (const n of dec) if (k < n.slopes.length) { s += n.slopes[k]; c++; }
        avg[k] = c ? s / c : (k ? avg[k - 1] : -6);
      }
    }
    for (const n of this.notes) if (!n.slopes.length) n.slopes = Array.from(avg.slice(0, n.K));
    this.cache = new Map();
    this.queue = [];
    this.timer = null;
  }

  neighbors(midi) {
    let lo = null, hi = null;
    for (const n of this.notes) {
      if (n.midi <= midi) lo = n;
      if (n.midi >= midi && !hi) hi = n;
    }
    lo = lo || hi;
    hi = hi || lo;
    const w = lo === hi ? 0 : (midi - lo.midi) / (hi.midi - lo.midi);
    return { lo, hi, w };
  }

  render(midi) {
    const sr = this.ctx.sampleRate, hop = this.hop;
    const f0 = 440 * Math.pow(2, (midi - 69) / 12) * Math.pow(2, this.tune / 1200);
    const { lo, hi, w } = this.neighbors(midi);
    const decay = this.decay;
    const J = Math.max(1, Math.min(48, Math.floor(Math.min(11000, sr * 0.45) / f0)));
    let len, ls = 0, le = 0, Lp = 0;
    if (decay) len = 2.6;
    else { Lp = aplusLoopLength(f0, sr); ls = 0.4; le = ls + Lp; len = le + 0.02; }
    const N = Math.round(len * sr);
    const Fx = Math.ceil(len / hop) + 2;
    const amp = new Float32Array(J * Fx);
    const bars = new Float32Array(12);
    for (let j = 1; j <= J; j++) {
      const freq = j * f0;
      for (let f = 0; f < Fx; f++) {
        const d = (1 - w) * aplusEnvDb(lo, f, freq, hop) + w * aplusEnvDb(hi, f, freq, hop);
        amp[(j - 1) * Fx + f] = Math.pow(10, d / 20);
      }
      const base = (j - 1) * Fx;
      const fa = Math.round(0.08 / hop), fr = Math.round(0.2 / hop);
      if (decay) {
        for (let f = fa + 1; f < Fx; f++) amp[base + f] = Math.min(amp[base + f], amp[base + f - 1]);
      } else {
        let ref = 0;
        for (let f = 0; f <= Math.min(fr, Fx - 1); f++) ref = Math.max(ref, amp[base + f]);
        for (let f = fr + 1; f < Fx; f++) amp[base + f] = Math.min(amp[base + f], ref * 1.4);
      }
      if (j <= 12) bars[j - 1] = amp[base + Math.min(Fx - 1, Math.round(0.3 / hop))];
    }
    if (!decay) {
      const fl = { ls: ls / hop, Lp: Lp / hop };
      for (let j = 0; j < J; j++) {
        const base = j * Fx;
        const src = amp.slice(base, base + Fx);
        const at = (x) => {
          const i = Math.max(0, Math.min(Fx - 2, Math.floor(x)));
          return src[i] + (x - i) * (src[i + 1] - src[i]);
        };
        for (let f = Math.floor(fl.ls); f < Fx; f++) {
          const x = Math.min(1, Math.max(0, (f - fl.ls) / fl.Lp));
          amp[base + f] = (1 - x) * src[f] + x * at(f - fl.Lp);
        }
      }
    }
    const L = new Float32Array(N), R = new Float32Array(N);
    const fpS = 1 / (sr * hop);
    for (let j = 1; j <= J; j++) {
      const base = (j - 1) * Fx;
      let pl = Math.random(), pr = j === 1 ? pl : Math.random();
      const inc = (j * f0) / sr;
      if (inc >= 0.5) break;
      for (let i = 0; i < N; i++) {
        const fp = i * fpS, fi = fp | 0;
        const a = amp[base + fi] + (fp - fi) * (amp[base + fi + 1] - amp[base + fi]);
        let x = pl * APLUS_TS, k = x | 0;
        L[i] += a * (APLUS_SIN[k] + (x - k) * (APLUS_SIN[k + 1] - APLUS_SIN[k]));
        x = pr * APLUS_TS; k = x | 0;
        R[i] += a * (APLUS_SIN[k] + (x - k) * (APLUS_SIN[k + 1] - APLUS_SIN[k]));
        pl += inc; if (pl >= 1) pl -= 1;
        pr += inc; if (pr >= 1) pr -= 1;
      }
    }
    const a0 = Math.round(0.05 * sr), a1 = Math.min(N, Math.round(0.35 * sr));
    let e = 0, pk = 0;
    for (let i = a0; i < a1; i++) e += L[i] * L[i] + R[i] * R[i];
    for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const g = Math.min(0.1 / Math.sqrt(e / (2 * (a1 - a0)) + 1e-12), 0.6 / (pk + 1e-12));
    const fin = Math.round(0.002 * sr);
    const fout = decay ? Math.round(0.3 * sr) : 0;
    for (let i = 0; i < N; i++) {
      let s = g;
      if (i < fin) s *= i / fin;
      if (fout && i > N - fout) s *= (N - i) / fout;
      L[i] *= s; R[i] *= s;
    }
    const buf = this.ctx.createBuffer(2, N, sr);
    buf.copyToChannel(L, 0);
    buf.copyToChannel(R, 1);
    let bmax = 0;
    for (const b of bars) bmax = Math.max(bmax, b);
    const out = { buf, decay, ls, le, bars: Array.from(bars, (b) => Math.max(0, 1 + (20 * Math.log10(b / (bmax || 1) + 1e-9)) / 60)) };
    this.cache.set(midi, out);
    return out;
  }

  get(midi) {
    return this.cache.get(midi) || this.render(midi);
  }

  prerender(lo, hi, center) {
    const keys = [];
    for (let m = lo; m <= hi; m++) if (!this.cache.has(m)) keys.push(m);
    keys.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    this.queue = keys;
    clearTimeout(this.timer);
    const step = () => {
      const m = this.queue.shift();
      if (m === undefined) return;
      if (!this.cache.has(m)) this.render(m);
      this.timer = setTimeout(step, 8);
    };
    this.timer = setTimeout(step, 30);
  }

  stop() {
    clearTimeout(this.timer);
    this.queue = [];
  }

  on(midi, vel, dest, at) {
    const k = this.get(midi);
    const src = this.ctx.createBufferSource();
    src.buffer = k.buf;
    if (!k.decay) { src.loop = true; src.loopStart = k.ls; src.loopEnd = k.le; }
    const g = this.ctx.createGain();
    g.gain.value = (0.35 + 0.65 * vel) * 0.65;
    src.connect(g).connect(dest);
    src.start(at);
    return {
      bars: k.bars,
      release(t, rel) {
        g.gain.setTargetAtTime(0, t, rel / 4);
        try { src.stop(t + rel * 1.6 + 0.05); } catch {}
      },
      kill() {
        try { src.stop(); } catch {}
        g.disconnect();
      },
    };
  }
}
