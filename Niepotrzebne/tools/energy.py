# Stem Keys: loudness of every stem in 2-second steps, to find where a part lives.
import sys, glob, os
import numpy as np, soundfile as sf
d = sys.argv[1]
names = sorted(glob.glob(os.path.join(d, "*.flac")))
secs = int(sys.argv[2]) if len(sys.argv) > 2 else 30
print("stem".ljust(22), " ".join(f"{s:>3d}" for s in range(0, secs, 2)))
for n in names:
    x, sr = sf.read(n, dtype="float32", frames=secs * 44100)
    m = x.mean(1)
    rows = []
    for s in range(0, secs, 2):
        seg = m[s * sr:(s + 2) * sr]
        rows.append(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9))
    print(os.path.basename(n)[:-5].ljust(22), " ".join(f"{int(r):>3d}" for r in rows))
