"""aad.review: diff, detectors, schemas, store, packets, CLI and the viewer's /review/ routes.
The bracket demo (aad/examples/bracket_demo) is the project-agnostic fixture: the bad build moved the M5 hole 5 mm
while the boss and the counterbore stayed, and the agent also moved the base plate's hole."""
import base64
import json
import os
import subprocess
import sys
import threading
import urllib.request

import numpy as np
import pytest

from aad.review import diff as D
from aad.review import packet as P
from aad.review.glb import read_parts, write_parts
from aad.review.schema import SchemaError, validate
from aad.review.store import Store, build_id

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(ROOT, "aad", "examples", "bracket_demo")
GOOD = os.path.join(DEMO, "good", "bracket_demo.glb")
BAD = os.path.join(DEMO, "bad", "bracket_demo.glb")


def box(c=(0, 0, 0), s=(10, 10, 10)):
    c, s = np.array(c, float), np.array(s, float) / 2
    v = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * s + c
    f = [(0, 2, 3), (0, 3, 1), (4, 5, 7), (4, 7, 6), (0, 1, 5), (0, 5, 4), (2, 6, 7), (2, 7, 3), (0, 4, 6), (0, 6, 2),
         (1, 3, 7), (1, 7, 5)]
    return v, np.array(f)


def rows(doc):
    return {r["name"]: r for r in doc["parts"]}


# ---- the bracket demo ----
def test_bracket_demo_flags_the_planted_edit():
    doc = D.diff([GOOD], [BAD], scope=["bracket"])
    r = rows(doc)
    assert r["bracket"]["status"] == "changed" and r["bracket"]["in_scope"] and not r["bracket"]["collateral"]
    assert r["base_plate"]["status"] == "changed" and r["base_plate"]["collateral"]
    assert r["screw_m5x20"]["status"] == "unchanged" and not r["screw_m5x20"]["collateral"]
    assert doc["collateral"] == ["base_plate"]
    assert doc["parts"][0]["name"] == "base_plate"           # collateral sorts first
    kinds = {(w["part"], w["kind"]) for w in doc["warnings"]}
    assert ("bracket", "thin_feature") in kinds
    thin = next(w for w in doc["warnings"] if w["kind"] == "thin_feature")
    assert thin["value"] < 0.3 and thin["baseline"] > 2.5        # 0.25 mm wall, baseline the 3 mm wall
    assert not any(w["part"] != "bracket" for w in doc["warnings"])


def test_bracket_demo_identical_and_unscoped():
    same = D.diff([GOOD], [GOOD])
    assert same["summary"]["unchanged"] == 3 and same["summary"]["changed"] == 0 and same["warnings"] == []
    loose = D.diff([GOOD], [BAD])
    assert loose["scope"] is None and loose["collateral"] == [] and all(r["in_scope"] is None for r in loose["parts"])


def test_bracket_demo_fixture_is_reproducible(tmp_path):
    pytest.importorskip("build123d")
    subprocess.run([sys.executable, os.path.join(DEMO, "bracket.py"), "--out", str(tmp_path)], check=True,
                   capture_output=True)
    for kind, ref in (("good", GOOD), ("bad", BAD)):
        doc = D.diff([ref], [str(tmp_path / kind / "bracket_demo.glb")], detect=False)
        assert doc["summary"]["unchanged"] == 3, kind


# ---- classification and detectors ----
def test_moved_rotated_added_removed(tmp_path):
    rng = np.random.default_rng(1)
    a = {"block": box(), "plate": box((0, 0, -6), (40, 40, 2)), "gone": box((30, 0, 0), (4, 4, 4))}
    rot = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], float) @ np.array(
        [[1, 0, 0], [0, np.cos(0.4), -np.sin(0.4)], [0, np.sin(0.4), np.cos(0.4)]])
    v, f = box()
    b = {"block": (v + [3, 0, 0], f), "plate": (box((0, 0, -6), (40, 40, 2))[0] @ rot.T, f),
         "new": box((-30, 0, 0), (4, 4, 4))}
    write_parts(tmp_path / "a.glb", a)
    write_parts(tmp_path / "b.glb", b)
    r = rows(D.diff([tmp_path / "a.glb"], [tmp_path / "b.glb"], scope=["block"]))
    assert r["block"]["status"] == "moved" and r["block"]["delta"]["translation"] == pytest.approx([3, 0, 0])
    assert r["plate"]["status"] == "moved" and r["plate"]["delta"]["rotated"] and r["plate"]["collateral"]
    assert r["new"]["status"] == "added" and r["new"]["collateral"]
    assert r["gone"]["status"] == "removed" and r["gone"]["collateral"]
    assert not r["block"]["collateral"]
    del rng


def test_detectors_components_floating_triangle_jump(tmp_path):
    v1, f1 = box()
    v2, f2 = box((0, 0, 20), (3, 3, 3))
    split = (np.vstack([v1, v2]), np.vstack([f1, f2 + 8]))
    base = box((0, 0, -6), (40, 40, 2))
    # a dense subdivided copy of the block for the triangle jump
    def subdiv(v, f, n):
        for _ in range(n):
            vv, ff = list(map(tuple, v)), []
            idx = {p: i for i, p in enumerate(vv)}
            def mid(i, j):
                p = tuple((np.array(vv[i]) + np.array(vv[j])) / 2)
                if p not in idx:
                    idx[p] = len(vv)
                    vv.append(p)
                return idx[p]
            for a, b, c in f:
                ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
                ff += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
            v, f = np.array(vv), np.array(ff)
        return v, f
    write_parts(tmp_path / "a.glb", {"block": box(), "plate": base, "post": box((0, 0, 8), (2, 2, 6)),
                                      "dense": box((15, 0, 0), (5, 5, 5))})
    write_parts(tmp_path / "b.glb", {"block": split, "plate": base, "post": box((0, 0, 60), (2, 2, 7)),
                                      "dense": subdiv(*box((15, 0, 0), (5, 5, 5.5)), 3)})
    doc = D.diff([tmp_path / "a.glb"], [tmp_path / "b.glb"])
    kinds = {(w["part"], w["kind"]) for w in doc["warnings"]}
    assert ("block", "new_components") in kinds
    assert ("post", "floating") in kinds
    assert ("dense", "triangle_jump") in kinds
    assert ("plate", "floating") not in kinds


def test_glb_roundtrip_and_hierarchy(tmp_path):
    v, f = box((1, 2, 3))
    write_parts(tmp_path / "x.glb", {"a": (v, f), "a2": (v + 5, f)})
    ps = read_parts(tmp_path / "x.glb")
    assert [p.name for p in ps] == ["a", "a2"]
    assert np.allclose(ps[0].vertices, v, atol=1e-5) and ps[0].triangles.shape == (12, 3)


# ---- schemas, store, packets ----
def pin(n=1, **kw):
    p = dict(schema="cadreview/1", id=f"p{n}", n=n, kind="point", status="open", note="thin wall",
             issue_class="weird_geometry", severity="high", created="2026-11-11T20:00:00Z",
             anchor=dict(part=dict(key="m > bracket", node="bracket", component="bracket", file=0,
                                   path=["m", "bracket"]), local=[1, 2, 3], normal_local=[0, 0, 1],
                         world=[1, 2, 3], normal_world=[0, 0, 1]), parts=[])
    p.update(kw)
    return p


def test_schemas_reject_bad_documents():
    validate(pin(), "pin")
    with pytest.raises(SchemaError):
        validate(pin(issue_class="vibes"), "pin")
    with pytest.raises(SchemaError):
        validate(pin(severity="urgent"), "pin")
    with pytest.raises(SchemaError):
        validate(dict(pin(), extra=1), "pin")
    with pytest.raises(SchemaError):
        validate(dict(schema="cadreview/2", stops=[]), "tour")
    validate(dict(schema="cadreview/1", build=None, stops=[dict(id="s1", parts=["bracket"], note="moved hole")]),
             "tour")
    classes = json.load(open(os.path.join(ROOT, "aad", "review", "issue_classes.json")))["classes"]
    assert [c["id"] for c in classes] == [
        "weird_geometry", "incoherent_addition", "collateral_damage", "floating_unsupported", "orientation_mirror",
        "fit_clearance", "printability", "holes_ports_blocked", "fasteners_assembly", "regression", "belt_pulley",
        "envelope_size", "intent_misread", "other"]


def test_store_pins_resolve_reopen_and_issue_counts(tmp_path):
    st = Store(tmp_path)
    st.replace_pins([pin(1), pin(2, issue_class="fit_clearance", anchor=None,
                                parts=[dict(key="m > base_plate", node="base_plate")], kind="region")],
                    build="b1")
    with pytest.raises(SchemaError):
        st.replace_pins([pin(3, severity="x")])
    assert [p["id"] for p in st.pins("open")] == ["p1", "p2"]
    st.resolve("p1", build="b1")
    st.resolve("2", build="b1")
    assert st.pins("open") == []
    doc = D.diff([GOOD], [BAD])
    assert st.reopen_changed(doc, "b1") == []                     # same build it was resolved on
    reo = st.reopen_changed(doc, "b2")
    assert sorted(p["id"] for p in reo) == ["p1", "p2"]
    assert all(p["status"] == "reopened" and "changed again" in p["reopened_reason"] for p in st.pins())
    counts = st.issue_counts()
    assert counts["total"] == {"weird_geometry": 1, "fit_clearance": 1}
    assert counts["open"] == {"weird_geometry": 1, "fit_clearance": 1}
    st.replace_pins([])                                            # deleting keeps the history counts
    assert st.issue_counts()["total"] == {"weird_geometry": 1, "fit_clearance": 1}


def test_store_baselines_keep_newest_three(tmp_path):
    st = Store(tmp_path / "proj")
    src = tmp_path / "m.glb"
    for i in range(5):
        write_parts(src, {"a": box((i, 0, 0))})
        st.snapshot([str(src)], build_id([str(src)]))
    bl = st.baselines()
    assert len(bl) == 3 and all(os.path.exists(p) for b in bl for p in b["paths"])
    assert st.snapshot([str(src)], build_id([str(src)]))["id"] == bl[0]["id"]     # same build: no new copy


def test_packet_written_and_valid(tmp_path):
    st = Store(tmp_path)
    st.replace_pins([pin(1)])
    st.set_scope([dict(key="m > bracket", node="bracket")])
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
    doc, d = P.write(st, dict(model=dict(name="bracket_demo", files=[BAD]), camera=dict(
        projection="ortho", position=[1, 2, 3], target=[0, 0, 0], zoom=1), png="data:image/png;base64," + png))
    assert os.path.exists(os.path.join(d, "packet.json")) and open(os.path.join(d, "view.png"), "rb").read(4) == b"\x89PNG"
    validate(json.load(open(os.path.join(d, "packet.json"))), "packet")
    assert "aad review --project" in doc["prompt"] and "1 part(s) in the scope lock" in doc["prompt"]


# ---- CLI ----
def cli(*args, cwd=None):
    r = subprocess.run([sys.executable, "-m", "aad", "review", *args], capture_output=True, text=True,
                       cwd=cwd or ROOT, env=dict(os.environ, PYTHONPATH=ROOT))
    assert r.returncode == 0, r.stderr
    return r.stdout


def test_cli_status_resolve_diff_template(tmp_path):
    st = Store(tmp_path)
    st.replace_pins([pin(1), pin(2, note="second")])
    st.set_current("bracket_demo", [BAD], build_id([BAD]), ["bracket", "base_plate"])
    s = json.loads(cli("--project", str(tmp_path), "--json"))
    assert [p["id"] for p in s["open_pins"]] == ["p1", "p2"] and s["open_pins"][0]["orphaned"] is False
    assert "thin wall" in cli("--project", str(tmp_path))
    assert "resolved #1" in cli("resolve", "p1", "--project", str(tmp_path))
    assert [p["id"] for p in json.loads(cli("--project", str(tmp_path), "--json"))["open_pins"]] == ["p2"]
    st.set_scope([dict(key="k", node="bracket")])
    d = json.loads(cli("diff", GOOD, BAD, "--project", str(tmp_path), "--json", "--save"))
    assert d["collateral"] == ["base_plate"]
    assert json.loads(cli("--project", str(tmp_path), "--json"))["diff"]["collateral"] == ["base_plate"]
    t = json.loads(cli("tour-template", "--project", str(tmp_path)))
    validate(t, "tour")
    assert t["build"] == build_id([BAD]) and {s["parts"][0] for s in t["stops"]} == {"bracket", "base_plate"}
    txt = cli("diff", GOOD, BAD)
    assert "changed  bracket" in txt and "thin_feature" in txt


def test_empty_note_pin_takes_the_class_meaning_as_its_reason(tmp_path):
    classes = json.load(open(os.path.join(ROOT, "aad", "review", "issue_classes.json")))["classes"]
    assert all(c.get("meaning", "").strip().endswith(".") for c in classes), "every class has a one-sentence meaning"
    meaning = {c["id"]: c["meaning"] for c in classes}
    st = Store(tmp_path)
    st.replace_pins([pin(1, note=""), pin(2, note="boss wall too thin", issue_class="printability")])
    s = json.loads(cli("--project", str(tmp_path), "--json"))
    p1, p2 = s["open_pins"]
    assert p1["note"] == "" and p1["reason"] == meaning["weird_geometry"] == p1["class_meaning"]
    assert p2["reason"] == "boss wall too thin" and p2["class_meaning"] == meaning["printability"]
    txt = cli("--project", str(tmp_path))
    assert meaning["weird_geometry"] in txt and "(no note)" not in txt
    assert "boss wall too thin" in txt and "class: " + meaning["printability"] in txt
    doc, d = P.write(st, dict(model=dict(name="bracket_demo", files=[BAD])))
    assert [p["reason"] for p in doc["pins"]] == [meaning["weird_geometry"], "boss wall too thin"]
    validate(json.load(open(os.path.join(d, "packet.json"))), "packet")


def test_edge_pin_validates_and_prints(tmp_path):
    edge = dict(points=[[0, 0, 5], [10, 0, 5], [20, 0, 5.5]], length_mm=20.01, start=[0, 0, 5], end=[20, 0, 5.5],
                midpoint=[10, 0, 5], direction=[0.9997, 0, 0.025])
    validate(pin(1, kind="edge", edge=edge), "pin")
    validate(pin(2), "pin")                                         # point pins without an edge still validate
    with pytest.raises(SchemaError):
        validate(pin(3, kind="edge", edge=dict(edge, points=[[0, 0, 0]])), "pin")
    with pytest.raises(SchemaError):
        validate(pin(4, kind="edge", edge=dict(edge, extra=1)), "pin")
    st = Store(tmp_path)
    st.replace_pins([pin(1, kind="edge", edge=edge)])
    s = json.loads(cli("--project", str(tmp_path), "--json"))
    assert s["open_pins"][0]["kind"] == "edge" and s["open_pins"][0]["edge"]["length_mm"] == 20.01
    assert "edge 20.01 mm from (0.0, 0.0, 5.0) to (20.0, 0.0, 5.5)" in cli("--project", str(tmp_path))


# ---- viewer routes ----
def test_viewer_review_routes(tmp_path):
    from aad.viewer.server import Sources, Viewer, _bind, load_versions
    man = tmp_path / "versions.json"
    man.write_text(json.dumps(dict(current="bad", versions=[dict(id="good", label="Good", paths=[GOOD]),
                                                           dict(id="bad", label="Bad", paths=[BAD])])))
    V = Viewer(Sources([BAD]), project=str(tmp_path))
    V, versions = load_versions(str(man), current=V)
    srv = _bind(V, 0, versions)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def get(p):
        with urllib.request.urlopen(base + p, timeout=30) as r:
            return r.status, r.read()

    def post(p, body):
        req = urllib.request.Request(base + p, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())
    try:
        assert json.loads(get("/models.json")[1])["review"]["enabled"]
        s = json.loads(get("/status.json")[1])
        assert s["complete"]
        st = json.loads(get("/review/state.json")[1])
        assert st["project"] == str(tmp_path) and [b["id"] for b in st["baselines"]] == ["good"]
        assert len(st["issue_classes"]) == 14
        assert post("/review/pins", dict(pins=[pin(1)]))[0] == 200
        assert post("/review/pins", dict(pins=[pin(1, severity="nope")]))[0] == 400
        assert post("/review/scope", dict(parts=[dict(key="bracket_demo.glb > bracket", node="bracket")]))[0] == 200
        d = json.loads(get("/review/diff.json?against=good")[1])
        assert d["collateral"] == ["base_plate"] and d["a"]["id"] == "good"
        assert get("/review/baseline/good/models/0")[1][:4] == b"glTF"
        code, pk = post("/review/packet", dict(camera=None, png=None))
        assert code == 200 and os.path.exists(pk["packet"])
        validate(json.load(open(pk["packet"])), "packet")
        assert get("/vendor/three/build/three.module.js")[0] == 200
        assert get("/vendor/LICENSES.txt")[0] == 200
        for bad in ("/vendor/../server.py", "/vendor/%2e%2e/server.py", "/server.py"):
            with pytest.raises(urllib.error.HTTPError):
                get(bad)
        assert json.loads(get("/v/good/models.json")[1])["review"]["enabled"] is False
        assert os.path.exists(tmp_path / ".cadreview" / "current.json")
    finally:
        srv.shutdown()
        srv.server_close()
        th.join()


# ---- the reviewed baseline: "since your last packet" ----
def variant(path, dz=1.0):
    """BAD with base_plate grown by dz mm in Z: a third build that changes only the base plate."""
    parts = read_parts(BAD)
    for p in parts:
        if p.name == "base_plate":
            v = p.vertices.copy()
            v[v[:, 2] < -1, 2] -= dz
            p.vertices = v
    write_parts(path, parts)


def rebuild(V, model, src, stamp):
    """Replace the served model file (a new build) and let the review layer take it as the current build."""
    import shutil
    if callable(src):
        src(model)
    else:
        shutil.copyfile(src, model)
    os.utime(model, (stamp, stamp))
    V.review.build = None
    V.review._snapshot(stamp)
    return V.review.current_build()


def test_reviewed_baseline_is_pinned_and_the_default(tmp_path):
    st = Store(tmp_path / "proj")
    src = tmp_path / "m.glb"
    write_parts(src, {"a": box((0, 0, 0))})
    b1 = build_id([str(src)])
    st.snapshot([str(src)], b1)
    doc, _ = P.write(st, dict(model=dict(name="m", build=b1, files=[str(src)])))
    st.mark_reviewed([str(src)], b1, doc["id"])
    for i in range(1, 6):                                     # five more builds: pruning keeps 3 plus the reviewed one
        write_parts(src, {"a": box((i, 0, 0))})
        st.snapshot([str(src)], build_id([str(src)]))
    bl = st.baselines()
    assert len(bl) == 4 and b1 in {b["build"] for b in bl}
    rv = st.reviewed_baseline()
    assert rv["build"] == b1 and rv["packet"] == doc["id"] and rv["reviewed"]["packet"] == doc["id"]
    validate(json.load(open(os.path.join(rv["dir"], "baseline.json"))), "baseline")
    b, kind, label = st.default_baseline(build_id([str(src)]))
    assert kind == "reviewed" and b["build"] == b1 and label.startswith("since your last packet (reviewed ")
    assert st.default_baseline(b1)[1] == "build"              # the reviewed build itself is current: previous build


def test_two_builds_after_one_packet_still_diff_against_the_reviewed_build(tmp_path):
    from aad.viewer.server import Sources, Viewer
    import shutil
    model = tmp_path / "out" / "bracket_demo.glb"
    model.parent.mkdir()
    shutil.copyfile(GOOD, model)
    proj = tmp_path / "proj"
    V = Viewer(Sources([str(model)]), project=str(proj))
    R = V.review
    b1 = rebuild(V, model, GOOD, 1_800_000_000)
    code, pk = R.post("/review/packet", dict(camera=None, png=None, pins=[pin(1, build=b1)]))
    assert code == 200
    b2 = rebuild(V, model, BAD, 1_800_000_100)               # the agent's first attempt
    # the reviewer checks pin 1 off on the first attempt; the correction below must not reopen it
    R.post("/review/pins", dict(pins=[pin(1, build=b1, status="resolved", resolved_build=b2,
                                          resolved_at="2099-01-01T00:00:00Z")]))
    b3 = rebuild(V, model, variant, 1_800_000_200)           # a small correction
    assert len({b1, b2, b3}) == 3
    choices = R.state()["baselines"]
    assert choices[0]["kind"] == "reviewed" and choices[0]["build"] == b1
    assert choices[0]["label"].startswith("since your last packet (reviewed ")
    assert [c["kind"] for c in choices[1:]] == ["build"] and choices[1]["build"] == b2
    assert choices[1]["label"].startswith("previous build (")
    code, d = R.get("/review/diff.json", "")
    assert code == 200 and d["a"]["build"] == b1 and d["a"]["kind"] == "reviewed" and d["a"]["packet"] == pk["id"]
    r = rows(d)
    assert r["bracket"]["status"] == "changed" and r["base_plate"]["status"] == "changed"
    assert d["reopened"] == []                                # bracket did not change since it was resolved
    validate(json.load(open(proj / ".cadreview" / "diff.json")), "diff")
    code, d2 = R.get("/review/diff.json", "against=previous")
    assert d2["a"]["build"] == b2 and rows(d2)["bracket"]["status"] == "unchanged"
    # the CLI defaults the same way and says which baseline it used
    R.store.set_current("bracket_demo", [str(model)], b3, ["bracket", "base_plate", "screw_m5x20"])
    txt = cli("diff", "--project", str(proj))
    assert txt.splitlines()[0].startswith(f"baseline: since your last packet (reviewed ") and b1 in txt.splitlines()[0]
    j = json.loads(cli("diff", "--project", str(proj), "--json"))
    assert j["a"]["build"] == b1 and j["a"]["kind"] == "reviewed" and "since your last packet" in j["baseline_used"]
    s = json.loads(cli("--project", str(proj), "--json"))
    assert s["baseline"]["kind"] == "reviewed" and s["baseline"]["build"] == b1 and s["baseline"]["packet"] == pk["id"]
    assert "diff baseline: since your last packet" in cli("--project", str(proj))


# ---- Not fixed: escalation by the reviewer, and "Unchanged here since your packet" ----
def test_not_fixed_pins_come_first_with_the_escalation_line(tmp_path):
    from aad.review.store import ESCALATION
    assert ESCALATION == ("Previous attempt did not fix this. Do not repeat the same approach; re-read the pin and "
                          "the reviewed baseline.")
    validate(pin(1, status="not_fixed", attempts=2, escalated_build="abc", escalated_at="2026-11-11T22:00:00Z"), "pin")
    with pytest.raises(SchemaError):
        validate(pin(1, attempts=-1), "pin")
    st = Store(tmp_path)
    st.replace_pins([pin(1, note="first"), pin(2, note="skipped by the agent", status="not_fixed", attempts=1,
                                               escalated_build="b2")])
    s = json.loads(cli("--project", str(tmp_path), "--json"))
    assert [p["id"] for p in s["open_pins"]] == ["p2", "p1"]
    assert s["open_pins"][0]["escalation"] == ESCALATION and "escalation" not in s["open_pins"][1]
    txt = cli("--project", str(tmp_path))
    assert "[NOT FIXED, attempt 1]" in txt and ESCALATION in txt and "1 marked NOT FIXED, listed first" in txt
    assert txt.index("#2 (p2) [NOT FIXED") < txt.index("#1 (p1)")
    doc, d = P.write(st, dict(model=dict(name="bracket_demo", files=[BAD])))
    assert [p["id"] for p in doc["pins"]] == ["p2", "p1"] and doc["pins"][0]["escalation"] == ESCALATION
    assert "#2 are marked NOT FIXED" in doc["prompt"] and ESCALATION in doc["prompt"]
    validate(json.load(open(os.path.join(d, "packet.json"))), "packet")
    assert st.issue_counts()["open"] == {"weird_geometry": 2}


def test_pin_changes_finds_what_an_agent_skipped(tmp_path):
    v3 = tmp_path / "v3.glb"
    variant(v3)                                               # only the base plate changes against BAD

    def mk(i, node, local, kind="point"):
        return dict(id=i, kind=kind, anchor=dict(part=dict(node=node), local=local), parts=[dict(node=node)])
    res = D.pin_changes([BAD], [str(v3)], [mk("p1", "bracket", [0, 0, 35]), mk("p2", "base_plate", [45, 35, -3]),
                                           mk("p3", "bracket", [-28, -18, 1]),
                                           dict(id="p4", kind="region", anchor=None, parts=[dict(node="screw_m5x20")])])
    assert res["p1"] == dict(part_changed=False, near_changed=False, parts=[], radius_mm=5.0)   # skipped: badge
    assert res["p2"]["part_changed"] and res["p2"]["near_changed"]
    assert not res["p3"]["part_changed"] and res["p3"]["near_changed"]   # the base plate changed within 5 mm
    assert res["p4"] == dict(part_changed=False, near_changed=None, parts=[], radius_mm=5.0)
    # through the viewer: only pins of the last packet, against the reviewed build
    from aad.viewer.server import Sources, Viewer
    import shutil
    model = tmp_path / "out" / "bracket_demo.glb"
    model.parent.mkdir()
    shutil.copyfile(BAD, model)
    V = Viewer(Sources([str(model)]), project=str(tmp_path / "proj"))
    rebuild(V, model, BAD, 1_800_000_000)
    p1 = pin(1, anchor=dict(pin()["anchor"], local=[0, 0, 35]))
    V.review.post("/review/pins", dict(pins=[p1]))
    assert V.review.get("/review/pin-changes.json", "")[1]["pins"] == {}     # no packet yet
    V.review.post("/review/packet", dict(camera=None, png=None))
    assert V.review.get("/review/pin-changes.json", "")[1]["against"] is None   # still the reviewed build
    rebuild(V, model, variant, 1_800_000_100)
    V.review.post("/review/pins", dict(pins=[p1, pin(2)]))                 # pin 2 is newer than the packet
    code, pc = V.review.get("/review/pin-changes.json", "")
    assert code == 200 and pc["against"]["packet"] and pc["radius_mm"] == 5.0
    assert set(pc["pins"]) == {"p1"} and pc["pins"]["p1"]["part_changed"] is False
    assert pc["pins"]["p1"]["near_changed"] is False


def test_follow_up_pin_records_its_parent(tmp_path):
    validate(pin(2, parent="p1"), "pin")
    validate(pin(2, parent=None), "pin")
    with pytest.raises(SchemaError):
        validate(pin(2, parent="#1"), "pin")
    st = Store(tmp_path)
    st.replace_pins([pin(1), pin(2, note="and here too", parent="p1")])
    s = json.loads(cli("--project", str(tmp_path), "--json"))
    assert s["open_pins"][1]["parent"] == "p1"
    assert "#2 (p2) (follow-up to p1)" in cli("--project", str(tmp_path))


def test_a_build_copied_in_later_keeps_its_place_by_build_time(tmp_path):
    st = Store(tmp_path / "proj")
    old, new = tmp_path / "old.glb", tmp_path / "new.glb"
    write_parts(old, {"a": box((0, 0, 0))})
    write_parts(new, {"a": box((1, 0, 0))})
    os.utime(old, (1_700_000_000, 1_700_000_000))
    os.utime(new, (1_800_000_000, 1_800_000_000))
    st.snapshot([str(new)], build_id([str(new)]))
    st.snapshot([str(old)], build_id([str(old)]), bid="reviewed-x")       # copied in afterwards
    assert [b["id"] for b in st.baselines()][-1] == "reviewed-x"
    assert st.default_baseline("current")[0]["build"] == build_id([str(new)])
