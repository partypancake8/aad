"""`aad review`: what the viewer knows, for a coding agent.

  aad review [--project DIR] [--json]           open pins, scope lock, latest diff summary, camera, packets
  aad review resolve <pin-id> [--project DIR]   mark a pin resolved (it reopens if its part changes again)
  aad review diff [a.glb [b.glb]] [--json]      per-part diff of b against a (+ detectors); with --project
                                                   the project's scope lock decides collateral. Without a: the
                                                   build your last packet was sent against ("since your last
                                                   packet"), else the previous build; without b: the current build.
                                                   The first line says which baseline was used.
  aad review tour-template [--project DIR]      an empty tour.json for the current build, to fill and save as
                                                   <project>/.cadreview/tour.json
"""
import argparse
import datetime
import json
import os
import sys

from . import diff as D
from .edges import CHANGED_LINE, edge_changes
from .schema import SCHEMA
from .keep import keep_changes, keep_pins
from .store import Store, build_id, escalated_first, find_project, hhmm, is_repinned, issue_classes, with_reason


def _store(a):
    return Store(find_project(a.project))


def _pin_line(p, orphaned):
    where = ""
    if p.get("anchor"):
        an = p["anchor"]
        where = f"{an['part']['node']} at local ({', '.join(f'{x:.1f}' for x in an['local'])}) mm"
        e = p.get("edge")
        if e:
            v = lambda q: "(" + ", ".join(f"{x:.1f}" for x in q) + ")"
            where += (f"; edge {e['length_mm']:.2f} mm from {v(e['start'])} to {v(e['end'])}, direction "
                      f"{v(e['direction'])}, {len(e['points'])} points")
    elif p.get("parts"):
        where = f"region of {len(p['parts'])} part(s): " + ", ".join(x["node"] for x in p["parts"][:6])
    tag = " ORPHANED (part missing in the current build)" if orphaned else ""
    if p.get("edge_changed"):
        tag += f"\n      EDGE CHANGED: {CHANGED_LINE}"
    st = "" if p["status"] == "open" else f" [{p['status'].upper()}]"
    if p["status"] == "not_fixed":
        st = f" [NOT FIXED, attempt {p.get('attempts') or 1}]"
    elif is_repinned(p):
        st = f" [REPINNED, attempt {p.get('attempts') or 1}]"
    m = p.get("measure")
    meas = f"; measured {m['distance']:.2f} mm" if m else ""
    why = p.get("reason") or p.get("note") or ""
    also = f"\n      class: {p['class_meaning']}" if p.get("note") and p.get("class_meaning") else ""
    if p.get("escalation"):
        also = f"\n      {p['escalation']}" + also
    fu = f" (follow-up to {p['parent']})" if p.get("parent") else ""
    grp = f"{p['group'].replace('_', ' ')}: " if p.get("group") else ""
    ins = f" ({p['instruction']})" if p.get("instruction") else ""
    return (f"  #{p['n']} ({p['id']}){st}{fu} {grp}{p['issue_class']}{ins} / {p['severity']}: {why}\n      {where}{meas}"
            f"{tag}{also}" + _history_lines(p))


def _local_hhmm(iso):
    """HH:MM in local time of an ISO time (the viewer writes UTC "Z" times)."""
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return hhmm(iso)


def _history_lines(p):
    """The repin trail of a pin, oldest first: where it was and what it said before each repin."""
    out = []
    for i, h in enumerate(p.get("history") or []):
        an = h.get("anchor")
        if an:
            where = f"{an['part']['node']} at local ({', '.join(f'{x:.1f}' for x in an['local'])}) mm"
        else:
            where = f"region of {len(h.get('parts') or [])} part(s): " + ", ".join(x["node"] for x in (h.get("parts") or [])[:6])
        why = h.get("note") or "(no note: the class meaning)"
        out.append(f"\n      earlier {i + 1} ({_local_hhmm(h.get('at'))}, build {h.get('build')}, {h.get('status')}): "
                   f"{h.get('issue_class')}: {why}; at {where}")
    return "".join(out)


def _keep_check(store, cur):
    """Keep pins whose neighbourhood changed against the default baseline (since your last packet when there is one),
    as (list, baseline label)."""
    if not keep_pins(store.pins()):
        return [], None
    files = [p for p in cur.get("files") or [] if os.path.exists(p)]
    b, _, label = store.default_baseline(cur.get("build"))
    if not files or not b:
        return [], None
    return keep_changes(b["paths"], files, store.pins()), label


def status(store):
    cur = store.current() or {}
    parts = set(cur.get("parts") or [])
    open_pins, classes = [], issue_classes()
    files = [f for f in cur.get("files") or [] if os.path.exists(f)]
    try:
        ec = edge_changes(files, store.pins("open"), cur.get("build"))
    except Exception as e:                   # a model that cannot be read leaves the pins as they are
        print(f"edge check skipped: {e}", file=sys.stderr)
        ec = {}
    for p in escalated_first(store.pins("open")):
        p = with_reason(p, classes)
        nodes = [p["anchor"]["part"]["node"]] if p.get("anchor") else [x["node"] for x in p.get("parts") or []]
        q = dict(p, orphaned=bool(parts) and any(n not in parts for n in nodes))
        if p["id"] in ec:
            q["edge_changed"] = ec[p["id"]]["edge_changed"]
            if q["edge_changed"]:
                q["edge_note"] = CHANGED_LINE
        open_pins.append(q)
    all_pins = store.pins()
    b, kind, label = store.default_baseline(cur.get("build"))
    baseline = dict(kind=kind, id=b["id"], build=b.get("build"), label=label, packet=b.get("packet"),
                    files=b["paths"]) if b else None
    cam = store.camera() or {}
    tour = store.tour()
    kc, kc_label = _keep_check(store, cur)
    return dict(schema=SCHEMA, project=store.project, review_dir=store.root,
                model={k: cur.get(k) for k in ("name", "files", "build", "updated")} if cur else None,
                open_pins=open_pins, resolved_pins=sum(1 for p in all_pins if p["status"] == "resolved"),
                scope=store.scope()["parts"], baseline=baseline, diff=D.summary(store.latest_diff()),
                camera=cam.get("camera"), selection=cam.get("selection"),
                packets=store.packets()[:5],
                tour=dict(path=store.path("tour.json"), stops=len(tour.get("stops", [])),
                          decisions=tour.get("decisions", {})) if tour else None,
                issues=store.issue_counts(), keep_changed=kc, keep_against=kc_label)


def format_status(s):
    out = [f"project {s['project']}"]
    m = s.get("model")
    out.append(f"model {m['name']} build {m['build']} ({len(m['files'] or [])} file(s))" if m else
               "model: none yet (open the viewer once with --project)")
    for k in s.get("keep_changed") or []:
        out.append(f"KEEP PIN CHANGED {k['message']} (against {s.get('keep_against')})")
    nf = sum(1 for p in s["open_pins"] if p["status"] == "not_fixed")
    nr = sum(1 for p in s["open_pins"] if is_repinned(p))
    first = " and ".join(x for x in (f"{nf} marked NOT FIXED" if nf else "", f"{nr} REPINNED" if nr else "") if x)
    out.append(f"open pins: {len(s['open_pins'])} (resolved {s['resolved_pins']})"
               + (f"; {first}, listed first" if first else ""))
    for p in s["open_pins"]:
        out.append(_pin_line(p, p.get("orphaned")))
    sc = s["scope"]
    out.append(f"scope lock: {len(sc)} part(s) may change" + (": " + ", ".join(x["node"] for x in sc[:12]) if sc else
                                                              " (none set)"))
    bl = s.get("baseline")
    out.append(f"diff baseline: {bl['label']}, build {bl['build']}" + (f", packet {bl['packet']}" if bl.get("packet")
               else "") if bl else "diff baseline: none yet (appears after a rebuild or a packet)")
    d = s.get("diff")
    if d:
        su = d["summary"]
        out.append(f"latest diff against {d['against']}: {su['changed']} changed, {su['moved']} moved, "
                   f"{su['added']} added, {su['removed']} removed; {len(d['collateral'])} collateral")
        if bl and d.get("against_build") != bl["build"]:
            out.append("  (not against the diff baseline above; run `aad review diff` for it)")
        for c in d["collateral"][:12]:
            out.append(f"  COLLATERAL {c}")
        for w in d["warnings"][:12]:
            out.append(f"  warning {w['kind']}{' (mesh hint)' if w.get('hint') else ''} {w['part']}: {w['message']}")
    else:
        out.append("latest diff: none")
    c = s.get("camera")
    if c:
        out.append(f"camera {c.get('projection')} position {c['position']} target {c['target']} view {c.get('view')}")
    if s.get("selection"):
        out.append(f"selection {s['selection']['key']}")
    for p in s["packets"][:3]:
        out.append(f"packet {p['id']}: {p['packet']} + {p['screenshot']}")
    if s.get("tour"):
        out.append(f"tour {s['tour']['path']}: {s['tour']['stops']} stop(s), {len(s['tour']['decisions'])} decided")
    return "\n".join(out)


def cmd_status(a):
    s = status(_store(a))
    print(json.dumps(s, indent=1) if a.json else format_status(s))
    return 0


def cmd_resolve(a):
    st = _store(a)
    cur = st.current() or {}
    try:
        p = st.resolve(a.pin, build=cur.get("build"))
    except KeyError as e:
        print(str(e).strip("'"), file=sys.stderr)
        return 1
    print(json.dumps(p, indent=1) if a.json else f"resolved #{p['n']} ({p['id']}): {p['note']}")
    return 0


def cmd_diff(a):
    scope = None
    st = None
    if a.project or not (a.a and a.b):
        st = _store(a)
        sc = st.scope()["parts"]
        scope = [x["node"] for x in sc] if sc else None
    cur = (st.current() or {}) if st else {}
    if a.b:
        b_paths, b_label = [a.b], os.path.basename(a.b)
    else:
        b_paths, b_label = [p for p in cur.get("files") or [] if os.path.exists(p)], "current build"
        if not b_paths:
            print("no current build in the project (open the viewer once with --project, or name b.glb)",
                  file=sys.stderr)
            return 1
    b_build = build_id(b_paths)
    kind = packet = None
    if a.a:
        a_paths, a_label, a_id, a_build, kind = [a.a], os.path.basename(a.a), None, build_id([a.a]), "file"
        used = f"baseline: {a.a} (named)"
    else:
        bl, kind, a_label = st.default_baseline(b_build)
        if not bl:
            print("no baseline yet: the previous build appears after a rebuild, the reviewed one after a packet",
                  file=sys.stderr)
            return 1
        a_paths, a_id, a_build, packet = bl["paths"], bl["id"], bl.get("build"), bl.get("packet")
        used = (f"baseline: {a_label}, build {a_build}" + (f", packet {packet}" if packet else "")
                + f" ({', '.join(a_paths)})")
    doc = D.diff(a_paths, b_paths, scope=scope, a_label=a_label, b_label=b_label, a_id=a_id, a_build=a_build,
                 b_build=b_build, thin_mm=a.thin, a_kind=kind, a_packet=packet)
    if st and a.save:
        st.save_diff(doc)

        def diff_for(build):
            for x in st.baselines():
                if x.get("build") == build:
                    return D.diff(x["paths"], b_paths, a_label=f"build {build}", a_build=build, detect=False)
            return None
        st.reopen_changed(doc, doc["b"]["build"], diff_for=diff_for if not a.a else None)
    print(json.dumps(dict(doc, baseline_used=used), indent=1) if a.json else used + "\n" + D.format_text(doc))
    return 0


def cmd_tour_template(a):
    st = _store(a)
    cur = st.current() or {}
    d = st.latest_diff()
    stops = []
    if d:
        for r in d["parts"]:
            if r["status"] != "unchanged":
                stops.append(dict(id=f"s{len(stops) + 1}", parts=[r["name"]], kind=r["status"] if r["status"] in
                                  ("changed", "added", "removed") else "changed", note="", ghost=True))
    if not stops:
        stops = [dict(id="s1", parts=["<GLB node name>"], kind="changed", note="what changed and why", ghost=True)]
    print(json.dumps(dict(schema=SCHEMA, build=cur.get("build"), title="", author="", stops=stops), indent=1))
    return 0


def add_args(p):
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--project", default=argparse.SUPPRESS,
                        help="CAD project dir holding .cadreview/ (default: nearest one above cwd)")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="JSON instead of text")
    p.add_argument("--project", help="CAD project dir holding .cadreview/ (default: nearest one above cwd)")
    p.add_argument("--json", action="store_true", help="JSON instead of text")
    sub = p.add_subparsers(dest="review_cmd")
    q = sub.add_parser("resolve", parents=[common], help="mark a pin resolved")
    q.add_argument("pin", help="pin id (p3) or number (3)")
    q.set_defaults(review_fn=cmd_resolve)
    q = sub.add_parser("diff", parents=[common], help="per-part diff of b against a")
    q.add_argument("a", nargs="?", help="baseline model (default: since your last packet, else the previous build)")
    q.add_argument("b", nargs="?", help="model to compare (default: the current build)")
    q.add_argument("--thin", type=float, default=0.5, help="thin feature threshold in mm (default 0.5)")
    q.add_argument("--save", action="store_true", help="with --project: save as the latest diff and reopen pins")
    q.set_defaults(review_fn=cmd_diff)
    q = sub.add_parser("tour-template", parents=[common], help="print an empty tour.json for the current build")
    q.set_defaults(review_fn=cmd_tour_template)
    return p


def run(a):
    fn = getattr(a, "review_fn", None) or cmd_status
    return fn(a)


def main(argv=None):
    return run(add_args(argparse.ArgumentParser(prog="aad review")).parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
