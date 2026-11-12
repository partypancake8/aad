# Agent instructions for aad

Paste this section into the instructions file your coding agent reads (`AGENTS.md`, `CLAUDE.md` or similar) in
any CAD project you review with aad. It assumes the model is built from code and exported to GLB, and that the
person reviewing runs `aad view` on that GLB.

```markdown
## CAD review with aad

The reviewer marks problems in the aad viewer. Their review state is in `.cadreview/` at the project root.

1. At the start of every CAD turn run `aad review --json` (add `--project DIR` if you are not inside the
   project). Read `open_pins`, `scope`, `baseline` and `diff`. If the reviewer sent a packet, also look at its
   `view.png`: the pins are numbered on it.
2. A pin with no note is complete. Its issue class is the reason, and `reason` / `class_meaning` in the JSON
   spell out what the class asks for. Do not ask for a note.
3. Only parts in the scope lock may change. If a pin sits on a part outside the scope, say so in your reply
   and leave that part alone. Never reinterpret it as a pin on some other part.
4. Work on `not_fixed` pins first (they are listed first, with an `escalation` line). The last attempt did not
   fix them, so do not try the same approach again. Re-read the pin and compare against the reviewed baseline.
5. A `regression` pin means something that was right before is broken again. Find the revision where it was
   right, restore that geometry, and keep the later changes the reviewer asked for.
6. After the build, run `aad review diff`. It compares against the build the reviewer last looked at. Explain
   every part it lists as COLLATERAL (changed outside the scope lock) or fix it, and mention any detector
   warning (thin wall, new loose shell, sliver triangles, part no longer touching anything).
7. Write a change tour: `aad review tour-template > .cadreview/tour.json`, then fill in one note per stop
   saying what changed and why. The reviewer accepts or rejects each stop in the viewer.
8. Never resolve, delete or edit the reviewer's pins, and never edit their scope lock. Resolving is their call
   (`aad review resolve` exists for when they ask you to).
9. Never loosen a check, tolerance or test to make a build pass. If a check fails, fix the model or report it.
```

## Why each rule is there

- Rule 1 replaces a paragraph of description with exact data: the part's GLB node name, the hit point and
  normal in the part's own coordinates, the edge polyline for an edge pin, and the camera the reviewer used.
- Rule 2 exists because reviewers stop writing notes once the class chips are fast. The class meanings in
  `aad/review/issue_classes.json` are written as instructions.
- Rule 3 is the core of the scope lock. A pin on a locked part is information for the reviewer, not
  permission to move the fix somewhere else.
- Rules 4 and 5 stop the loop where an agent repeats the same fix, or undoes newer work while restoring an
  older one.
- Rule 6 is what makes collateral damage visible before the reviewer finds it by eye.
- Rule 7 gives the reviewer an ordered list of what you changed to accept or reject, instead of a diff to
  search through.
- Rules 8 and 9 keep the review state and the checks honest.
