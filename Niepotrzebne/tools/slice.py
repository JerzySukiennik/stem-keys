# Stem Keys: cut playable one-shot samples from a separated stem, cleaned with a harmonic mask.
import json, os, sys
import numpy as np, soundfile as sf, librosa

stem, notes_path, out_dir, t0, t1 = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
os.makedirs(out_dir, exist_ok=True)
x, sr = sf.read(stem, dtype="float32", always_2d=True)
notes = json.load(open(notes_path))
notes = [n for n in notes if t0 <= n["t"] < t1]
clean = [a for a in notes if not any(b["midi"] == a["midi"] and abs(a["t"] - b["t"] - 0.487) < 0.03 and a["amp"] < b["amp"] for b in notes)]

def score(a):
    crowd = sum(b["amp"] for b in clean if b is not a and -0.04 < b["t"] - a["t"] < 0.3 and b["midi"] % 12 != a["midi"] % 12)
    return a["amp"] - 0.35 * crowd + 0.3 * min(a["dur"], 0.4)

L, N_FFT, HOP = 0.7, 2048, 256
best = {}
for a in clean:
    if not 50 <= a["midi"] <= 81 or a["dur"] < 0.1:
        continue
    s = score(a)
    if a["midi"] not in best or s > best[a["midi"]][0]:
        best[a["midi"]] = (s, a)

freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
out = []
for midi, (s, a) in sorted(best.items()):
    i0 = int((a["t"] - 0.012) * sr)
    seg = x[i0:i0 + int(L * sr)].T
    f0 = librosa.midi_to_hz(midi)
    mask = np.zeros_like(freqs)
    for k in range(1, int(9000 / f0) + 1):
        fk = k * f0
        width = max(14.0, fk * 0.012)
        mask = np.maximum(mask, np.exp(-0.5 * ((freqs - fk) / width) ** 2))
    chans = []
    for ch in seg:
        S = librosa.stft(ch, n_fft=N_FFT, hop_length=HOP)
        chans.append(librosa.istft(S * mask[:, None], hop_length=HOP, length=len(ch)))
    y = np.stack(chans)
    ls, le, xf = int(0.18 * sr), int(0.55 * sr), int(0.08 * sr)
    w = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    y[:, le - xf:le] = y[:, le - xf:le] * (1 - w) + y[:, ls - xf:ls] * w
    fade_in, fade_out = int(0.003 * sr), int(0.05 * sr)
    y[:, :fade_in] *= np.linspace(0, 1, fade_in)
    y[:, -fade_out:] *= np.linspace(1, 0, fade_out)
    rms = np.sqrt(np.mean(y[:, : int(0.2 * sr)] ** 2)) + 1e-9
    y *= 0.12 / rms
    peak = np.abs(y).max()
    if peak > 0.95:
        y *= 0.95 / peak
    if s < -0.3:
        continue
    name = f"a_{midi}.wav"
    sf.write(os.path.join(out_dir, name), y.T, sr, subtype="PCM_16")
    out.append({"midi": midi, "file": name, "t": a["t"], "score": round(s, 3), "loopStart": ls / sr, "loopEnd": le / sr})
    print(midi, librosa.midi_to_note(midi), "t", a["t"], "score", round(s, 2))

json.dump(out, open(os.path.join(out_dir, "samples.json"), "w"), indent=1)
intro = [{"t": round(n["t"] - t0, 4), "dur": max(0.06, n["dur"]), "midi": n["midi"], "vel": round(min(1, max(0.2, n["amp"] / 0.8)), 3)} for n in clean]
json.dump(intro, open(os.path.join(out_dir, "intro-notes.json"), "w"))
import subprocess
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(t0), "-t", str(t1 - t0), "-i", stem, "-af", "afade=t=out:st=%.2f:d=0.4" % (t1 - t0 - 0.4), "-c:a", "aac", "-b:a", "192k", os.path.join(out_dir, "original.m4a")], check=True)
print(len(out), "samples,", len(intro), "intro notes")
