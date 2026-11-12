"""Edge pins on a later build: does the edge the pin was made on still exist?

An edge pin stores the polyline of the feature edge that was clicked (`edge.points`, part-local mm). When the model is
rebuilt that polyline is matched against the part's current feature edges, the same ones the viewer draws: three.js
EdgesGeometry segments (faces meeting at CREASE_DEG or more, plus open boundaries) grown into chains that stop at a
turn over TURN_DEG or a junction. Points sampled along the stored polyline must lie within EDGE_TOL mm of one chain
(mean and max) whose length agrees within EDGE_LEN. No match: the geometry changed there since the pin was made.
"""
import math
import os

import numpy as np

from .mesh import read_model

EDGE_TOL = 0.3
EDGE_LEN = 0.05
CREASE_DEG = 35.0
TURN_DEG = 30.0
CHANGED_LINE = "the pinned edge no longer exists in this form; the geometry changed here since the pin was made"


def _local(part):
    """Part vertices in the node's own frame (the frame pin points are stored in), back at float32 precision."""
    if part.matrix is None:
        return part.vertices
    m = part.matrix
    v = (part.vertices - m[:3, 3]) @ np.linalg.inv(m[:3, :3]).T
    return v.astype(np.float32).astype(np.float64)


def _keys(v, q=1e4):
    return [tuple(r) for r in np.floor(v * q + 0.5).astype(np.int64).tolist()]


def feature_segments(v, tris, angle=CREASE_DEG):
    """(n, 2, 3) segments as three.js EdgesGeometry(geometry, angle) builds them."""
    thr = math.cos(math.radians(angle))
    keys = _keys(v)
    a, b, c = v[tris[:, 0]], v[tris[:, 1]], v[tris[:, 2]]
    n = np.cross(c - b, a - b)
    ln = np.linalg.norm(n, axis=1)
    n = np.where(ln[:, None] > 0, n / np.where(ln > 0, ln, 1)[:, None], 0.0)
    edges, out = {}, []
    for t, (i0, i1, i2) in enumerate(tris.tolist()):
        h = (keys[i0], keys[i1], keys[i2])
        if h[0] == h[1] or h[1] == h[2] or h[2] == h[0]:
            continue
        idx = (i0, i1, i2)
        for j in range(3):
            jn = (j + 1) % 3
            fw, rv = (h[j], h[jn]), (h[jn], h[j])
            sib = edges.get(rv)
            if sib:
                if float(n[t] @ n[sib[2]]) <= thr:
                    out.append((idx[j], idx[jn]))
                edges[rv] = None
            elif fw not in edges:
                edges[fw] = (idx[j], idx[jn], t)
    out.extend((e[0], e[1]) for e in edges.values() if e)
    if not out:
        return np.zeros((0, 2, 3))
    ix = np.array(out, dtype=np.int64)
    return np.stack([v[ix[:, 0]], v[ix[:, 1]]], axis=1)


def chains(seg, turn_deg=TURN_DEG):
    """Every chain of the segments as an (k, 3) polyline, grown as the viewer's edge pick grows one."""
    cos_t = math.cos(math.radians(turn_deg))
    n = len(seg)
    pts = seg.reshape(-1, 3)
    ids, vid = {}, []
    for k in _keys(pts):
        vid.append(ids.setdefault(k, len(ids)))
    adj = {}
    for s in range(n):
        for vv in (vid[2 * s], vid[2 * s + 1]):
            adj.setdefault(vv, []).append(s)
    chain_of = [-1] * n
    out = []
    for s0 in range(n):
        if chain_of[s0] >= 0:
            continue
        used = {s0}

        def walk(end):
            res, cur = [], s0
            while True:
                nb = [x for x in adj[vid[end]] if x != cur]
                if len(nb) != 1:
                    break
                nx = nb[0]
                if nx in used:
                    break
                other = 2 * cur + 1 if end == 2 * cur else 2 * cur
                near = 2 * nx if vid[2 * nx] == vid[end] else 2 * nx + 1
                far = 2 * nx + 1 if near == 2 * nx else 2 * nx
                d1 = pts[end] - pts[other]
                d2 = pts[far] - pts[near]
                l1, l2 = np.linalg.norm(d1), np.linalg.norm(d2)
                if l1 == 0 or l2 == 0 or float(d1 @ d2) / (l1 * l2) < cos_t:
                    break
                used.add(nx)
                res.append(far)
                cur, end = nx, far
            return res

        fw = walk(2 * s0 + 1)
        bw = walk(2 * s0)
        order = bw[::-1] + [2 * s0, 2 * s0 + 1] + fw
        for s in used:
            chain_of[s] = len(out)
        out.append(pts[order])
    return out


def _length(p):
    return float(np.linalg.norm(np.diff(p, axis=0), axis=1).sum()) if len(p) > 1 else 0.0


def samples(points, n):
    """n points evenly spaced by arc length along a polyline."""
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 2:
        return p
    cum = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))])
    if cum[-1] <= 0:
        return p
    t = np.linspace(0, cum[-1], n)
    return np.stack([np.interp(t, cum, p[:, k]) for k in range(3)], axis=1)


def dist_to_polyline(q, p):
    """Distance from each point of q (m, 3) to the polyline p (k, 3)."""
    a, b = p[:-1], p[1:]
    ab = b - a
    l2 = (ab * ab).sum(1)
    t = np.clip(((q[:, None, :] - a[None]) * ab[None]).sum(2) / np.where(l2 > 0, l2, 1)[None], 0, 1)
    d = np.linalg.norm(q[:, None, :] - (a[None] + t[..., None] * ab[None]), axis=2)
    return d.min(1)


def match(edge, part_chains, tol=EDGE_TOL, len_tol=EDGE_LEN):
    """(matched, mean, max) of a stored edge record against a part's chains."""
    L = float(edge.get("length_mm") or 0.0)
    S = samples(edge["points"], max(8, min(64, math.ceil(L / 0.5) + 1)))
    lo, hi = S.min(0) - tol, S.max(0) + tol
    best = None
    for ch in part_chains:
        if abs(_length(ch) - L) > len_tol * max(L, 1e-6):
            continue
        if np.any(ch.max(0) < lo) or np.any(ch.min(0) > hi):
            continue
        d = dist_to_polyline(S, ch)
        mean, mx = float(d.mean()), float(d.max())
        if mx <= tol and mean <= tol and (best is None or mean < best[1]):
            best = (True, mean, mx)
    return best or (False, None, None)


_cache = {}


def _part_chains(paths, node):
    sig = tuple((p, os.path.getmtime(p), os.path.getsize(p)) for p in paths)
    key = (sig, node)
    if key not in _cache:
        if (sig, None) not in _cache:
            _cache[(sig, None)] = {pt.name: pt for pt in read_model(paths)[0]}
        pt = _cache[(sig, None)].get(node)
        _cache[key] = chains(feature_segments(_local(pt), pt.triangles)) if pt is not None else None
    return _cache[key]


def edge_changes(paths, pins, build):
    """{pin id: {edge_changed, mean_mm, max_mm}} for the edge pins (with a stored polyline) made on a build other than
    `build`, judged against the model files `paths`. A pin whose part is missing is left out (it is orphaned)."""
    out = {}
    if not paths or not build:
        return out
    for p in pins:
        e, an = p.get("edge"), p.get("anchor")
        b = p.get("repinned_build") or p.get("build")
        if p.get("kind") != "edge" or not e or not e.get("points") or not an or not b or b == build:
            continue
        ch = _part_chains(paths, an["part"]["node"])
        if ch is None:
            continue
        ok, mean, mx = match(e, ch)
        out[p["id"]] = dict(edge_changed=not ok, mean_mm=None if mean is None else round(mean, 4),
                            max_mm=None if mx is None else round(mx, 4))
    return out
