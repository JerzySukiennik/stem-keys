# Stem Keys: cut the fit target phrase and its cleaned notes for the synth fitter.
import json, sys
import numpy as np, soundfile as sf, librosa
stem, notes_path, out_dir, t0, t1 = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
SR = 16000
x, sr = sf.read(stem, dtype="float32", start=int(t0 * 44100), stop=int(t1 * 44100))
y = librosa.resample(x.mean(1), orig_sr=sr, target_sr=SR).astype(np.float32)
sf.write(f"{out_dir}/target.wav", y, SR, subtype="FLOAT")
n = json.load(open(notes_path))
keep = []
for a in n:
    echo = any(b["midi"] == a["midi"] and abs(a["t"] - b["t"] - 0.487) < 0.03 and a["amp"] < b["amp"] for b in n)
    if echo:
        continue
    if a["t"] < t0 - 0.6 or a["t"] >= t1:
        continue
    keep.append({"t": round(a["t"] - t0, 4), "dur": max(0.06, a["dur"]), "midi": a["midi"], "vel": round(min(1, max(0.2, a["amp"] / 0.8)), 3)})
keep = [k for k in keep if k["t"] + k["dur"] > 0]
json.dump({"sr": SR, "len": len(y), "notes": keep}, open(f"{out_dir}/fitdata.json", "w"))
print("kept", len(keep), "of", len(n), "len", len(y) / SR)
