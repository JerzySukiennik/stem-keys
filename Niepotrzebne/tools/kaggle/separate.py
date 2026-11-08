# Stem Keys: Kaggle GPU kernel that splits the song into stems with Demucs.
import glob, subprocess, sys, time
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "demucs", "soundfile"], check=True)
import numpy as np, soundfile as sf, torch
from demucs.pretrained import get_model
from demucs.apply import apply_model

src = glob.glob("/kaggle/input/**/human_nature.flac", recursive=True)[0]
wav, sr = sf.read(src, dtype="float32", always_2d=True)
x = torch.from_numpy(wav.T.copy())
dev = "cuda" if torch.cuda.is_available() else "cpu"
print("device", dev, "sr", sr, "len", x.shape)
for name in ["htdemucs_6s", "htdemucs_ft"]:
    t = time.time()
    m = get_model(name).to(dev).eval()
    ref = x.mean(0)
    mu, sd = ref.mean(), ref.std()
    with torch.no_grad():
        out = apply_model(m, ((x - mu) / sd)[None].to(dev), shifts=2, split=True, overlap=0.25, progress=False)[0]
    out = out * sd + mu
    for stem, s in zip(m.sources, out):
        sf.write(f"/kaggle/working/{name}_{stem}.flac", s.cpu().numpy().T, sr)
    print(name, m.sources, round(time.time() - t, 1), "s")
