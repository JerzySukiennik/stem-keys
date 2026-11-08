// Stem Keys: test page comparing a sampler cut from the stem (A) with an auto-fitted synth (B).
const SONG = "human-nature";
const LO = 48, HI = 84;
const LEVEL = 0.6, ORIG_LEVEL = 2.4;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
const $ = (id) => document.getElementById(id);

let ctx, master, synth, aBus, aWet, aFb, aDelay, aDamp;
let mode = "a", echoOn = true, pedal = false, octave = 60;
let preset, samples, introNotes, origBuf;
const voicesA = new Map();
const down = new Set();
const sustained = new Set();
let demo = null;

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url);
  return r.json();
}

async function boot() {
  try {
    [preset, samples, introNotes] = await Promise.all([
      loadJSON(`presets/${SONG}.json`),
      loadJSON(`sounds/${SONG}/samples.json`),
      loadJSON(`sounds/${SONG}/intro-notes.json`),
    ]);
  } catch (e) {
    $("facts").innerHTML = `<span class="err">Brak lokalnych plików dźwięku (${e.message}). Sample żyją tylko na Macu, nie w repo.</span>`;
    return;
  }
  buildKeyboard();
  fillFacts();
  setupMIDI();
}

function fillFacts() {
  const lo = samples[0], hi = samples[samples.length - 1];
  const nm = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const better = Math.round((1 - preset.loss / preset.startLoss) * 100);
  const knobs = Object.keys(preset.params).length;
  const knobWord = [2, 3, 4].includes(knobs % 10) && ![12, 13, 14].includes(knobs % 100) ? "gałki" : "gałek";
  $("facts").innerHTML = [
    `<span>Rozdzielenie: <b>Demucs 6 ścieżek</b> na Kaggle GPU</span>`,
    `<span>Nuty intro: <b>${introNotes.length}</b> (Basic Pitch)</span>`,
    `<span>A: <b>${samples.length} nagranych nut</b>, ${nm(lo.midi)} do ${nm(hi.midi)}</span>`,
    `<span>B: <b>${knobs} ${knobWord}</b>, ${preset.evals.toLocaleString("pl-PL")} prób, o ${better}% bliżej nagrania niż ręczny preset</span>`,
    `<span>Strój nagrania: <b>+${Math.round(preset.tune)} centów</b> (A = ${(440 * Math.pow(2, preset.tune / 1200)).toFixed(0)} Hz)</span>`,
  ].join("");
}

async function startAudio() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: "interactive" });
  master = ctx.createGain();
  master.gain.value = +$("vol").value;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 4;
  limiter.ratio.value = 16;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  master.connect(limiter).connect(ctx.destination);
  await ctx.audioWorklet.addModule("synth-worklet.js");
  synth = new AudioWorkletNode(ctx, "stem-synth", { numberOfInputs: 0, outputChannelCount: [2] });
  synth.connect(master);
  synth.port.postMessage({ type: "params", params: preset.params, gain: preset.gain * LEVEL, tune: preset.tune });

  const p = preset.params;
  aBus = ctx.createGain();
  aBus.connect(master);
  aDelay = ctx.createDelay(2);
  aDelay.delayTime.value = p.dlyTime;
  aDamp = ctx.createBiquadFilter();
  aDamp.type = "lowpass";
  aDamp.frequency.value = p.dlyDamp;
  aDamp.Q.value = 0.5;
  aFb = ctx.createGain();
  aFb.gain.value = p.dlyFb;
  aWet = ctx.createGain();
  aWet.gain.value = p.dlyMix;
  aBus.connect(aDelay);
  aDelay.connect(aDamp);
  aDamp.connect(aFb);
  aFb.connect(aDelay);
  aDamp.connect(aWet);
  aWet.connect(master);

  const decode = async (url) => ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  await Promise.all(samples.map(async (s) => {
    s.buffer = await decode(`sounds/${SONG}/${s.file}`);
    s.cleanBuffer = await decode(`sounds/${SONG}/${s.clean}`);
  }));
  origBuf = await decode(`sounds/${SONG}/original.m4a`);
  $("gate").classList.add("hidden");
}

function nearestSample(midi) {
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  return best;
}

function playA(midi, vel, at, clean) {
  const s = nearestSample(midi);
  const src = ctx.createBufferSource();
  src.buffer = clean ? s.cleanBuffer : s.buffer;
  src.playbackRate.value = Math.pow(2, (midi - s.midi) / 12);
  src.loop = true;
  src.loopStart = clean ? s.cLoopStart : s.loopStart;
  src.loopEnd = clean ? s.cLoopEnd : s.loopEnd;
  const g = ctx.createGain();
  g.gain.value = (0.35 + 0.65 * vel) * 0.9 * LEVEL;
  src.connect(g).connect(aBus);
  src.start(at);
  return {
    release(t) {
      g.gain.setTargetAtTime(0, t, preset.params.rel / 3);
      try { src.stop(t + preset.params.rel * 2 + 0.05); } catch {}
    },
    kill() {
      try { src.stop(); } catch {}
      g.disconnect();
    },
  };
}

function soundOn(midi, vel, at = 0) {
  if (mode !== "b") {
    voicesA.get(midi)?.release(at || ctx.currentTime);
    voicesA.set(midi, playA(midi, vel, at || ctx.currentTime, mode === "c"));
  } else {
    synth.port.postMessage({ type: "on", midi, vel, at });
  }
}

function soundOff(midi, at = 0) {
  const v = voicesA.get(midi);
  if (v) { v.release(at || ctx.currentTime); voicesA.delete(midi); }
  synth.port.postMessage({ type: "off", midi, at });
}

function noteOn(midi, vel) {
  if (!ctx || ctx.state !== "running") return;
  sustained.delete(midi);
  down.add(midi);
  soundOn(midi, vel);
  paintKey(midi, true);
}

function noteOff(midi) {
  if (!down.has(midi)) return;
  down.delete(midi);
  paintKey(midi, false);
  if (pedal) sustained.add(midi);
  else if (ctx) soundOff(midi);
}

function setPedal(on) {
  pedal = on;
  if (!on) {
    for (const m of sustained) if (!down.has(m)) soundOff(m);
    sustained.clear();
  }
}

function panic() {
  for (const [, v] of voicesA) v.release(ctx.currentTime);
  voicesA.clear();
  synth?.port.postMessage({ type: "panic" });
  for (const m of [...down]) paintKey(m, false);
  down.clear();
  sustained.clear();
}

function setMode(m) {
  if (m === mode) return;
  if (ctx) panic();
  mode = m;
  $("srcA").setAttribute("aria-pressed", m === "a");
  $("srcC").setAttribute("aria-pressed", m === "c");
  $("srcB").setAttribute("aria-pressed", m === "b");
  document.body.classList.toggle("b", m === "b");
}

function setEcho(on) {
  echoOn = on;
  if (!ctx) return;
  aWet.gain.setTargetAtTime(on ? preset.params.dlyMix : 0, ctx.currentTime, 0.02);
  aFb.gain.setTargetAtTime(on ? preset.params.dlyFb : 0, ctx.currentTime, 0.02);
  synth.port.postMessage({ type: "echo", on });
}

function stopDemo() {
  if (!demo) return;
  demo.src?.stop();
  demo.handles?.forEach((h) => h.kill());
  cancelAnimationFrame(demo.raf);
  document.querySelectorAll("[data-demo]").forEach((b) => b.classList.remove("on"));
  $("prog").style.width = "0";
  if (demo.kind !== "orig") panic();
  demo = null;
}

function playDemo(kind) {
  stopDemo();
  const t0 = ctx.currentTime + 0.08;
  const len = origBuf.duration;
  demo = { kind, t0, len, handles: [] };
  if (kind === "orig") {
    const src = ctx.createBufferSource();
    src.buffer = origBuf;
    const g = ctx.createGain();
    g.gain.value = ORIG_LEVEL;
    src.connect(g).connect(master);
    src.start(t0);
    demo.src = src;
  } else {
    for (const n of introNotes) {
      const on = t0 + n.t, off = on + n.dur;
      if (kind !== "b") {
        const h = playA(n.midi, n.vel, on, kind === "c");
        h.release(off);
        demo.handles.push(h);
      } else {
        synth.port.postMessage({ type: "on", midi: n.midi, vel: n.vel, at: on });
        synth.port.postMessage({ type: "off", midi: n.midi, at: off });
      }
    }
  }
  document.querySelector(`[data-demo="${kind}"]`).classList.add("on");
  const tick = () => {
    const f = (ctx.currentTime - t0) / len;
    $("prog").style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
    if (f < 1.05) demo.raf = requestAnimationFrame(tick);
    else stopDemo();
  };
  demo.raf = requestAnimationFrame(tick);
}

function buildKeyboard() {
  const kb = $("kb");
  const whites = [];
  for (let m = LO; m <= HI; m++) if (!isBlack(m)) whites.push(m);
  const W = 100 / whites.length;
  const sampled = new Set(samples.map((s) => s.midi));
  whites.forEach((m) => {
    const el = document.createElement("div");
    el.className = "wk";
    el.dataset.midi = m;
    if (m % 12 === 0) el.innerHTML = `<span class="name">C${m / 12 - 1}</span>`;
    if (sampled.has(m)) el.insertAdjacentHTML("beforeend", `<span class="mark"></span>`);
    kb.appendChild(el);
  });
  for (let m = LO; m <= HI; m++) {
    if (!isBlack(m)) continue;
    const idx = whites.indexOf(m + 1);
    const el = document.createElement("div");
    el.className = "bk";
    el.dataset.midi = m;
    el.style.left = `calc(${idx * W}% - ${W * 0.3}%)`;
    el.style.width = `${W * 0.6}%`;
    if (sampled.has(m)) el.innerHTML = `<span class="mark"></span>`;
    kb.appendChild(el);
  }
  const ptr = new Map();
  const keyAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-midi]");
    return el && kb.contains(el) ? +el.dataset.midi : null;
  };
  kb.addEventListener("pointerdown", async (e) => {
    e.preventDefault();
    await startAudio();
    const m = keyAt(e);
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

function paintKey(midi, on) {
  document.querySelector(`[data-midi="${midi}"]`)?.classList.toggle("down", on);
}

const KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ";": 16 };
const typed = new Map();
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "z" || k === "x") {
    octave = Math.max(36, Math.min(84, octave + (k === "z" ? -12 : 12)));
    $("octName").textContent = "C" + (octave / 12 - 1);
    return;
  }
  if (!(k in KEYS) || !ctx) return;
  const m = octave + KEYS[k];
  typed.set(k, m);
  noteOn(m, 0.8);
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (typed.has(k)) { noteOff(typed.get(k)); typed.delete(k); }
});

function setupMIDI() {
  const name = $("midiName"), pill = $("midiPill");
  if (!navigator.requestMIDIAccess) { name.textContent = "ta przeglądarka nie ma MIDI (użyj Chrome)"; return; }
  navigator.requestMIDIAccess().then((access) => {
    const refresh = () => {
      const ins = [...access.inputs.values()];
      ins.forEach((i) => { i.onmidimessage = onMidi; });
      name.textContent = ins.length ? ins.map((i) => i.name).join(", ") : "podłącz klawiaturę";
      pill.classList.toggle("live", ins.length > 0);
    };
    access.onstatechange = refresh;
    refresh();
  }, () => { name.textContent = "brak dostępu"; });
}

function onMidi(e) {
  const [st, d1, d2] = e.data;
  const type = st & 0xf0;
  if (type === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) noteOff(d1);
  else if (type === 0xb0 && d1 === 64) setPedal(d2 >= 64);
}

$("gateBtn").addEventListener("click", startAudio);
$("srcA").addEventListener("click", () => setMode("a"));
$("srcB").addEventListener("click", () => setMode("b"));
$("srcC").addEventListener("click", () => setMode("c"));
$("echo").addEventListener("change", (e) => setEcho(e.target.checked));
$("vol").addEventListener("input", (e) => { if (master) master.gain.setTargetAtTime(+e.target.value, ctx.currentTime, 0.02); });
$("stop").addEventListener("click", stopDemo);
document.querySelectorAll("[data-demo]").forEach((b) => b.addEventListener("click", async () => {
  await startAudio();
  playDemo(b.dataset.demo);
}));
boot();
