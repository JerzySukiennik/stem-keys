# Stem Keys: Kaggle pipeline, one song in, playable instrument data and backing tracks out.
import base64, glob, json, os, pathlib, subprocess, sys, time

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def sh(cmd):
    subprocess.run(cmd, shell=True, check=True)


IN = os.path.dirname(glob.glob("/kaggle/input/**/song.flac", recursive=True)[0])
W = "/tmp/sk"
OUT = "/kaggle/working"
os.makedirs(W, exist_ok=True)
META = json.load(open(f"{IN}/meta.json"))

sh(f"{sys.executable} -m pip install -q demucs mir_eval pretty_midi 'resampy<0.4.3' onnxruntime 'setuptools<81'")
sh(f"{sys.executable} -m pip install -q --no-deps basic-pitch==0.4.0")
sh("curl -sL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar -xJ -C /tmp")
NODE = "/tmp/node-v22.11.0-linux-x64/bin/node"
CODE = f"{W}/code"
os.makedirs(CODE, exist_ok=True)
for f in ["synth-core.js", "specloss.mjs", "fit.mjs"]:
    sh(f"cp '{IN}/{f}' '{CODE}/{f}'")
open(f"{CODE}/package.json", "w").write('{"type": "module"}')
log("deps ready")

import numpy as np
import soundfile as sf
import torch
import librosa
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

wav, SR = sf.read(f"{IN}/song.flac", dtype="float32", always_2d=True)
assert SR == 44100
from demucs.apply import apply_model
from demucs.pretrained import get_model

model = get_model("htdemucs_6s").to("cuda" if torch.cuda.is_available() else "cpu").eval()
x = torch.from_numpy(wav.T.copy())
ref = x.mean(0)
mu, sd = ref.mean(), ref.std()
with torch.no_grad():
    sep = apply_model(model, ((x - mu) / sd)[None].to(next(model.parameters()).device), shifts=2 if torch.cuda.is_available() else 1, split=True, overlap=0.25, progress=False)[0]
sep = (sep * sd + mu).cpu().numpy()
STEMS = {name: sep[i] for i, name in enumerate(model.sources)}
del model, sep, x
torch.cuda.empty_cache()
DUR = wav.shape[0] / SR
log("separated", list(STEMS), round(DUR, 1), "s")

HOP_S, WIN_S = 0.5, 1.0
LABEL = {"piano": "Klawisze", "other": "Syntezator", "bass": "Bas"}


def activity(mono):
    r = librosa.feature.rms(y=mono, frame_length=int(WIN_S * SR), hop_length=int(HOP_S * SR), center=False)[0]
    return 20 * np.log10(r + 1e-9)


import basic_pitch
from basic_pitch.inference import predict

ONNX = pathlib.Path(basic_pitch.__file__).parent / "saved_models/icassp_2022/nmp.onnx"


def transcribe(name, mono):
    p = f"{W}/{name}.wav"
    sf.write(p, mono, SR)
    fmin, fmax = (28, 520) if name == "bass" else (60, 3000)
    _, _, notes = predict(p, ONNX, onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=60,
                          minimum_frequency=fmin, maximum_frequency=fmax, multiple_pitch_bends=False, melodia_trick=True)
    return sorted([{"t": float(s), "dur": float(e - s), "midi": int(m), "amp": float(a)} for s, e, m, a, _ in notes], key=lambda n: n["t"])


def find_echo(notes):
    by = {}
    for n in notes:
        by.setdefault(n["midi"], []).append(n)
    lags = []
    for ns in by.values():
        for i, a in enumerate(ns):
            for b in ns[i + 1:i + 6]:
                d = b["t"] - a["t"]
                if 0.15 < d < 0.8 and b["amp"] < a["amp"] * 0.9:
                    lags.append(d)
    if len(lags) < 10:
        return None
    h, e = np.histogram(lags, bins=np.arange(0.15, 0.81, 0.01))
    k = int(np.argmax(h))
    nz = h[h > 0]
    if h[k] < max(8, 0.06 * len(notes)) or h[k] < 3 * np.median(nz):
        return None
    return float((e[k] + e[k + 1]) / 2)


def mark_echo(notes, lag):
    for a in notes:
        a["echo"] = False
    if not lag:
        return
    for a in notes:
        for b in notes:
            if b is not a and b["midi"] == a["midi"] and abs(a["t"] - b["t"] - lag) < 0.03 and a["amp"] < b["amp"]:
                a["echo"] = True
                break


def regions_of(win_idx):
    out = []
    for i in sorted(win_idx):
        t0, t1 = i * HOP_S, i * HOP_S + WIN_S
        if out and t0 <= out[-1][1] + 0.01:
            out[-1][1] = t1
        else:
            out.append([t0, t1])
    return out


def in_regions(t, regs):
    return any(a <= t < b for a, b in regs)


def discover(name, mono, notes, act):
    thr = max(np.percentile(act, 95) - 25, -50)
    idx = np.where(act > thr)[0]
    if len(idx) < 12:
        return []
    if name == "bass":
        return [idx]
    y = librosa.resample(mono, orig_sr=SR, target_sr=22050)
    mf = librosa.feature.mfcc(y=y, sr=22050, n_mfcc=20, hop_length=512)
    ft = librosa.frames_to_time(np.arange(mf.shape[1]), sr=22050, hop_length=512)
    feats = []
    for i in idx:
        t0, t1 = i * HOP_S, i * HOP_S + WIN_S
        sel = (ft >= t0) & (ft < t1)
        ns = [n for n in notes if t0 <= n["t"] < t1]
        mdur = float(np.median([n["dur"] for n in ns])) if ns else 0.0
        feats.append(np.concatenate([mf[1:, sel].mean(1), [len(ns), mdur]]))
    X = StandardScaler().fit_transform(np.array(feats))
    X[:, -2:] *= 0.7
    labels, best = np.zeros(len(idx), int), 0.18
    for k in (2, 3, 4):
        if len(idx) < k * 16:
            break
        lab = KMeans(k, n_init=10, random_state=0).fit_predict(X)
        s = silhouette_score(X, lab)
        if s > best:
            best, labels = s, lab
    sm = labels.copy()
    for j in range(len(labels)):
        sm[j] = np.bincount(labels[max(0, j - 2):j + 3]).argmax()
    groups = [idx[sm == c] for c in np.unique(sm) if (sm == c).sum() >= 16]
    return groups or [idx]


def kind_of(notes):
    if not notes:
        return "riff"
    md = float(np.median([n["dur"] for n in notes]))
    ends = sorted([(n["t"], 1) for n in notes] + [(n["t"] + n["dur"], -1) for n in notes])
    cur, poly, last, tot = 0, 0.0, ends[0][0], 0.0
    for t, d in ends:
        if cur > 0:
            poly += cur * (t - last)
            tot += t - last
        cur += d
        last = t
    poly = poly / tot if tot else 1
    if md > 0.6:
        return "pad"
    if poly > 2.4:
        return "akordy"
    return "riff"


def mmss(t):
    return f"{int(t // 60)}:{int(t % 60):02d}"


def f0_refine(seg, midi):
    f_nom = librosa.midi_to_hz(midi)
    n = len(seg)
    spec = np.abs(np.fft.rfft(seg * np.hanning(n), 1 << 17))
    fr = np.fft.rfftfreq(1 << 17, 1 / SR)
    est, wts = [], []
    for k in range(1, 6):
        lo, hi = k * f_nom * 2 ** (-0.6 / 12), k * f_nom * 2 ** (0.6 / 12)
        ii = np.where((fr >= lo) & (fr <= hi))[0]
        if len(ii) < 3:
            continue
        j = ii[np.argmax(spec[ii])]
        a, b, c = spec[j - 1], spec[j], spec[j + 1]
        off = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        est.append((fr[j] + off * (fr[1] - fr[0])) / k)
        wts.append(b)
    return float(np.average(est, weights=wts)) if est else float(f_nom)


def aplus_model(mono, notes, is_bass):
    pool = [n for n in notes if not n.get("echo") and n["dur"] >= 0.08]

    def score(a):
        crowd = sum(b["amp"] for b in pool if b is not a and -0.04 < b["t"] - a["t"] < 0.3 and b["midi"] % 12 != a["midi"] % 12)
        return a["amp"] - (0.15 if is_bass else 0.35) * crowd + 0.3 * min(a["dur"], 0.4)

    best = {}
    for a in pool:
        s = score(a)
        if a["midi"] not in best or s > best[a["midi"]][0]:
            best[a["midi"]] = (s, a)
    chosen = sorted(best.values(), key=lambda v: -v[0])
    good = [v for v in chosen if v[0] > -0.3]
    chosen = (good if len(good) >= 4 else chosen[:6])[:24]
    L = 1.0 if is_bass else 0.8
    hop = 441
    out = []
    for s, a in sorted(chosen, key=lambda v: v[1]["midi"]):
        i0 = max(0, int((a["t"] - 0.01) * SR))
        seg = mono[i0:i0 + int(L * SR)]
        if len(seg) < int(0.5 * SR):
            continue
        f0 = f0_refine(seg[: int(0.5 * SR)], a["midi"])
        K = int(min(40, 9000 / f0))
        St = np.abs(librosa.stft(seg, n_fft=8192 if is_bass else 4096, hop_length=hop))
        nfft = 8192 if is_bass else 4096
        freqs = librosa.fft_frequencies(sr=SR, n_fft=nfft)
        amps = np.zeros((K, St.shape[1]), np.float32)
        wsum = np.hanning(nfft).sum()
        for k in range(1, K + 1):
            fk = k * f0
            band = np.where(np.abs(freqs - fk) <= max(5.0, fk * 0.012))[0]
            if len(band):
                amps[k - 1] = St[band].max(0) * 2 / wsum
        ker = np.ones(3) / 3
        amps = np.array([np.convolve(r, ker, mode="same") for r in amps])
        peak = float(amps.max()) + 1e-9
        db = 20 * np.log10(amps / peak + 1e-9)
        q = np.clip(np.round((db + 90) / 90 * 255), 0, 255).astype(np.uint8)
        e = 10 * np.log10((amps ** 2).sum(0) + 1e-12)
        tt = np.arange(len(e)) * hop / SR
        sel = (tt > 0.15) & (tt < L - 0.05)
        slope = float(np.polyfit(tt[sel], e[sel], 1)[0]) if sel.sum() > 5 else 0.0
        decay = slope < -12
        slopes = []
        if decay:
            for k in range(K):
                v = db[k, sel]
                slopes.append(round(float(np.clip(np.polyfit(tt[sel], v, 1)[0], -90, 0)), 1))
        out.append({"midi": a["midi"], "f0": round(f0, 3), "K": K, "frames": int(St.shape[1]), "amps": base64.b64encode(q.T.tobytes()).decode(),
                    "peak": peak, "decay": bool(decay), "slopes": slopes, "cents": round(1200 * np.log2(f0 / librosa.midi_to_hz(a["midi"])), 1), "score": round(float(s), 3)})
    return out


KEYS_PRIOR = json.load(open(f"{IN}/priors.json"))["keys"]
BASS_PRIOR = json.load(open(f"{IN}/priors.json"))["bass"]


def fit_b(cid, mono, notes, regs, is_bass, echo_lag):
    span = 3.5
    best, best_s = None, -1
    for n in notes:
        s = n["t"] - 0.2
        if s < 0 or not in_regions(s, regs) or not in_regions(min(s + span, DUR - 0.01) - 0.01, regs):
            continue
        ns = [m for m in notes if s <= m["t"] < s + span and not m.get("echo")]
        v = len(ns) * (np.mean([m["amp"] for m in ns]) if ns else 0)
        if v > best_s:
            best, best_s = s, v
    if best is None:
        best = regs[0][0]
    s0 = best
    d = f"{W}/fit_{cid}"
    os.makedirs(d, exist_ok=True)
    seg = mono[int(s0 * SR):int((s0 + span) * SR)]
    y = librosa.resample(seg, orig_sr=SR, target_sr=16000).astype(np.float32)
    sf.write(f"{d}/target.wav", y, 16000, subtype="FLOAT")
    ns = [{"t": round(m["t"] - s0, 4), "dur": max(0.06, m["dur"]), "midi": m["midi"], "vel": round(min(1, max(0.2, m["amp"] / 0.8)), 3)}
          for m in notes if s0 - 0.6 <= m["t"] < s0 + span and not m.get("echo")]
    ns = [m for m in ns if m["t"] + m["dur"] > 0]
    json.dump({"sr": 16000, "len": len(y), "notes": ns}, open(f"{d}/fitdata.json", "w"))
    prior = dict(BASS_PRIOR if is_bass else KEYS_PRIOR)
    if echo_lag:
        prior["dlyTime"] = min(0.7, max(0.3, echo_lag if echo_lag >= 0.3 else echo_lag * 2))
    env = dict(os.environ, SYNTH_CORE=f"file://{CODE}/synth-core.js", START="0", START_PARAMS=json.dumps(prior))
    r = subprocess.run([NODE, f"{CODE}/fit.mjs", d, "3000", str(os.cpu_count()), "fit.json"], env=env, capture_output=True, text=True)
    print(r.stdout[-400:], r.stderr[-400:], flush=True)
    res = json.load(open(f"{d}/fit.json"))
    return {"params": res["params"], "loss": res["loss"], "priorLoss": res["startLoss"], "phrase": [round(s0, 2), round(s0 + span, 2)]}


def encode(path_wav, path_out, kbps):
    sh(f"ffmpeg -hide_banner -loglevel error -y -i '{path_wav}' -c:a aac -b:a {kbps}k '{path_out}'")


candidates, used_stems, tunes = [], set(), []
for name in ["other", "piano", "bass"]:
    mono = STEMS[name].mean(0)
    act = activity(mono)
    p95 = float(np.percentile(act, 95))
    log(name, "p95 dB", round(p95, 1))
    if p95 < -45:
        continue
    notes = transcribe(name, mono)
    lag = find_echo(notes)
    mark_echo(notes, lag)
    log(name, "notes", len(notes), "echo", lag)
    for g in discover(name, mono, notes, act):
        regs = regions_of(g)
        ns = [n for n in notes if in_regions(n["t"], regs)]
        if len([n for n in ns if not n["echo"]]) < 12:
            continue
        candidates.append({"stem": name, "regs": regs, "notes": ns, "echo": lag, "mono": mono, "size": len(g) * (10 ** (np.median(act[g]) / 20))})

bass = [c for c in candidates if c["stem"] == "bass"][:1]
keys = sorted([c for c in candidates if c["stem"] != "bass"], key=lambda c: -c["size"])[: 6 - len(bass)]
candidates = keys + bass
log("candidates", [(c["stem"], len(c["notes"]), c["regs"][0]) for c in candidates])

result = {"meta": META, "duration": DUR, "candidates": [], "mixes": {}}
names_seen = {}
for i, c in enumerate(candidates):
    is_bass = c["stem"] == "bass"
    model_notes = aplus_model(c["mono"], c["notes"], is_bass)
    if len(model_notes) < 3:
        log("skip", i, "too few A+ notes")
        continue
    tunes += [n["cents"] for n in model_notes]
    b = fit_b(i, c["mono"], c["notes"], c["regs"], is_bass, c["echo"])
    kind = "linia" if is_bass else kind_of([n for n in c["notes"] if not n["echo"]])
    first = c["regs"][0][0]
    nm = f"{LABEL[c['stem']]} · {kind}"
    names_seen[nm] = names_seen.get(nm, 0) + 1
    p0 = max(0.0, b["phrase"][0] - 0.5)
    prev = f"prev_{i}.m4a"
    sf.write(f"{W}/prev.wav", STEMS[c["stem"]][:, int(p0 * SR):int((p0 + 6) * SR)].T, SR)
    encode(f"{W}/prev.wav", f"{OUT}/{prev}", 128)
    lo = min(n["midi"] for n in c["notes"])
    hi = max(n["midi"] for n in c["notes"])
    result["candidates"].append({
        "id": i, "stem": c["stem"], "name": nm, "kind": kind, "from": mmss(first), "regions": [[round(a, 2), round(b2, 2)] for a, b2 in c["regs"]],
        "range": [lo, hi], "echo": c["echo"], "preview": prev, "previewAt": round(p0, 2), "aplus": {"hop": 441 / SR, "notes": model_notes}, "b": b,
    })
    used_stems.add(c["stem"])
    log("candidate", i, nm, "A+ notes", len(model_notes), "B loss", round(b["loss"], 2), "from", round(b["priorLoss"], 2))

for r in result["candidates"]:
    if names_seen[r["name"]] > 1:
        r["name"] = f"{r['name']} (od {r['from']})"
result["tune"] = float(np.median(tunes)) if tunes else 0.0

order = [s for s in ["bass", "piano", "other"] if s in used_stems]
full = sum(STEMS.values())
for mask in range(1 << len(order)):
    muted = [order[j] for j in range(len(order)) if mask >> j & 1]
    mix = full - sum((STEMS[m] for m in muted), np.zeros_like(full))
    key = "-".join(muted) if muted else "full"
    sf.write(f"{W}/mix.wav", np.clip(mix.T, -1, 1), SR)
    encode(f"{W}/mix.wav", f"{OUT}/mix_{key}.m4a", 160)
    result["mixes"][key] = f"mix_{key}.m4a"
log("mixes", list(result["mixes"]))
json.dump(result, open(f"{OUT}/result.json", "w"))
log("done")
