"""Browser tests: serve a scratch copy of the bracket demo with `aad view` and run the Playwright checks on it.

    python tests/browser/run.py [--port 7904] [--shots DIR] [--keep]

Needs Node 18+ and Playwright (`npm install playwright` somewhere, then `npx playwright install chromium`); point
PLAYWRIGHT_MODULE at the package when it is not resolvable from this folder. The demo copy and its .cadreview/
state live in a new temp directory, so a real project is never touched. Exit 0 when both checks pass.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DEMO = os.path.join(ROOT, "aad", "examples", "bracket_demo")


def wait_up(url, proc, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url + "models.json", timeout=2):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=7904)
    ap.add_argument("--shots", help="directory for the layout screenshots the review check takes")
    ap.add_argument("--keep", action="store_true", help="keep the temp directory and print its path")
    a = ap.parse_args(argv)
    tmp = tempfile.mkdtemp(prefix="aad-browser-")
    demo, proj = os.path.join(tmp, "demo"), os.path.join(tmp, "proj")
    os.makedirs(proj)
    shutil.copytree(DEMO, demo, ignore=shutil.ignore_patterns("*.py", "__pycache__"))
    # the toolbar check opens the "good" version with a DEV badge and a long name
    vj = os.path.join(demo, "versions.json")
    with open(vj) as f:
        spec = json.load(f)
    for v in spec["versions"]:
        if v["id"] == "good":
            v["title"] = "DEV | Bracket demo good version with a deliberately long model title for the narrow toolbar check"
    with open(vj, "w") as f:
        json.dump(spec, f)
    model = os.path.join(demo, "bad", "bracket_demo.glb")
    url = f"http://127.0.0.1:{a.port}/"
    env = dict(os.environ, PYTHONPATH=ROOT, AAD_PYTHON=os.environ.get("AAD_PYTHON", sys.executable))
    srv = subprocess.Popen([sys.executable, "-m", "aad", "view", model, "--versions",
                            os.path.join(demo, "versions.json"), "--project", proj, "--port", str(a.port),
                            "--no-open"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    rc = 1
    try:
        if not wait_up(url, srv):
            print("viewer did not start:", srv.stderr.read() if srv.poll() is not None else "timeout",
                  file=sys.stderr)
            return 1
        runs = [["node", os.path.join(HERE, "review.cjs"), url, "--project", proj, "--baseline", "good",
                 "--model", model] + (["--shots", a.shots] if a.shots else []),
                ["node", os.path.join(HERE, "isolate.cjs"), url]]
        rc = 0
        for cmd in runs:
            r = subprocess.run(cmd, env=env)
            print(f"{os.path.basename(cmd[1])}: exit {r.returncode}", flush=True)
            rc |= r.returncode
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        if a.keep:
            print("kept", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print("browser tests", "passed" if rc == 0 else "FAILED")
    return 1 if rc else 0


if __name__ == "__main__":
    sys.exit(main())
