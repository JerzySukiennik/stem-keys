# Stem Keys

Play a song's own sounds on a MIDI keyboard. The song is split into stems, the target part is transcribed, and three playable instruments are built from it:

- **A**: notes cut from the stem, cleaned with a harmonic mask, looped for sustain.
- **A+**: the same notes rebuilt additively from their measured harmonics only, so no background of the song remains.
- **B**: a synth whose 23 parameters are fitted automatically (CMA-ES) so a phrase played with the transcribed notes matches the stem's spectrogram.

First test: the intro synth of Michael Jackson's *Human Nature*.

## Run

```
python3 Niepotrzebne/devserver.py 8987
```

Open http://localhost:8987 in Chrome (Web MIDI). Samples live in `sounds/`, which is local only and never committed: they are derived from a copyrighted recording. The fitted synth preset in `presets/` contains only numbers.

## Pipeline

| Step | Tool | Where |
| --- | --- | --- |
| Download | yt-dlp | local |
| Stems | Demucs `htdemucs_6s`, `htdemucs_ft` | Kaggle GPU |
| Notes | Basic Pitch (ONNX) | local |
| A, A+ | `Niepotrzebne/tools/slice.py`, `resynth.py` | local |
| B | `Niepotrzebne/tools/fit.mjs` with `synth-core.js` | Kaggle CPU |

The original song file is deleted after separation.

## Credits

- [Demucs](https://github.com/facebookresearch/demucs) (MIT)
- [Basic Pitch](https://github.com/spotify/basic-pitch) (Apache 2.0)
- [librosa](https://librosa.org) (ISC)
