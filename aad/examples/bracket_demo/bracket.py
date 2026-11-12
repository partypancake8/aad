"""Bracket demo: a printed L bracket bolted to a laser-cut base plate through a boss.

    pip install build123d                                  # only this script needs it
    python aad/examples/bracket_demo/bracket.py            # rewrites good/bracket_demo.glb and bad/bracket_demo.glb

good: the M5 through hole is concentric with the boss and with the screw-head counterbore in the boss top.
bad:  a planted agent edit for "move the hole 5 mm": the hole moved +5 mm in X but the boss and the counterbore
      did not (a 0.25 mm wall is left on the boss), and the agent also moved the base plate's clearance hole,
      which was outside the scope lock (bracket only). `aad review diff good/... bad/...` with that scope reports
      bracket changed with a thin_feature warning and base_plate as COLLATERAL.

Units mm, Z up. Parts: bracket (PETG), base_plate (3 mm aluminium), screw_m5x20 (socket head cap screw).
"""
import argparse
import os
import sys

from build123d import Align, Box, Cylinder, Location

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(HERE))))
from aad.review.glb import write_parts  # noqa: E402

MIN = (Align.CENTER, Align.CENTER, Align.MIN)
HOLE_R, BOSS_R, BOSS_H, PLATE_T, BASE_T = 2.75, 8.0, 10.0, 5.0, 3.0
CB_R, CB_D = 5.0, 5.0                      # counterbore for the M5 head (8.5 mm) in the boss top


def parts(bad=False):
    dx = 5.0 if bad else 0.0
    top = PLATE_T + BOSS_H
    body = Box(60, 40, PLATE_T, align=MIN) + Box(60, 5, 35, align=MIN).moved(Location((0, 17.5, 0)))
    body += Cylinder(BOSS_R, BOSS_H, align=MIN).moved(Location((0, 0, PLATE_T)))
    body -= Cylinder(HOLE_R, 60).moved(Location((dx, 0, 0)))
    body -= Cylinder(CB_R, CB_D, align=MIN).moved(Location((0, 0, top - CB_D)))
    base = Box(100, 80, BASE_T, align=MIN).moved(Location((0, 0, -BASE_T)))
    base -= Cylinder(HOLE_R, 20).moved(Location((dx, 0, 0)))
    screw = Cylinder(2.5, 20, align=MIN).moved(Location((0, 0, top - CB_D - 20)))
    screw += Cylinder(4.25, 5, align=MIN).moved(Location((0, 0, top - CB_D)))
    return dict(bracket=(body, (0.51, 0.67, 0.78)), base_plate=(base, (0.72, 0.74, 0.77)),
                screw_m5x20=(screw, (0.18, 0.19, 0.21)))


def mesh(shape, tol=0.02, ang=0.15):
    verts, tris = shape.tessellate(tol, ang)
    return [tuple(v) for v in verts], [tuple(t) for t in tris]


def write(out_dir, bad):
    os.makedirs(out_dir, exist_ok=True)
    data = {}
    for name, (shape, rgb) in parts(bad).items():
        v, t = mesh(shape)
        data[name] = (v, t, rgb)
    return write_parts(os.path.join(out_dir, "bracket_demo.glb"), data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=HERE, help="writes <out>/good/ and <out>/bad/ (default: next to this file)")
    a = ap.parse_args(argv)
    for kind in ("good", "bad"):
        print(write(os.path.join(a.out, kind), kind == "bad"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
