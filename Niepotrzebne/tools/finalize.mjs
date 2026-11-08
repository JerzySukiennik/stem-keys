// Stem Keys: pick the best fit run, level-match it to the sampler and write the preset.
import fs from "node:fs";
import path from "node:path";
import { Voice, renderPhrase } from "../../synth-core.js";
import { readWavFloat, makeFeaturizer, loss } from "./specloss.mjs";

const [fitDir, outFile, tune = "0", wavOut] = process.argv.slice(2);
const runs = fs.readdirSync(fitDir).filter((f) => /^fit_\d\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(fitDir, f), "utf8")));
runs.sort((a, b) => a.loss - b.loss);
runs.forEach((r, i) => console.log(i, "loss", r.loss.toFixed(3), "from", r.startLoss.toFixed(3), "evals", r.evals, "s", r.seconds.toFixed(0)));
const best = runs[0];
const p = best.params;

const sr = 44100, n = Math.round(0.4 * sr);
const buf = new Float32Array(n);
const v = new Voice(sr);
v.start(69, 0.8, 0.37);
v.render(p, buf, 0, n);
let e = 0;
for (let i = 0; i < Math.round(0.2 * sr); i++) e += buf[i] * buf[i];
const rms = Math.sqrt(e / Math.round(0.2 * sr));
const gain = (0.12 * (0.35 + 0.65 * 0.8) * 0.9) / Math.max(rms, 1e-6);

const HAND = {
  sawA: 0.8, sawB: 0.05, pulA: 0.05, pulB: 0.5, sinA: 0.05, sinB: 0.05, sinC: 0.3, noise: 0.01,
  pw: 0.3, det: 6, cut: 12, envAmt: 36, fdec: 0.25, res: 1.5, hp: -24,
  atk: 0.004, dec: 0.6, sus: 0.2, rel: 0.3, dlyMix: 0.35, dlyFb: 0.35, dlyDamp: 4000, dlyTime: 0.4875,
};
const fdata = JSON.parse(fs.readFileSync(path.join(fitDir, "fitdata.json"), "utf8"));
const tw = readWavFloat(path.join(fitDir, "target.wav"));
const feat = makeFeaturizer(tw.sr);
const T = feat(tw.x);
let tMax = -Infinity;
for (const v of T) if (v > tMax) tMax = v;
const handLoss = loss(T, feat(renderPhrase(HAND, fdata.notes, fdata.sr, fdata.len)), tMax).L;
console.log("hand preset loss", handLoss.toFixed(3), "best", best.loss.toFixed(3));

const out = {
  song: "Human Nature",
  part: "intro synth",
  params: p,
  gain,
  tune: +tune,
  loss: best.loss,
  startLoss: handLoss,
  evals: runs.reduce((a, r) => a + r.evals, 0),
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log("gain", gain.toFixed(3), "params", JSON.stringify(p));

if (wavOut) {
  const fd = JSON.parse(fs.readFileSync(path.join(fitDir, "fitdata.json"), "utf8"));
  const y = renderPhrase(p, fd.notes, fd.sr, fd.len);
  let pk = 0;
  for (const s of y) pk = Math.max(pk, Math.abs(s));
  const b = Buffer.alloc(44 + y.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + y.length * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(fd.sr, 24);
  b.writeUInt32LE(fd.sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(y.length * 2, 40);
  y.forEach((s, i) => b.writeInt16LE(Math.round((s / pk) * 0.9 * 32767), 44 + i * 2));
  fs.writeFileSync(wavOut, b);
}
