// Stem Keys: log-band spectrogram features and the matching loss for the synth fitter.
import fs from "node:fs";

export function readWavFloat(path) {
  const b = fs.readFileSync(path);
  let o = 12, fmt = null, data = null;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === "data") data = b.subarray(o + 8, o + 8 + sz);
    o += 8 + sz + (sz & 1);
  }
  const n = data.length / (fmt.bits / 8) / fmt.ch;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = i * fmt.ch * (fmt.bits / 8);
    out[i] = fmt.bits === 32 ? data.readFloatLE(at) : data.readInt16LE(at) / 32768;
  }
  return { sr: fmt.sr, x: out };
}

function makeFFT(n) {
  const rev = new Uint32Array(n), lg = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let j = 0; j < lg; j++) r |= ((i >> j) & 1) << (lg - 1 - j); rev[i] = r; }
  const cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = -Math.sin(2 * Math.PI * i / n); }
  const re = new Float64Array(n), im = new Float64Array(n);
  return (input) => {
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const a = s + k, b2 = a + half, w = k * step;
          const tr = re[b2] * cs[w] - im[b2] * sn[w], ti = re[b2] * sn[w] + im[b2] * cs[w];
          re[b2] = re[a] - tr; im[b2] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    return [re, im];
  };
}

export function makeFeaturizer(sr, N = 1024, H = 256, nb = 48, fLo = 70, fHi = 7600) {
  const fft = makeFFT(N);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const edges = [];
  for (let i = 0; i <= nb; i++) edges.push(Math.max(1, Math.round(fLo * Math.pow(fHi / fLo, i / nb) * N / sr)));
  const frame = new Float64Array(N);
  return (x) => {
    const nf = Math.max(1, Math.floor((x.length - N) / H) + 1);
    const out = new Float32Array(nf * nb);
    for (let f = 0; f < nf; f++) {
      for (let i = 0; i < N; i++) frame[i] = (x[f * H + i] || 0) * win[i];
      const [re, im] = fft(frame);
      for (let b = 0; b < nb; b++) {
        let p = 0;
        const lo = edges[b], hi = Math.max(edges[b + 1], lo + 1);
        for (let k = lo; k < hi; k++) p += re[k] * re[k] + im[k] * im[k];
        out[f * nb + b] = 10 * Math.log10(p / (hi - lo) + 1e-12);
      }
    }
    return out;
  };
}

export function loss(T, S, tMax) {
  const floor = tMax - 60, loud = tMax - 45;
  const diffs = [];
  for (let i = 0; i < T.length; i++) if (T[i] > loud) diffs.push(T[i] - S[i]);
  diffs.sort((a, b) => a - b);
  const c = diffs.length ? diffs[diffs.length >> 1] : 0;
  let L = 0;
  for (let i = 0; i < T.length; i++) {
    const t = Math.max(T[i], floor), s = Math.max(S[i] + c, floor);
    L += Math.abs(t - s);
  }
  return { L: L / T.length, gainDb: c };
}
