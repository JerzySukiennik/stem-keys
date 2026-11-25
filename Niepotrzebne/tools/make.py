# Stem Keys: from a song title to a finished playable instrument file in the library, all heavy work on Kaggle.
# Stems come from the shared library (~/Music/Blend/Library) when the song is already there; --swieze forces a fresh 6-stem split.
# --nuty "<Artysta - Tytuł>" (or "wszystkie") adds the note timeline to a song that was built before timelines existed.
import argparse, hashlib, json, re, shutil, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NP = ROOT / "Niepotrzebne"
TOOLS = NP / "tools"
LIB = ROOT / "biblioteka"
SHARED = Path.home() / "Music/Blend/Library"
YTDLP = NP / ".venv/bin/yt-dlp"
KAGGLE = ["/Users/jurek/Downloads/Claude/Projects/AIe/G-Images/.venv/bin/python", "-m", "kaggle"]
USER = "jerzysukiennik"
BAD = ["live", "lyric", "cover", "karaoke", "instrumental", "remix", "sped up", "slowed", "8d", "reaction", "tutorial", "piano version", "concert"]
BASS_PRIOR = {
    "sawA": 0.7, "sawB": 0.05, "pulA": 0.35, "pulB": 0.02, "sinA": 0.6, "sinB": 0.05, "sinC": 0.02, "noise": 0.01,
    "pw": 0.35, "det": 3, "cut": 14, "envAmt": 24, "fdec": 0.15, "res": 1.2, "hp": -36,
    "atk": 0.003, "dec": 0.5, "sus": 0.5, "rel": 0.08, "dlyMix": 0.0, "dlyFb": 0.0, "dlyDamp": 3000, "dlyTime": 0.45,
}
FULL_OUT = r"^(result\.json|prev_\d+\.m4a|mix_.*\.m4a|.*\.log)$"
NOTES_OUT = r"^(timeline\.json|.*\.log)$"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def kaggle(*args):
    r = subprocess.run(KAGGLE + list(args), capture_output=True, text=True)
    out = "\n".join(l for l in (r.stdout + r.stderr).splitlines() if "outdated" not in l and "suppress" not in l)
    return r.returncode, out


def score(row):
    vid, title, channel, _ = row
    t, s = title.lower(), 0
    if "official audio" in t:
        s += 5
    elif "audio" in t:
        s += 2
    if channel.lower().endswith(" - topic"):
        s += 4
    for b in BAD:
        if b in t:
            s -= 4
    return s


def search(query):
    r = subprocess.run([str(YTDLP), "--no-update", f"ytsearch8:{query}", "--flat-playlist", "--print", "%(id)s\t%(title)s\t%(channel)s\t%(duration)s"], capture_output=True, text=True)
    return [l.split("\t") for l in r.stdout.strip().splitlines() if l.count("\t") == 3]


def clean_title(s):
    s = re.sub(r"\s*[\(\[][^\)\]]*(official|audio|video|remaster|hd|hq|lyric|visualizer)[^\)\]]*[\)\]]", "", s, flags=re.I)
    return s.strip(" -")


def meta_from(info):
    title = info.get("track") or ""
    artist = info.get("artist") or info.get("creator") or ""
    if not title or not artist:
        raw = clean_title(info.get("title", ""))
        if " - " in raw:
            a, t = raw.split(" - ", 1)
            artist, title = artist or a.strip(), title or t.strip()
        else:
            title = title or raw
            artist = artist or re.sub(r"\s*-?\s*Topic(\s*\d+)?$", "", info.get("channel", "")).replace("VEVO", "").strip()
    artist = artist.split(",")[0].strip()
    return {"title": clean_title(title), "artist": artist, "source": info.get("webpage_url"), "duration": info.get("duration")}


def safe(s):
    return re.sub(r'[\\/:*?"<>|]', "", s).strip()


def pick(query):
    rows = search(query)
    if not rows:
        sys.exit("no search results")
    ranked = sorted(rows, key=score, reverse=True)
    for r in ranked[:5]:
        log("candidate", score(r), r[0], r[1], "|", r[2])
    best = ranked[0]
    if score(best) < 2 or (len(ranked) > 1 and score(ranked[1]) == score(best) and ranked[1][1].lower() != best[1].lower()):
        log("AMBIGUOUS: pass --id to choose")
        sys.exit(3)
    return best[0]


def shared_song(vid):
    for m in sorted(SHARED.glob("*/meta.json")):
        try:
            meta = json.load(open(m))
        except Exception:
            continue
        if vid in str(meta.get("source", "")) and all((m.parent / f"{s}.m4a").exists() for s in ("bass", "other")):
            return m.parent, meta
    return None, None


def fresh_work(key):
    h = hashlib.sha1(key.encode()).hexdigest()[:8]
    work = NP / "runs" / h
    if work.exists():
        shutil.rmtree(work)
    (work / "ds").mkdir(parents=True)
    (work / "kn").mkdir()
    (work / "out").mkdir()
    return work, h


def download(vid, work):
    log("download", vid)
    subprocess.run([str(YTDLP), "--no-update", "-q", "-f", "bestaudio", "-x", "--audio-format", "wav", "--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg",
                    "-o", str(work / "song.%(ext)s"), f"https://www.youtube.com/watch?v={vid}"], check=True)
    info = json.load(open(work / "song.info.json"))
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(work / "song.wav"), "-ar", "44100", "-ac", "2", "-c:a", "flac", str(work / "ds/song.flac")], check=True)
    (work / "song.wav").unlink()
    return meta_from(info)


def from_shared(folder, shared, work):
    log("shared library", folder.name)
    for s in ("vocals", "drums", "bass", "other"):
        if (folder / f"{s}.m4a").exists():
            shutil.copy(folder / f"{s}.m4a", work / "ds" / f"stem_{s}.m4a")
    duration = None
    try:
        beats = json.load(open(folder / "beats.json"))
        duration = round(beats["frames"] / beats["sr"])
    except Exception:
        pass
    return {"title": shared["title"], "artist": shared["artist"], "source": shared.get("source"), "duration": duration}


def kaggle_run(work, h, pattern, minutes=45):
    ds, kn = f"sk-in-{h}", f"sk-run-{h}"
    json.dump({"title": ds.replace("-", " "), "id": f"{USER}/{ds}", "licenses": [{"name": "unknown"}], "isPrivate": True}, open(work / "ds/dataset-metadata.json", "w"))
    shutil.copy(TOOLS / "kaggle/pipeline.py", work / "kn/pipeline.py")
    json.dump({"id": f"{USER}/{kn}", "title": kn.replace("-", " "), "code_file": "pipeline.py", "language": "python", "kernel_type": "script", "is_private": True,
               "enable_gpu": False, "enable_internet": True, "dataset_sources": [f"{USER}/{ds}"], "competition_sources": [], "kernel_sources": []}, open(work / "kn/kernel-metadata.json", "w"))
    status = ""
    try:
        code, out = kaggle("datasets", "create", "-p", str(work / "ds"))
        log("dataset", code, out.splitlines()[-1] if out else "")
        for _ in range(30):
            code, out = kaggle("datasets", "status", f"{USER}/{ds}")
            if out.strip().endswith("ready"):
                break
            time.sleep(10)
        for _ in range(60):
            code, out = kaggle("kernels", "push", "-p", str(work / "kn"))
            if "session count" not in out:
                break
            time.sleep(60)
        log("kernel", out.splitlines()[-1] if out else code)
        if "error" in out.lower() or "successfully pushed" not in out:
            sys.exit(f"kernel push failed: {out[-300:]}")
        t0 = time.time()
        while time.time() - t0 < minutes * 60:
            time.sleep(30)
            code, out = kaggle("kernels", "status", f"{USER}/{kn}")
            if code != 0:
                if "Cannot access kernel" in out:
                    status = "MISSING"
                    break
                continue
            status = out.strip().split('"')[-2] if '"' in out else out.strip()
            log("status", status, f"{(time.time() - t0) / 60:.1f} min")
            if any(s in status for s in ["COMPLETE", "ERROR", "CANCEL"]):
                break
        kaggle("kernels", "output", f"{USER}/{kn}", "-p", str(work / "out"), "--file-pattern", pattern)
    finally:
        kaggle("datasets", "delete", "-y", f"{USER}/{ds}")
        kaggle("kernels", "delete", "-y", f"{USER}/{kn}")
        if (work / "ds/song.flac").exists():
            (work / "ds/song.flac").unlink()
    return status


def fail(work, status):
    for l in (work / "out").glob("*.log"):
        print(l.read_text()[-6000:])
    sys.exit(f"pipeline failed: {status}")


def run(query, vid=None, fresh=False):
    vid = vid or pick(query)
    work, h = fresh_work(vid)
    folder, shared = (None, None) if fresh else shared_song(vid)
    if folder:
        meta = from_shared(folder, shared, work)
        cover = folder / "cover.jpg"
    else:
        meta = download(vid, work)
        cover = work / "song.jpg"
    log("song", meta["artist"], "-", meta["title"])
    json.dump(meta, open(work / "ds/meta.json", "w"))
    for f in [ROOT / "synth-core.js", TOOLS / "specloss.mjs", TOOLS / "fit.mjs"]:
        shutil.copy(f, work / "ds" / f.name)
    keys_prior = json.load(open(ROOT / "presets/human-nature.json"))["params"]
    json.dump({"keys": keys_prior, "bass": BASS_PRIOR}, open(work / "ds/priors.json", "w"))
    status = kaggle_run(work, h, FULL_OUT)
    if not (work / "out/result.json").exists():
        fail(work, status)
    sys.path.insert(0, str(TOOLS))
    import build
    dest = build.build_song(work / "out", cover, meta)
    build.build_library()
    log("built", dest)
    shutil.rmtree(work)
    log("cleaned up")


def notes(name):
    dest = LIB / name
    res_path = dest / ".zrodlo/result.json"
    if not res_path.exists():
        sys.exit(f"no such song in the library: {name}")
    res = json.loads(res_path.read_text())
    m = re.search(r"v=([\w-]{11})", res["meta"].get("source") or "")
    if not m:
        sys.exit(f"{name}: no YouTube source in result.json")
    vid = m.group(1)
    work, h = fresh_work(vid + "-nuty")
    folder, shared = shared_song(vid) if res["meta"].get("stems") == "shared-4" else (None, None)
    meta = from_shared(folder, shared, work) if folder else download(vid, work)
    json.dump({**meta, "mode": "timeline"}, open(work / "ds/meta.json", "w"))
    status = kaggle_run(work, h, NOTES_OUT, minutes=40)
    out = work / "out/timeline.json"
    if not out.exists():
        fail(work, status)
    res["timeline"] = json.loads(out.read_text())["timeline"]
    res_path.write_text(json.dumps(res))
    sys.path.insert(0, str(TOOLS))
    import build
    log("notes added", name, {k: len(v) for k, v in res["timeline"].items()}, build.write_player(dest))
    shutil.rmtree(work)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?")
    ap.add_argument("--id")
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--swieze", action="store_true")
    ap.add_argument("--nuty")
    a = ap.parse_args()
    if a.rebuild:
        sys.path.insert(0, str(TOOLS))
        import build
        build.rebuild_all()
    elif a.nuty == "wszystkie":
        for d in sorted(LIB.glob("*/.zrodlo/result.json")):
            if not json.loads(d.read_text()).get("timeline"):
                notes(d.parent.parent.name)
    elif a.nuty:
        notes(a.nuty)
    else:
        run(a.query, a.id, a.swieze)
