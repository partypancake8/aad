"""Cheap mesh-level detectors run by the diff on changed and added parts. They are warnings, not errors: each
compares the current part with its baseline so long-standing tessellation quirks do not fire every build.

  new_components  more disconnected shells than the baseline (a cut split the part, or a stray body appeared)
  slivers         many more needle or cap triangles than the baseline (knife edges, near-tangent cuts)
  thin_feature    a wall thinner than THIN_MM where the baseline was thicker (an inward ray test)
  triangle_jump   triangle count more than doubled or halved
  floating        the part touches no other part (bounding boxes CONTACT_MM apart) but did in the baseline
"""
import time

import numpy as np

from .mesh import components, min_thickness, slivers

THIN_MM = 0.5
CONTACT_MM = 0.05
MAX_THIN_TRIS = 120000


def _w(kind, part, message, value=None, baseline=None, at=None):
    return dict(kind=kind, part=part, message=message, value=value, baseline=baseline, at=at)


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
            out.append(_w("floating", n, "touches no other part" + ("" if a is None else " (it did in the baseline)")))
        if st == "moved":
            continue
        cb = components(b)
        ca = components(a) if a is not None else 1
        if cb > ca:
            out.append(_w("new_components", n, f"{cb} disconnected shells, baseline {ca}", cb, ca))
        sb_, sa_ = slivers(b), (slivers(a) if a is not None else 0)
        if sb_ >= max(8, int(sa_ * 1.5) + 8):
            out.append(_w("slivers", n, f"{sb_} sliver triangles, baseline {sa_}", sb_, sa_))
        tb, ta = stats_b[n]["tris"], (stats_a[n]["tris"] if a is not None else None)
        if ta and (tb > 2 * ta or tb < ta / 2) and abs(tb - ta) > 100:
            out.append(_w("triangle_jump", n, f"triangle count {ta} -> {tb}", tb, ta))
        if deadline is not None and time.time() > deadline:
            continue
        if tb > MAX_THIN_TRIS:
            continue
        samples = int(min(tb, max(400, 4e6 / max(tb, 1))))
        thick_b, at = min_thickness(b, samples=samples)
        if thick_b is not None and thick_b < thin_mm:
            thick_a = None
            if a is not None and stats_a[n]["tris"] <= MAX_THIN_TRIS:
                thick_a, _ = min_thickness(a, samples=int(min(stats_a[n]["tris"], max(400, 4e6 / max(stats_a[n]["tris"], 1)))))
            if thick_a is None or thick_a > thick_b * 1.5 + 0.05:
                out.append(_w("thin_feature", n, f"wall {thick_b:.2f} mm thick" +
                              (f" (baseline {thick_a:.2f} mm)" if thick_a is not None else ""),
                              round(thick_b, 4), round(thick_a, 4) if thick_a is not None else None, at))
    return out
