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

- `aad review` prints the open pins in review order (Not fixed and repinned first, then problems, change
  requests and notes, with orphan flags and follow-up parents), the scope lock, keep pins whose surroundings
  changed (`KEEP PIN CHANGED`, `keep_changed` in JSON), the diff baseline, the latest diff with its collateral and warnings, the camera and selection, the latest
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

### aad agent

    aad agent install [--claude] [--codex] [--user | --project DIR | --dir DIR] [--force]
    aad agent print [--claude | --codex]

- Installs the `aad` skill, which orients a coding agent on aad (the loop, the vocabulary, every command, how
  to read a pin, the ten rules) and then waits for the user. Claude Code runs it as `/aad`; Codex as `$aad` or
  from `/skills`. With neither `--claude` nor `--codex` it installs both.
- `--user` (default): `~/.claude/skills/aad/SKILL.md` (or under `CLAUDE_CONFIG_DIR`) and
  `~/.codex/skills/aad/SKILL.md` (or under `CODEX_HOME`).
- `--project DIR`: `DIR/.claude/skills/aad/SKILL.md` and `DIR/.agents/skills/aad/SKILL.md`, the project-level
  skill folders each tool reads. Commit them to share the skill with the project.
- `--dir DIR`: `DIR/claude/aad/SKILL.md` and `DIR/codex/aad/SKILL.md`, for inspection.
- An existing file with the same text is left alone. A different one is kept unless `--force`. Text between
  the `aad:local-notes` markers at the end of an installed file is kept on every reinstall.
- `aad agent print` writes the Claude Code version (or `--codex`) to stdout. Both share one body,
  `aad/agents/body.md`, under a frontmatter per tool.

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
| `baselines/<id>/` | copies of earlier builds (newest 10; "Stored builds to keep" under More in the Revisions tab sets 1 to 50 and is remembered in that browser, `AAD_KEEP_BUILDS` sets the server default) plus the builds the newest 3 packets were sent against |
| `packets/<time>/` | `packet.json` and `view.png` from each Send packet |

These files record absolute local paths (the project directory, the model files, the packet location in its
prompt) and copies of the models, so add the whole `.cadreview/` to `.gitignore`. To share pins or the scope
lock, commit just `pins.json` or `scope.json`, after checking them for paths you do not want to publish.

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
- A repinned pin keeps its id, gets the new anchor, class and note, `attempts` + 1 and `repinned_at`, and its
  previous state is appended to `history` (time, build, anchor, class, note, status).

### Issue classes

Each class has a group, a label, a hint and a one-sentence `meaning` written as an instruction to an agent, in
`aad/review/issue_classes.json`. The pin card shows them in this order:

| Group | Classes |
|---|---|
| Change request | `design_change`, `appearance`, `resize`, `move`, `add_feature`, `remove_feature`, `simplify`, `lighten`, `strengthen` |
| Problem | `weird_geometry`, `incoherent_addition`, `collateral_damage`, `floating_unsupported`, `orientation_mirror`, `fit_clearance`, `printability`, `holes_ports_blocked`, `fasteners_assembly`, `regression`, `belt_pulley`, `envelope_size`, `intent_misread` |
| Note to the agent | `question` (answer only, change nothing), `keep` (locked: geometry changed within 5 mm is flagged, even inside the scope lock), `reference` (an example to match) |
| Other | `other` |

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

The viewer binds 127.0.0.1 only. The page uses these routes, and scripts can too. Every request needs a Host
of `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, and every POST needs
`Content-Type: application/json`; a POST with a foreign `Origin` or a cross-site `Sec-Fetch-Site` is refused
with 403 (see Security in the README).

| Route | |
|---|---|
| `GET /models.json`, `/models/<n>` | the loaded files and their bytes |
| `GET /status.json` | change signature, polled every 2 s by the page |
| `GET /tree.json`, `/views.json` | the part tree and camera buttons |
| `GET /part-stats.json` | per-part volume, area, box, triangle count and closed-shell flag (weight estimate, Part info) |
| `GET /review/state.json` | pins, scope, tour, issue classes, baselines, latest diff |
| `GET /review/diff.json?against=ID` | diff against a baseline (`reviewed`, `previous`, a build or version id) |
| `GET /review/pin-changes.json` | for each pin of the last packet, whether anything near it changed |
| `POST /review/pins`, `/review/scope`, `/review/tour-decisions`, `/review/camera`, `/review/packet` | writes from the page |
| `POST /review/revisions/keep` | `{"keep": n}`: stored builds to keep (1 to 50) for this server process; prunes older ones |
