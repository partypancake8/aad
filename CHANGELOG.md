# Changelog

## Unreleased

- The viewer server refuses requests for any Host other than 127.0.0.1, localhost or [::1] on its port, and
  writes that are not same-origin JSON; responses carry `nosniff` and a same-origin resource policy.
- Revisions tab: "Stored builds to keep" (remembered in the browser); the hologram draws feature edges and
  curved silhouettes only, without triangle diagonals.
- Layout: weight inputs fit their values, pin actions wrap as whole groups, the tab row steps down instead of
  clipping, long titles wrap, and the pin card stays clear of the view cube.

## 0.1.0 (2026-11-11)

First release as its own project.

- `aad view`: local three.js viewer for `.glb`, `.stl` and `.ply` files or directories of them, with live
  reload, a part tree, section planes, explode, entity-based measure (vertex, edge, plane), a weight
  estimate and Part info, a view cube with roll and step arrows, free or constrained orbit, Fusion style and
  classic navigation, and one undo history over every committed change. All page libraries are vendored; the
  page makes no network calls.
- Review workspace in the viewer: point, edge and region pins with an issue class in four groups (change
  request, problem, note to the agent, other; the note is optional), keep and question pins, scope lock, a
  Revisions tab that compares the current build with the build of your last packet (collateral flagged, old
  geometry as a green hologram), change tour with accept, reject and repin, Not fixed escalation, Repin on the
  same pin id with history, follow-up pins, pins that reopen when their part changes again, and Send packet
  (packet.json plus an annotated screenshot).
- `aad review`: the agent's side of the same state (`--json`, `diff`, `resolve`, `tour-template`).
- `aad demo`: the bracket demo with a planted bad edit, served from a temp copy.
- On-disk format `.cadreview/` with `"schema": "cadreview/1"`, validated against bundled JSON Schemas.
- Runtime dependency: numpy. scipy is used when present to speed up one detector.
