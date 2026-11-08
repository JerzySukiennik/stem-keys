# Stem Keys: spectrogram grid of cut samples.
import json, sys
import numpy as np, soundfile as sf, librosa, librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
d, out = sys.argv[1], sys.argv[2]
S = json.load(open(d + "/samples.json"))
fig, axes = plt.subplots(3, 6, figsize=(24, 9))
for ax, s in zip(axes.flat, S):
    y, sr = sf.read(d + "/" + s["file"], dtype="float32")
    y = librosa.resample(y.mean(1), orig_sr=sr, target_sr=22050)
    C = librosa.amplitude_to_db(np.abs(librosa.cqt(y, sr=22050, hop_length=128, fmin=librosa.note_to_hz("C2"), n_bins=72)), ref=np.max)
    librosa.display.specshow(C, sr=22050, hop_length=128, x_axis="time", y_axis="cqt_note", fmin=librosa.note_to_hz("C2"), ax=ax, vmin=-50)
    ax.set_title(f'{librosa.midi_to_note(s["midi"])} score {s["score"]}')
plt.tight_layout()
plt.savefig(out, dpi=45)
