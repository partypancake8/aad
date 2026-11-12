# aad

aad ("agent aided design") is a local review tool for CAD written as code. A person pins problems on the 3D
model in the aad viewer; a coding agent reads them from the command line and fixes the code. Loading this skill
gives you that context. It is not an instruction to act.

**Knowing aad is not a request to do anything.** After loading, say in a sentence that you know how aad works
and carry on the conversation. Do not build, edit geometry, resolve pins, write a tour or start a viewer until
the user asks for it.

## The loop

1. The person opens the model (a GLB built from code) in `aad view` and pins problems on parts, points or edges.
2. They set a scope lock: the parts the next edit may change. Everything else is locked.
3. Send packet writes a packet with a numbered screenshot and copies a prompt for the agent.
4. The agent reads `aad review --json`, edits the code, rebuilds, and runs `aad review diff` against the build
   the person reviewed. Parts that changed outside the scope lock are collateral.
5. The agent writes a change tour. The person accepts, rejects or repins each stop, or marks pins not fixed.

## Vocabulary

- **Pin**: one marked problem. Kinds: `point` (a spot on a face), `edge` (a feature edge, stored as a
  polyline), `region` (a box over several parts).
- **Issue class** and **group**: every pin has a class, and every class is in a group. Change request (resize,
  move, add or remove a feature, simplify, strengthen and more), problem (weird geometry, collateral damage,
  fit, printability, regression and more), note to the agent (`question`: answer only, change nothing; `keep`:
  locked by the user; `reference`: an example to match elsewhere), and other.
- **Status**: `open`, `resolved`, `reopened` (resolved, then its part changed again) or `not_fixed` (the
  person says the last attempt failed; carries `attempts`). A **repinned** pin is still open but was moved to
  the spot that is wrong now; it keeps its id, gains `attempts` and keeps its earlier spots in `history`.
- **Scope lock**: the parts the next edit may change.
- **Collateral**: a part that changed outside the scope lock.
- **Keep pin**: a locked spot. Any geometry within 5 mm of it that changes is flagged (`keep_changed`), even
  inside the scope lock.
- **Reviewed baseline**: the build the person's last packet was sent against. Diffs compare against it.
- **Revisions**: earlier builds kept in `.cadreview/baselines/`. The viewer draws an old revision over the
  current model as a green hologram.
- **Packet**: one hand-off from the viewer: `packet.json` and `view.png` in `.cadreview/packets/<time>/`.
- **Tour**: the agent's ordered list of what it changed and why, in `.cadreview/tour.json`.
- **`.cadreview/`**: the review state at the project root, plain JSON, every file tagged
  `"schema": "cadreview/1"`.

## Commands

If `aad` is not on PATH, try `python -m aad` in the environment where it is installed.

- `aad view <model.glb | dir | versions.json> --project DIR [--port N] [--no-open]`: start the viewer when the
  user wants to look at or pin a model. Long running; run it in the background and give the user the URL.
  Example: `aad view out/bracket.glb --project . --port 7893 --no-open`
- `aad review`: read the review state (open pins in review order, scope lock, keep pins, baseline, latest diff,
  packets, tour). Use it to see what the person has pinned. Example: `aad review --project ~/cad/bracket`
- `aad review --json`: the same as one JSON object, for working through the pins. Example:
  `aad review --json --project .`
- `aad review diff`: after a rebuild, compare the current build with the reviewed baseline, collateral first,
  with detector warnings. Example: `aad review diff --project .`
- `aad review tour-template`: an empty tour for the current build, to fill in after a change. Example:
  `aad review tour-template > .cadreview/tour.json`
- `aad review resolve <pin>`: mark a pin resolved. Only when the user asks you to. Example: `aad review resolve 3`
- `aad demo [DIR] [--port N] [--no-open]`: a copy of the bracket demo with a planted bad edit, for trying aad
  out. Example: `aad demo --no-open`
- `aad agent install [--claude] [--codex] [--user | --project DIR | --dir DIR] [--force]`: install this skill
  for Claude Code and Codex. Example: `aad agent install --claude --codex`
- With the aad hook installed, a note that starts "aad review for <model>" appears in your context on its own
  when the pins, a packet, the scope lock or the tour decisions change. Treat it like a packet prompt.
- `aad mcp` serves the same review as MCP tools (`review`, `pin`, `diff`, `tour_template`, `write_tour`,
  `packet_image`) when the user has registered it; `aad follow <project dir>` links a working directory to a
  project.

`--project DIR` defaults to the nearest folder above the working directory that holds `.cadreview/`.

## Reading a pin from `aad review --json`

`open_pins` is in review order. For each pin:

- `n` is the number on the screenshot and in the viewer; `id` is stable (`p3`).
- `anchor.part.node` is the part: its GLB node name, the name the code gives it. Region pins list `parts`
  instead.
- `anchor.local` and `anchor.normal_local` are the point and normal in the part's own coordinates, in mm.
  `anchor.world` is where it was when pinned.
- `edge` (edge pins): `points`, `start`, `end`, `direction`, `length_mm`, in part coordinates.
- `issue_class` and `group`; `reason` is the note, or the class meaning when there is no note;
  `class_meaning` is the class written as an instruction; `instruction` marks question and keep pins.
- `status`, `attempts`, `escalation` (for not fixed and repinned pins), `history` (earlier spots, classes and
  notes of a repinned pin), `parent` (a follow-up pin), `orphaned` (its part is missing from the current
  build), `measure` (a measurement attached to the pin).

Also in the JSON: `scope` (locked-in parts by node name), `keep_changed`, `baseline`, `diff`, `packets`
(newest first, each with its `screenshot` path) and `tour`.

## How the user talks about it

- A pasted message that starts "CAD review for <model>: N open pin(s)" is a packet prompt. It is a request
  for a review turn: read the review, look at the screenshot, work the pins under the rules below.
- "pin", "repin", "not fixed", "keep pin", "scope", "tour", "revisions", "hologram" and "send packet" refer to
  things in the viewer.

## The ten rules for a review turn

1. At the start of every CAD turn run `aad review --json` (add `--project DIR` if you are not inside the
   project). Read `open_pins`, `scope`, `keep_changed`, `baseline` and `diff`. If the reviewer sent a packet,
   also look at its `view.png`: the pins are numbered on it.
2. A pin with no note is complete. Its issue class is the reason, and `reason` / `class_meaning` in the JSON
   spell out what the class asks for. Do not ask for a note.
3. Pins come in review order. Work on `not_fixed` and repinned pins first: the last attempt did not fix them,
   so do not try the same approach again. A repinned pin has a new spot and keeps its earlier spots and notes
   in `history`; read the new anchor and reason, not the old one. Then problems, then change requests.
4. Question pins (`instruction`: "answer only, change nothing") get an answer in your reply and no geometry
   change. Keep pins (`instruction`: "locked by the user") are locked: nothing within 5 mm of them may change,
   even inside the scope lock. Reference pins are an example to match elsewhere.
5. Only parts in the scope lock may change. If a pin sits on a part outside the scope, say so in your reply
   and leave that part alone. Never reinterpret it as a pin on some other part.
6. A `regression` pin means something that was right before is broken again. Find the revision where it was
   right, restore that geometry, and keep the later changes the reviewer asked for.
7. After the build, run `aad review diff`. It compares against the build the reviewer last looked at. Explain
   every part it lists as COLLATERAL (changed outside the scope lock), and every KEEP PIN CHANGED line that
   `aad review` prints, or fix them, and mention any detector warning (thin wall, new loose shell, sliver
   triangles, part no longer touching anything).
8. Write a change tour: `aad review tour-template > .cadreview/tour.json`, then fill in one note per stop
   saying what changed and why. The reviewer accepts, rejects or repins each stop in the viewer.
9. Never resolve, delete or edit the reviewer's pins, and never edit their scope lock. Resolving is their call
   (`aad review resolve` exists for when they ask you to).
10. Never loosen a check, tolerance or test to make a build pass. If a check fails, fix the model or report it.

Before editing, say in two or three lines which features move together and what must not change. After the
build, report what changed and what the person needs to judge in the viewer. The person decides whether it is
fixed.

## Local notes

<!-- aad:local-notes:start -->
<!-- aad:local-notes:end -->
