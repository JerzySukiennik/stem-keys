# Stem Keys: from a song title to a finished playable instrument file in the library, all heavy work on Kaggle.
import argparse, hashlib, json, re, shutil, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NP = ROOT / "Niepotrzebne"
TOOLS = NP / "tools"
YTDLP = NP / ".venv/bin/yt-dlp"
KAGGLE = ["/Users/jurek/Downloads/Claude/Projects/AIe/G-Images/.venv/bin/python", "-m", "kaggle"]
USER = "jerzysukiennik"
BAD = ["live", "lyric", "cover", "karaoke", "instrumental", "remix", "sped up", "slowed", "8d", "reaction", "tutorial", "piano version", "concert"]
BASS_PRIOR = {
    "sawA": 0.7, "sawB": 0.05, "pulA": 0.35, "pulB": 0.02, "sinA": 0.6, "sinB": 0.05, "sinC": 0.02, "noise": 0.01,
    "pw": 0.35, "det": 3, "cut": 14, "envAmt": 24, "fdec": 0.15, "res": 1.2, "hp": -36,
    "atk": 0.003, "dec": 0.5, "sus": 0.5, "rel": 0.08, "dlyMix": 0.0, "dlyFb": 0.0, "dlyDamp": 3000, "dlyTime": 0.45,
}


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


def run(query, vid=None):
    if not vid:
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
        vid = best[0]
    h = hashlib.sha1(vid.encode()).hexdigest()[:8]
    work = NP / "runs" / h
    if work.exists():
        shutil.rmtree(work)
    (work / "ds").mkdir(parents=True)
    (work / "kn").mkdir()
    (work / "out").mkdir()
    log("download", vid)
    subprocess.run([str(YTDLP), "--no-update", "-q", "-f", "bestaudio", "-x", "--audio-format", "wav", "--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg",
                    "-o", str(work / "song.%(ext)s"), f"https://www.youtube.com/watch?v={vid}"], check=True)
    info = json.load(open(work / "song.info.json"))
    meta = meta_from(info)
    log("song", meta["artist"], "-", meta["title"])
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(work / "song.wav"), "-ar", "44100", "-ac", "2", "-c:a", "flac", str(work / "ds/song.flac")], check=True)
    (work / "song.wav").unlink()
    json.dump(meta, open(work / "ds/meta.json", "w"))
    for f in [ROOT / "synth-core.js", TOOLS / "specloss.mjs", TOOLS / "fit.mjs"]:
        shutil.copy(f, work / "ds" / f.name)
    keys_prior = json.load(open(ROOT / "presets/human-nature.json"))["params"]
    json.dump({"keys": keys_prior, "bass": BASS_PRIOR}, open(work / "ds/priors.json", "w"))
    ds, kn = f"sk-in-{h}", f"sk-run-{h}"
    json.dump({"title": ds.replace("-", " "), "id": f"{USER}/{ds}", "licenses": [{"name": "unknown"}], "isPrivate": True}, open(work / "ds/dataset-metadata.json", "w"))
    shutil.copy(TOOLS / "kaggle/pipeline.py", work / "kn/pipeline.py")
    json.dump({"id": f"{USER}/{kn}", "title": kn.replace("-", " "), "code_file": "pipeline.py", "language": "python", "kernel_type": "script", "is_private": True,
               "enable_gpu": False, "enable_internet": True, "dataset_sources": [f"{USER}/{ds}"], "competition_sources": [], "kernel_sources": []}, open(work / "kn/kernel-metadata.json", "w"))
    try:
        code, out = kaggle("datasets", "create", "-p", str(work / "ds"))
        log("dataset", code, out.splitlines()[-1] if out else "")
        for _ in range(30):
            code, out = kaggle("datasets", "status", f"{USER}/{ds}")
            if out.strip().endswith("ready"):
                break
            time.sleep(10)
        code, out = kaggle("kernels", "push", "-p", str(work / "kn"))
        log("kernel", out.splitlines()[-1] if out else code)
        if "GPU quota" in out:
            km = json.load(open(work / "kn/kernel-metadata.json"))
            km["enable_gpu"] = False
            json.dump(km, open(work / "kn/kernel-metadata.json", "w"))
            code, out = kaggle("kernels", "push", "-p", str(work / "kn"))
            log("kernel on CPU", out.splitlines()[-1] if out else code)
        if "error" in out.lower() or "successfully pushed" not in out:
            sys.exit(f"kernel push failed: {out[-300:]}")
        t0, status = time.time(), ""
        while time.time() - t0 < 45 * 60:
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
        code, out = kaggle("kernels", "output", f"{USER}/{kn}", "-p", str(work / "out"), "--file-pattern", r"^(result\.json|prev_\d+\.m4a|mix_.*\.m4a|.*\.log)$")
        if not (work / "out/result.json").exists():
            for l in (work / "out").glob("*.log"):
                print(l.read_text()[-6000:])
            sys.exit(f"pipeline failed: {status}")
        sys.path.insert(0, str(TOOLS))
        import build
        dest = build.build_song(work / "out", work / "song.jpg", meta)
        build.build_library()
        log("built", dest)
    finally:
        kaggle("datasets", "delete", "-y", f"{USER}/{ds}")
        kaggle("kernels", "delete", "-y", f"{USER}/{kn}")
        if (work / "ds/song.flac").exists():
            (work / "ds/song.flac").unlink()
    shutil.rmtree(work)
    log("cleaned up")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?")
    ap.add_argument("--id")
    ap.add_argument("--rebuild", action="store_true")
    a = ap.parse_args()
    if a.rebuild:
        sys.path.insert(0, str(TOOLS))
        import build
        build.rebuild_all()
    else:
        run(a.query, a.id)
