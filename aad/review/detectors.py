"""Cheap mesh-level detectors run by the diff on changed and added parts. They are warnings, not errors: each
compares the current part with its baseline so long-standing tessellation quirks do not fire every build. Every
warning carries `evidence`, part-local mm (the part's node frame, as the viewer's mesh holds it), so the page can fly
to the spot and mark it without recomputing anything:

  new_components  more disconnected shells than the baseline (a cut split the part, or a stray body appeared);
                  evidence: the smallest extra shells' triangles
  slivers         many more needle or cap triangles than the baseline AND their summed area is a real share of the
                  part's surface that grew against the baseline; a finer tessellation alone multiplies the count
                  without adding area, so this is a mesh hint (hint: true); evidence: the sliver triangles (capped)
  thin_feature    a wall thinner than THIN_MM where the baseline was thicker (mesh.min_thickness: exhaustive inward
                  rays, adjacent faces and grazing hits ignored, backed by a patch of agreeing samples); evidence:
                  the ray's origin and far points and both triangles
  triangle_jump   triangle count more than doubled or halved; evidence: none (the part)
  floating        the part touches no other part (bounding boxes CONTACT_MM apart) but did in the baseline;
                  evidence: the part's box
"""
import time

import numpy as np

from .mesh import component_labels, components, min_thickness, sliver_mask

THIN_MM = 0.5
CONTACT_MM = 0.05
MAX_THIN_TRIS = 120000
SLIVER_AREA_FRAC = 0.01          # slivers must cover at least 1 percent of the part's surface ...
SLIVER_AREA_GROWTH = 1.5         # ... and 1.5 times the baseline's share plus half a percentage point
MAX_EVIDENCE_TRIS = 1500
BASELINE_CAP_MM = 4.0            # how deep the baseline's wall is searched for the comparison and the message


def _w(kind, part, message, value=None, baseline=None, at=None, evidence=None, hint=False):
    out = dict(kind=kind, part=part, message=message, value=value, baseline=baseline, at=at, evidence=evidence)
    if hint:
        out["hint"] = True
    return out


def _local(part, pts):
    """World points (n, 3) into the part's node frame, rounded to a micrometre."""
    p = np.asarray(pts, float).reshape(-1, 3)
    if part.matrix is not None:
        m = np.linalg.inv(part.matrix)
        p = p @ m[:3, :3].T + m[:3, 3]
    return np.round(p, 4)


def _tri_list(part, mask, limit=MAX_EVIDENCE_TRIS):
    """Flat part-local corner list [x, y, z, ...] (9 numbers per triangle) of the masked triangles, largest first
    when over `limit`, and how many there were."""
    idx = np.nonzero(mask)[0]
    total = int(len(idx))
    if total > limit:
        v, t = part.vertices, part.triangles[idx]
        ar = np.linalg.norm(np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1)
        idx = idx[np.argsort(-ar, kind="stable")[:limit]]
    corners = part.vertices[part.triangles[idx]].reshape(-1, 3)
    return _local(part, corners).reshape(-1).tolist(), total


def _touching(stats_by_name, contact):
    names = list(stats_by_name)
    if len(names) < 2:
        return {n: True for n in names}
    lo = np.array([stats_by_name[n]["bbox"]["min"] for n in names]) - contact
    hi = np.array([stats_by_name[n]["bbox"]["max"] for n in names]) + contact
    ov = np.all((lo[:, None, :] <= hi[None, :, :]) & (lo[None, :, :] <= hi[:, None, :]), axis=2)
    np.fill_diagonal(ov, False)
    return {n: bool(ov[i].any()) for i, n in enumerate(names)}


def run(rows, parts_a, parts_b, stats_a, stats_b, thin_mm=THIN_MM, contact_mm=CONTACT_MM, deadline=None):
    out = []
    touch_a = _touching(stats_a, contact_mm)
    touch_b = _touching(stats_b, contact_mm)
    for r in rows:
        n, st = r["name"], r["status"]
        if st not in ("changed", "added", "moved"):
            continue
        b = parts_b[n]
        a = parts_a.get(n) if st != "added" else None
        if len(stats_b) > 1 and not touch_b.get(n, True) and (a is None or touch_a.get(n, False)):
            bb = stats_b[n]["bbox"]
            box = _local(b, [bb["min"], bb["max"]])
            out.append(_w("floating", n, "touches no other part" + ("" if a is None else " (it did in the baseline)"),
                          evidence=dict(box_world=dict(min=bb["min"], max=bb["max"]),
                                        corners=box.reshape(-1).tolist())))
        if st == "moved":
            continue
        cb = components(b)
        ca = components(a) if a is not None else 1
        if cb > ca:
            lab, k = component_labels(b)
            sizes = np.bincount(lab, minlength=k)
            extra = np.argsort(sizes, kind="stable")[:max(1, k - ca)]     # the smallest shells are the stray ones
            tris, total = _tri_list(b, np.isin(lab, extra))
            out.append(_w("new_components", n, f"{cb} disconnected shells, baseline {ca}", cb, ca,
                          evidence=dict(tris=tris, count=total, shells=int(len(extra)))))
        mb, ab = sliver_mask(b)
        sb_ = int(mb.sum())
        if a is not None:
            ma, aa = sliver_mask(a)
            sa_, fa = int(ma.sum()), float(aa[ma].sum() / max(aa.sum(), 1e-12))
        else:
            sa_, fa = 0, 0.0
        fb = float(ab[mb].sum() / max(ab.sum(), 1e-12))
        if sb_ >= max(8, int(sa_ * 1.5) + 8) and fb >= SLIVER_AREA_FRAC and fb >= fa * SLIVER_AREA_GROWTH + 0.005:
            tris, total = _tri_list(b, mb)
            out.append(_w("slivers", n, f"{sb_} sliver triangles covering {100 * fb:.1f} % of the surface, baseline "
                                        f"{sa_} ({100 * fa:.1f} %)", sb_, sa_, hint=True,
                          evidence=dict(tris=tris, count=total, area_mm2=round(float(ab[mb].sum()), 3),
                                        area_frac=round(fb, 5), baseline_area_frac=round(fa, 5))))
        tb, ta = stats_b[n]["tris"], (stats_a[n]["tris"] if a is not None else None)
        if ta and (tb > 2 * ta or tb < ta / 2) and abs(tb - ta) > 100:
            out.append(_w("triangle_jump", n, f"triangle count {ta} -> {tb}", tb, ta))
        if deadline is not None and time.time() > deadline:
            continue
        if tb > MAX_THIN_TRIS:
            continue
        thick_b, at, ev = min_thickness(b, cap=thin_mm, detail=True)
        if thick_b is not None and thick_b < thin_mm:
            thick_a = None
            if a is not None and stats_a[n]["tris"] <= MAX_THIN_TRIS:
                thick_a, _ = min_thickness(a, cap=max(BASELINE_CAP_MM, 1.5 * thick_b + 0.05))
            if thick_a is None or thick_a > thick_b * 1.5 + 0.05:
                base = (f" (baseline {thick_a:.2f} mm)" if thick_a is not None else
                        f" (baseline over {max(BASELINE_CAP_MM, 1.5 * thick_b + 0.05):.2f} mm)" if a is not None else "")
                pts = _local(b, [ev["origin"], ev["hit"], *ev["origin_tri"], *ev["hit_tri"]])
                evidence = dict(origin=pts[0].tolist(), hit=pts[1].tolist(), origin_tri=pts[2:5].reshape(-1).tolist(),
                                hit_tri=pts[5:8].reshape(-1).tolist(), thickness=round(thick_b, 4),
                                patch_mm2=ev["patch_mm2"], samples=ev["samples"])
                out.append(_w("thin_feature", n, f"wall {thick_b:.2f} mm thick" + base,
                              round(thick_b, 4), round(thick_a, 4) if thick_a is not None else None, at, evidence))
    return out
