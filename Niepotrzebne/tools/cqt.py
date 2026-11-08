# Stem Keys: note-scale spectrograms of stems for visual inspection.
import sys
import numpy as np, soundfile as sf, librosa, librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
out, t0, t1 = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
files = sys.argv[4:]
fig, axes = plt.subplots(len(files), 1, figsize=(18, 4.2 * len(files)))
axes = np.atleast_1d(axes)
for ax, f in zip(axes, files):
    x, sr = sf.read(f, dtype="float32", start=int(t0 * 44100), stop=int(t1 * 44100))
    y = librosa.resample(x.mean(1), orig_sr=sr, target_sr=22050)
    C = librosa.amplitude_to_db(np.abs(librosa.cqt(y, sr=22050, hop_length=256, fmin=librosa.note_to_hz("C2"), n_bins=72, bins_per_octave=12)), ref=np.max)
    librosa.display.specshow(C, sr=22050, hop_length=256, x_axis="time", y_axis="cqt_note", fmin=librosa.note_to_hz("C2"), bins_per_octave=12, ax=ax, vmin=-60)
    ax.set_title(f.split("/")[-1])
plt.tight_layout()
plt.savefig(out, dpi=60)
