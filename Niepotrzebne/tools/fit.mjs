// Stem Keys: CMA-ES fit of synth parameters so a rendered phrase matches the separated stem.
import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreUrl = process.env.SYNTH_CORE || new URL("../../synth-core.js", import.meta.url).href;
const { SPEC, decode, encode, renderPhrase } = await import(coreUrl);
const { readWavFloat, makeFeaturizer, loss } = await import(new URL("./specloss.mjs", import.meta.url).href);

function setup(dir) {
  const fd = JSON.parse(fs.readFileSync(path.join(dir, "fitdata.json"), "utf8"));
  const { sr, x } = readWavFloat(path.join(dir, "target.wav"));
  const feat = makeFeaturizer(sr);
  const T = feat(x);
  let tMax = -Infinity;
  for (const v of T) if (v > tMax) tMax = v;
  return (vec) => {
    const u = vec.map((v) => Math.min(1, Math.max(0, v)));
    let pen = 0;
    vec.forEach((v, i) => { pen += (v - u[i]) ** 2; });
    const p = decode(u);
    const y = renderPhrase(p, fd.notes, sr, fd.len);
    const r = loss(T, feat(y), tMax);
    return { f: r.L + 50 * pen, gainDb: r.gainDb };
  };
}

if (!isMainThread) {
  const evalf = setup(workerData.dir);
  parentPort.on("message", ({ id, x }) => parentPort.postMessage({ id, ...evalf(x) }));
} else {
  const [dir, maxEvals = "3000", nWorkers = "2", outName = "fit.json"] = process.argv.slice(2);
  const W = +nWorkers;
  const workers = Array.from({ length: W }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { dir } }));
  const pending = new Map();
  let nextId = 0;
  workers.forEach((w) => w.on("message", (m) => { pending.get(m.id)(m); pending.delete(m.id); }));
  const evalMany = (xs) => Promise.all(xs.map((x, i) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    workers[i % W].postMessage({ id, x });
  })));

  const start = {
    sawA: 0.8, sawB: 0.05, pulA: 0.05, pulB: 0.5, sinA: 0.05, sinB: 0.05, sinC: 0.3, noise: 0.01,
    pw: 0.3, det: 6, cut: 12, envAmt: 36, fdec: 0.25, res: 1.5, hp: -24,
    atk: 0.004, dec: 0.6, sus: 0.2, rel: 0.3, dlyMix: 0.35, dlyFb: 0.35, dlyDamp: 4000, dlyTime: 0.4875,
  };
  const N = SPEC.length;
  const mode = process.env.START || "0";
  let xmean = mode === "1" ? new Array(N).fill(0.5)
    : mode === "2" ? Array.from({ length: N }, () => 0.15 + 0.7 * Math.random())
    : encode(start).map((v) => Math.min(0.98, Math.max(0.02, v)));
  let sigma = mode === "0" ? 0.25 : 0.35;
  const lambda = Math.max(4 + Math.floor(3 * Math.log(N)), 2 * W * Math.ceil((4 + Math.floor(3 * Math.log(N))) / (2 * W)));
  const mu = lambda >> 1;
  let w = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const ws = w.reduce((a, b) => a + b, 0);
  w = w.map((v) => v / ws);
  const mueff = 1 / w.reduce((a, b) => a + b * b, 0);
  const cc = (4 + mueff / N) / (N + 4 + 2 * mueff / N);
  const cs = (mueff + 2) / (N + mueff + 5);
  const c1 = 2 / ((N + 1.3) ** 2 + mueff);
  const cmu = Math.min(1 - c1, 2 * (mueff - 2 + 1 / mueff) / ((N + 2) ** 2 + mueff));
  const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (N + 1)) - 1) + cs;
  const chiN = Math.sqrt(N) * (1 - 1 / (4 * N) + 1 / (21 * N * N));
  let pc = new Array(N).fill(0), ps = new Array(N).fill(0);
  let B = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => +(i === j)));
  let D = new Array(N).fill(1);
  let C = B.map((r) => r.slice());
  let invsqrtC = B.map((r) => r.slice());
  const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  function eig(A) {
    const n = A.length, a = A.map((r) => r.slice());
    const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
      if (off < 1e-20) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
      }
    }
    return { vals: a.map((r, i) => r[i]), V };
  }

  let best = { f: Infinity }, evals = 0, gen = 0, eigeneval = 0;
  const t0 = Date.now();
  const log = [];
  const first = (await evalMany([xmean]))[0];
  best = { f: first.f, x: xmean.slice(), gainDb: first.gainDb };
  console.log("start loss", first.f.toFixed(3), "lambda", lambda, "workers", W);
  while (evals < +maxEvals) {
    gen++;
    const zs = [], ys = [], xs = [];
    for (let k = 0; k < lambda; k++) {
      const z = Array.from({ length: N }, randn);
      const y = new Array(N).fill(0);
      for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += B[i][j] * D[j] * z[j]; y[i] = s; }
      zs.push(z); ys.push(y); xs.push(xmean.map((m, i) => m + sigma * y[i]));
    }
    const res = await evalMany(xs);
    evals += lambda;
    const idx = res.map((r, i) => i).sort((a, b) => res[a].f - res[b].f);
    if (res[idx[0]].f < best.f) best = { f: res[idx[0]].f, x: xs[idx[0]].slice(), gainDb: res[idx[0]].gainDb };
    const xold = xmean;
    xmean = new Array(N).fill(0);
    for (let k = 0; k < mu; k++) for (let i = 0; i < N; i++) xmean[i] += w[k] * xs[idx[k]][i];
    const dm = xmean.map((v, i) => (v - xold[i]) / sigma);
    const isd = new Array(N).fill(0);
    for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += invsqrtC[i][j] * dm[j]; isd[i] = s; }
    ps = ps.map((v, i) => (1 - cs) * v + Math.sqrt(cs * (2 - cs) * mueff) * isd[i]);
    const psn = Math.sqrt(ps.reduce((a, b) => a + b * b, 0));
    const hsig = psn / Math.sqrt(1 - (1 - cs) ** (2 * gen)) / chiN < 1.4 + 2 / (N + 1) ? 1 : 0;
    pc = pc.map((v, i) => (1 - cc) * v + hsig * Math.sqrt(cc * (2 - cc) * mueff) * dm[i]);
    const ar = idx.slice(0, mu).map((k) => xs[k].map((v, i) => (v - xold[i]) / sigma));
    for (let i = 0; i < N; i++) for (let j = 0; j <= i; j++) {
      let s = (1 - c1 - cmu) * C[i][j] + c1 * (pc[i] * pc[j] + (1 - hsig) * cc * (2 - cc) * C[i][j]);
      for (let k = 0; k < mu; k++) s += cmu * w[k] * ar[k][i] * ar[k][j];
      C[i][j] = C[j][i] = s;
    }
    sigma *= Math.exp((cs / damps) * (psn / chiN - 1));
    sigma = Math.min(sigma, 0.6);
    if (evals - eigeneval > lambda / (c1 + cmu) / N / 10) {
      eigeneval = evals;
      const { vals, V } = eig(C);
      B = V;
      D = vals.map((v) => Math.sqrt(Math.max(v, 1e-14)));
      invsqrtC = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => {
        let s = 0; for (let k = 0; k < N; k++) s += B[i][k] * B[j][k] / D[k]; return s;
      }));
    }
    if (gen % 10 === 0) {
      const line = `gen ${gen} evals ${evals} best ${best.f.toFixed(3)} sigma ${sigma.toFixed(3)} ${((Date.now() - t0) / 1000).toFixed(0)}s`;
      console.log(line);
      log.push(line);
    }
    if (sigma < 1e-3) break;
  }
  const p = decode(best.x.map((v) => Math.min(1, Math.max(0, v))));
  const out = { loss: best.f, startLoss: first.f, gainDb: best.gainDb, evals, seconds: (Date.now() - t0) / 1000, params: p, log };
  fs.writeFileSync(path.join(dir, outName), JSON.stringify(out, null, 1));
  console.log("done", best.f.toFixed(3), "from", first.f.toFixed(3), "in", out.seconds.toFixed(0), "s");
  console.log(JSON.stringify(p));
  workers.forEach((wk) => wk.terminate());
}
