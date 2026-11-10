# Stem Keys: deploy the library privately to Cloudflare Pages behind a password.
import os, re, secrets, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NP = ROOT / "Niepotrzebne"
HERE = Path(__file__).resolve().parent
LIB = ROOT / "biblioteka"
OUT = NP / "deploy-out"
ENV = NP / ".env"
DOC = Path.home() / "Documents/Gzowo Labs/Stem Keys/Dokumenty/Hasło Stem Keys.txt"
PROJECT = "stem-keys"
WRANGLER = ["npx", "-y", "wrangler@4"]
WORDS = ["rakieta", "pianino", "klawisz", "gzowo", "orbita", "silnik", "dysza", "akord", "basik", "echo", "lampa", "kometa",
         "rytm", "nuta", "tempo", "wulkan", "sokol", "zegar", "kanion", "fala", "planeta", "zorza", "piorun", "magnes",
         "radar", "satelita", "tarcza", "kompas", "laser", "pulsar", "neon", "kosmos", "turbina", "modul", "rampa", "lot"]


def password():
    env = dict(l.split("=", 1) for l in ENV.read_text().splitlines() if "=" in l) if ENV.exists() else {}
    if env.get("SK_PASSWORD"):
        return env["SK_PASSWORD"], False
    pw = "-".join(secrets.choice(WORDS) for _ in range(3)) + "-" + str(secrets.randbelow(90) + 10)
    env["SK_PASSWORD"] = pw
    ENV.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    os.chmod(ENV, 0o600)
    return pw, True


def wrangler(*args, inp=None, cwd=None):
    r = subprocess.run(WRANGLER + list(args), input=inp, capture_output=True, text=True, cwd=cwd)
    return r.returncode, r.stdout + r.stderr


def assemble():
    sys.path.insert(0, str(NP / "tools"))
    import build
    build.rebuild_all()
    if OUT.exists():
        shutil.rmtree(OUT)
    pub = OUT / "public"
    shutil.copytree(LIB, pub, ignore=shutil.ignore_patterns(".zrodlo", ".DS_Store"))
    shutil.copy(pub / "Biblioteka.html", pub / "index.html")
    (OUT / "functions").mkdir()
    shutil.copy(HERE / "_middleware.js", OUT / "functions/_middleware.js")
    files = sum(1 for p in pub.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in pub.rglob("*") if p.is_file())
    print(f"package: {files} files, {size / 1e6:.0f} MB")


def main():
    pw, fresh = password()
    assemble()
    code, out = wrangler("pages", "project", "create", PROJECT, "--production-branch", "main", cwd=OUT)
    print("project:", "created" if code == 0 else ("exists" if "already" in out.lower() else out[-300:]))
    code, out = wrangler("pages", "secret", "put", "SK_PASSWORD", "--project-name", PROJECT, inp=pw)
    print("secret:", "ok" if code == 0 else out[-300:])
    code, out = wrangler("pages", "deploy", "public", "--project-name", PROJECT, "--branch", "main", "--commit-dirty=true", cwd=OUT)
    print(out[-800:])
    if code != 0:
        sys.exit("deploy failed")
    urls = re.findall(r"https://[a-z0-9.-]+\.pages\.dev", out)
    site = f"https://{PROJECT}.pages.dev"
    DOC.parent.mkdir(parents=True, exist_ok=True)
    DOC.write_text(f"Stem Keys - prywatna biblioteka\nAdres: {site}\nHasło: {pw}\n")
    print("deployment:", urls[-1] if urls else "?", "| site:", site, "| password file:", DOC, "| new password:", fresh)
    shutil.rmtree(OUT)


if __name__ == "__main__":
    main()
