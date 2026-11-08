# Stem Keys

Play a song's own sounds on a MIDI keyboard, over the song's own backing track.

Give it a song title. The pipeline finds the studio version, splits it into stems, finds the distinct keyboard, synth and bass sounds in it, and turns each one into two playable instruments:

- **A+**: every key rebuilt additively from the harmonic model measured on real notes in the recording, with the spectral envelope interpolated between the nearest recorded notes, so the whole keyboard keeps the original timbre.
- **B**: a synth whose 23 parameters are fitted automatically (CMA-ES) so a phrase played with the transcribed notes matches the stem's spectrogram.

Each song becomes one HTML file that opens with a double click in Chrome and works offline: two hands (split or layer), Web MIDI with sustain pedal, echo, reverb, release and brightness knobs, and a backing track with the played part removed and pitch-preserving tempo control.

## Make a song

```
Niepotrzebne/.venv/bin/python Niepotrzebne/tools/make.py "Artist Title"
```

Everything heavy runs in one Kaggle GPU kernel (`Niepotrzebne/tools/kaggle/pipeline.py`): Demucs `htdemucs_6s`, Basic Pitch, timbre clustering, A+ harmonic models, B fits in Node, backing mixes. The full mix and the Kaggle copies are deleted afterwards. The result lands in `biblioteka/`, which is local only and never committed: it is derived from copyrighted recordings.

`make.py --rebuild` regenerates every song player and `biblioteka/Biblioteka.html` after changes to `player/`.

## Layout

| Path | What |
| --- | --- |
| `synth-core.js` | B synth DSP, shared by the AudioWorklet and the fitter |
| `synth-worklet.js` | polyphonic AudioWorklet for B |
| `player/` | song player and library templates, inlined into each song file |
| `Niepotrzebne/tools/make.py` | title in, finished song out |
| `Niepotrzebne/tools/build.py` | assembles song players and the library |
| `Niepotrzebne/tools/fit.mjs`, `specloss.mjs` | CMA-ES synth fitter and spectral loss |
| `Niepotrzebne/tools/kaggle/pipeline.py` | the Kaggle kernel |

## Credits

- [Demucs](https://github.com/facebookresearch/demucs) (MIT)
- [Basic Pitch](https://github.com/spotify/basic-pitch) (Apache 2.0)
- [librosa](https://librosa.org) (ISC)
- [Michroma](https://github.com/googlefonts/Michroma-font) font (SIL OFL 1.1, `player/fonts/OFL.txt`)
