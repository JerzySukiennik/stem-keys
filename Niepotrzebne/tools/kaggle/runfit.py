# Stem Keys: Kaggle CPU kernel that runs the synth fitter with Node on all cores.
import glob, os, shutil, subprocess, json
src = os.path.dirname(glob.glob("/kaggle/input/**/fit.mjs", recursive=True)[0])
run = "/kaggle/working/run"
os.makedirs(run, exist_ok=True)
for f in os.listdir(src):
    shutil.copy(os.path.join(src, f), run)
open(f"{run}/package.json", "w").write('{"type": "module"}')
subprocess.run("curl -sL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar -xJ -C /kaggle/working", shell=True, check=True)
node = "/kaggle/working/node-v22.11.0-linux-x64/bin/node"
cpus = os.cpu_count()
print("cpus", cpus)
env = dict(os.environ, SYNTH_CORE=f"file://{run}/synth-core.js")
for start in ["0", "1", "2"]:
    env["START"] = start
    subprocess.run([node, f"{run}/fit.mjs", run, "5000", str(cpus), f"fit_{start}.json"], env=env, check=True)
    shutil.copy(f"{run}/fit_{start}.json", "/kaggle/working/")
for f in ["target.wav", "fitdata.json"]:
    os.remove(f"{run}/{f}")
