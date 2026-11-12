"""Review state of one CAD project: <project>/.cadreview/ (every JSON file carries "schema": "cadreview/1" and is
validated against schemas/ before it is written).

  pins.json        every pin: open, resolved, reopened (its part changed again) or not_fixed (the reviewer escalated it:
                   `attempts` counts the attempts that did not fix it) (pins.schema.json)
  scope.json       parts that may change in the next edit (scope.schema.json)
  tour.json        an agent's change tour for one build, plus the viewer's accept/reject decisions
  camera.json      the viewer's last committed camera and selection
  current.json     the build the viewer shows: name, files, build id, part names (for orphan checks)
  diff.json        the latest diff the viewer or CLI computed
  history.jsonl    pin events (created, updated, resolved, reopened, deleted), for the known-issues counts
  baselines/<id>/  copies of earlier builds kept automatically (newest 10, AAD_KEEP_BUILDS) plus baseline.json; the build each of the
                   newest 3 packets was sent against is a "reviewed" baseline (baseline.json "reviewed") that pruning
                   never removes, so "since your last packet" always compares the build the reviewer looked at
  packets/<ts>/    packet.json + view.png written by Send packet
"""
import datetime
import hashlib
import json
import os
import shutil
import threading

from .schema import SCHEMA, validate

DIR = ".cadreview"
KEEP_BASELINES = 10                 # earlier builds kept as revisions; AAD_KEEP_BUILDS overrides (1 to 50)
KEEP_REVIEWED = 3                   # packets whose reviewed build stays pinned
_lock = threading.RLock()
_build_cache = {}


_keep_override = None               # the viewer's "Stored builds to keep" control, for this server process


def set_keep_builds(n):
    """Override the number of earlier builds kept, for the rest of this process (the viewer's Revisions tab sets it;
    None goes back to the environment default). Returns the value in force. ValueError outside 1 to 50."""
    global _keep_override
    if n is None:
        _keep_override = None
        return keep_builds()
    if isinstance(n, bool) or not isinstance(n, (int, float, str)):
        raise ValueError("keep must be a whole number from 1 to 50")
    v = float(n)
    if v != int(v) or not 1 <= v <= 50:
        raise ValueError("keep must be a whole number from 1 to 50")
    _keep_override = int(v)
    return _keep_override


def keep_builds():
    """How many earlier (unreviewed) builds are kept: the viewer's override when set, else AAD_KEEP_BUILDS when
    set (1 to 50), else KEEP_BASELINES. A large assembly's GLB can be 30 MB, so the default stays at 10."""
    if _keep_override is not None:
        return _keep_override
    try:
        return max(1, min(50, int(os.environ.get("AAD_KEEP_BUILDS", KEEP_BASELINES))))
    except ValueError:
        return KEEP_BASELINES


ISSUE_CLASSES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "issue_classes.json")


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def issue_classes():
    """The pin issue classes (id, label, hint, meaning) from issue_classes.json."""
    with open(ISSUE_CLASSES) as fh:
        return json.load(fh)["classes"]


OPEN = ("open", "reopened", "not_fixed")
ESCALATION = ("Previous attempt did not fix this. Do not repeat the same approach; re-read the pin and the reviewed "
              "baseline.")


REPINNED = ("The user moved this pin after your last attempt: the earlier spot and note are in history. The previous "
            "change did not address what is wrong; read the new anchor and reason.")
INSTRUCTIONS = {"question": "answer only, change nothing", "keep": "locked by the user"}
GROUP_RANK = {"problem": 1, "other": 1, "change_request": 2, "note": 3}


def issue_groups():
    """The class groups in display order (id, label, badge) from issue_classes.json."""
    with open(ISSUE_CLASSES) as fh:
        return json.load(fh).get("groups") or []


def class_group(issue_class, classes=None):
    """The group of an issue class ("change_request", "problem", "note" or "other"); unknown ids are problems."""
    return next((c.get("group") or "problem" for c in (classes or issue_classes()) if c["id"] == issue_class),
                "problem")


def is_repinned(pin):
    """The reviewer moved this pin after an attempt (Repin): still open, with the repin trail in `history`."""
    return bool(pin.get("repinned_at")) and pin.get("status") in ("open", "reopened")


def with_reason(pin, classes=None):
    """A copy of a pin with `reason` (its note, or its class meaning when the note is empty: a note is optional and
    the class alone is a complete pin), `class_meaning` (the class's instruction to an agent) and, for a pin the reviewer
    marked Not fixed, `escalation` (the instruction to the next attempt)."""
    meaning = next((c.get("meaning", "") for c in (classes or issue_classes()) if c["id"] == pin.get("issue_class")),
                   "")
    note = (pin.get("note") or "").strip()
    out = dict(pin, reason=note or meaning, class_meaning=meaning, group=class_group(pin.get("issue_class"), classes))
    if pin.get("status") == "not_fixed":
        out["escalation"] = ESCALATION
    elif is_repinned(pin):
        out["escalation"] = REPINNED
    else:
        out.pop("escalation", None)
    if pin.get("issue_class") in INSTRUCTIONS:
        out["instruction"] = INSTRUCTIONS[pin["issue_class"]]
    else:
        out.pop("instruction", None)
    return out


def review_rank(pin, classes=None):
    """Order for aad review and packets: not fixed and repinned pins first, then problems, change requests, notes."""
    if pin.get("status") == "not_fixed" or is_repinned(pin):
        return 0
    return GROUP_RANK.get(class_group(pin.get("issue_class"), classes), 1)


def escalated_first(pins):
    """Pins in review order (review_rank): the ones marked Not fixed or repinned first, then problems, change
    requests and notes (stable otherwise)."""
    classes = issue_classes()
    return sorted(pins, key=lambda p: review_rank(p, classes))


def hhmm(iso):
    """HH:MM of an ISO time string ('' when it has none)."""
    return iso[11:16] if isinstance(iso, str) and len(iso) >= 16 else ""


def built_at(b):
    """When a baseline's build was written: its newest model file's mtime (a build copied in later keeps its own
    time), else its created time, as epoch seconds. Baselines are ordered by it, newest first."""
    ts = [f.get("mtime") for f in b.get("files") or [] if isinstance(f.get("mtime"), (int, float))]
    if ts:
        return max(ts)
    try:
        return datetime.datetime.fromisoformat(b["created"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return 0.0


def reviewed_label(b):
    return f"since your last packet (reviewed {hhmm(b.get('reviewed_at'))})"


def find_project(start=None):
    """Nearest ancestor of `start` (default cwd) holding .cadreview, else .git or pyproject.toml, else `start`."""
    start = os.path.abspath(os.path.expanduser(start or os.getcwd()))
    if os.path.isfile(start):
        start = os.path.dirname(start)
    for marker in (DIR, ".git", "pyproject.toml"):
        d = start
        while True:
            if os.path.exists(os.path.join(d, marker)):
                return d
            up = os.path.dirname(d)
            if up == d:
                break
            d = up
    return start


def build_id(paths):
    """Short content hash of a model's files (cached per path, mtime and size)."""
    h = hashlib.sha256()
    for p in paths:
        st = os.stat(p)
        key = (os.path.realpath(p), st.st_mtime_ns, st.st_size)
        digest = _build_cache.get(key)
        if digest is None:
            fh_h = hashlib.sha256()
            with open(p, "rb") as fh:
                for blk in iter(lambda: fh.read(1 << 20), b""):
                    fh_h.update(blk)
            digest = fh_h.hexdigest()
            _build_cache[key] = digest
        h.update(digest.encode())
    return h.hexdigest()[:12]


class Store:
    def __init__(self, project):
        self.project = os.path.abspath(os.path.expanduser(project))
        self.root = os.path.join(self.project, DIR)

    # ---- files ----
    def path(self, *p):
        return os.path.join(self.root, *p)

    def _read(self, name, default=None):
        try:
            with open(self.path(name)) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return default

    def _write(self, name, doc, schema=None):
        if schema:
            validate(doc, schema)
        p = self.path(name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(doc, fh, indent=1)
            fh.write("\n")
        os.replace(tmp, p)
        return p

    def _event(self, kind, pin):
        os.makedirs(self.root, exist_ok=True)
        with open(self.path("history.jsonl"), "a") as fh:
            fh.write(json.dumps(dict(schema=SCHEMA, t=now(), event=kind, id=pin.get("id"),
                                     issue_class=pin.get("issue_class"), severity=pin.get("severity"),
                                     note=pin.get("note", "")[:200])) + "\n")

    # ---- pins ----
    def pins_doc(self):
        d = self._read("pins.json")
        if not isinstance(d, dict) or d.get("schema") != SCHEMA:
            d = dict(schema=SCHEMA, next=1, pins=[])
        return d

    def pins(self, status=None):
        ps = self.pins_doc()["pins"]
        if status == "open":
            return [p for p in ps if p["status"] in OPEN]
        return ps

    def pinned_parts(self, packet=None):
        """{node name: [pin numbers]} of the reviewer's pins that ask for a change there: the pins open now, plus,
        for a diff against the build packet `packet` reviewed, the pins that were open when it was sent (one resolved
        since still asked for its change). A part that carries one is not collateral when it changes outside the
        scope lock."""
        pins = list(self.pins())
        if packet:
            try:
                with open(self.path("packets", os.path.basename(packet), "packet.json")) as fh:
                    pins += json.load(fh).get("pins") or []
            except (OSError, ValueError):
                pass
        out = {}
        for p in pins:
            if p.get("status") not in OPEN:
                continue
            nodes = [p["anchor"]["part"]["node"]] if p.get("anchor") else [x["node"] for x in p.get("parts") or []]
            for n in nodes:
                if n and p.get("n") is not None and p["n"] not in out.setdefault(n, []):
                    out[n].append(p["n"])
        return {k: sorted(v) for k, v in out.items()}

    def replace_pins(self, pins, build=None):
        """The viewer's full pin list (its undo history owns them): validated, numbered, events logged."""
        with _lock:
            old = {p["id"]: p for p in self.pins_doc()["pins"]}
            out, nxt = [], self.pins_doc()["next"]
            for p in pins:
                p = dict(p, schema=SCHEMA)
                p.setdefault("created", now())
                p.setdefault("status", "open")
                p.setdefault("build", build)
                validate(p, "pin")
                out.append(p)
                n = int(p["id"][1:])
                nxt = max(nxt, n + 1, p["n"] + 1)
            doc = dict(schema=SCHEMA, next=nxt, updated=now(), pins=out)
            self._write("pins.json", doc, "pins")
            new = {p["id"]: p for p in out}
            for k, p in new.items():
                o = old.get(k)
                if o is None:
                    self._event("created", p)
                elif len(p.get("history") or []) > len(o.get("history") or []):
                    self._event("repinned", p)
                elif o.get("status") != p.get("status"):
                    self._event(p["status"] if p["status"] != "open" else "reopened", p)
                elif o != p:
                    self._event("updated", p)
            for k, p in old.items():
                if k not in new:
                    self._event("deleted", p)
            return doc

    def add_pin(self, pin, build=None):
        with _lock:
            d = self.pins_doc()
            n = d["next"]
            pin = dict(pin, schema=SCHEMA, id=f"p{n}", n=max([p["n"] for p in d["pins"]] + [0]) + 1)
            pin.setdefault("status", "open")
            pin.setdefault("created", now())
            pin.setdefault("build", build)
            return self.replace_pins(d["pins"] + [pin], build)["pins"][-1]

    def resolve(self, pin_id, build=None):
        with _lock:
            d = self.pins_doc()
            hit = None
            for p in d["pins"]:
                if p["id"] == pin_id or str(p["n"]) == str(pin_id).lstrip("#"):
                    p.update(status="resolved", resolved_at=now(), resolved_build=build, updated=now())
                    hit = p
            if hit is None:
                raise KeyError(f"no pin {pin_id}")
            self.replace_pins(d["pins"], build)
            return hit

    def reopen_changed(self, diff_doc, build, diff_for=None):
        """Resolved pins whose part changed again become `reopened`. Returns the reopened pins.

        With `diff_for(build id) -> diff doc or None` (a diff of the current build against that stored build), each
        pin is judged against the build it was resolved on, so a fix made after a packet never reopens its own pin;
        a pin resolved before the last packet without its own build kept is judged against the reviewed build.
        Without it, `diff_doc` is the reference for every pin (the old behaviour, for a diff of two loose files)."""
        out, cache = [], {}

        def ref_diff(ref):
            if not ref:
                return None
            if (diff_doc.get("a") or {}).get("build") == ref:
                return diff_doc
            if ref not in cache:
                cache[ref] = diff_for(ref)
            return cache[ref]

        rv = self.reviewed_baseline() if diff_for else None
        with _lock:
            d = self.pins_doc()
            for p in d["pins"]:
                if p["status"] != "resolved" or not build or p.get("resolved_build") == build:
                    continue
                ref, ref_label = diff_doc, diff_doc["a"]["label"]
                if diff_for:
                    ref = ref_diff(p.get("resolved_build"))
                    ref_label = f"build {p.get('resolved_build')}, where it was resolved"
                    if ref is None and rv and (p.get("resolved_at") or "") <= (rv.get("reviewed_at") or ""):
                        ref, ref_label = ref_diff(rv.get("build")), f"build {rv.get('build')} (your last packet)"
                    if ref is None:
                        continue                                  # nothing to compare with: never reopen on a guess
                touched = {r["name"] for r in ref["parts"] if r["status"] != "unchanged"}
                nodes = {x["node"] for x in p.get("parts") or []}
                if p.get("anchor"):
                    nodes.add(p["anchor"]["part"]["node"])
                hit = sorted(nodes & touched)
                if hit:
                    p.update(status="reopened", reopened_at=now(), updated=now(),
                             reopened_reason=f"{', '.join(hit)} changed again in build {build} "
                                             f"(diff against {ref_label})")
                    out.append(p)
            if out:
                self.replace_pins(d["pins"], build)
        return out

    def issue_counts(self):
        """Pins per issue class over the project's whole history (history.jsonl created events, falling back to
        pins.json), plus open counts."""
        counts, open_, seen = {}, {}, set()
        try:
            with open(self.path("history.jsonl")) as fh:
                for ln in fh:
                    try:
                        e = json.loads(ln)
                    except ValueError:
                        continue
                    if e.get("event") == "created" and e.get("id") not in seen:
                        seen.add(e.get("id"))
                        counts[e.get("issue_class") or "other"] = counts.get(e.get("issue_class") or "other", 0) + 1
        except OSError:
            pass
        for p in self.pins():
            if p["id"] not in seen:
                counts[p["issue_class"]] = counts.get(p["issue_class"], 0) + 1
            if p["status"] in OPEN:
                open_[p["issue_class"]] = open_.get(p["issue_class"], 0) + 1
        return dict(total=counts, open=open_)

    # ---- scope ----
    def scope(self):
        d = self._read("scope.json")
        return d if isinstance(d, dict) and d.get("schema") == SCHEMA else dict(schema=SCHEMA, parts=[])

    def set_scope(self, parts, note=None):
        doc = dict(schema=SCHEMA, updated=now(), parts=parts)
        if note:
            doc["note"] = note
        self._write("scope.json", doc, "scope")
        return doc

    # ---- tour ----
    def tour(self):
        d = self._read("tour.json")
        return d if isinstance(d, dict) else None

    def set_tour_decisions(self, decisions):
        with _lock:
            t = self.tour()
            if not t:
                raise KeyError("no tour.json")
            t["decisions"] = decisions
            self._write("tour.json", t, "tour")
            return t

    # ---- camera, current build, latest diff ----
    def camera(self):
        return self._read("camera.json")

    def set_camera(self, doc):
        doc = dict(doc, schema=SCHEMA, updated=now())
        return self._write("camera.json", doc)

    def current(self):
        return self._read("current.json")

    def set_current(self, name, files, build, parts):
        return self._write("current.json", dict(schema=SCHEMA, updated=now(), name=name, files=files, build=build,
                                                parts=parts))

    def latest_diff(self):
        return self._read("diff.json")

    def save_diff(self, doc):
        return self._write("diff.json", doc, "diff")

    # ---- baselines ----
    def baselines(self):
        out = []
        d = self.path("baselines")
        if os.path.isdir(d):
            for k in os.listdir(d):
                b = self._read(os.path.join("baselines", k, "baseline.json"))
                if isinstance(b, dict) and b.get("schema") == SCHEMA:
                    b["dir"] = os.path.join(d, k)
                    b["paths"] = [os.path.join(d, k, f["name"]) for f in b["files"]]
                    if all(os.path.exists(p) for p in b["paths"]):
                        out.append(b)
        out.sort(key=lambda b: (built_at(b), b["created"], os.stat(os.path.join(b["dir"], "baseline.json")).st_mtime_ns),
                 reverse=True)
        return out

    def snapshot(self, files, build, label=None, bid=None, names=None, reviewed=None, prune=True, created=None):
        """Keep a copy of a build's model files as a baseline (skipped when a baseline of this build exists; then
        `reviewed` is only recorded on it). Keeps the newest KEEP_BASELINES unpinned ones (see pinned_builds).
        `names`: stored file names (default each file's basename); `created`: when the build was made, for a build
        imported later (default now). Returns the baseline dict."""
        with _lock:
            have = self.baselines()
            for b in have:
                if b.get("build") == build:
                    if reviewed:
                        b = self._set_reviewed(b, reviewed)
                    return b
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            bid, i = bid or f"build-{stamp}", 2
            base = bid
            while os.path.exists(self.path("baselines", bid)):
                bid, i = f"{base}-{i}", i + 1
            d = self.path("baselines", bid)
            os.makedirs(d)
            entries, used = [], set()
            for j, p in enumerate(files):
                nm = (names[j] if names else None) or os.path.basename(p)
                while nm in used:
                    nm = "_" + nm
                used.add(nm)
                shutil.copy2(p, os.path.join(d, nm))
                st = os.stat(p)
                entries.append(dict(name=nm, size=st.st_size, mtime=st.st_mtime, source=os.path.abspath(p)))
            doc = dict(schema=SCHEMA, id=bid, created=created or now(), label=label or f"build {build}", build=build,
                       files=entries)
            if reviewed:
                doc["reviewed"] = reviewed
            self._write(os.path.join("baselines", bid, "baseline.json"), doc, "baseline")
            if prune:
                self.prune()
            doc["dir"] = d
            doc["paths"] = [os.path.join(d, e["name"]) for e in entries]
            return doc

    def _set_reviewed(self, b, reviewed):
        doc = {k: v for k, v in b.items() if k not in ("dir", "paths")}
        doc["reviewed"] = reviewed
        self._write(os.path.join("baselines", b["id"], "baseline.json"), doc, "baseline")
        return dict(doc, dir=b["dir"], paths=b["paths"])

    def pinned_builds(self):
        """Builds the newest KEEP_REVIEWED packets were sent against: their baselines are never pruned."""
        return {p["build"] for p in self.packet_builds()[:KEEP_REVIEWED]}

    def prune(self):
        with _lock:
            pinned = self.pinned_builds()
            for old in [b for b in self.baselines() if b.get("build") not in pinned][keep_builds():]:
                shutil.rmtree(old["dir"], ignore_errors=True)

    def revisions_size(self):
        """Bytes stored under baselines/ (every kept revision)."""
        total = 0
        for b in self.baselines():
            for p in b["paths"]:
                try:
                    total += os.path.getsize(p)
                except OSError:
                    pass
        return total

    def clear_old(self, current_build=None):
        """Clear old revisions: remove every kept build except the reviewed ones (pinned by a packet) and the
        current build. Returns the ids removed."""
        with _lock:
            pinned = self.pinned_builds()
            gone = []
            for b in self.baselines():
                if b.get("build") in pinned or b.get("build") == current_build or b.get("reviewed"):
                    continue
                shutil.rmtree(b["dir"], ignore_errors=True)
                gone.append(b["id"])
            return gone

    def reviewed_baseline(self):
        """The baseline of the build the last packet was sent against, with `packet` (its id) and `reviewed_at`
        (when it was sent), or None when no packet was sent or that build was never kept."""
        pk = self.packet_builds()
        if not pk:
            return None
        last = pk[0]
        for b in self.baselines():
            if b.get("build") == last["build"]:
                return dict(b, packet=last["id"], reviewed_at=last["created"])
        return None

    def mark_reviewed(self, files, build, packet_id):
        """Send packet: keep the build the packet was sent against as the reviewed baseline (pinned)."""
        if not build or not files:
            return None
        return self.snapshot(files, build, label=f"build {build}",
                             reviewed=dict(packet=packet_id, at=now()))

    def default_baseline(self, current_build=None):
        """(baseline dict, kind, label) a diff compares against when none is named: the reviewed build of the last
        packet when there is one and it is not the current build, else the newest earlier build; (None, None, None)
        when there is neither."""
        rv = self.reviewed_baseline()
        if rv and rv.get("build") != current_build:
            return rv, "reviewed", reviewed_label(rv)
        for b in self.baselines():
            if b.get("build") != current_build:
                return b, "build", f"previous build ({hhmm(b['created'])}, build {b.get('build')})"
        return None, None, None

    # ---- packets ----
    def packet_builds(self):
        """[{id, created, build}] of every packet that names its build, newest first."""
        out = []
        for p in self.packets():
            try:
                with open(p["packet"]) as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            b = (d.get("model") or {}).get("build")
            if b:
                out.append(dict(id=p["id"], created=d.get("created") or "", build=b))
        return out

    def packets(self):
        d = self.path("packets")
        if not os.path.isdir(d):
            return []
        out = []
        for k in sorted(os.listdir(d), reverse=True):
            p = os.path.join(d, k, "packet.json")
            if os.path.exists(p):
                out.append(dict(id=k, packet=p, screenshot=os.path.join(d, k, "view.png")))
        return out
