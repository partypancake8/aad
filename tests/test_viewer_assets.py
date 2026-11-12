"""Every file the viewer page loads (importmap, module imports, relative imports inside vendored modules, CSS
url() references, the stylesheet and the entry script) exists and is tracked by git, so a fresh clone or
worktree can serve the page. Guards against ignore rules such as `build/` swallowing vendor/three/build/."""
import json
import os
import re
import shutil
import subprocess

import pytest

VIEWER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "aad", "viewer")
REPO = os.path.dirname(os.path.dirname(VIEWER))
# static import / export-from statements at the start of a line (bundles mention paths in comments too)
IMPORT = re.compile(r"""^\s*(?:import|export)\b[^'";]*?(?:\bfrom\s*)?['"]([^'"]+)['"]""", re.M)


def _importmap():
    html = open(os.path.join(VIEWER, "index.html"), encoding="utf-8").read()
    m = re.search(r'<script type="importmap">(.*?)</script>', html, re.S)
    return html, json.loads(m.group(1))["imports"]


def _resolve(spec, base, imports):
    if spec in imports:
        return os.path.normpath(os.path.join(VIEWER, imports[spec]))
    for k, v in imports.items():
        if k.endswith("/") and spec.startswith(k):
            return os.path.normpath(os.path.join(VIEWER, v + spec[len(k):]))
    if spec.startswith("."):
        return os.path.normpath(os.path.join(os.path.dirname(base), spec))
    return None


def page_files():
    html, imports = _importmap()
    files = set()
    for ref in re.findall(r'(?:src|href)="([^"]+\.(?:js|css|svg|png))"', html):
        files.add(os.path.normpath(os.path.join(VIEWER, ref)))
    todo = [f for f in files if f.endswith(".js")] + [os.path.normpath(os.path.join(VIEWER, v)) for v in imports.values()
                                                        if not v.endswith("/")]
    seen = set()
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        files.add(f)
        if not os.path.exists(f):
            continue
        for spec in IMPORT.findall(open(f, encoding="utf-8", errors="replace").read()):
            r = _resolve(spec, f, imports)
            if r:
                todo.append(r)
    from aad.viewer.server import page_files               # every page file the server serves, favicons included
    files.update(os.path.join(VIEWER, f) for f in page_files())
    for css in [f for f in files if f.endswith(".css")]:
        if os.path.exists(css):
            for ref in re.findall(r"url\(([^)]+)\)", open(css, encoding="utf-8").read()):
                ref = ref.strip("'\"")
                if not ref.startswith(("data:", "http")):
                    files.add(os.path.normpath(os.path.join(os.path.dirname(css), ref)))
    return sorted(files)


def test_every_page_file_exists():
    files = page_files()
    assert any(f.endswith(os.path.join("three", "build", "three.module.js")) for f in files)
    assert any(f.endswith(os.path.join("three", "build", "three.core.js")) for f in files)
    missing = [os.path.relpath(f, REPO) for f in files if not os.path.isfile(f)]
    assert not missing, missing


@pytest.mark.skipif(not shutil.which("git") or not os.path.exists(os.path.join(REPO, ".git")),
                    reason="not a git checkout (installed package)")
def test_every_page_file_is_tracked_by_git():
    untracked = []
    for f in page_files():
        r = subprocess.run(["git", "ls-files", "--error-unmatch", os.path.relpath(f, REPO)], cwd=REPO,
                           capture_output=True, text=True)
        if r.returncode:
            untracked.append(os.path.relpath(f, REPO))
    assert not untracked, f"not tracked by git (check .gitignore): {untracked}"


def test_favicons_are_page_files():
    names = {os.path.basename(f) for f in page_files()}
    assert {"favicon.svg", "favicon-dev.svg", "favicon-prod.svg", "favicon-32.png", "favicon-180.png"} <= names
    html = open(os.path.join(VIEWER, "index.html"), encoding="utf-8").read()
    assert '<link rel="icon" type="image/svg+xml" href="favicon.svg"' in html
    cube = open(os.path.join(VIEWER, "vendor", "tabler-icons", "cube.svg"), encoding="utf-8").read()
    for name in ("favicon.svg", "favicon-dev.svg", "favicon-prod.svg"):
        svg = open(os.path.join(VIEWER, name), encoding="utf-8").read()
        for d in re.findall(r'<path d="([^"]+)"', cube):           # the Tabler glyph, unchanged
            assert f'<path d="{d}"/>' in svg, (name, d)
