# Stem Keys: polyphonic note transcription of a stem with Basic Pitch.
import sys, json
import logging
logging.disable(logging.WARNING)
from basic_pitch.inference import predict
from basic_pitch import ICASSP_2022_MODEL_PATH
src, out = sys.argv[1], sys.argv[2]
_, midi, notes = predict(src, ICASSP_2022_MODEL_PATH, onset_threshold=0.5, frame_threshold=0.3, minimum_note_length=60, minimum_frequency=60, maximum_frequency=3000, multiple_pitch_bends=False, melodia_trick=True)
ev = sorted([{"t": round(float(s), 3), "dur": round(float(e - s), 3), "midi": int(p), "amp": round(float(a), 3)} for s, e, p, a, _ in notes], key=lambda n: (n["t"], n["midi"]))
json.dump(ev, open(out, "w"), indent=0)
print(len(ev), "notes")
names = "C C# D D# E F F# G G# A A# B".split()
for n in ev[:80]:
    print(f'{n["t"]:6.3f} {n["dur"]:5.3f} {names[n["midi"]%12]}{n["midi"]//12-1:<2} {n["amp"]:.2f}')
