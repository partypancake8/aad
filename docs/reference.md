# aad reference

The README covers the loop. This page is the detail: every command, the optional inputs the viewer accepts,
and the review files on disk.

## Commands

### aad view

    aad view <model.glb | dir | versions.json> [more paths] [--project DIR] [--port N] [--versions FILE] [--no-open]

- Paths are `.glb`, `.stl` or `.ply` files (mm, Z up) or directories of them. Each directory is one group in
  the tree and is rescanned on every poll, so new files appear without a restart.
- A single `.json` path is read as a versions manifest (see [Versions](#versions)).
- `--project DIR` is where `.cadreview/` lives. Default: the nearest folder above the first model that already
  has a `.cadreview/`, else the nearest one with `.git` or `pyproject.toml`, else the model's folder.
- `--port N` (default 7891) binds 127.0.0.1 only. `--no-open` skips opening a browser tab.
- `--no-review` turns the review workspace off and gives a plain viewer.
- `--tree FILE`, `--views FILE`, `--movable NAME`, `--save-to FILE`, `--second DIR`, `--name NAME`: the optional
  inputs below.
- `--check` starts the server on a free port, fetches every route and every model file, and prints `ok`. With
  no paths it uses a built-in sample.

### aad review

    aad review [--project DIR] [--json]
    aad review diff [A.glb [B.glb]] [--project DIR] [--json] [--save] [--thin MM]
    aad review resolve <pin id or number> [--project DIR]
    aad review tour-template [--project DIR]

- `aad review` prints the open pins (Not fixed first, with orphan flags and follow-up parents), the scope lock,
  the diff baseline, the latest diff with its collateral and warnings, the camera and selection, the latest
  packets, the tour and the issue counts. `--json` gives the same as one object.
- `aad review diff` with no files compares the current build against the build your last packet was sent
  against, or the previous build when no packet was sent. The first line says which baseline was used
  (`baseline_used` in JSON). With `--project` the scope lock decides collateral; `--save` stores the result as
  the latest diff and reopens resolved pins whose part changed.
- `aad review resolve` marks a pin resolved on the current build. It reopens if its part changes again.
- `aad review tour-template` prints an empty tour for the current build with one stop per part the latest diff
  found. Fill in the notes and save it as `.cadreview/tour.json`.

### aad demo

    aad demo [DIR] [--port N] [--no-open]

Copies the bracket demo to DIR (default: a new temp directory), locks the scope to `bracket`, and serves the
planted bad build with the good build as a version to compare against.

## Optional viewer inputs

All of these are optional. Without them the viewer builds a tree from the files and the GLB node names, and
fits six camera buttons to the model.

### Part tree (`--tree FILE`)

A JSON file with a `components` list. Each component gives its GLB node name and where it sits in the tree:

```json
{"components": [
  {"name": "lid", "node_name": "enclosure_lid", "tree_path": ["Enclosure", "Top", "lid"], "kind": "printed"},
  {"name": "m3x8_1", "tree_path": ["Fasteners", "m3x8_1"], "kind": "fastener"}
]}
```

`tree_path` is module, then any sub-assemblies, then the part's display name. `node_name` defaults to `name`.
The file is watched; edits show up on the next poll.

### Camera buttons (`--views FILE`)

A JSON list (or `{"views": [...], "default_view": "iso"}`) of named cameras:

```json
[{"name": "iso", "label": "Iso", "eye": [300, -300, 250], "focal": [0, 0, 60], "up": [0, 0, 1], "scale": 180,
  "hide": ["module:Fasteners"]}]
```

`scale` is the half height of the framed view in mm. `hide` lists components (regular
expressions on the component name, or `module:<name>`) that the view hides. A view with `"kind": "camera"` and a
`fisheye` block (`sensor_px`, `f_px_per_rad`, `theta_max_rad`, `right`, `up`, `axis`, optional `observer`
parts) renders what an equidistant fisheye lens at `eye` would see, for checking a camera's field of view.

### Build status (`build.json`)

A `build.json` next to the first model with `{"ok": true}` or `{"ok": false}` makes the status line read
"build ok" or "build FAILED". Without it the status line only shows when the model last changed.

### STL and PLY colours (`viewer-materials.json`)

STL has no colour. A `viewer-materials.json` beside the mesh files maps file names to colours:
`{"shell.stl": "#f4c20d"}`.

### Movable group (`--movable NAME`)

Gives one group (a directory) a move, rotate and scale gizmo for fitting a part against another (a scan
against a mount, for example). Every change saves the pose to `--save-to` (default `pose.json` beside the
models) and appends it to `pose_history.jsonl`. `--second DIR` adds a hidden group that moves with it.

### Versions

A manifest lists named model versions with paths relative to itself:

```json
{"name": "Bracket demo", "default": "bad", "current": "bad", "versions": [
  {"id": "good", "label": "Good", "paths": ["good/bracket_demo.glb"]},
  {"id": "bad", "label": "Planted bad edit", "paths": ["bad/bracket_demo.glb"]}
]}
```

The viewer shows a Version selector, and each version has its own URL (`/v/good/`). With model paths and
`--versions` together, the served files are the live build (the manifest's `current` id) with the review
state, and every other entry is a reference version to switch to and diff against. An entry may also name a
`tree` file and a `title`.

## Review files

Everything lives in `<project>/.cadreview/`. Every JSON file carries `"schema": "cadreview/1"` and is validated
against `aad/review/schemas/` before it is written.

| File | What it holds |
|---|---|
| `pins.json` | every pin with its status: `open`, `resolved`, `reopened` (its part changed again) or `not_fixed` |
| `scope.json` | the parts that may change in the next edit; every other part is locked |
| `tour.json` | an agent's change tour for one build, plus the reviewer's accept or reject per stop |
| `camera.json` | the viewer's last committed camera and selection |
| `current.json` | the build the viewer shows: name, files, build id, part names |
| `diff.json` | the latest diff the viewer or the CLI computed |
| `history.jsonl` | pin events, for the per-class issue counts |
| `baselines/<id>/` | copies of earlier builds (newest 3) plus the builds the newest 3 packets were sent against |
| `packets/<time>/` | `packet.json` and `view.png` from each Send packet |

Add `baselines/` and `packets/` to `.gitignore`. Pins and the scope lock are yours to commit or not.

### A pin

```json
{"schema": "cadreview/1", "id": "p3", "n": 3, "kind": "edge", "status": "open",
 "issue_class": "printability", "severity": "medium", "note": "",
 "anchor": {"part": {"key": "bracket_demo.glb > bracket", "node": "bracket"},
            "local": [5.0, 0.0, 12.4], "normal_local": [1, 0, 0], "world": [5.0, 0.0, 12.4]},
 "edge": {"points": [[5, -8, 5], [5, 8, 5]], "length_mm": 16.0, "start": [5, -8, 5], "end": [5, 8, 5],
          "midpoint": [5, 0, 5], "direction": [0, 1, 0]},
 "build": "693ce0c00dd4", "created": "2026-11-11T21:40:00-05:00"}
```

- `anchor.part.node` is the GLB node name. `local` and `normal_local` are in the part's own coordinates, so a
  pin follows its part when the part moves. `world` is where it was when the pin was made.
- `kind` is `point`, `edge` (a feature edge, with its polyline in part-local mm) or `region` (a box of parts,
  listed in `parts`).
- `note` is optional. `aad review` and packets add `reason` (the note, or the class meaning when the note is
  empty) and `class_meaning`.
- `not_fixed` pins carry `attempts` and `escalated_build`; follow-up pins carry `parent`.

### Issue classes

`weird_geometry`, `incoherent_addition`, `collateral_damage`, `floating_unsupported`, `orientation_mirror`,
`fit_clearance`, `printability`, `holes_ports_blocked`, `fasteners_assembly`, `regression`, `belt_pulley`,
`envelope_size`, `intent_misread`, `other`. Each has a label, a hint and a one-sentence `meaning` written as an
instruction to an agent, in `aad/review/issue_classes.json`.

### The diff

The diff runs in Python on the meshes. For every part (GLB node) it compares the bounding box, volume, area,
triangle count, centroid and an order-independent geometry hash, and classifies the part as unchanged,
moved (same shape somewhere else, possibly turned), changed, added or removed. With a scope lock, any part
that changed outside the scope is `collateral` and sorts first. Detectors add warnings for new disconnected
shells, many new sliver triangles, a wall under 0.5 mm that used to be thicker, a triangle count that doubled
or halved, and a part that no longer touches anything.

The diff knows parts by GLB node name. Keep node names stable across builds (name your parts in code) and the
diff, the pins and the scope lock all follow them.

## HTTP routes

The viewer binds 127.0.0.1 only. The page uses these routes, and scripts can too:

| Route | |
|---|---|
| `GET /models.json`, `/models/<n>` | the loaded files and their bytes |
| `GET /status.json` | change signature, polled every 2 s by the page |
| `GET /tree.json`, `/views.json` | the part tree and camera buttons |
| `GET /review/state.json` | pins, scope, tour, issue classes, baselines, latest diff |
| `GET /review/diff.json?against=ID` | diff against a baseline (`reviewed`, `previous`, a build or version id) |
| `GET /review/pin-changes.json` | for each pin of the last packet, whether anything near it changed |
| `POST /review/pins`, `/review/scope`, `/review/tour-decisions`, `/review/camera`, `/review/packet` | writes from the page |
