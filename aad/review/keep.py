"""Keep pins are local locks: the reviewer pins a spot with the `keep` class ("This is right; do not change it"). When any
geometry within NEAR_MM of a keep pin's point changes between the reviewed build and the current one, that is
flagged like collateral (top of the viewer's Revisions tab, `aad review`), even when the part is inside the scope lock.
A region keep pin (no point) is flagged when any of its parts changed."""
from . import diff as D
from .store import OPEN

KEEP = "keep"


def keep_pins(pins):
    """The open keep pins of a pin list."""
    return [p for p in pins or [] if p.get("issue_class") == KEEP and p.get("status") in OPEN]


def keep_changes(a_paths, b_paths, pins, radius=D.NEAR_MM):
    """[{id, n, nodes, parts, part_changed, near_changed, radius_mm, message}] for every open keep pin whose
    neighbourhood (or, for a region pin, whose parts) changed from build a to build b; [] when none did."""
    kp = keep_pins(pins)
    if not kp or not a_paths or not b_paths:
        return []
    res = D.pin_changes(a_paths, b_paths, kp, radius)
    out = []
    for p in kp:
        r = res.get(p["id"]) or {}
        near = r.get("near_changed")
        if not (near is True or (near is None and r.get("part_changed"))):
            continue
        nodes = [p["anchor"]["part"]["node"]] if p.get("anchor") else [x["node"] for x in p.get("parts") or []]
        what = f"geometry within {radius:g} mm of it changed" if near is not None else "its part changed"
        out.append(dict(id=p["id"], n=p["n"], nodes=nodes, parts=r.get("parts") or [],
                        part_changed=bool(r.get("part_changed")), near_changed=near, radius_mm=radius,
                        message=f"keep pin #{p['n']} on {', '.join(nodes)}: {what}; the user locked this spot, "
                                f"put it back as it was"))
    return out
