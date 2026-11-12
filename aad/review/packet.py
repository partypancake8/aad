"""Review packets: one hand-off from the viewer to a coding agent, written to
<project>/.cadreview/packets/<YYYYMMDD-HHMMSS>/packet.json + view.png (the annotated screenshot)."""
import base64
import datetime
import os

from .schema import SCHEMA, validate
from .store import ESCALATION, OPEN, REPINNED, Store, escalated_first, is_repinned, issue_classes, now, with_reason


def prompt_text(store, packet_dir, n_open, scope_n, model_name, not_fixed=(), repinned=()):
    proj = store.project
    scope = (f"Only the {scope_n} part(s) in the scope lock may change; anything else that changes is collateral "
             "damage." if scope_n else "No scope lock is set; keep every part you were not asked to change "
             "exactly as it is.")
    esc = (f"Pin(s) {', '.join('#' + str(n) for n in not_fixed)} are marked NOT FIXED (listed first): {ESCALATION} "
           if not_fixed else "")
    if repinned:
        esc += f"Pin(s) {', '.join('#' + str(n) for n in repinned)} were REPINNED (listed first): {REPINNED} "
    return (f"CAD review for {model_name}: {n_open} open pin(s). {esc}Run `aad review --project {proj} --json` for the "
            f"pins (part, local point, normal, issue class, reason: the note, or the class meaning when the note is empty), the scope lock, the latest diff and the camera, "
            f"and look at {os.path.join(packet_dir, 'view.png')} (pins are numbered). {scope} After the rebuild, "
            f"run `aad review diff` or reload the viewer and check the diff for collateral before replying.")


def write(store: Store, payload, png_bytes=None):
    """payload: the viewer's packet fields (model, camera, selection, pins, scope, measurements, hidden, diff,
    tour, screenshot_markers). Returns (packet dict, packet dir)."""
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    pid, i = stamp, 2
    while os.path.exists(store.path("packets", pid)):
        pid, i = f"{stamp}-{i}", i + 1
    d = store.path("packets", pid)
    pins = payload.get("pins")
    if pins is None:
        pins = store.pins()
    classes = issue_classes()
    pins = [with_reason(p, classes) for p in escalated_first(pins)]
    open_n = sum(1 for p in pins if p.get("status") in OPEN)
    not_fixed = [p["n"] for p in pins if p.get("status") == "not_fixed"]
    repinned = [p["n"] for p in pins if is_repinned(p)]
    scope = payload.get("scope")
    if scope is None:
        scope = store.scope()["parts"]
    model = payload.get("model") or {}
    doc = dict(schema=SCHEMA, id=pid, created=now(), project=store.project,
               model=dict(name=model.get("name", "model"), title=model.get("title", model.get("name", "model")),
                          version=model.get("version"), build=model.get("build"), files=model.get("files", [])),
               camera=payload.get("camera"), selection=payload.get("selection"), pins=pins, scope=scope,
               measurements=payload.get("measurements") or [], hidden=payload.get("hidden") or [],
               diff=payload.get("diff"), tour=payload.get("tour"), screenshot="view.png",
               screenshot_markers=payload.get("screenshot_markers") or [],
               prompt=prompt_text(store, d, open_n, len(scope), model.get("name", "model"), not_fixed,
                                 repinned))
    validate(doc, "packet")
    os.makedirs(d)
    if png_bytes is None and isinstance(payload.get("png"), str):
        s = payload["png"]
        png_bytes = base64.b64decode(s.split(",", 1)[1] if s.startswith("data:") else s)
    if png_bytes:
        with open(os.path.join(d, "view.png"), "wb") as fh:
            fh.write(png_bytes)
    store._write(os.path.join("packets", pid, "packet.json"), doc, "packet")
    return doc, d
