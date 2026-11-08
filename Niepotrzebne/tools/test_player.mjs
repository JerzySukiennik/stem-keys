// Stem Keys: headless Chrome check of a built song player opened straight from disk (file://).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire("/Users/jurek/openclaw/node_modules/");
const { chromium } = require("playwright-core");

const [file, shot = "player.png", w = "1280", h = "1000"] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
await page.waitForTimeout(600);
const report = await page.evaluate(async () => {
  const r = { title: document.title, sounds: document.querySelectorAll(".sound").length, keys: document.querySelectorAll(".kb [data-midi]").length };
  document.getElementById("gateBtn").click();
  await new Promise((res) => setTimeout(res, 2500));
  r.gateHidden = document.getElementById("gate").classList.contains("hidden");
  r.ctx = typeof ctx !== "undefined" && ctx ? ctx.state : "none";
  const out = [];
  for (const c of SONG.candidates) {
    const inst = new AplusInstrument(ctx, c, SONG.tune || 0);
    const t0 = performance.now();
    const mid = Math.round((c.range[0] + c.range[1]) / 2);
    const k = inst.render(mid);
    const lo = inst.render(c.stem === "bass" ? 28 : 40);
    const hi = inst.render(c.stem === "bass" ? 55 : 88);
    const ms = Math.round((performance.now() - t0) / 3);
    const d = k.buf.getChannelData(0);
    let e = 0, nan = 0, pk = 0;
    for (const v of d) { e += v * v; if (!Number.isFinite(v)) nan++; pk = Math.max(pk, Math.abs(v)); }
    let jump = 0;
    if (!k.decay) {
      const sr = ctx.sampleRate, a = Math.round(k.ls * sr), b = Math.round(k.le * sr);
      jump = Math.abs(d[b - 1] - d[a - 1]);
    }
    out.push({ name: c.name, notes: c.aplus.notes.length, decay: k.decay, msPerKey: ms, rms: +Math.sqrt(e / d.length).toFixed(3), peak: +pk.toFixed(3), nan, loopJump: +jump.toFixed(4), lowLen: +lo.buf.duration.toFixed(2), highLen: +hi.buf.duration.toFixed(2), bLoss: +c.b.loss.toFixed(2), bPrior: +c.b.priorLoss.toFixed(2) });
  }
  r.candidates = out;
  const oc = new OfflineAudioContext(2, 44100, 44100);
  await oc.audioWorklet.addModule("data:text/javascript;charset=utf-8," + encodeURIComponent(WORKLET_SRC));
  const n = new AudioWorkletNode(oc, "stem-synth", { numberOfInputs: 0, outputChannelCount: [2] });
  n.connect(oc.destination);
  n.port.postMessage({ type: "params", params: SONG.candidates[0].b.params, gain: 1, tune: SONG.tune });
  await new Promise((res) => setTimeout(res, 50));
  n.port.postMessage({ type: "on", midi: 64, vel: 0.8, at: 0.05 });
  const buf = await oc.startRendering();
  let e = 0;
  for (const v of buf.getChannelData(0)) e += v * v;
  r.bWorkletRms = +Math.sqrt(e / 44100).toFixed(4);
  const band = document.getElementById("band");
  await new Promise((res) => { if (band.readyState >= 1) res(); else band.addEventListener("loadedmetadata", res, { once: true }); setTimeout(res, 4000); });
  r.band = { src: decodeURIComponent(band.src.split("/").slice(-2).join("/")), duration: band.duration, without: document.getElementById("bandWithout").textContent };
  await band.play().catch((err) => (r.bandErr = err.message));
  await new Promise((res) => setTimeout(res, 800));
  r.band.playing = !band.paused && band.currentTime > 0;
  band.pause();
  const prev = document.querySelector(".orig");
  prev.click();
  await new Promise((res) => setTimeout(res, 1200));
  r.previewOn = prev.classList.contains("on");
  prev.click();
  r.midiApi = !!navigator.requestMIDIAccess;
  r.mode = document.querySelector("#modes [aria-checked=true]")?.dataset.mode;
  r.hands = [...document.querySelectorAll(".hand")].map((x) => x.dataset.hand + ":" + x.querySelector(".hand-sound").textContent.trim().slice(0, 40));
  return r;
});
await page.screenshot({ path: shot, fullPage: true });
console.log(JSON.stringify(report, null, 1));
console.log(logs.slice(-30).join("\n"));
await browser.close();
