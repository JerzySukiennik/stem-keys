# Stem Keys: assemble self-contained song players and the library page from pipeline results.
import base64, html, json, re, shutil, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLAYER = ROOT / "player"
LIB = ROOT / "biblioteka"


def safe(s):
    return re.sub(r'[\\/:*?"<>|]', "", s).strip()


def strip_module(src):
    src = re.sub(r"^import .*?;\s*$", "", src, flags=re.M)
    return re.sub(r"^export (const|function|class|let)", r"\1", src, flags=re.M)


def fonts_css():
    out = []
    for f, rng in [("michroma.woff2", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212"),
                   ("michroma-ext.woff2", "U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF")]:
        b = base64.b64encode((PLAYER / "fonts" / f).read_bytes()).decode()
        out.append(f"@font-face{{font-family:'Michroma';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,{b}) format('woff2');unicode-range:{rng};}}")
    return "".join(out)


def song_dir(meta):
    return LIB / safe(f"{meta['artist']} - {meta['title']}")


def html_name(meta):
    return safe(meta["title"]) + ".html"


def bars(c):
    notes = c["aplus"]["notes"]
    n = notes[len(notes) // 2]
    raw = base64.b64decode(n["amps"])
    K, F = n["K"], n["frames"]
    vals = []
    for k in range(12):
        if k >= K:
            vals.append(None)
            continue
        fr = range(min(10, F - 1), min(50, F))
        vals.append(sum(raw[f * K + k] / 255 * 90 - 90 for f in fr) / max(1, len(fr)))
    mx = max(v for v in vals if v is not None)
    return [0 if v is None else max(0.0, 1 + (v - mx) / 60) for v in vals]


def write_player(dest):
    src = dest / ".zrodlo"
    res = json.loads((src / "result.json").read_text())
    previews = {}
    for c in res["candidates"]:
        p = src / c["preview"]
        if p.exists():
            previews[c["id"]] = base64.b64encode(p.read_bytes()).decode()
    song = {k: res[k] for k in ["meta", "duration", "candidates", "mixes", "tune"]}
    song["previews"] = previews
    (dest / "dane.js").write_text("window.SONG = " + json.dumps(song, separators=(",", ":")) + ";\n")
    core = strip_module((ROOT / "synth-core.js").read_text())
    worklet = core + "\n" + strip_module((ROOT / "synth-worklet.js").read_text())
    script = "\n".join([core, (PLAYER / "aplus.js").read_text(), (PLAYER / "player.js").read_text()])
    page = (PLAYER / "player.html").read_text()
    page = page.replace("{{TITLE}}", html.escape(f"{res['meta']['title']} · Stem Keys"))
    page = page.replace("{{FONTS}}", fonts_css()).replace("{{STYLE}}", (PLAYER / "player.css").read_text())
    page = page.replace("{{WORKLET}}", json.dumps(worklet).replace("</", "<\\/"))
    page = page.replace("{{SCRIPT}}", script.replace("</script", "<\\/script"))
    for old in dest.glob("*.html"):
        old.unlink()
    (dest / html_name(res["meta"])).write_text(page)
    return dest / html_name(res["meta"])


def build_song(outdir, cover, meta):
    res = json.loads((outdir / "result.json").read_text())
    res["meta"] = {**res.get("meta", {}), **meta}
    dest = song_dir(res["meta"])
    if dest.exists():
        shutil.rmtree(dest)
    (dest / "podklad").mkdir(parents=True)
    (dest / ".zrodlo").mkdir()
    for f in res["mixes"].values():
        shutil.copy(outdir / f, dest / "podklad" / f)
    for c in res["candidates"]:
        if (outdir / c["preview"]).exists():
            shutil.copy(outdir / c["preview"], dest / ".zrodlo" / c["preview"])
    if cover and Path(cover).exists():
        shutil.copy(cover, dest / "okladka.jpg")
    (dest / ".zrodlo" / "result.json").write_text(json.dumps(res))
    write_player(dest)
    return dest


def build_library():
    cards = []
    for d in sorted(LIB.glob("*/.zrodlo/result.json")):
        res = json.loads(d.read_text())
        dest = d.parent.parent
        meta = res["meta"]
        link = urllib.parse.quote(dest.name) + "/" + urllib.parse.quote(html_name(meta))
        cover = urllib.parse.quote(dest.name) + "/okladka.jpg" if (dest / "okladka.jpg").exists() else ""
        rows = []
        for c in res["candidates"]:
            b = "".join(f'<i style="height:{round(4 + v * 96)}%"></i>' for v in bars(c))
            short = re.sub(r"\s*\(od [^)]*\)$", "", c["name"])
            rows.append(f'<li><div class="bars">{b}</div><span>{html.escape(short)}</span><em>{html.escape(c["from"])}</em></li>')
        img = f'<img src="{cover}" alt="">' if cover else '<div class="noimg"></div>'
        cards.append(f'<a class="card" href="{link}">{img}<div class="ct"><h2>{html.escape(meta["title"])}</h2><p>{html.escape(meta["artist"])}</p><ul>{"".join(rows)}</ul></div></a>')
    page = (PLAYER / "library.html").read_text()
    body = "".join(cards) if cards else '<p class="empty">Biblioteka jest pusta. Napisz do Claude tytuł piosenki, a pojawi się tutaj.</p>'
    page = page.replace("{{FONTS}}", fonts_css()).replace("{{CARDS}}", body).replace("{{COUNT}}", str(len(cards)))
    LIB.mkdir(exist_ok=True)
    (LIB / "Biblioteka.html").write_text(page)
    return LIB / "Biblioteka.html"


def rebuild_all():
    for d in sorted(LIB.glob("*/.zrodlo/result.json")):
        print("rebuilt", write_player(d.parent.parent))
    print("library", build_library())
