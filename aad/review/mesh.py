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


def slivers(part, aspect=40.0, min_height=0.05):
    """Triangles that are needle- or cap-shaped: longest edge / shortest altitude above `aspect` and shortest
    altitude under `min_height` mm. CAD tessellation makes some of these on curved faces; the detector compares
    against the baseline count."""
    a, b, c = _tri_arrays(part)
    if len(a) == 0:
        return 0
    e = np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)], 1)
    longest = e.max(1)
    area2 = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    h = np.where(longest > 0, area2 / np.maximum(longest, 1e-12), 0)
    return int(np.count_nonzero((longest > aspect * np.maximum(h, 1e-12)) & (h < min_height) & (area2 > 1e-12)))


def min_thickness(part, samples=400, max_tris=400000, seed=0):
    """Smallest wall thickness found by casting rays inward (against the outward normal) from sampled triangle
    centres to the part's own surface. Returns (thickness mm or None, world point of the thinnest sample)."""
    a, b, c = _tri_arrays(part)
    m = len(a)
    if m == 0 or m > max_tris:
        return None, None
    cr = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cr, axis=1)
    ok = area2 > 1e-10
    if not ok.any():
        return None, None
    n = np.zeros_like(cr)
    n[ok] = cr[ok] / area2[ok, None]
    if m <= samples:
        idx = np.nonzero(ok)[0]
    else:
        rng = np.random.default_rng(seed)
        p = np.where(ok, area2, 0)
        idx = rng.choice(m, size=samples, replace=False, p=p / p.sum())
    org = (a[idx] + b[idx] + c[idx]) / 3.0
    d = -n[idx]
    e1, e2 = b - a, c - a
    best, where = np.inf, None
    chunk = max(1, int(4e6 // max(m, 1)))
    for s in range(0, len(idx), chunk):
        o, dd = org[s:s + chunk], d[s:s + chunk]
        pv = np.cross(dd[:, None, :], e2[None, :, :])
        det = np.einsum("tk,rtk->rt", e1, pv)
        good = np.abs(det) > 1e-12
        inv = np.where(good, 1.0 / np.where(good, det, 1.0), 0.0)
        tv = o[:, None, :] - a[None, :, :]
        u = np.einsum("rtk,rtk->rt", tv, pv) * inv
        qv = np.cross(tv, e1[None, :, :])
        v = np.einsum("rk,rtk->rt", dd, qv) * inv
        t = np.einsum("tk,rtk->rt", e2, qv) * inv
        hit = good & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-4)
        t = np.where(hit, t, np.inf)
        tm = t.min(1)
        k = int(np.argmin(tm))
        if tm[k] < best:
            best, where = float(tm[k]), (o[k] + dd[k] * tm[k] / 2).tolist()
    return (best if np.isfinite(best) else None), where
