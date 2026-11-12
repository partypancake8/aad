# Changelog

## Unreleased

- Pins toggle in the toolbar (H): hides every pin marker, pinned edge, repin trail and attached measurement in
  the view and brings them back. View state only, remembered in the browser, never an undo step or a change to
  pins.json; Pin mode, dropping or repinning a pin and flying to one turn it back on, and Send packet always
  draws the pins. Home moves to Shift+H.
- A pin whose point is behind other visible geometry draws dimmed with a dashed ring (the selected pin stays
  solid); a pin whose part is hidden loses its marker and its row says "part hidden".
- Toolbar: the DEV or PROD badge, the model name and the build status no longer overlap at narrow widths; the
  status compacts, then hides, before the name truncates. `build.json` may carry `interference_pairs` and
  `design_violations`.
- Revisions rows say "1 part differs"; the pin card's location line never breaks inside a number.
- `aad agent install` and `aad agent print`: an `aad` skill for Claude Code (`/aad`) and Codex (`$aad`) that
  orients a fresh agent on aad (the loop, vocabulary, commands, reading a pin, the ten rules) without starting
  any work. User, project or any directory; never replaces a different file without `--force`; keeps local
  notes on reinstall.
- Favicon: the Tabler cube on a dark tile in the accent blue (SVG with light and dark tab bar styles, plus 32 px
  and 180 px PNGs); it turns yellow or green with a DEV or PROD title badge. `/favicon.ico` serves the PNG.
- The packet prompt ends with "If your agent has the /aad skill, load it first."
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
