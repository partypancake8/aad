"""The viewer's /review/ routes: the page side of aad.review (pins, scope lock, diff, tour, packets).

  GET  /review/state.json            enabled, project, build, pins, scope, tour (+ whether it is for this build),
                                     issue classes and counts, baselines to diff against, latest diff summary
  POST /review/pins                  {"pins": [...]} the page's whole pin list (its undo history owns them)
  POST /review/scope                 {"parts": [...]} parts that may change in the next edit
  POST /review/tour-decisions        {"decisions": {stop id: {"decision": "accept"|"reject", ...}}}
  POST /review/camera                {"camera": {...}, "selection": part ref or null}
  GET  /review/diff.json?against=ID  diff of the current build against a baseline (build-... or a version id,
                                     "reviewed", "previous"; default: since your last packet when a packet was
                                     sent, else the previous build), saved as .cadreview/diff.json; resolved pins
                                     whose part changed since the build they were resolved on reopen; `keep`
                                     lists the keep pins whose 5 mm neighbourhood changed (local locks)
  GET  /review/pin-changes.json      for each open pin of the last packet: did its part change, and did anything
                                     within 5 mm of its point change, since the build the packet was sent against
                                     (empty when the current build is still that build)
  GET  /review/baseline/ID/models/N  model file N of a baseline (the page draws it as the revision hologram)
  GET  /review/revisions.json        the Revisions list: for each diff choice how many parts differ from the
                                     current build (cached per build pair), stored size, how many builds are kept
  POST /review/revisions/clear       remove the kept earlier builds except the reviewed ones and the current one
  POST /review/packet                {packet fields..., "png": data URL} -> .cadreview/packets/<ts>/; the build
                                     it was sent against becomes the pinned "reviewed" baseline
The current build's files are copied to .cadreview/baselines/ when the viewer starts and whenever a new complete
build appears, so the previous build is always available as a baseline.
"""
import json
import os
import threading
import urllib.parse

from ..review import diff as D
from ..review import packet as P
from ..review.keep import keep_changes
from ..review.schema import SchemaError
from ..review.store import Store, build_id, find_project, hhmm, issue_classes, issue_groups, reviewed_label

def _issue_classes():
    return issue_classes()


class ReviewAPI:
    def __init__(self, viewer, project=None):
        self.V = viewer
        files = [f["path"] for f in viewer.src.files()]
        self.store = Store(project or find_project(files[0] if files else None))
        self.lock = threading.Lock()
        self.seen = None                       # signature of the last build snapshotted
        self.build = None
        self._diff_lock = threading.Lock()
        self._differ = {}                       # (choice id, current build) -> parts that differ

    # ---- builds ----
    def model_files(self):
        return [f["path"] for f in self.V.src.files() if f["ext"] in (".glb", ".stl")]

    def observe(self, status):
        """Called with every status.json: a new complete build becomes the current build and is snapshotted."""
        if not status.get("complete"):
            return
        sig = status.get("sig")
        with self.lock:
            if sig == self.seen:
                return
            self.seen = sig
        threading.Thread(target=self._snapshot, args=(sig,), daemon=True).start()

    def _snapshot(self, sig):
        try:
            files = self.model_files()
            if not files:
                return
            b = build_id(files)
            from .server import glb_mesh_nodes
            parts = []
            for p in files:
                parts += glb_mesh_nodes(p) if p.lower().endswith(".glb") else [os.path.basename(p)]
            self.store.snapshot(files, b, label=f"build {b}")
            self.store.set_current(self.V.name, files, b, parts)
            self.build = b
        except Exception as e:  # noqa: BLE001  (review state must never break the viewer)
            print(f"review: snapshot failed: {e}", flush=True)

    def current_build(self):
        """Build id of the files served now (build_id caches per path, mtime and size, so this stays cheap and is
        never stale while the snapshot of a new build is still being copied)."""
        files = self.model_files()
        if files:
            try:
                self.build = build_id(files)
            except OSError:
                pass
        return self.build

    def baselines(self):
        """Diff choices, the default first: "since your last packet" (the build the last packet was sent against)
        when it is not the current build, then the earlier builds kept, newest first, then the manifest versions.
        Each label says what it is and when."""
        cur = self.current_build()
        out = []
        rv = self.store.reviewed_baseline()
        if rv and rv.get("build") == cur:
            rv = None
        if rv:
            out.append(dict(id=rv["id"], kind="reviewed", label=reviewed_label(rv), created=rv["created"],
                            build=rv.get("build"), files=len(rv["paths"]), packet=rv["packet"],
                            reviewed_at=rv["reviewed_at"]))
        n = 0
        for b in self.store.baselines():
            if b.get("build") == cur:
                continue
            what = "previous build" if n == 0 else "earlier build"
            n += 1
            if rv and b["id"] == rv["id"]:
                continue                       # listed first as "since your last packet"
            out.append(dict(id=b["id"], kind="build", label=f"{what} ({hhmm(b['created'])}, build {b.get('build')})",
                            created=b["created"], build=b.get("build"), files=len(b["paths"]),
                            size=sum(os.path.getsize(p) for p in b["paths"] if os.path.exists(p))))
        for v in self.V.version_options:
            vv = (self.V.version_viewers or {}).get(v["id"])
            if v["id"] != self.V.version_id and vv is not None:
                n = sum(1 for f in vv.src.files() if f["ext"] in (".glb", ".stl"))
                out.append(dict(id=v["id"], kind="version", label=f"version {v['label']} (from the manifest)",
                                created=None, build=None, files=n))
        return out

    def _baseline_paths(self, bid):
        """(paths, label, id, build, kind, packet) of a diff choice; bid None, "" or "default" is the first choice
        (the reviewed build when there is one), "previous" the newest earlier build, "reviewed" the reviewed build."""
        choices = self.baselines()
        if bid in (None, "", "default"):
            bid = choices[0]["id"] if choices else None
        elif bid in ("previous", "reviewed"):
            want = "build" if bid == "previous" else "reviewed"
            bid = next((b["id"] for b in choices if b["kind"] == want), None)
        if bid is None:
            return (None,) * 6
        ch = next((b for b in choices if b["id"] == bid), None)
        for b in self.store.baselines():
            if b["id"] == bid:
                return (b["paths"], ch["label"] if ch else b.get("label") or bid, bid, b.get("build"),
                        ch["kind"] if ch else "build", ch.get("packet") if ch else None)
        vv = (self.V.version_viewers or {}).get(bid)
        if vv is not None and vv is not self.V:
            label = ch["label"] if ch else bid
            return [f["path"] for f in vv.src.files() if f["ext"] in (".glb", ".stl")], label, bid, None, "version", None
        return (None,) * 6

    def _diff_against_build(self, build):
        """Diff of the current build against the stored baseline of `build` (no detectors), or None."""
        for b in self.store.baselines():
            if b.get("build") == build:
                return D.diff(b["paths"], self.model_files(), a_label=f"build {build}", a_build=build,
                              b_build=self.current_build(), detect=False)
        return None

    # ---- GET ----
    def state(self):
        st = self.store
        tour = st.tour()
        cur = self.current_build()
        tour_for = None
        if tour:
            tour_for = "current" if tour.get("build") in (None, cur) else "other"
        latest = st.latest_diff()
        return dict(enabled=True, project=st.project, review_dir=st.root, build=cur,
                    pins=st.pins_doc(), scope=st.scope(), tour=tour, tour_for=tour_for,
                    issue_classes=_issue_classes(), issue_groups=issue_groups(), issues=st.issue_counts(), baselines=self.baselines(),
                    diff=D.summary(latest) if latest and latest["b"].get("build") == cur else None,
                    packets=st.packets()[:5])

    def diff(self, against):
        paths, label, bid, abuild, kind, packet = self._baseline_paths(against)
        if not paths:
            return 404, dict(error=f"no baseline {against!r} (the previous build appears after the next rebuild; "
                                   f"versions: {[v['id'] for v in self.V.version_options]})")
        sc = self.store.scope()["parts"]
        scope = sorted({p["node"] for p in sc}) if sc else None
        cur = self.current_build()
        with self._diff_lock:
            doc = D.diff(paths, self.model_files(), scope=scope, a_label=label, b_label="current build",
                         a_id=bid, b_id=self.V.version_id, a_build=abuild, b_build=cur, a_kind=kind, a_packet=packet)
            self.store.save_diff(doc)
            reopened = self.store.reopen_changed(doc, cur, diff_for=self._diff_against_build)
            keep = keep_changes(paths, self.model_files(), self.store.pins())
        doc = dict(doc, reopened=[p["id"] for p in reopened], keep=keep)
        return 200, doc

    def revisions(self):
        """Rows of the Revisions tab: every diff choice with the number of parts that differ from the current
        build (changed, moved, added or removed; geometry only, no detectors, nothing saved), the bytes stored
        and the retention setting."""
        from ..review.store import keep_builds
        cur = self.current_build()
        rows = []
        for ch in self.baselines():
            key = (ch["id"], ch.get("build"), cur)
            n, parts = self._differ.get(key, (None, None))
            if n is None:
                paths = self._baseline_paths(ch["id"])[0]
                if paths:
                    try:
                        with self._diff_lock:
                            d = D.diff(paths, self.model_files(), detect=False)
                        s = d["summary"]
                        n = s["changed"] + s["moved"] + s["added"] + s["removed"]
                        parts = [r["name"] for r in d["parts"] if r["status"] in ("changed", "moved", "removed")]
                        self._differ[key] = (n, parts)
                    except Exception as e:  # noqa: BLE001  (one unreadable revision must not hide the rest)
                        print(f"review: revision {ch['id']}: {e}", flush=True)
            rows.append(dict(ch, differ=n, parts=parts))     # parts: the old shapes the hologram draws by default
        return 200, dict(build=cur, rows=rows, size_bytes=self.store.revisions_size(), keep=keep_builds())

    def pin_changes(self):
        """Open pins that were in the last packet, against the reviewed build (see diff.pin_changes)."""
        rv = next((b for b in self.baselines() if b["kind"] == "reviewed"), None)
        if not rv:
            return 200, dict(against=None, pins={})
        paths = self._baseline_paths(rv["id"])[0]
        try:
            with open(self.store.path("packets", rv["packet"], "packet.json")) as fh:
                sent = {p["id"] for p in json.load(fh).get("pins") or []}
        except (OSError, ValueError):
            sent = set()
        pins = [p for p in self.store.pins("open") if p["id"] in sent]
        with self._diff_lock:
            res = D.pin_changes(paths, self.model_files(), pins)
        return 200, dict(against=dict(id=rv["id"], label=rv["label"], build=rv["build"], packet=rv["packet"]),
                         build=self.current_build(), radius_mm=D.NEAR_MM, pins=res)

    def get(self, path, query):
        if path == "/review/state.json":
            return 200, self.state()
        if path == "/review/pin-changes.json":
            return self.pin_changes()
        if path == "/review/revisions.json":
            return self.revisions()
        if path == "/review/diff.json":
            q = urllib.parse.parse_qs(query)
            return self.diff((q.get("against") or ["default"])[0])
        if path.startswith("/review/baseline/"):
            bits = path.split("/")            # '', review, baseline, ID, models, N
            if len(bits) == 6 and bits[4] == "models":
                paths = self._baseline_paths(bits[3])[0]
                try:
                    return 200, ("file", paths[int(bits[5])])
                except (TypeError, ValueError, IndexError):
                    pass
            return 404, dict(error=f"no {path}")
        return 404, dict(error=f"no {path}")

    # ---- POST ----
    def post(self, path, body):
        st = self.store
        try:
            if path == "/review/pins":
                return 200, st.replace_pins(body.get("pins") or [], build=self.current_build())
            if path == "/review/scope":
                return 200, st.set_scope(body.get("parts") or [], body.get("note"))
            if path == "/review/tour-decisions":
                return 200, st.set_tour_decisions(body.get("decisions") or {})
            if path == "/review/revisions/clear":
                gone = st.clear_old(self.current_build())
                return 200, dict(removed=gone, baselines=self.baselines(), size_bytes=st.revisions_size())
            if path == "/review/revisions/keep":
                from ..review.store import set_keep_builds
                try:
                    if body.get("keep") is None:
                        raise ValueError("keep must be a whole number from 1 to 50")
                    n = set_keep_builds(body.get("keep"))
                except (TypeError, ValueError) as e:
                    return 400, dict(error=str(e))
                st.prune()
                return 200, dict(keep=n, baselines=self.baselines(), size_bytes=st.revisions_size())
            if path == "/review/camera":
                st.set_camera(dict(camera=body.get("camera"), selection=body.get("selection")))
                return 200, dict(ok=True)
            if path == "/review/packet":
                model = body.get("model") or {}
                model.setdefault("name", self.V.name)
                model.setdefault("title", self.V.title)
                model.setdefault("version", self.V.version_id)
                model["build"] = self.current_build()
                model["files"] = self.model_files()
                body["model"] = model
                doc, d = P.write(st, body)
                try:                                  # the build reviewed in this packet stays as its baseline
                    st.mark_reviewed(model["files"], model["build"], doc["id"])
                except OSError as e:
                    print(f"review: keeping the reviewed build failed: {e}", flush=True)
                return 200, dict(id=doc["id"], dir=d, packet=os.path.join(d, "packet.json"),
                                 screenshot=os.path.join(d, "view.png"), prompt=doc["prompt"])
        except SchemaError as e:
            return 400, dict(error=str(e), problems=e.problems)
        except KeyError as e:
            return 404, dict(error=str(e))
        return 404, dict(error=f"no POST {path}")
