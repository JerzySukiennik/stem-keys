// Stem Keys: song player, two hands of A+ or B instruments over the song's own backing track.
const S = window.SONG;
const $ = (id) => document.getElementById(id);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const STEM_ORDER = ["bass", "piano", "other"];
const STEM_LABEL = { bass: "bas", piano: "klawisze", other: "syntezatory" };
const HAND_LABEL = { left: "Lewa ręka", right: "Prawa ręka" };
const KNOBS = [
  { key: "echo", label: "Echo", min: 0, max: 0.8, fmt: (v) => Math.round((v / 0.8) * 100) + "%" },
  { key: "verb", label: "Pogłos", min: 0, max: 0.6, fmt: (v) => Math.round((v / 0.6) * 100) + "%" },
  { key: "rel", label: "Wybrzmienie", min: 0.03, max: 2.5, log: true, fmt: (v) => (v < 1 ? Math.round(v * 1000) + " ms" : v.toFixed(1) + " s") },
  { key: "bright", label: "Jasność", min: -1, max: 1, fmt: (v) => (Math.abs(v) < 0.005 ? "0" : (v > 0 ? "+" : "") + v.toFixed(2)) },
];

const cands = S.candidates;
const byId = new Map(cands.map((c) => [c.id, c]));
for (const c of cands) c.short = c.name.replace(/\s*\(od [^)]*\)$/, "");
const keysC = cands.filter((c) => c.stem !== "bass");
const bassC = cands.find((c) => c.stem === "bass");

function recKnobs(c) {
  return { echo: clamp(c.b.params.dlyMix, 0, 0.8), verb: 0.12, rel: clamp(c.b.params.rel, c.stem === "bass" ? 0.08 : 0.15, 1.5), bright: 0 };
}

function freshState() {
  const right = (keysC[0] || bassC || cands[0]).id;
  const left = bassC && keysC.length ? bassC.id : null;
  const st = {
    mode: left != null ? "split" : "single",
    split: 48,
    active: "right",
    kbOct: 60,
    hands: {
      left: { cand: left, ver: "aplus", oct: 0, knobs: left != null ? recKnobs(byId.get(left)) : null },
      right: { cand: right, ver: "aplus", oct: 0, knobs: recKnobs(byId.get(right)) },
    },
  };
  return st;
}

const STORE = "stemkeys:" + S.meta.artist + ":" + S.meta.title;
let state = freshState();
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || "null");
  if (saved && saved.hands && ["left", "right"].every((h) => saved.hands[h].cand == null || byId.has(saved.hands[h].cand))) state = saved;
} catch {}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {}
}

let ctx = null, master = null, convolver = null, workletReady = null;
const engines = {};
const aplusCache = new Map();
const bGainCache = new Map();

function makeIR(sec) {
  const sr = ctx.sampleRate, n = Math.round(sec * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * 3.1) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  return buf;
}

function bGain(c) {
  if (bGainCache.has(c.id)) return bGainCache.get(c.id);
  const sr = ctx.sampleRate, n = Math.round(0.3 * sr);
  const buf = new Float32Array(n);
  const v = new Voice(sr);
  v.start(c.stem === "bass" ? 40 : 69, 0.8, 0.37);
  v.render(c.b.params, buf, 0, n);
  let e = 0;
  for (let i = Math.round(0.05 * sr); i < n; i++) e += buf[i] * buf[i];
  const rms = Math.sqrt(e / (n - Math.round(0.05 * sr))) || 1e-6;
  const g = (0.1 * (0.35 + 0.65 * 0.8) * 0.65) / rms;
  bGainCache.set(c.id, g);
  return g;
}

class HandEngine {
  constructor(hand) {
    this.hand = hand;
    this.in = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.5;
    this.hs = ctx.createBiquadFilter();
    this.hs.type = "highshelf";
    this.hs.frequency.value = 2500;
    this.out = ctx.createGain();
    this.in.connect(this.lp).connect(this.hs).connect(this.out).connect(master);
    this.delay = ctx.createDelay(2);
    this.damp = ctx.createBiquadFilter();
    this.damp.type = "lowpass";
    this.damp.Q.value = 0.5;
    this.fb = ctx.createGain();
    this.wet = ctx.createGain();
    this.out.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.fb).connect(this.delay);
    this.damp.connect(this.wet).connect(master);
    this.verb = ctx.createGain();
    this.out.connect(this.verb).connect(convolver);
    this.voices = new Map();
    this.key = "";
    this.inst = null;
    this.synth = null;
    this.ver = "aplus";
    this.rel = 0.3;
    this.cand = null;
  }

  async setup(c, ver) {
    const key = c ? c.id + ":" + ver : "";
    if (key === this.key) return;
    this.allOff();
    this.key = key;
    this.cand = c;
    this.ver = ver;
    if (!c) return;
    this.delay.delayTime.value = c.b.params.dlyTime;
    this.damp.frequency.value = c.b.params.dlyDamp;
    this.fb.gain.value = clamp(c.b.params.dlyFb, 0, 0.85);
    if (ver === "aplus") {
      if (!aplusCache.has(c.id)) aplusCache.set(c.id, new AplusInstrument(ctx, c, S.tune || 0));
      this.inst = aplusCache.get(c.id);
      const [lo, hi] = playRange(c);
      this.inst.prerender(lo, hi, Math.round((c.range[0] + c.range[1]) / 2));
    } else {
      await workletReady;
      if (!this.synth) {
        this.synth = new AudioWorkletNode(ctx, "stem-synth", { numberOfInputs: 0, outputChannelCount: [2] });
        this.synth.connect(this.in);
        this.synth.port.postMessage({ type: "echo", on: false });
      }
      this.pushParams();
    }
  }

  pushParams() {
    if (!this.synth || !this.cand) return;
    const p = { ...this.cand.b.params, rel: this.rel, dlyMix: 0 };
    this.synth.port.postMessage({ type: "params", params: p, gain: bGain(this.cand), tune: S.tune || 0 });
  }

  knobs(k) {
    const t = ctx.currentTime;
    this.wet.gain.setTargetAtTime(k.echo, t, 0.02);
    this.verb.gain.setTargetAtTime(k.verb, t, 0.02);
    this.rel = k.rel;
    const b = k.bright;
    this.lp.frequency.setTargetAtTime(b < 0 ? 18000 * Math.pow(2, b * 4) : 20000, t, 0.02);
    this.hs.gain.setTargetAtTime(b > 0 ? b * 9 : 0, t, 0.02);
    if (this.ver === "b") this.pushParams();
  }

  on(midi, vel) {
    if (!this.cand) return null;
    if (this.ver === "aplus") {
      this.voices.get(midi)?.release(ctx.currentTime, 0.03);
      const v = this.inst.on(midi, vel, this.in, ctx.currentTime);
      this.voices.set(midi, v);
      return v.bars;
    }
    this.synth?.port.postMessage({ type: "on", midi, vel });
    return null;
  }

  off(midi) {
    if (this.ver === "aplus") {
      const v = this.voices.get(midi);
      if (v) { v.release(ctx.currentTime, this.rel); this.voices.delete(midi); }
    } else this.synth?.port.postMessage({ type: "off", midi });
  }

  allOff() {
    for (const v of this.voices.values()) v.kill();
    this.voices.clear();
    this.synth?.port.postMessage({ type: "panic" });
  }
}

function playRange(c) {
  return c.stem === "bass" ? [24, 60] : [36, 96];
}

async function startAudio() {
  if (ctx) return;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  ctx = new AudioContext({ latencyHint: "interactive" });
  master = ctx.createGain();
  master.gain.value = 0.9;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6;
  lim.knee.value = 4;
  lim.ratio.value = 16;
  lim.attack.value = 0.002;
  lim.release.value = 0.15;
  master.connect(lim).connect(ctx.destination);
  convolver = ctx.createConvolver();
  convolver.buffer = makeIR(2.2);
  convolver.connect(master);
  workletReady = loadWorklet();
  engines.left = new HandEngine("left");
  engines.right = new HandEngine("right");
  await applyHands();
  $("gate").classList.add("hidden");
}

async function loadWorklet() {
  const data = "data:text/javascript;charset=utf-8," + encodeURIComponent(WORKLET_SRC);
  const urls = location.protocol === "file:" ? [data] : ["../worklet.js", data];
  for (const u of urls) {
    try { await ctx.audioWorklet.addModule(u); return true; } catch {}
  }
  return false;
}

async function applyHands() {
  if (!ctx) return;
  for (const h of ["left", "right"]) {
    const hs = state.hands[h];
    const used = h === "right" || state.mode !== "single";
    const c = used && hs.cand != null ? byId.get(hs.cand) : null;
    await engines[h].setup(c, hs.ver);
    if (c) engines[h].knobs(hs.knobs);
  }
}

function handsFor(midi) {
  if (state.mode === "single") return ["right"];
  if (state.mode === "layer") return ["left", "right"];
  return [midi < state.split ? "left" : "right"];
}

const held = new Map();
const sustained = new Map();
let pedal = false;
let picking = false;

function noteOn(midi, vel) {
  ensureRange(midi);
  if (picking) {
    state.split = midi;
    picking = false;
    $("setSplit").classList.remove("on");
    document.querySelector(".kb-wrap").classList.remove("picking");
    save();
    renderKeyboard();
    return;
  }
  if (!ctx || ctx.state !== "running") { pulseGate(); return; }
  if (bandArmed) {
    setArmed(false);
    band.play();
  }
  const prev = sustained.get(midi) || held.get(midi);
  if (prev) for (const [h, m] of prev) engines[h].off(m);
  sustained.delete(midi);
  const out = [];
  for (const h of handsFor(midi)) {
    const hs = state.hands[h];
    if (hs.cand == null) continue;
    const m = midi + 12 * hs.oct;
    const bars = engines[h].on(m, vel);
    out.push([h, m]);
    if (bars) paintBars(document.querySelector(`.hand[data-hand=${h}] .bars`), bars);
  }
  held.set(midi, out);
  paintKey(midi, out.length ? out[out.length - 1][0] : null);
}

function noteOff(midi) {
  const hs = held.get(midi);
  if (!hs) return;
  held.delete(midi);
  paintKey(midi, null);
  if (pedal) sustained.set(midi, hs);
  else for (const [h, m] of hs) engines[h]?.off(m);
}

function setPedal(on) {
  pedal = on;
  if (!on) {
    for (const [midi, hs] of sustained) if (!held.has(midi)) for (const [h, m] of hs) engines[h]?.off(m);
    sustained.clear();
  }
}

function panic() {
  for (const e of Object.values(engines)) e.allOff();
  held.clear();
  sustained.clear();
  document.querySelectorAll(".kb .down").forEach((k) => k.classList.remove("down"));
}

function pulseGate() {
  const g = $("gate");
  g.classList.remove("hidden");
}

function barsFromModel(c) {
  const notes = c.aplus.notes;
  const n = notes[Math.floor(notes.length / 2)];
  const raw = atob(n.amps);
  const K = n.K, F = n.frames;
  const out = [];
  for (let k = 0; k < 12; k++) {
    if (k >= K) { out.push(0); continue; }
    let s = 0, cnt = 0;
    for (let f = Math.min(10, F - 1); f < Math.min(50, F); f++) { s += (raw.charCodeAt(f * K + k) / 255) * 90 - 90; cnt++; }
    out.push(s / Math.max(1, cnt));
  }
  const mx = Math.max(...out.filter((v, i) => i < K));
  return out.map((v, i) => (i >= K ? 0 : Math.max(0, 1 + (v - mx) / 60)));
}

function barsHTML(vals) {
  return `<div class="bars" aria-hidden="true">${vals.map((v) => `<i style="height:${Math.round(4 + v * 96)}%"></i>`).join("")}</div>`;
}

function paintBars(el, vals) {
  if (!el) return;
  el.querySelectorAll("i").forEach((i, k) => { i.style.height = Math.round(4 + (vals[k] || 0) * 96) + "%"; });
}

const modelBars = new Map(cands.map((c) => [c.id, barsFromModel(c)]));
const previews = new Map();
let previewSrc = null;

async function togglePreview(c, btn) {
  await startAudio();
  if (previewSrc) {
    const was = previewSrc.cid;
    previewSrc.node.stop();
    previewSrc = null;
    document.querySelectorAll(".orig.on").forEach((b) => b.classList.remove("on"));
    if (was === c.id) return;
  }
  let buf = previews.get(c.id);
  if (!buf) {
    const bin = atob(S.previews[c.id]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    buf = await ctx.decodeAudioData(bytes.buffer);
    let e = 0;
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) e += d[i] * d[i];
    buf.norm = 0.09 / (Math.sqrt(e / d.length) || 1);
    previews.set(c.id, buf);
  }
  const node = ctx.createBufferSource();
  node.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = Math.min(6, buf.norm);
  node.connect(g).connect(master);
  node.start();
  node.onended = () => { if (previewSrc && previewSrc.node === node) { previewSrc = null; btn.classList.remove("on"); } };
  previewSrc = { node, cid: c.id };
  btn.classList.add("on");
}

function renderSounds() {
  const box = $("sounds");
  box.innerHTML = "";
  for (const c of cands) {
    const el = document.createElement("div");
    el.className = "sound";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.dataset.id = c.id;
    const n = c.aplus.notes.length;
    el.innerHTML = `${barsHTML(modelBars.get(c.id))}
      <div class="sname">${c.short}</div>
      <div class="smeta">od ${c.from} · ${n} ${n === 1 ? "nuta" : n < 5 ? "nuty" : "nut"} z nagrania</div>
      <div class="sfoot"><button class="orig" aria-label="Posłuchaj oryginału"><svg viewBox="0 0 10 10"><path d="M1 0l9 5-9 5z"/></svg>Oryginał</button><span class="chips"></span></div>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".orig")) return;
      assign(c.id);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); assign(c.id); } });
    el.querySelector(".orig").addEventListener("click", (e) => { e.stopPropagation(); togglePreview(c, e.currentTarget); });
    box.appendChild(el);
  }
  $("soundsNote").textContent = `Kliknij brzmienie, żeby dać je ${state.mode === "single" ? "na klawiaturę" : "aktywnej ręce"}`;
  paintSounds();
}

function paintSounds() {
  document.querySelectorAll(".sound").forEach((el) => {
    const id = +el.dataset.id;
    const L = state.mode !== "single" && state.hands.left.cand === id;
    const R = state.hands.right.cand === id;
    el.classList.toggle("on-left", L);
    el.classList.toggle("on-right", R);
    el.querySelector(".chips").innerHTML = (L ? `<span class="chip l">L</span>` : "") + (R ? `<span class="chip r">P</span>` : "");
  });
}

async function assign(id) {
  const h = state.mode === "single" ? "right" : state.active;
  const hs = state.hands[h];
  if (hs.cand !== id) {
    hs.cand = id;
    hs.knobs = recKnobs(byId.get(id));
    hs.oct = 0;
  }
  save();
  renderHands();
  paintSounds();
  updateBand();
  await applyHands();
}

function knobAngle(k, v) {
  const u = k.log ? Math.log(v / k.min) / Math.log(k.max / k.min) : (v - k.min) / (k.max - k.min);
  return -135 + 270 * clamp(u, 0, 1);
}

function fromUnit(k, u) {
  u = clamp(u, 0, 1);
  return k.log ? k.min * Math.pow(k.max / k.min, u) : k.min + (k.max - k.min) * u;
}

function toUnit(k, v) {
  return k.log ? Math.log(v / k.min) / Math.log(k.max / k.min) : (v - k.min) / (k.max - k.min);
}

function arcPath(a0, a1) {
  const r = 18, cx = 22, cy = 22;
  const p = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function knobHTML(k, v) {
  const a = knobAngle(k, v);
  const zero = k.key === "bright" ? 0 : -135;
  const [s, e] = a < zero ? [a, zero] : [zero, a];
  const t = (a * Math.PI) / 180;
  return `<div class="knob" tabindex="0" role="slider" aria-label="${k.label}" data-k="${k.key}">
    <svg viewBox="0 0 44 44"><path class="track" d="${arcPath(-135, 135)}"/><path class="val" d="${e - s > 0.5 ? arcPath(s, e) : ""}"/>
    <circle class="cap" cx="22" cy="22" r="12.5"/><line class="tick" x1="${(22 + 5 * Math.sin(t)).toFixed(2)}" y1="${(22 - 5 * Math.cos(t)).toFixed(2)}" x2="${(22 + 11 * Math.sin(t)).toFixed(2)}" y2="${(22 - 11 * Math.cos(t)).toFixed(2)}"/></svg>
    <span class="kval">${k.fmt(v)}</span><span class="klabel">${k.label}</span></div>`;
}

function renderHands() {
  const box = $("hands");
  box.className = "hands" + (state.mode === "single" ? " single" : "");
  box.innerHTML = "";
  for (const h of ["left", "right"]) {
    const hs = state.hands[h];
    const c = hs.cand != null ? byId.get(hs.cand) : null;
    const el = document.createElement("div");
    el.className = "hand" + (state.active === h && state.mode !== "single" ? " active" : "");
    el.dataset.hand = h;
    const label = state.mode === "single" ? "Cała klawiatura" : state.mode === "layer" ? (h === "left" ? "Warstwa 1" : "Warstwa 2") : HAND_LABEL[h];
    el.innerHTML = `<div class="hand-head"><span class="swatch"></span><span class="hand-name">${label}</span>
        <div class="ver" role="group" aria-label="Wersja"><button data-ver="aplus" aria-pressed="${hs.ver === "aplus"}">A+</button><button data-ver="b" aria-pressed="${hs.ver === "b"}">B</button></div></div>
      <div class="hand-sound${c ? "" : " empty"}">${c ? `${c.short}<small>od ${c.from} · ${hs.ver === "aplus" ? "odbudowane z nagrania" : "syntezator dopasowany do nagrania"}</small>` : "Kliknij brzmienie powyżej"}</div>
      ${barsHTML(c ? modelBars.get(c.id) : new Array(12).fill(0))}
      <div class="knobs">${c ? KNOBS.map((k) => knobHTML(k, hs.knobs[k.key])).join("") : ""}
        <div class="hand-tools">
          <div class="oct"><button data-oct="-1" aria-label="Oktawa niżej">−</button><span>${hs.oct === 0 ? "oktawa 0" : "oktawa " + (hs.oct > 0 ? "+" : "") + hs.oct}</span><button data-oct="1" aria-label="Oktawa wyżej">+</button></div>
          <button class="ghost reset">Jak w nagraniu</button>
        </div></div>`;
    el.addEventListener("click", (e) => {
      if (state.mode !== "single" && state.active !== h) {
        state.active = h;
        save();
        document.querySelectorAll(".hand").forEach((x) => x.classList.toggle("active", x.dataset.hand === h));
      }
    });
    el.querySelectorAll(".ver button").forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      hs.ver = b.dataset.ver;
      save();
      renderHands();
      await startAudio();
      await applyHands();
    }));
    el.querySelectorAll("[data-oct]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      hs.oct = clamp(hs.oct + +b.dataset.oct, -3, 3);
      save();
      renderHands();
    }));
    el.querySelector(".reset")?.addEventListener("click", (e) => {
      e.stopPropagation();
      hs.knobs = recKnobs(c);
      hs.oct = 0;
      save();
      renderHands();
      if (ctx) engines[h].knobs(hs.knobs);
    });
    el.querySelectorAll(".knob").forEach((kel) => bindKnob(kel, h));
    box.appendChild(el);
  }
  document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-checked", b.dataset.mode === state.mode));
  $("setSplit").style.visibility = state.mode === "split" ? "visible" : "hidden";
}

function bindKnob(el, h) {
  const k = KNOBS.find((x) => x.key === el.dataset.k);
  const hs = state.hands[h];
  const set = (v) => {
    hs.knobs[k.key] = v;
    const tmp = document.createElement("div");
    tmp.innerHTML = knobHTML(k, v);
    el.querySelector("svg").replaceWith(tmp.querySelector("svg"));
    el.querySelector(".kval").textContent = k.fmt(v);
    if (ctx && engines[h]) engines[h].knobs(hs.knobs);
  };
  let y0 = 0, u0 = 0;
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    y0 = e.clientY;
    u0 = toUnit(k, hs.knobs[k.key]);
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    set(fromUnit(k, u0 + (y0 - e.clientY) / 140));
  });
  el.addEventListener("pointerup", (e) => { el.releasePointerCapture(e.pointerId); save(); });
  el.addEventListener("click", (e) => e.stopPropagation());
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    set(recKnobs(byId.get(hs.cand))[k.key]);
    save();
  });
  el.addEventListener("keydown", (e) => {
    const d = { ArrowUp: 0.04, ArrowRight: 0.04, ArrowDown: -0.04, ArrowLeft: -0.04 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    set(fromUnit(k, toUnit(k, hs.knobs[k.key]) + d));
    save();
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    set(fromUnit(k, toUnit(k, hs.knobs[k.key]) - e.deltaY / 1500));
    save();
  }, { passive: false });
}

let kbLo = 36, kbHi = 96;
const compactQ = window.matchMedia("(max-width: 760px), (pointer: coarse)");
const compact = () => compactQ.matches;

function compactRange() {
  const wrap = document.querySelector(".kb-wrap");
  const n = Math.max(8, Math.floor((wrap.clientWidth - 16) / 33));
  let lo = clamp(state.touchLo ?? defaultTouchLo(), 24, 96);
  let count = 0, hi = lo;
  for (let m = lo; count < n && m <= 108; m++) { if (!isBlack(m)) { count++; hi = m; } }
  return [lo, hi];
}

function defaultTouchLo() {
  return state.mode === "split" ? Math.max(24, state.split - 12 - (state.split % 12)) : 60;
}

function shiftOctave(d) {
  state.touchLo = clamp((state.touchLo ?? defaultTouchLo()) + 12 * d, 24, 84);
  save();
  renderKeyboard();
}

function ensureRange(m) {
  if (compact()) return;
  if (m >= kbLo && m <= kbHi) return;
  kbLo = Math.min(kbLo, m - (m % 12));
  kbHi = Math.max(kbHi, m - (m % 12) + 12);
  renderKeyboard();
}

function zoneColor(m) {
  if (state.mode !== "split") return "transparent";
  return m < state.split ? "var(--left)" : "var(--right)";
}

function renderKeyboard() {
  const kb = $("kb");
  kb.innerHTML = "";
  document.body.classList.toggle("compact", compact());
  if (compact()) {
    [kbLo, kbHi] = compactRange();
    $("kbRange").textContent = `${noteName(kbLo)}–${noteName(kbHi)}`;
  } else if (kbLo > 36 || kbHi < 96) {
    kbLo = Math.min(kbLo, 36);
    kbHi = Math.max(kbHi, 96);
  }
  const whites = [];
  for (let m = kbLo; m <= kbHi; m++) if (!isBlack(m)) whites.push(m);
  const W = 100 / whites.length;
  kb.style.minWidth = compact() ? "0" : Math.max(640, whites.length * 22) + "px";
  whites.forEach((m) => {
    const el = document.createElement("div");
    el.className = "wk";
    el.dataset.midi = m;
    el.style.setProperty("--zone", zoneColor(m));
    if (m % 12 === 0) el.innerHTML = `<span class="cname">${noteName(m)}</span>`;
    kb.appendChild(el);
  });
  for (let m = kbLo; m <= kbHi; m++) {
    if (!isBlack(m)) continue;
    const idx = whites.indexOf(m + 1);
    const el = document.createElement("div");
    el.className = "bk";
    el.dataset.midi = m;
    el.style.left = `calc(${idx * W}% - ${W * 0.31}%)`;
    el.style.width = `${W * 0.62}%`;
    kb.appendChild(el);
  }
  if (state.mode === "split" && state.split > kbLo && state.split <= kbHi) {
    const wi = whites.findIndex((m) => m >= state.split);
    const mk = document.createElement("div");
    mk.className = "split-mark";
    mk.style.left = `calc(${wi * W}% - 2px)`;
    mk.innerHTML = `<span>${noteName(state.split)}</span>`;
    kb.appendChild(mk);
  }
  for (const [m, hs] of held) paintKey(m, hs.length ? hs[hs.length - 1][0] : null);
}

function paintKey(m, hand) {
  const el = document.querySelector(`.kb [data-midi="${m}"]`);
  if (!el) return;
  el.classList.toggle("down", !!hand);
  if (hand) el.style.setProperty("--hit", hand === "left" ? "var(--left)" : "var(--right)");
}

function bindKeyboardPointer() {
  const kb = $("kb");
  const ptr = new Map();
  const keyAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-midi]");
    return el && kb.contains(el) ? +el.dataset.midi : null;
  };
  kb.addEventListener("pointerdown", async (e) => {
    e.preventDefault();
    const m = keyAt(e);
    if (!picking) await startAudio();
    ptr.set(e.pointerId, m);
    if (m != null) noteOn(m, 0.8);
  });
  window.addEventListener("pointermove", (e) => {
    if (!ptr.has(e.pointerId)) return;
    const m = keyAt(e), prev = ptr.get(e.pointerId);
    if (m === prev) return;
    if (prev != null) noteOff(prev);
    if (m != null) noteOn(m, 0.8);
    ptr.set(e.pointerId, m);
  });
  const up = (e) => {
    if (!ptr.has(e.pointerId)) return;
    const m = ptr.get(e.pointerId);
    if (m != null) noteOff(m);
    ptr.delete(e.pointerId);
  };
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

const TYPE_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ";": 16 };
const typed = new Map();
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, .knob")) return;
  const k = e.key.toLowerCase();
  if (k === "z" || k === "x") {
    state.kbOct = clamp(state.kbOct + (k === "z" ? -12 : 12), 24, 96);
    $("octName").textContent = noteName(state.kbOct);
    save();
    return;
  }
  if (!(k in TYPE_KEYS)) return;
  const m = state.kbOct + TYPE_KEYS[k];
  typed.set(k, m);
  noteOn(m, 0.8);
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (typed.has(k)) { noteOff(typed.get(k)); typed.delete(k); }
});

function setupMIDI() {
  const name = $("midiName"), pill = $("midiPill");
  if (!navigator.requestMIDIAccess) { name.textContent = "MIDI tylko w Chrome"; return; }
  navigator.requestMIDIAccess().then((access) => {
    const refresh = () => {
      const ins = [...access.inputs.values()];
      ins.forEach((i) => { i.onmidimessage = onMidi; });
      name.textContent = ins.length ? ins.map((i) => i.name).join(", ") : "Podłącz klawiaturę";
      pill.classList.toggle("live", ins.length > 0);
    };
    access.onstatechange = refresh;
    refresh();
  }, () => { name.textContent = "Brak zgody na MIDI"; });
}

function onMidi(e) {
  const [st, d1, d2] = e.data;
  const type = st & 0xf0;
  if (type === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) noteOff(d1);
  else if (type === 0xb0 && d1 === 64) setPedal(d2 >= 64);
}

const band = $("band");
band.preservesPitch = true;
band.webkitPreservesPitch = true;
let bandKey = null;

function mutedStems() {
  const m = new Set();
  const hands = state.mode === "single" ? ["right"] : ["left", "right"];
  for (const h of hands) {
    const c = state.hands[h].cand != null ? byId.get(state.hands[h].cand) : null;
    if (c) m.add(c.stem);
  }
  return STEM_ORDER.filter((s) => m.has(s));
}

function updateBand() {
  const muted = mutedStems();
  const key = muted.length ? muted.join("-") : "full";
  const file = S.mixes[key] || S.mixes.full;
  $("bandWithout").textContent = muted.length ? "bez: " + muted.map((s) => STEM_LABEL[s]).join(", ") : "cała piosenka";
  if (key === bandKey) return;
  bandKey = key;
  const t = band.currentTime || 0, playing = !band.paused;
  band.src = "podklad/" + file;
  band.playbackRate = +$("tempo").value / 100;
  band.addEventListener("loadedmetadata", () => {
    band.currentTime = Math.min(t, band.duration || t);
    band.playbackRate = +$("tempo").value / 100;
    if (playing) band.play();
  }, { once: true });
}

const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function paintRange(el) {
  const p = ((+el.value - +el.min) / (+el.max - +el.min)) * 100;
  el.style.setProperty("--p", p + "%");
}

let bandArmed = false;

function setArmed(v) {
  bandArmed = v;
  const b = $("bandPlay");
  b.classList.toggle("armed", v);
  b.setAttribute("aria-label", v ? "Anuluj czekanie na klawisz" : "Graj podkład");
  $("bandHint").hidden = !v;
  $("bandWithout").hidden = v;
}

async function unlockBand() {
  const t = band.currentTime;
  band.muted = true;
  try { await band.play(); } catch {}
  band.pause();
  band.currentTime = t;
  band.muted = false;
}

function bindBand() {
  $("bandPlay").addEventListener("click", async () => {
    await startAudio();
    if (!band.paused) { band.pause(); return; }
    if (bandArmed) { setArmed(false); return; }
    await unlockBand();
    setArmed(true);
  });
  band.addEventListener("play", () => $("bandPlay").classList.add("on"));
  band.addEventListener("pause", () => $("bandPlay").classList.remove("on"));
  band.addEventListener("timeupdate", () => {
    const d = band.duration || S.duration;
    $("bandSeek").value = Math.round((band.currentTime / d) * 1000);
    paintRange($("bandSeek"));
    $("bandTime").textContent = `${fmtT(band.currentTime)} / ${fmtT(d)}`;
  });
  $("bandSeek").addEventListener("input", (e) => {
    const d = band.duration || S.duration;
    band.currentTime = (+e.target.value / 1000) * d;
    paintRange(e.target);
  });
  $("tempo").addEventListener("input", (e) => {
    band.playbackRate = +e.target.value / 100;
    $("tempoOut").textContent = e.target.value + "%";
    paintRange(e.target);
  });
  $("bandVol").addEventListener("input", (e) => {
    band.volume = +e.target.value;
    $("bandVolOut").textContent = Math.round(+e.target.value * 100) + "%";
    paintRange(e.target);
  });
  band.volume = +$("bandVol").value;
  ["bandSeek", "tempo", "bandVol"].forEach((id) => paintRange($(id)));
  $("bandTime").textContent = `0:00 / ${fmtT(S.duration)}`;
}

function bindModes() {
  document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", async () => {
    state.mode = b.dataset.mode;
    if (state.mode !== "single" && state.hands.left.cand == null) {
      const other = cands.find((c) => c.id !== state.hands.right.cand) || cands[0];
      state.hands.left = { cand: other.id, ver: "aplus", oct: 0, knobs: recKnobs(other) };
    }
    save();
    if (ctx) panic();
    renderHands();
    renderKeyboard();
    paintSounds();
    renderSounds();
    updateBand();
    await applyHands();
  }));
  $("setSplit").addEventListener("click", () => {
    picking = !picking;
    $("setSplit").classList.toggle("on", picking);
    document.querySelector(".kb-wrap").classList.toggle("picking", picking);
  });
}

function boot() {
  document.title = `${S.meta.title} · Stem Keys`;
  $("title").textContent = S.meta.title;
  $("artist").textContent = S.meta.artist + (S.tune && Math.abs(S.tune) >= 3 ? ` · strój nagrania ${S.tune > 0 ? "+" : ""}${Math.round(S.tune)} centów` : "");
  $("cover").src = "okladka.jpg";
  $("cover").onerror = () => { $("cover").style.visibility = "hidden"; };
  $("octName").textContent = noteName(state.kbOct);
  renderSounds();
  renderHands();
  renderKeyboard();
  bindKeyboardPointer();
  bindBand();
  bindModes();
  updateBand();
  setupMIDI();
  $("gateBtn").addEventListener("click", startAudio);
  $("kbDown").addEventListener("click", () => shiftOctave(-1));
  $("kbUp").addEventListener("click", () => shiftOctave(1));
  let rt = null;
  const relayout = () => { clearTimeout(rt); rt = setTimeout(renderKeyboard, 120); };
  window.addEventListener("resize", relayout);
  compactQ.addEventListener?.("change", relayout);
}

boot();
