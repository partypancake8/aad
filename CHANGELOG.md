# Changelog

## 0.1.0 (2026-11-11)

First release as its own project.

- `aad view`: local three.js viewer for `.glb`, `.stl` and `.ply` files or directories of them, with live
  reload, a part tree, section planes, explode, measure, a view cube, Fusion style and classic navigation, and
  one undo history over every committed change. All page libraries are vendored; the page makes no network
  calls.
- Review workspace in the viewer: point, edge and region pins with an issue class (the note is optional),
  scope lock, per-part diff against the build of your last packet with collateral flagged, ghosted baseline,
  change tour with accept and reject, Not fixed escalation, follow-up pins, pins that reopen when their part
  changes again, and Send packet (packet.json plus an annotated screenshot).
- `aad review`: the agent's side of the same state (`--json`, `diff`, `resolve`, `tour-template`).
- `aad demo`: the bracket demo with a planted bad edit, served from a temp copy.
- On-disk format `.cadreview/` with `"schema": "cadreview/1"`, validated against bundled JSON Schemas.
- Runtime dependency: numpy. scipy is used when present to speed up one detector.
