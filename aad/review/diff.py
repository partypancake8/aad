"""Build-to-build geometry diff, per part, from the model meshes (GLB nodes or STL files).

Every part of both models gets mesh.stats(); parts are matched by name and classified:
  unchanged  same triangles (order-independent hash), or every measure within tolerance
  moved      the same shape somewhere else: translation-invariant hash equal, or triangle count, volume, area and
             principal moments equal within tolerance (a rigid move or turn)
  changed    anything else
  added / removed   the name exists on one side only
With a scope (node names that may change), every non-unchanged part outside it is collateral. Detectors
(detectors.py) add warnings for changed and added parts.

pin_changes() answers, per pin, whether its part changed and whether any geometry within NEAR_MM of its point
changed between two builds (mesh level), for the "Unchanged here since your packet" badge.
"""
import datetime
import os
import threading
import time

import numpy as np

from . import detectors
from . import mesh as M
from .mesh import _hash, read_model, stats
from .schema import SCHEMA, validate

POS_TOL = 0.01          # mm
NEAR_MM = 5.0           # pin_changes radius
REL_TOL = 1e-4          # relative volume / area / moments

_cache, _lock = {}, threading.Lock()


def _sig(paths):
    out = []
    for p in paths:
        st = os.stat(p)
        out.append((os.path.realpath(p), st.st_mtime_ns, st.st_size))
    return tuple(out)


def load(paths):
    """(parts by name, stats by name, skipped files), cached per file signature."""
    paths = [os.path.abspath(p) for p in paths]
    key = _sig(paths)
    with _lock:
        hit = _cache.get(key)
    if hit:
        return hit
    parts, skipped = read_model(paths)
    by = {p.name: p for p in parts}
    st = {p.name: stats(p) for p in parts}
    res = (by, st, skipped)
    with _lock:
        if len(_cache) > 6:
            _cache.pop(next(iter(_cache)))
        _cache[key] = res
    return res


def part_table(paths):
    """Per-part measures of one model for the viewer's weight estimate and Part info card, from the same stats the
    diff uses (one source of truth): name, file, triangle count, volume (mm3), area (mm2), world box, closed."""
    by, st, skipped = load(paths)
    out = []
    for name, s in st.items():
        p = by[name]
        closed = getattr(p, "closed_shell", None)
        if closed is None:                                  # cached on the part, with the stats of this file signature
            closed = p.closed_shell = M.is_closed(p)
        out.append(dict(name=name, file=(p.extras or {}).get("file"), tris=s["tris"], volume=s["volume"],
                        area=s["area"], bbox=s["bbox"], closed=closed))
    return dict(parts=out, skipped=[os.path.basename(x) for x in skipped])


def _close(x, y, rel, absol=1e-9):
    return abs(x - y) <= rel * max(abs(x), abs(y)) + absol


def classify(a, b, pos_tol=POS_TOL, rel=REL_TOL):
    """(status, delta) for the stats of one part on both sides."""
    ca, cb = np.array(a["centroid"]), np.array(b["centroid"])
    d = cb - ca
    sa = np.array(a["bbox"]["max"]) - np.array(a["bbox"]["min"])
    sb = np.array(b["bbox"]["max"]) - np.array(b["bbox"]["min"])
    delta = dict(volume=b["volume"] - a["volume"], area=b["area"] - a["area"], tris=b["tris"] - a["tris"],
                 centroid=[float(x) for x in d], distance=float(np.linalg.norm(d)),
                 bbox_size=[float(x) for x in (sb - sa)])
    if a["hash"] == b["hash"]:
        return "unchanged", delta
    same_metrics = (a["tris"] == b["tris"] and _close(a["volume"], b["volume"], rel, 1e-6)
                    and _close(a["area"], b["area"], rel, 1e-6))
    bbox_tol = max(pos_tol * 5, 0.05)        # a re-tessellated or spun circle shifts its box by a few hundredths
    bbox_same = (np.abs(np.array(a["bbox"]["min"]) - np.array(b["bbox"]["min"])).max() <= bbox_tol
                 and np.abs(np.array(a["bbox"]["max"]) - np.array(b["bbox"]["max"])).max() <= bbox_tol)
    moments_same = all(_close(x, y, max(rel * 10, 1e-3), 1e-6) for x, y in zip(a["moments"], b["moments"]))
    if a["shape_hash"] == b["shape_hash"] and np.linalg.norm(d) > pos_tol:
        delta["translation"] = delta["centroid"]
        return "moved", delta
    if same_metrics and moments_same:
        if bbox_same and np.linalg.norm(d) <= pos_tol:
            return "unchanged", delta          # same shape in the same place, triangles listed differently
        delta["translation"] = delta["centroid"]
        delta["rotated"] = not np.allclose(sa, sb, atol=bbox_tol)
        return "moved", delta                  # rigid move or turn
    return "changed", delta


def diff(a_paths, b_paths, scope=None, a_label="baseline", b_label="current", a_id=None, b_id=None,
         a_build=None, b_build=None, pos_tol=POS_TOL, rel=REL_TOL, thin_mm=detectors.THIN_MM,
         contact_mm=detectors.CONTACT_MM, detect=True, time_budget=12.0, a_kind=None, a_packet=None):
    """Diff document (schemas/diff.schema.json) of model b against baseline a. `scope`: node names allowed to
    change, or None when no scope lock is set."""
    t0 = time.time()
    pa, sa, ska = load(a_paths)
    pb, sb, skb = load(b_paths)
    scope_set = set(scope) if scope else None
    names = list(sb.keys()) + [n for n in sa if n not in sb]
    rows, counts = [], dict(unchanged=0, moved=0, changed=0, added=0, removed=0)
    for n in names:
        a, b = sa.get(n), sb.get(n)
        if a is None:
            status, delta = "added", None
        elif b is None:
            status, delta = "removed", None
        else:
            status, delta = classify(a, b, pos_tol, rel)
        counts[status] += 1
        part = pb.get(n) or pa.get(n)
        in_scope = (n in scope_set) if scope_set is not None else None
        rows.append(dict(name=n, status=status, file=(part.extras or {}).get("file"), in_scope=in_scope,
                         collateral=bool(scope_set is not None and status != "unchanged" and not in_scope),
                         a=a, b=b, delta=delta, warnings=[]))
    warns = []
    if detect:
        warns = detectors.run(rows, pa, pb, sa, sb, thin_mm=thin_mm, contact_mm=contact_mm,
                              deadline=t0 + time_budget)
        by = {r["name"]: r for r in rows}
        for w in warns:
            by[w["part"]]["warnings"].append(w)
    collateral = [r["name"] for r in rows if r["collateral"]]
    order = dict(changed=0, added=1, removed=2, moved=3, unchanged=4)
    rows.sort(key=lambda r: (not r["collateral"], order[r["status"]], -len(r["warnings"]), r["name"]))
    doc = dict(schema=SCHEMA, created=datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
               seconds=round(time.time() - t0, 2),
               a=dict(dict(label=a_label, id=a_id, build=a_build, files=[os.path.abspath(p) for p in a_paths]),
                      **({"kind": a_kind} if a_kind else {}), **({"packet": a_packet} if a_packet else {})),
               b=dict(label=b_label, id=b_id, build=b_build, files=[os.path.abspath(p) for p in b_paths]),
               tolerances=dict(position_mm=pos_tol, relative=rel, thin_mm=thin_mm, contact_mm=contact_mm),
               scope=sorted(scope_set) if scope_set is not None else None,
               summary=dict(counts, collateral=len(collateral), warnings=len(warns)),
               collateral=collateral, parts=rows, warnings=warns, skipped=ska + skb)
    return validate(doc, "diff")


def summary(doc, limit=40):
    """Short form of a diff for the CLI, packets and prompts: counts, collateral, non-unchanged parts, warnings."""
    if not doc:
        return None
    changed = [dict(name=r["name"], status=r["status"], collateral=r["collateral"],
                    distance_mm=round(r["delta"]["distance"], 3) if r.get("delta") else None,
                    volume_mm3=round(r["delta"]["volume"], 2) if r.get("delta") else None,
                    warnings=[w["kind"] for w in r["warnings"]])
               for r in doc["parts"] if r["status"] != "unchanged"]
    return dict(against=doc["a"]["label"], against_id=doc["a"].get("id"), against_build=doc["a"].get("build"),
                against_kind=doc["a"].get("kind"), created=doc["created"],
                summary=doc["summary"], collateral=doc["collateral"], parts=changed[:limit],
                more=max(0, len(changed) - limit),
                warnings=[dict(kind=w["kind"], part=w["part"], message=w["message"]) for w in doc["warnings"][:limit]])


def format_text(doc):
    s = doc["summary"]
    lines = [f"diff {doc['b']['label']} against {doc['a']['label']}: {s['changed']} changed, {s['moved']} moved, "
             f"{s['added']} added, {s['removed']} removed, {s['unchanged']} unchanged ({doc['seconds']} s)"]
    if doc["scope"] is not None:
        lines.append(f"scope lock: {len(doc['scope'])} part(s) may change; "
                     f"{len(doc['collateral'])} COLLATERAL change(s) outside it")
    for r in doc["parts"]:
        if r["status"] == "unchanged":
            continue
        tag = "COLLATERAL " if r["collateral"] else ""
        d = r.get("delta") or {}
        extra = ""
        if d:
            extra = f"  centroid shift {d['distance']:.3f} mm, volume {d['volume']:+.2f} mm3, tris {d['tris']:+d}"
        lines.append(f"  {tag}{r['status']:8s} {r['name']}{extra}")
        for w in r["warnings"]:
            lines.append(f"      warning {w['kind']}: {w['message']}")
    return "\n".join(lines)


_tri_cache = {}


def _all_tris(paths):
    """(a, b, c, lo, hi) triangle corners and boxes of every part of a model, cached per file signature."""
    key = _sig([os.path.abspath(p) for p in paths])
    with _lock:
        hit = _tri_cache.get(key)
    if hit:
        return hit
    by, _, _ = load(paths)
    tris = [p.vertices[p.triangles] for p in by.values() if len(p.triangles)]
    t = np.concatenate(tris) if tris else np.zeros((0, 3, 3))
    res = (t[:, 0], t[:, 1], t[:, 2], t.min(1), t.max(1))
    with _lock:
        if len(_tri_cache) > 4:
            _tri_cache.pop(next(iter(_tri_cache)))
        _tri_cache[key] = res
    return res


def _closest_dist2(p, a, b, c):
    """Squared distance from point p to each triangle (a, b, c), Ericson's closest-point regions, vectorised."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = np.einsum("ij,ij->i", ab, ap), np.einsum("ij,ij->i", ac, ap)
    bp = p - b
    d3, d4 = np.einsum("ij,ij->i", ab, bp), np.einsum("ij,ij->i", ac, bp)
    cp = p - c
    d5, d6 = np.einsum("ij,ij->i", ab, cp), np.einsum("ij,ij->i", ac, cp)
    va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
    with np.errstate(divide="ignore", invalid="ignore"):
        den = va + vb + vc
        v, w = vb / den, vc / den
        q = a + ab * v[:, None] + ac * w[:, None]                      # inside the face
        t_ab = d1 / (d1 - d3)
        t_ac = d2 / (d2 - d6)
        t_bc = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    regions = [
        ((d1 <= 0) & (d2 <= 0), a),
        ((d3 >= 0) & (d4 <= d3), b),
        ((d6 >= 0) & (d5 <= d6), c),
        ((vc <= 0) & (d1 >= 0) & (d3 <= 0), a + ab * np.nan_to_num(t_ab)[:, None]),
        ((vb <= 0) & (d2 >= 0) & (d6 <= 0), a + ac * np.nan_to_num(t_ac)[:, None]),
        ((va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0), b + (c - b) * np.nan_to_num(t_bc)[:, None]),
    ]
    q = np.where(np.isfinite(q), q, a)
    done = np.zeros(len(a), bool)
    for m, pt in regions:
        m = m & ~done
        q[m] = pt[m]
        done |= m
    d = q - p
    return np.einsum("ij,ij->i", d, d)


def _near_hash(tris, point, r):
    """Hash of the triangles within r mm of point (box prefilter, then the exact triangle distance)."""
    a, b, c, lo, hi = tris
    d = np.maximum(np.maximum(lo - point, 0), point - hi)             # point to each triangle's box
    m = np.flatnonzero(np.einsum("ij,ij->i", d, d) <= r * r)
    if len(m):
        m = m[_closest_dist2(point, a[m], b[m], c[m]) <= r * r]
    return _hash(a[m], b[m], c[m], 1e-3), int(len(m))


def _to_world(part, local):
    p = np.asarray(local, float)
    if part.matrix is None:
        return p
    return part.matrix[:3, :3] @ p + part.matrix[:3, 3]


def pin_changes(a_paths, b_paths, pins, radius=NEAR_MM):
    """{pin id: {part_changed, near_changed, parts, radius_mm}} for pins (dicts as in pins.json) between build a
    and build b. part_changed: any of the pin's parts is not unchanged (or missing on a side). near_changed (point
    and edge pins): the triangles of any part within `radius` mm of the pin's point differ; the point is the pin's
    part-local point placed by that part's node transform in each build. None when it cannot be judged."""
    pa, sa, _ = load(a_paths)
    pb, sb, _ = load(b_paths)
    ta = tb = None
    out = {}
    for p in pins:
        nodes = [x["node"] for x in p.get("parts") or []]
        an = p.get("anchor")
        if an and an["part"]["node"] not in nodes:
            nodes.insert(0, an["part"]["node"])
        changed = []
        for n in nodes:
            if n not in sa or n not in sb or classify(sa[n], sb[n])[0] != "unchanged":
                changed.append(n)
        near = None
        if an and an.get("local") is not None:
            n = an["part"]["node"]
            if n in pa and n in pb:
                if ta is None:
                    ta, tb = _all_tris(a_paths), _all_tris(b_paths)
                ha, ka = _near_hash(ta, _to_world(pa[n], an["local"]), radius)
                hb, kb = _near_hash(tb, _to_world(pb[n], an["local"]), radius)
                near = ha != hb
            else:
                near = True
        out[p["id"]] = dict(part_changed=bool(changed), near_changed=near, parts=changed, radius_mm=radius)
    return out
