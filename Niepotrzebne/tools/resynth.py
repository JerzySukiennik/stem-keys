# Stem Keys: rebuild each cut note from its own harmonics only, so no background of the song remains.
import json, os, sys
import numpy as np, soundfile as sf, librosa

d = sys.argv[1]
S = json.load(open(os.path.join(d, "samples.json")))
N_FFT, HOP = 4096, 256
win_sum = np.hanning(N_FFT).sum()
rng = np.random.default_rng(7)
cents = []
for s in S:
    y, sr = sf.read(os.path.join(d, s["file"]), dtype="float32")
    m = y.mean(1)
    f_nom = librosa.midi_to_hz(s["midi"])
    seg = m[: int(0.5 * sr)] * np.hanning(int(0.5 * sr))
    NF = 1 << 16
    spec = np.abs(np.fft.rfft(seg, NF))
    fr = np.fft.rfftfreq(NF, 1 / sr)
    est, wts = [], []
    for k in range(1, 6):
        lo, hi = k * f_nom * 2 ** (-0.6 / 12), k * f_nom * 2 ** (0.6 / 12)
        idx = np.where((fr >= lo) & (fr <= hi))[0]
        if not len(idx):
            continue
        j = idx[np.argmax(spec[idx])]
        a, b, c = spec[j - 1], spec[j], spec[j + 1]
        off = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        est.append((fr[j] + off * (fr[1] - fr[0])) / k)
        wts.append(b)
    f0 = float(np.average(est, weights=wts)) if est else f_nom
    cents.append(1200 * np.log2(f0 / f_nom))
    St = np.abs(librosa.stft(m, n_fft=N_FFT, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    nfr = St.shape[1]
    K = int(min(9000, sr / 2 - 500) / f0)
    env = np.zeros((K, nfr), np.float32)
    for k in range(1, K + 1):
        fk = k * f0
        band = np.where(np.abs(freqs - fk) <= max(8.0, fk * 0.012))[0]
        if len(band):
            env[k - 1] = St[band].max(0) * 2 / win_sum
    ker = np.ones(5) / 5
    env = np.array([np.convolve(e, ker, mode="same") for e in env])
    n = len(m)
    t_fr = np.arange(nfr) * HOP
    out = np.zeros((2, n), np.float32)
    tt = np.arange(n) / sr
    for k in range(1, K + 1):
        a = np.interp(np.arange(n), t_fr, env[k - 1])
        if a.max() < 1e-5:
            continue
        ph = rng.uniform(0, 2 * np.pi, 2)
        if k == 1:
            ph[1] = ph[0]
        w = 2 * np.pi * k * f0 * tt
        out[0] += a * np.sin(w + ph[0])
        out[1] += a * np.sin(w + ph[1])
    ls, xf = int(s["loopStart"] * sr), int(0.08 * sr)
    le = ls + int(round(round((s["loopEnd"] - s["loopStart"]) * f0) / f0 * sr))
    s["cLoopStart"], s["cLoopEnd"] = ls / sr, le / sr
    wv = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    out[:, le - xf:le] = out[:, le - xf:le] * (1 - wv) + out[:, ls - xf:ls] * wv
    fi, fo = int(0.003 * sr), int(0.05 * sr)
    out[:, :fi] *= np.linspace(0, 1, fi)
    out[:, -fo:] *= np.linspace(1, 0, fo)
    out *= 0.12 / (np.sqrt(np.mean(out[:, : int(0.2 * sr)] ** 2)) + 1e-9)
    pk = np.abs(out).max()
    if pk > 0.95:
        out *= 0.95 / pk
    s["clean"] = f"c_{s['midi']}.wav"
    sf.write(os.path.join(d, s["clean"]), out.T, sr, subtype="PCM_16")
    print(s["midi"], "f0", round(f0, 2), "cents", round(cents[-1], 1), "harmonics", K)

json.dump(S, open(os.path.join(d, "samples.json"), "w"), indent=1)
print("median tuning offset (cents):", round(float(np.median(cents)), 1))
