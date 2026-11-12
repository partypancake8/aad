"""`aad follow`: let agent sessions started outside a CAD project still see its pins, plus the user state directory
the hook keeps its seen-state in.

  aad follow <project dir> [--cwd DIR]     sessions whose working directory is DIR (default: here) follow that project
  aad unfollow [--cwd DIR]                 forget the mapping for DIR
  aad follow --list                        every mapping

State lives outside every project and outside the repo: $AAD_STATE_DIR, else $XDG_STATE_HOME/aad, else
~/.local/state/aad. follow.json maps a working directory to a project directory. A working directory below a
mapped one follows it too (the nearest mapping wins).

Standard library only, and nothing heavy at import time: the hook imports this on every prompt.
"""
import json
import os
import sys

DIR = ".cadreview"
FOLLOW = "follow.json"


def state_dir():
    """The user state directory for aad (not created here)."""
    d = os.environ.get("AAD_STATE_DIR")
    if d:
        return os.path.abspath(os.path.expanduser(d))
    xdg = os.environ.get("XDG_STATE_HOME")
    base = os.path.abspath(os.path.expanduser(xdg)) if xdg else os.path.join(os.path.expanduser("~"), ".local",
                                                                              "state")
    return os.path.join(base, "aad")


def _norm(p):
    return os.path.realpath(os.path.abspath(os.path.expanduser(p)))


def follows():
    """{working dir: project dir}; empty when the file is missing or unreadable."""
    try:
        with open(os.path.join(state_dir(), FOLLOW), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    m = d.get("follows") if isinstance(d, dict) else None
    return {k: v for k, v in (m or {}).items() if isinstance(k, str) and isinstance(v, str)}


def _save(m):
    d = state_dir()
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, FOLLOW)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(dict(follows=m), fh, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, p)


def set_follow(cwd, project):
    m = follows()
    m[_norm(cwd)] = _norm(project)
    _save(m)
    return m


def unset_follow(cwd):
    """Remove the mapping for `cwd`. Returns the project it followed, or None."""
    m = follows()
    old = m.pop(_norm(cwd), None)
    if old is not None:
        _save(m)
    return old


def find_review_project(cwd):
    """The review project for a working directory: the nearest directory at or above `cwd` that either has a follow
    mapping (the mapping wins at the same level) or holds .cadreview/. None when there is neither."""
    if not cwd:
        return None
    d = os.path.abspath(os.path.expanduser(cwd))
    m = follows()
    if m:
        d = os.path.realpath(d)
    while True:
        if d in m:
            return m[d]
        if os.path.isdir(os.path.join(d, DIR)):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def add_args(p, unfollow=False):
    if not unfollow:
        p.add_argument("project", nargs="?", help="the CAD project directory (holding .cadreview/) to follow")
        p.add_argument("--list", action="store_true", help="list every mapping")
    p.add_argument("--cwd", help="the working directory the mapping is for (default: the current one)")
    return p


def run_follow(a):
    if a.list or not a.project:
        m = follows()
        if not m:
            print(f"no follow mappings ({os.path.join(state_dir(), FOLLOW)})")
        for k in sorted(m):
            print(f"{k} -> {m[k]}")
        return 0
    proj = _norm(a.project)
    if not os.path.isdir(proj):
        print(f"aad follow: {proj} is not a directory", file=sys.stderr)
        return 1
    cwd = _norm(a.cwd or os.getcwd())
    set_follow(cwd, proj)
    print(f"sessions in {cwd} now follow {proj}")
    if not os.path.isdir(os.path.join(proj, DIR)):
        print(f"note: {proj} has no {DIR}/ yet; it appears once the viewer runs with --project {proj}")
    print("undo with: aad unfollow" + (f" --cwd {cwd}" if a.cwd else ""))
    return 0


def run_unfollow(a):
    cwd = _norm(a.cwd or os.getcwd())
    old = unset_follow(cwd)
    print(f"{cwd} no longer follows {old}" if old else f"{cwd} had no follow mapping")
    return 0
