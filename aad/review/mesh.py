"""Per-part mesh measures for the review diff and detectors (numpy only).

stats(part) -> dict(tris, bbox, volume, area, centroid, moments, hash, shape_hash):
  volume    |signed volume| by the divergence theorem (mm^3); meaningful for closed shells
  area      surface area (mm^2)
  centroid  volume-weighted centroid, area-weighted when the shell is open or flat
  moments   sorted principal second moments of the surface about the centroid (rotation invariant)
  hash      order-independent hash of the triangles quantized to 1 micrometre (world position)
  shape_hash the same about the centroid, 10 micrometres (translation invariant)
"""
import hashlib
import os
import struct

import numpy as np

from .glb import Part, read_parts


def read_stl(path, index=0):
    with open(path, "rb") as fh:
        data = fh.read()
    name = os.path.basename(path)
    if len(data) >= 84:
        n = struct.unpack("<I", data[80:84])[0]
        if 84 + n * 50 == len(data):
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]),
                                count=n, offset=84)
            v = rec["v"].reshape(-1, 3).astype(np.float64)
            return Part(name=name, vertices=v, triangles=np.arange(len(v)).reshape(-1, 3), index=index)
    vs = [list(map(float, ln.split()[1:4])) for ln in data.decode("ascii", "replace").splitlines()
          if ln.strip().startswith("vertex")]
    v = np.array(vs, dtype=np.float64).reshape(-1, 3)
    return Part(name=name, vertices=v, triangles=np.arange(len(v)).reshape(-1, 3), index=index)


def read_model(paths):
    """Parts of one model given as a list of .glb / .stl files. GLB parts are named by node, STL parts by file
    name; a name used twice gets " #2". Returns (parts, skipped files)."""
    parts, skipped, seen = [], [], set()
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        if ext == ".glb":
            got = read_parts(p)
        elif ext == ".stl":
            got = [read_stl(p)]
        else:
            skipped.append(p)
            continue
        for g in got:
            k, j = g.name, 2
            while k in seen:
                k, j = f"{g.name} #{j}", j + 1
            seen.add(k)
            g.name = k
            g.index = len(parts)
            g.extras = dict(g.extras, file=os.path.basename(p))
            parts.append(g)
    return parts, skipped


def _tri_arrays(part):
    v, t = part.vertices, part.triangles
    return v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]


def _hash(a, b, c, q):
    if len(a) == 0:
        return "empty"
    tri = np.stack([a, b, c], axis=1)                      # (m, 3, 3)
    qi = np.round(tri / q).astype(np.int64)
    # rotate each triangle so its lexicographically smallest vertex comes first (keeps winding)
    first = np.zeros(len(qi), dtype=np.int64)
    best = qi[:, 0, :].copy()
    for k in (1, 2):
        cand = qi[:, k, :]
        less = (cand[:, 0] < best[:, 0]) | ((cand[:, 0] == best[:, 0]) & (
            (cand[:, 1] < best[:, 1]) | ((cand[:, 1] == best[:, 1]) & (cand[:, 2] < best[:, 2]))))
        first = np.where(less, k, first)
        best = np.where(less[:, None], cand, best)
    idx = (first[:, None] + np.arange(3)[None, :]) % 3
    rot = np.take_along_axis(qi, idx[:, :, None], axis=1).reshape(len(qi), 9)
    rot = rot[np.lexsort(rot.T[::-1])]
    return hashlib.sha1(rot.tobytes()).hexdigest()[:16]


def stats(part):
    a, b, c = _tri_arrays(part)
    cr = np.cross(b - a, c - a)
    area_t = 0.5 * np.linalg.norm(cr, axis=1)
    area = float(area_t.sum())
    vol6 = np.einsum("ij,ij->i", a, np.cross(b, c))
    svol = float(vol6.sum() / 6.0)
    vol = abs(svol)
    if len(a) == 0:
        cen = np.zeros(3)
    elif vol > 1e-6 * max(area, 1e-9) ** 1.5 and vol > 1e-9:
        cen = ((a + b + c) * vol6[:, None]).sum(0) / (4.0 * vol6.sum())
    elif area > 0:
        cen = (((a + b + c) / 3.0) * area_t[:, None]).sum(0) / area
    else:
        cen = part.vertices.mean(0) if len(part.vertices) else np.zeros(3)
    if len(a):
        lo = np.minimum(np.minimum(a, b), c).min(0)
        hi = np.maximum(np.maximum(a, b), c).max(0)
        tc = (a + b + c) / 3.0 - cen
        cov = (tc * area_t[:, None]).T @ tc / max(area, 1e-12)
        moments = sorted(float(x) for x in np.linalg.eigvalsh(cov))
    else:
        lo = hi = np.zeros(3)
        moments = [0.0, 0.0, 0.0]
    return dict(tris=int(len(a)), bbox=dict(min=[float(x) for x in lo], max=[float(x) for x in hi]),
                volume=vol, area=area, centroid=[float(x) for x in cen], moments=moments,
                hash=_hash(a, b, c, 1e-3), shape_hash=_hash(a - cen, b - cen, c - cen, 1e-2))


def is_closed(part, q=1e-4):
    """True when the triangles form closed shells: after welding vertices to q mm, every undirected edge is used by
    an even, non-zero number of triangles with as many in each direction (no boundary, consistent winding). The
    viewer's weight estimate trusts the volume only then."""
    a, b, c = _tri_arrays(part)
    if len(a) == 0:
        return False
    tri = np.stack([a, b, c], axis=1).reshape(-1, 3)
    _, vid = np.unique(np.round(tri / q).astype(np.int64), axis=0, return_inverse=True)
    vid = vid.reshape(-1, 3)
    e = np.concatenate([vid[:, [0, 1]], vid[:, [1, 2]], vid[:, [2, 0]]])
    e = e[e[:, 0] != e[:, 1]]                               # degenerate (welded) triangles add nothing
    if len(e) == 0:
        return False
    fwd = e[:, 0] < e[:, 1]
    key = np.where(fwd[:, None], e, e[:, ::-1])
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    n_f = np.bincount(inv, weights=fwd.astype(np.float64))
    n_b = np.bincount(inv, weights=(~fwd).astype(np.float64))
    return bool(np.all(n_f == n_b) and np.all(n_f > 0))


# ---- detector helpers ----
def components(part, q=1e-3):
    """Connected components of the triangle mesh after welding vertices closer than q mm."""
    v, t = part.vertices, part.triangles
    if len(t) == 0:
        return 0
    _, inv = np.unique(np.round(v / q).astype(np.int64), axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    tt = inv[t]
    n = int(inv.max()) + 1
    used = np.unique(tt.reshape(-1))
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        e = np.concatenate([tt[:, [0, 1]], tt[:, [1, 2]]])
        g = coo_matrix((np.ones(len(e), dtype=np.int8), (e[:, 0], e[:, 1])), shape=(n, n))
        _, lab = connected_components(g, directed=False)
        return int(len(np.unique(lab[used])))
    except ImportError:
        pass
    parent = np.arange(n)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    # vectorized label propagation, then a union-find pass for what is left
    lab = np.arange(n)
    for _ in range(64):
        m = np.minimum(np.minimum(lab[tt[:, 0]], lab[tt[:, 1]]), lab[tt[:, 2]])
        new = lab.copy()
        for k in range(3):
            np.minimum.at(new, tt[:, k], m)
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    else:
        parent = lab.copy()
        for a, b, c in tt:
            ra, rb, rc = find(a), find(b), find(c)
            r = min(ra, rb, rc)
            parent[ra] = parent[rb] = parent[rc] = r
        lab = np.array([find(i) for i in range(n)])
    return int(len(np.unique(lab[used])))


def sliver_mask(part, aspect=40.0, min_height=0.05):
    """Boolean mask of the needle- or cap-shaped triangles: longest edge / shortest altitude above `aspect` and
    shortest altitude under `min_height` mm, plus the area of every triangle (mm2)."""
    a, b, c = _tri_arrays(part)
    if len(a) == 0:
        return np.zeros(0, bool), np.zeros(0)
    e = np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)], 1)
    longest = e.max(1)
    area2 = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    h = np.where(longest > 0, area2 / np.maximum(longest, 1e-12), 0)
    return (longest > aspect * np.maximum(h, 1e-12)) & (h < min_height) & (area2 > 1e-12), area2 / 2


def slivers(part, aspect=40.0, min_height=0.05):
    """Triangles that are needle- or cap-shaped (sliver_mask). CAD tessellation makes some of these on curved faces,
    and a finer tessellation makes more of them with no change in shape: the detector compares the count and the
    summed area against the baseline."""
    return int(np.count_nonzero(sliver_mask(part, aspect, min_height)[0]))


def component_labels(part, q=1e-3):
    """Per-triangle shell label (connected components after welding vertices closer than q mm) and the count."""
    v, t = part.vertices, part.triangles
    if len(t) == 0:
        return np.zeros(0, np.int64), 0
    _, inv = np.unique(np.round(v / q).astype(np.int64), axis=0, return_inverse=True)
    tt = inv.reshape(-1)[t]
    n = int(tt.max()) + 1
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        e = np.concatenate([tt[:, [0, 1]], tt[:, [1, 2]]])
        _, vl = connected_components(coo_matrix((np.ones(len(e), dtype=np.int8), (e[:, 0], e[:, 1])), shape=(n, n)),
                                     directed=False)
        _, tl = np.unique(vl[tt[:, 0]], return_inverse=True)
        return tl.reshape(-1), int(tl.max()) + 1
    except ImportError:
        pass
    lab = np.arange(n)
    while True:                                   # label propagation over triangle corners to a fixed point
        m = np.minimum(np.minimum(lab[tt[:, 0]], lab[tt[:, 1]]), lab[tt[:, 2]])
        new = lab.copy()
        for k in range(3):
            np.minimum.at(new, tt[:, k], m)
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    tl = lab[tt[:, 0]]
    _, tl = np.unique(tl, return_inverse=True)
    return tl.reshape(-1), int(tl.max()) + 1


# ---- wall thickness ----
# A ray from each triangle centre goes inward (against the outward normal) to the part's own surface. A hit counts as
# the far side of a wall only when (1) the far face shares no vertex with the origin triangle (a face meeting it at an
# edge or corner, as at a sharp wedge or along a fillet, is the same surface turning, not the other side of a wall),
# (2) the far face faces back toward the origin face (normals at least 120 degrees apart: the ray leaves the solid
# through it, it does not graze a side face), and (3) the reading is backed by a patch of agreeing samples: the
# triangles of the same surface within max(1, 3 t) mm whose own reading is within 50 percent + 0.05 mm sum to at
# least PATCH_MM2 of area. The search is exhaustive (every triangle centre) but only looks `cap` mm deep, with the
# rays processed in spatially coherent blocks against the triangles near each block, so the answer is deterministic.
ADJ_Q = 1e-4
OPPOSE_COS = 0.5
PATCH_MM2 = 0.5


def _morton(q):
    q = np.clip(q, 0, 0x1FFFFF).astype(np.int64)

    def spread(x):
        x = (x | (x << 32)) & 0x1F00000000FFFF
        x = (x | (x << 16)) & 0x1F0000FF0000FF
        x = (x | (x << 8)) & 0x100F00F00F00F00F
        x = (x | (x << 4)) & 0x10C30C30C30C30C3
        x = (x | (x << 2)) & 0x1249249249249249
        return x
    return spread(q[:, 0]) | (spread(q[:, 1]) << 1) | (spread(q[:, 2]) << 2)


def _cast(org, d, src_vid, a, e1, e2, n, vid):
    """Nearest valid hit (t, triangle index) per ray against triangles a, e1, e2 with normals n and welded vertex ids
    vid; rules (1) and (2) above. t is inf where nothing counts."""
    pv = np.cross(d[:, None, :], e2[None, :, :])
    det = np.einsum("tk,rtk->rt", e1, pv)
    good = np.abs(det) > 1e-12
    inv = np.where(good, 1.0 / np.where(good, det, 1.0), 0.0)
    tv = org[:, None, :] - a[None, :, :]
    u = np.einsum("rtk,rtk->rt", tv, pv) * inv
    qv = np.cross(tv, e1[None, :, :])
    v = np.einsum("rk,rtk->rt", d, qv) * inv
    t = np.einsum("tk,rtk->rt", e2, qv) * inv
    hit = good & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-4)
    hit &= ~(vid[None, :, :, None] == src_vid[:, None, None, :]).any(axis=(2, 3))
    hit &= np.einsum("rk,tk->rt", -d, n) <= -OPPOSE_COS
    t = np.where(hit, t, np.inf)
    k = t.argmin(1)
    return t[np.arange(len(org)), k], k


def thickness_map(part, cap, block=128):
    """Wall thickness under every triangle centre where it is at most `cap` mm (inf elsewhere), the far triangle of
    each, and the triangle centres, unit normals and areas (mm2)."""
    a, b, c = _tri_arrays(part)
    m = len(a)
    cr = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cr, axis=1)
    ok = area2 > 1e-10
    n = np.zeros_like(cr)
    n[ok] = cr[ok] / area2[ok, None]
    _, vid = np.unique(np.round(part.vertices / ADJ_Q).astype(np.int64), axis=0, return_inverse=True)
    vid = vid.reshape(-1)[part.triangles]
    cen = (a + b + c) / 3.0
    e1, e2 = b - a, c - a
    lo, hi = np.minimum(np.minimum(a, b), c), np.maximum(np.maximum(a, b), c)
    T, K = np.full(m, np.inf), np.full(m, -1)
    src = np.nonzero(ok)[0]
    if len(src):
        c0 = cen[src].min(0)
        cell = max(cap, float((cen[src].max(0) - c0).max()) / 2e6, 1e-6)
        order = src[np.argsort(_morton(np.floor((cen[src] - c0) / cell)), kind="stable")]
        for s in range(0, len(order), block):
            ids = order[s:s + block]
            clo, chi = cen[ids].min(0) - cap, cen[ids].max(0) + cap
            cand = np.nonzero(np.all((lo <= chi) & (hi >= clo), axis=1))[0]
            if not len(cand):
                continue
            t, k = _cast(cen[ids], -n[ids], vid[ids], a[cand], e1[cand], e2[cand], n[cand], vid[cand])
            got = t <= cap
            T[ids[got]] = t[got]
            K[ids[got]] = cand[k[got]]
    return T, K, cen, n, area2 / 2, ok


def min_thickness(part, cap=4.0, max_tris=400000, detail=False):
    """Thinnest wall found under any triangle centre, up to `cap` mm deep (rules above). Returns (thickness mm or
    None, world point mid-wall), or with detail=True (thickness, point, evidence) where evidence holds the world
    origin and far points, both triangles' corners, the agreeing patch's area and sample count."""
    none = (None, None, None) if detail else (None, None)
    a, b, c = _tri_arrays(part)
    if len(a) == 0 or len(a) > max_tris:
        return none
    T, K, cen, n, area, ok = thickness_map(part, cap)
    for i0 in np.argsort(T, kind="stable"):
        t0 = T[i0]
        if not np.isfinite(t0):
            return none
        near = np.nonzero(ok & (np.linalg.norm(cen - cen[i0], axis=1) <= max(1.0, 3 * t0)) & (n @ n[i0] >= 0.9)
                          & (T <= 1.5 * t0 + 0.05))[0]
        patch = float(area[near].sum())
        if patch < PATCH_MM2:
            continue
        org, far = cen[i0], cen[i0] - n[i0] * t0
        where = ((org + far) / 2).tolist()
        if not detail:
            return float(t0), where
        k = K[i0]
        return float(t0), where, dict(origin=org.tolist(), hit=far.tolist(),
                                      origin_tri=[a[i0].tolist(), b[i0].tolist(), c[i0].tolist()],
                                      hit_tri=[a[k].tolist(), b[k].tolist(), c[k].tolist()],
                                      patch_mm2=round(patch, 4), samples=int(len(near)))
    return none
