"""`aad agent install --hooks | --mcp` and `aad agent uninstall --hooks`.

--hooks adds two command hooks to a settings file: UserPromptSubmit and SessionStart, each running
`aad hook <tool>`. Additive and idempotent: existing entries are never reordered, changed or removed, a timestamped
backup is written before any change, and a file whose structure is not the expected one is left alone with an
explanation. `uninstall --hooks` removes only handlers whose command is `... aad hook <tool>`.

Where (both tools use the same hooks layout: {"hooks": {Event: [{"matcher"?, "hooks": [{"type": "command", ...}]}]}}):
  Claude Code  --user: ~/.claude/settings.json (CLAUDE_CONFIG_DIR honoured)   --project DIR: DIR/.claude/settings.local.json
  Codex        --user: ~/.codex/hooks.json (CODEX_HOME honoured)              --project DIR: DIR/.codex/hooks.json
  --settings FILE: that file, for one tool (a scratch copy, a custom location)
With no --claude/--codex at user level, install picks the tools whose config directory exists.
Both tools add a UserPromptSubmit or SessionStart command hook's plain stdout to the model's context
(code.claude.com/docs/en/hooks, "Exit code 0"; the Codex hooks page, "UserPromptSubmit"); Codex runs a new hook only
after it is reviewed and trusted in /hooks.

--mcp only prints the MCP config snippet and the registration command for each tool; it changes nothing.
"""
import datetime
import json
import os
import re
import shlex
import shutil
import sys

TOOLS = ("claude", "codex")
EVENTS = (("UserPromptSubmit", None), ("SessionStart", "startup|resume|clear|compact|fork"))
TIMEOUT = 10
_OURS = re.compile(r"""(?:^|[\s/"'])aad["']?\s+hook\s+(claude|codex)\s*$""")


class Refused(Exception):
    """The settings file is not in a shape this installer edits safely."""


def settings_path(tool, mode, base=None):
    if mode == "file":
        return base
    if tool == "claude":
        if mode == "project":
            return os.path.join(base, ".claude", "settings.local.json")
        home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
        return os.path.join(home, "settings.json")
    if mode == "project":
        return os.path.join(base, ".codex", "hooks.json")
    home = os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    return os.path.join(home, "hooks.json")


def base_command():
    """argv that runs this aad: the `aad` script being run, else the `aad` on PATH, else this interpreter -m aad."""
    me = sys.argv[0] if sys.argv else ""
    if os.path.basename(me) == "aad" and os.path.isfile(me):
        return [os.path.abspath(me)]
    exe = shutil.which("aad")
    if exe:
        return [os.path.abspath(exe)]
    return [sys.executable, "-m", "aad"]


def default_tools():
    """With no --claude/--codex at user level: the tools whose config directory exists (Claude Code if neither)."""
    homes = dict(claude=os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"),
                 codex=os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex"))
    return [t for t in TOOLS if os.path.isdir(homes[t])] or ["claude"]


def hook_command(tool, base=None):
    return " ".join(shlex.quote(x) for x in (base or base_command()) + ["hook", tool])


def is_ours(handler, tool=None):
    if not isinstance(handler, dict) or not isinstance(handler.get("command"), str):
        return False
    m = _OURS.search(handler["command"])
    return bool(m) and (tool is None or m.group(1) == tool)


def entries(tool, command):
    """{event: matcher group} that install adds."""
    out = {}
    for ev, matcher in EVENTS:
        g = {}
        if matcher:
            g["matcher"] = matcher
        g["hooks"] = [dict(type="command", command=command, timeout=TIMEOUT)]
        out[ev] = g
    return out


def _load(path):
    """(doc, raw text or None, indent, trailing newline)."""
    if not os.path.exists(path):
        return {}, None, 2, True
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
    if not raw.strip():
        return {}, raw, 2, True
    try:
        doc = json.loads(raw)
    except ValueError as e:
        raise Refused(f"{path} is not plain JSON ({e}); edit it by hand or fix it first")
    m = re.search(r"\n([ \t]+)\S", raw)
    indent = (m.group(1) if m.group(1).startswith("\t") else len(m.group(1))) if m else 2
    return doc, raw, indent, raw.endswith("\n")


def _check(doc, path):
    if not isinstance(doc, dict):
        raise Refused(f"{path}: the top level is not a JSON object")
    hooks = doc.get("hooks", {})
    if not isinstance(hooks, dict):
        raise Refused(f"{path}: \"hooks\" is not an object of events")
    for ev, groups in hooks.items():
        if not isinstance(groups, list):
            raise Refused(f"{path}: hooks.{ev} is not a list of matcher groups")
        for i, g in enumerate(groups):
            if not isinstance(g, dict) or not isinstance(g.get("hooks"), list):
                raise Refused(f"{path}: hooks.{ev}[{i}] is not a matcher group with a \"hooks\" list")


def _write(path, doc, raw, indent, nl):
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = None
    if raw is not None:
        backup, i = f"{path}.aad-backup-{stamp}", 2
        while os.path.exists(backup):
            backup, i = f"{path}.aad-backup-{stamp}-{i}", i + 1
        shutil.copy2(path, backup)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    text = json.dumps(doc, indent=indent, ensure_ascii=False) + ("\n" if nl else "")
    tmp = path + ".aad-tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return backup


def install(tool, path, command=None, out=print, remove_hint=None):
    """Add the hook entries for `tool` to `path`. Returns 0, or 1 when the file was refused."""
    command = command or hook_command(tool)
    try:
        doc, raw, indent, nl = _load(path)
        _check(doc, path)
    except (Refused, OSError) as e:
        out(f"refused: {e}. Nothing was changed.")
        return 1
    hooks = doc.setdefault("hooks", {})
    added = {}
    for ev, group in entries(tool, command).items():
        groups = hooks.get(ev, [])
        if any(is_ours(h, tool) for g in groups for h in g["hooks"]):
            out(f"already present: {ev} hook running `aad hook {tool}` in {path}")
            continue
        hooks[ev] = groups + [group]
        added[ev] = group
    if not added:
        out(f"unchanged {path} ({tool})")
        return 0
    backup = _write(path, doc, raw, indent, nl)
    out(f"added to {path} ({tool})" + (f"; backup {backup}" if backup else " (new file)") + ":")
    for ev, g in added.items():
        out(f"  hooks.{ev} += {json.dumps(g)}")
    out(f"remove with: {remove_hint or 'aad agent uninstall --hooks --' + tool}")
    return 0


def uninstall(tool, path, out=print):
    """Remove only this tool's `aad hook` handlers from `path`. Returns 0, or 1 when refused."""
    if not os.path.exists(path):
        out(f"nothing to remove: {path} does not exist")
        return 0
    try:
        doc, raw, indent, nl = _load(path)
        _check(doc, path)
    except (Refused, OSError) as e:
        out(f"refused: {e}. Nothing was changed.")
        return 1
    hooks = doc.get("hooks") or {}
    removed = 0
    for ev in list(hooks):
        groups = []
        for g in hooks[ev]:
            keep = [h for h in g["hooks"] if not is_ours(h, tool)]
            if len(keep) == len(g["hooks"]):
                groups.append(g)
                continue
            removed += len(g["hooks"]) - len(keep)
            if keep:
                groups.append(dict(g, hooks=keep))
        if len(groups) != len(hooks[ev]) or groups != hooks[ev]:
            if groups:
                hooks[ev] = groups
            else:
                del hooks[ev]
    if not removed:
        out(f"nothing to remove: no `aad hook {tool}` entries in {path}")
        return 0
    if "hooks" in doc and not hooks:
        del doc["hooks"]
    backup = _write(path, doc, raw, indent, nl)
    out(f"removed {removed} `aad hook {tool}` handler(s) from {path}; backup {backup}")
    return 0


def mcp_snippets(base=None):
    """The registration commands and config snippets for `aad mcp` (printed, never applied)."""
    argv = (base or base_command()) + ["mcp"]
    cmd, args = argv[0], argv[1:]
    q = " ".join(shlex.quote(x) for x in argv)
    toml_args = "[" + ", ".join(json.dumps(x) for x in args) + "]"
    return "\n".join([
        "aad mcp: a stdio MCP server with the review tools (review, pin, diff, tour_template, write_tour,",
        "packet_image). Nothing was registered; run one of these yourself.",
        "",
        "Claude Code (user level; --scope project writes .mcp.json in the project instead):",
        f"  claude mcp add --transport stdio --scope user aad -- {q}",
        "  .mcp.json:",
        "  " + json.dumps({"mcpServers": {"aad": {"type": "stdio", "command": cmd, "args": args}}}),
        "",
        "Codex:",
        f"  codex mcp add aad -- {q}",
        "  ~/.codex/config.toml:",
        "  [mcp_servers.aad]",
        f"  command = {json.dumps(cmd)}",
        f"  args = {toml_args}",
        "",
        "Add --project DIR after `mcp` to pin one review project; otherwise the server follows its working "
        "directory (and `aad follow`).",
    ])


def run(a, out=print):
    """Dispatch for `aad agent install --hooks/--mcp` and `aad agent uninstall --hooks`."""
    picked = [t for t in TOOLS if getattr(a, t, False)]
    if a.agent_cmd == "install" and getattr(a, "mcp", False) and not getattr(a, "hooks", False):
        out(mcp_snippets())
        return 0
    settings = getattr(a, "settings", None)
    if settings and len(picked) != 1:
        out("--settings names one file: pick --claude or --codex with it")
        return 2
    if settings:
        mode, base = "file", os.path.abspath(os.path.expanduser(settings))
    elif getattr(a, "project", None):
        mode, base = "project", os.path.abspath(os.path.expanduser(a.project))
    else:
        mode, base = "user", None
    tools = picked or (default_tools() if mode == "user" and a.agent_cmd == "install" else list(TOOLS))
    where = (f" --settings {shlex.quote(base)}" if mode == "file" else
             f" --project {shlex.quote(base)}" if mode == "project" else "")
    code = 0
    for t in tools:
        path = settings_path(t, mode, base)
        if a.agent_cmd == "uninstall":
            code = max(code, uninstall(t, path, out=out))
        else:
            code = max(code, install(t, path, out=out,
                                     remove_hint=f"aad agent uninstall --hooks --{t}{where}"))
            if t == "codex" and code == 0:
                out("Codex runs a new or changed hook only after you review and trust it: type /hooks in Codex. "
                    "Project hooks load only in a trusted project.")
    if a.agent_cmd == "install" and getattr(a, "mcp", False):
        out("")
        out(mcp_snippets())
    if a.agent_cmd == "install" and code == 0:
        out("Start a new session (or /hooks in Claude Code) to load the hooks. The agent then gets a short review "
            "note on the next prompt after the pins change.")
    return code
