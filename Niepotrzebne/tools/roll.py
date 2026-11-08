# Stem Keys: detailed piano-roll spectrogram with an onset curve.
import sys
import numpy as np, soundfile as sf, librosa, librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
out, f, t0, t1 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
x, sr = sf.read(f, dtype="float32", start=int(t0 * 44100), stop=int(t1 * 44100))
y = librosa.resample(x.mean(1), orig_sr=sr, target_sr=22050)
hop = 128
C = np.abs(librosa.cqt(y, sr=22050, hop_length=hop, fmin=librosa.note_to_hz("C3"), n_bins=48, bins_per_octave=12))
D = librosa.amplitude_to_db(C, ref=np.max)
on = librosa.onset.onset_strength(y=y, sr=22050, hop_length=hop)
fig, (a, b) = plt.subplots(2, 1, figsize=(26, 9), gridspec_kw={"height_ratios": [4, 1]}, sharex=True)
librosa.display.specshow(D, sr=22050, hop_length=hop, x_axis="time", y_axis="cqt_note", fmin=librosa.note_to_hz("C3"), bins_per_octave=12, ax=a, vmin=-40)
a.set_yticks(librosa.note_to_hz([f"{n}{o}" for o in range(3, 7) for n in ["C", "E", "G"]]))
a.grid(True, axis="x", alpha=0.3)
t = librosa.frames_to_time(np.arange(len(on)), sr=22050, hop_length=hop)
b.plot(t, on)
b.set_xticks(np.arange(0, t1 - t0, 0.25))
b.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig(out, dpi=55)
