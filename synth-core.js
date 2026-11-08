// Stem Keys: shared synth DSP, used by the browser AudioWorklet and by the offline fitter.

export const SPEC = [
  ["sawA", 0, 1], ["sawB", 0, 1], ["pulA", 0, 1], ["pulB", 0, 1],
  ["sinA", 0, 1], ["sinB", 0, 1], ["sinC", 0, 1], ["noise", 0, 0.25],
  ["pw", 0.05, 0.5], ["det", 0, 25],
  ["cut", -12, 60], ["envAmt", 0, 72], ["fdec", 0.01, 2, 1], ["res", 0.5, 8, 1], ["hp", -36, 12],
  ["atk", 0.001, 0.08, 1], ["dec", 0.03, 4, 1], ["sus", 0, 1], ["rel", 0.03, 2, 1],
  ["dlyMix", 0, 0.8], ["dlyFb", 0, 0.8], ["dlyDamp", 1500, 12000, 1], ["dlyTime", 0.3, 0.7],
];

export function decode(x) {
  const p = {};
  SPEC.forEach(([k, lo, hi, log], i) => {
    const u = Math.min(1, Math.max(0, x[i]));
    p[k] = log ? lo * Math.pow(hi / lo, u) : lo + (hi - lo) * u;
  });
  return p;
}

export function encode(p) {
  return SPEC.map(([k, lo, hi, log]) => {
    const v = p[k];
    return log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo);
  });
}

const TS = 4096;
const SIN = new Float32Array(TS + 1);
for (let i = 0; i <= TS; i++) SIN[i] = Math.sin((2 * Math.PI * i) / TS);

function sinT(ph) {
  const x = ph * TS, i = x | 0;
  return SIN[i] + (x - i) * (SIN[i + 1] - SIN[i]);
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

let seed = 22222;
function noise() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
}

export class Voice {
  constructor(sr) {
    this.sr = sr;
    this.active = false;
  }

  start(midi, vel, phaseB = Math.random()) {
    this.midi = midi;
    this.vel = vel;
    this.f = 440 * Math.pow(2, (midi - 69) / 12);
    this.pa = 0; this.pb = phaseB; this.pc = 0;
    this.n = 0;
    this.envD = 1;
    this.fenv = 1;
    this.gate = true;
    this.relD = 1;
    this.relLevel = 0;
    this.level = 0;
    this.l1 = 0; this.l2 = 0; this.h1 = 0; this.h2 = 0;
    this.active = true;
  }

  release() {
    if (!this.gate) return;
    this.gate = false;
    this.relLevel = this.level;
    this.relD = 1;
  }

  render(p, out, from, to) {
    const sr = this.sr, inv = 1 / sr;
    const f = this.f;
    const dA = f * inv, dB = 2 * f * Math.pow(2, p.det / 1200) * inv, dC = 4 * f * inv;
    const pw = p.pw, dc = 2 * pw - 1;
    const kL = 1 / p.res, kH = 1.2;
    const hpF = Math.min(0.45 * sr, Math.max(10, f * Math.pow(2, p.hp / 12)));
    const gH = Math.tan(Math.PI * hpF * inv);
    const aH1 = 1 / (1 + gH * (gH + kH)), aH2 = gH * aH1, aH3 = gH * aH2;
    const amp = (0.35 + 0.65 * this.vel) * 0.25;
    const envScale = p.envAmt * (0.6 + 0.4 * this.vel);
    const atkN = Math.max(1, p.atk * sr);
    const decMul = Math.exp(-1 / (p.dec * sr));
    const fMul = Math.exp(-16 / (p.fdec * sr));
    const relMul = Math.exp(-1 / (p.rel * sr));
    const sus = p.sus;
    const lSawA = p.sawA, lSawB = p.sawB, lPulA = p.pulA, lPulB = p.pulB;
    const lSinA = p.sinA, lSinB = p.sinB, lSinC = p.sinC, lNoise = p.noise;
    const maxF = 0.45 * sr;
    let pa = this.pa, pb = this.pb, pc = this.pc, n = this.n;
    let envD = this.envD, fenv = this.fenv, relD = this.relD;
    let l1 = this.l1, l2 = this.l2, h1 = this.h1, h2 = this.h2;
    let aL1 = 0, aL2 = 0, aL3 = 0, env = this.level;
    for (let i = from; i < to; i++) {
      if (this.gate) {
        if (n < atkN) env = n / atkN;
        else { env = sus + (1 - sus) * envD; envD *= decMul; }
      } else {
        env = this.relLevel * relD;
        relD *= relMul;
        if (env < 3e-4) { this.active = false; break; }
      }
      if (((i - from) & 15) === 0) {
        let fe;
        if (n < atkN) fe = n / atkN;
        else { fe = fenv; fenv *= fMul; }
        let lpF = f * Math.pow(2, (p.cut + envScale * fe) / 12);
        lpF = lpF > maxF ? maxF : lpF < 20 ? 20 : lpF;
        const g = Math.tan(Math.PI * lpF * inv);
        aL1 = 1 / (1 + g * (g + kL)); aL2 = g * aL1; aL3 = g * aL2;
      }
      let s = lSawA * (2 * pa - 1 - blep(pa, dA)) + lSawB * (2 * pb - 1 - blep(pb, dB));
      if (lPulA > 0) {
        const q = pa - pw < 0 ? pa - pw + 1 : pa - pw;
        s += lPulA * ((pa < pw ? 1 : -1) + blep(pa, dA) - blep(q, dA) - dc);
      }
      if (lPulB > 0) {
        const q = pb - pw < 0 ? pb - pw + 1 : pb - pw;
        s += lPulB * ((pb < pw ? 1 : -1) + blep(pb, dB) - blep(q, dB) - dc);
      }
      if (lSinA > 0) s += lSinA * sinT(pa);
      if (lSinB > 0) s += lSinB * sinT(pb);
      if (lSinC > 0) s += lSinC * sinT(pc);
      if (lNoise > 0) s += lNoise * noise();
      pa += dA; if (pa >= 1) pa -= 1;
      pb += dB; if (pb >= 1) pb -= 1;
      pc += dC; if (pc >= 1) pc -= 1;

      let v3 = s - h2;
      let v1 = aH1 * h1 + aH2 * v3;
      let v2 = h2 + aH2 * h1 + aH3 * v3;
      h1 = 2 * v1 - h1; h2 = 2 * v2 - h2;
      const hp = s - kH * v1 - v2;

      v3 = hp - l2;
      v1 = aL1 * l1 + aL2 * v3;
      v2 = l2 + aL2 * l1 + aL3 * v3;
      l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;

      out[i] += v2 * env * amp;
      n++;
    }
    this.pa = pa; this.pb = pb; this.pc = pc; this.n = n;
    this.envD = envD; this.fenv = fenv; this.relD = relD;
    this.l1 = l1; this.l2 = l2; this.h1 = h1; this.h2 = h2;
    this.level = env;
  }
}

export class Echo {
  constructor(sr, maxSec = 2) {
    this.sr = sr;
    this.buf = new Float32Array(Math.ceil(sr * maxSec));
    this.w = 0;
    this.lp = 0;
  }

  process(p, io, from, to) {
    const buf = this.buf, n = buf.length;
    const d = Math.min(n - 1, Math.round(p.dlyTime * this.sr));
    const a = 1 - Math.exp(-6.283185307179586 * p.dlyDamp / this.sr);
    const mix = p.dlyMix, fb = p.dlyFb;
    let w = this.w, lp = this.lp;
    for (let i = from; i < to; i++) {
      let r = w - d;
      if (r < 0) r += n;
      lp += a * (buf[r] - lp);
      const dry = io[i];
      buf[w] = dry + fb * lp;
      io[i] = dry + mix * lp;
      w = w + 1 === n ? 0 : w + 1;
    }
    this.w = w; this.lp = lp;
  }
}

export function renderPhrase(p, notes, sr, len) {
  const out = new Float32Array(len);
  for (const nt of notes) {
    const v = new Voice(sr);
    v.start(nt.midi, nt.vel ?? 0.8, 0.37);
    const s0 = Math.max(0, Math.round(nt.t * sr));
    const s1 = Math.min(len, Math.round((nt.t + nt.dur) * sr));
    if (s0 >= len) continue;
    v.render(p, out, s0, s1);
    v.release();
    if (v.active) v.render(p, out, s1, Math.min(len, s1 + Math.round(1.2 * sr)));
  }
  new Echo(sr).process(p, out, 0, len);
  return out;
}
