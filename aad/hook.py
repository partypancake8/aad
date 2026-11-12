"""`aad hook claude | codex`: tell a coding agent when the review changed, on every prompt, without a pasted packet.

Claude Code and Codex run this as a UserPromptSubmit and SessionStart command hook. It reads the hook JSON on stdin
(`session_id`, `cwd`, `hook_event_name`, `prompt`, `source`), finds the review project (aad.follow:
find_review_project), and prints a short context block only when something changed since this session last saw
that project: a new packet, the open pins, the scope lock or the tour decisions. Otherwise it prints nothing. Both
tools add a command hook's plain stdout to the agent's context.

It never fails a prompt: on any error it prints nothing, exits 0 and appends the error to hook.log in the state
directory. Seen-state lives in <state dir>/seen/, one file per session, pruned after 14 days.

Speed matters (it runs before every prompt): standard library plus aad.review.store only, no numpy, no viewer.
"""
import hashlib
import json
import os
import sys
import time

from . import follow

MAX_PINS = 8
PRUNE_DAYS = 14
REASON_CHARS = 100
LOG_BYTES = 256 * 1024
TOOLS = ("claude", "codex")
NOTE_CLASSES = {"keep": "Keep pins (locked: nothing within 5 mm may change)",
                "question": "Question pins (answer only, change nothing)"}


# ---------------------------------------------------------------- review state, read cheaply

def _part(p):
    if p.get("anchor"):
        return p["anchor"]["part"]["node"]
    nodes = [x.get("node", "?") for x in p.get("parts") or []]
    return ", ".join(nodes[:3]) + (f" +{len(nodes) - 3}" if len(nodes) > 3 else "")


def _short(s, n=REASON_CHARS):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n - 3].rstrip() + "..."


def _hhmm_from_id(pid):
    """HH:MM from a packet id YYYYMMDD-HHMMSS[-n]."""
    try:
        t = pid.split("-")[1]
        return f"{t[0:2]}:{t[2:4]}"
    except (IndexError, AttributeError):
        return ""


def snapshot(project):
    """What the hook compares between calls, plus what it needs to write the block."""
    from .review.store import Store, escalated_first, is_repinned, issue_classes, with_reason
    st = Store(project)
    classes = issue_classes()
    all_pins = st.pins()
    open_pins = [with_reason(p, classes) for p in escalated_first([p for p in all_pins if p.get("status") in
                                                                    ("open", "reopened", "not_fixed")])]
    packets = st.packets()
    latest = packets[0] if packets else None
    scope = [x.get("node") or x.get("key") or "?" for x in st.scope().get("parts") or []]
    tour = st.tour() or {}
    decisions = {k: (v or {}).get("decision") for k, v in (tour.get("decisions") or {}).items()}
    cur = st.current() or {}
    name = cur.get("name")
    if not name and latest:
        try:
            with open(latest["packet"], encoding="utf-8") as fh:
                name = (json.load(fh).get("model") or {}).get("name")
        except (OSError, ValueError, AttributeError):
            name = None
    fp = dict(packet=latest["id"] if latest else None,
              pins={p["id"]: [p.get("n"), p.get("status"), p.get("issue_class"), p.get("note") or "",
                              p.get("attempts") or 0, p.get("repinned_at") or "", p.get("kind"), _part(p)]
                    for p in open_pins},
              scope=sorted(scope), decisions=decisions)
    return dict(fp=fp, open=open_pins, all={p["id"]: p for p in all_pins}, latest=latest, scope=scope,
                model=name or os.path.basename(project.rstrip(os.sep)) or project,
                repinned=[p["n"] for p in open_pins if is_repinned(p)],
                not_fixed=[p["n"] for p in open_pins if p.get("status") == "not_fixed"])


def changes(old, snap):
    """Human lines for what changed between the seen fingerprint `old` and `snap`."""
    new = snap["fp"]
    out = []
    if new["packet"] and new["packet"] != old.get("packet"):
        out.append(f"packet sent {_hhmm_from_id(new['packet'])}")
    op, np_ = old.get("pins") or {}, new["pins"]
    for pid, v in np_.items():
        o = op.get(pid)
        n = v[0]
        if o is None:
            out.append(f"pin #{n} added")
        elif v[1] != o[1]:
            out.append(f"pin #{n} " + {"not_fixed": "marked Not fixed", "reopened": "reopened (its part changed "
                                       "again)", "open": "open again"}.get(v[1], v[1]))
        elif v[5] != o[5]:
            out.append(f"pin #{n} repinned")
        elif v != o:
            out.append(f"pin #{n} edited")
    for pid, o in op.items():
        if pid not in np_:
            p = snap["all"].get(pid)
            out.append(f"pin #{o[0]} " + (p["status"] if p else "deleted"))
    if sorted(old.get("scope") or []) != new["scope"]:
        out.append("scope lock changed")
    od = old.get("decisions") or {}
    dec = [f"{k} {('accepted' if v == 'accept' else 'rejected' if v == 'reject' else v)}"
           for k, v in new["decisions"].items() if od.get(k) != v]
    if dec:
        out.append("tour " + ", ".join(dec))
    return out


def pin_text(p):
    tag = ""
    if p.get("status") == "not_fixed":
        tag = " [NOT FIXED]"
    elif p.get("repinned_at") and p.get("status") in ("open", "reopened"):
        tag = " [REPINNED]"
    elif p.get("status") == "reopened":
        tag = " [REOPENED]"
    return f"#{p['n']}{tag} {p.get('kind', 'point')} on {_part(p)}: {_short(p.get('reason') or p.get('note'))}"


def block(project, snap, delta):
    """The context block (a few short lines, never the full JSON)."""
    opn = snap["open"]
    work = [p for p in opn if p.get("issue_class") not in NOTE_CLASSES]
    extra = []
    if snap["not_fixed"]:
        extra.append(f"{len(snap['not_fixed'])} not fixed")
    if snap["repinned"]:
        extra.append(f"{len(snap['repinned'])} repinned")
    head = f"aad review for {snap['model']} ({project}): "
    if snap["latest"]:
        verb = "packet sent" if any(x.startswith("packet sent") for x in delta) else "last packet"
        head += f"{verb} {_hhmm_from_id(snap['latest']['id'])}, "
    head += f"{len(opn)} open pin(s)" + (f" ({', '.join(extra)})" if extra else "")
    sc = snap["scope"]
    head += ", scope lock: " + (", ".join(sc[:6]) + (f" and {len(sc) - 6} more" if len(sc) > 6 else "") if sc else
                                "none set") + "."
    lines = [head]
    if delta:
        lines.append("New since you last looked: " + "; ".join(delta[:10]) +
                     (f"; and {len(delta) - 10} more" if len(delta) > 10 else "") + ".")
    if work:
        shown = work[:MAX_PINS]
        lines.append("Open pins: " + "; ".join(pin_text(p) for p in shown) +
                     (f"; and {len(work) - MAX_PINS} more" if len(work) > MAX_PINS else "") + ".")
    for cls, label in NOTE_CLASSES.items():
        ps = [p for p in opn if p.get("issue_class") == cls]
        if ps:
            lines.append(f"{label}: " + ", ".join(f"#{p['n']} on {_part(p)}" for p in ps[:MAX_PINS]) +
                         (f" and {len(ps) - MAX_PINS} more" if len(ps) > MAX_PINS else "") + ".")
    tail = f"Run `aad review --project {project} --json` for anchors, scope and diff"
    img = snap["latest"] and snap["latest"].get("screenshot")
    if img and os.path.exists(img):
        tail += f", and look at the packet image {img} (pins are numbered)"
    lines.append(tail + ". Rules: the /aad skill. Never resolve or edit the reviewer's pins or scope lock.")
    return "\n".join(lines)


# ---------------------------------------------------------------- seen-state per session

def _seen_path(session):
    key = hashlib.sha256((session or "no-session").encode()).hexdigest()[:24]
    return os.path.join(follow.state_dir(), "seen", key + ".json")


def _load_seen(path):
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) and isinstance(d.get("projects"), dict) else {"projects": {}}
    except (OSError, ValueError):
        return {"projects": {}}


def _save_seen(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    os.replace(tmp, path)


def prune(now=None, days=PRUNE_DAYS):
    """Remove seen-state of sessions not touched in `days` days (checked at most once an hour)."""
    now = now or time.time()
    d = os.path.join(follow.state_dir(), "seen")
    stamp = os.path.join(d, ".pruned")
    try:
        if now - os.path.getmtime(stamp) < 3600:
            return 0
    except OSError:
        pass
    gone = 0
    try:
        names = os.listdir(d)
    except OSError:
        return 0
    for n in names:
        if not n.endswith(".json"):
            continue
        p = os.path.join(d, n)
        try:
            if now - os.path.getmtime(p) > days * 86400:
                os.remove(p)
                gone += 1
        except OSError:
            pass
    with open(stamp, "w"):
        pass
    return gone


# ---------------------------------------------------------------- entry points

def handle(payload):
    """The text to print for one hook payload ('' for nothing). Updates the seen-state."""
    if not isinstance(payload, dict):
        raise ValueError("hook input is not a JSON object")
    project = follow.find_review_project(payload.get("cwd") or os.getcwd())
    if not project:
        return ""
    project = os.path.abspath(project)
    path = _seen_path(payload.get("session_id"))
    seen = _load_seen(path)
    if payload.get("hook_event_name") == "SessionStart" and payload.get("source") in ("clear", "compact"):
        seen = {"projects": {}}                       # the agent's context was reset: tell it everything again
    old = seen["projects"].get(project)
    snap = snapshot(project)
    fp = snap["fp"]
    if old == fp:
        out = ""
    elif old is None:
        out = block(project, snap, []) if (fp["pins"] or fp["packet"] or fp["scope"]) else ""
    else:
        delta = changes(old, snap)
        out = block(project, snap, delta) if delta else ""
    seen["projects"][project] = fp
    seen["session"] = payload.get("session_id")
    seen["updated"] = time.time()
    _save_seen(path, seen)
    prune()
    return out


def log_error(msg):
    try:
        d = follow.state_dir()
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "hook.log")
        try:
            if os.path.getsize(p) > LOG_BYTES:
                os.replace(p, p + ".1")
        except OSError:
            pass
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except Exception:                                 # nowhere to log: still never fail the prompt
        pass


def main(argv=None, stdin=None, stdout=None):
    """`aad hook <claude|codex>`. Always returns 0."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    argv = list(sys.argv[2:] if argv is None else argv)
    try:
        if argv[:1] in (["-h"], ["--help"]):
            stdout.write("usage: aad hook {claude,codex} < hook-input.json\n"
                         "Prints a short review context block when the review changed since this session last "
                         "saw it; otherwise nothing. Always exits 0.\n")
            return 0
        tool = argv[0] if argv else "claude"
        if tool not in TOOLS:
            raise ValueError(f"unknown tool {tool!r} (expected claude or codex)")
        raw = stdin.read()
        out = handle(json.loads(raw) if raw.strip() else {})
        if out:
            stdout.write(out + "\n")
            stdout.flush()
    except Exception as e:                            # never fail a prompt
        log_error(f"{type(e).__name__}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
