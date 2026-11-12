"""`aad agent`: the /aad skill for Claude Code and Codex, which orients a coding agent on aad.

  aad agent print [--claude | --codex]                         the skill text on stdout
  aad agent install [--claude] [--codex] [--user | --project DIR | --dir DIR] [--force]
  aad agent install --hooks [--claude] [--codex] [--user | --project DIR | --settings FILE]   (see hooks.py)
  aad agent install --mcp                                      print the MCP server config (registers nothing)
  aad agent uninstall --hooks [--claude] [--codex] [--user | --project DIR | --settings FILE]

One shared body (body.md) under a per-tool frontmatter (claude.md, codex.md), so both stay in step. The body ends
with a local-notes section between two markers; install leaves it empty and keeps whatever an installed copy
already has there.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = ("claude", "codex")
NOTES_START = "<!-- aad:local-notes:start -->"
NOTES_END = "<!-- aad:local-notes:end -->"
_NOTES = re.compile(re.escape(NOTES_START) + r"(.*?)" + re.escape(NOTES_END), re.S)


def _read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def render(tool, notes=""):
    """The SKILL.md text for `tool` ("claude" or "codex"), with `notes` between the local-notes markers."""
    if tool not in TOOLS:
        raise ValueError(f"unknown tool {tool!r}")
    text = _read(f"{tool}.md") + _read("body.md")
    return set_notes(text, notes)


def get_notes(text):
    m = _NOTES.search(text)
    return m.group(1).strip("\n") if m else ""


def set_notes(text, notes):
    inner = "\n" + (notes.strip("\n") + "\n" if notes.strip() else "")
    return _NOTES.sub(lambda m: NOTES_START + inner + NOTES_END, text, count=1)


def target(tool, mode, base=None):
    """Where the skill goes. mode: "user", "project" (base = project dir) or "dir" (base = any dir)."""
    if mode == "dir":
        return os.path.join(base, tool, "aad", "SKILL.md")
    if mode == "project":
        sub = (".claude", "skills") if tool == "claude" else (".agents", "skills")
        return os.path.join(base, *sub, "aad", "SKILL.md")
    if tool == "claude":
        home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    else:
        home = os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    return os.path.join(home, "skills", "aad", "SKILL.md")


def install_one(tool, path, force=False, out=print):
    """Write the skill to `path`. An existing file with the same text (local notes aside) is left alone; a different
    one is kept unless `force`. Local notes in an existing file are carried over. Returns True when the file is in
    place afterwards."""
    new = render(tool)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            old = f.read()
        notes = get_notes(old)
        if set_notes(old, "") == new:
            out(f"unchanged {path} ({tool})")
            return True
        if not force:
            out(f"skipped {path} ({tool}): a different file is already there; rerun with --force to replace it "
                "(local notes between the aad:local-notes markers are kept)")
            return False
        new = render(tool, notes)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    out(f"wrote {path} ({tool})")
    return True


def add_args(p):
    sub = p.add_subparsers(dest="agent_cmd", required=True)
    pr = sub.add_parser("print", help="print the /aad skill text")
    g = pr.add_mutually_exclusive_group()
    g.add_argument("--claude", action="store_true", help="the Claude Code version (default)")
    g.add_argument("--codex", action="store_true", help="the Codex version")
    ins = sub.add_parser("install", help="install the /aad skill for Claude Code and Codex",
                         description="Install the /aad skill, which orients a coding agent on aad. With neither "
                                     "--claude nor --codex, installs both.")
    ins.add_argument("--claude", action="store_true", help="install for Claude Code")
    ins.add_argument("--codex", action="store_true", help="install for Codex")
    w = ins.add_mutually_exclusive_group()
    w.add_argument("--user", action="store_true",
                   help="user level (default): ~/.claude/skills/aad/ and ~/.codex/skills/aad/ "
                        "(CLAUDE_CONFIG_DIR and CODEX_HOME are honoured)")
    w.add_argument("--project", metavar="DIR",
                   help="project level: DIR/.claude/skills/aad/ and DIR/.agents/skills/aad/")
    w.add_argument("--dir", metavar="DIR", help="write DIR/claude/aad/SKILL.md and DIR/codex/aad/SKILL.md")
    ins.add_argument("--force", action="store_true", help="replace an existing different file")
    ins.add_argument("--hooks", action="store_true",
                     help="instead of the skill: add the hook that tells the agent when pins change "
                          "(Claude Code: settings.json, Codex: hooks.json), additively, with a backup")
    ins.add_argument("--mcp", action="store_true",
                     help="print the MCP server config and registration command for each tool (changes nothing)")
    w.add_argument("--settings", metavar="FILE", help="with --hooks: edit this settings file (one tool)")
    un = sub.add_parser("uninstall", help="remove the aad hook entries from a settings file")
    un.add_argument("--hooks", action="store_true", required=True, help="remove the `aad hook` entries")
    un.add_argument("--claude", action="store_true", help="Claude Code")
    un.add_argument("--codex", action="store_true", help="Codex")
    w = un.add_mutually_exclusive_group()
    w.add_argument("--user", action="store_true", help="user level (default)")
    w.add_argument("--project", metavar="DIR", help="project level")
    w.add_argument("--settings", metavar="FILE", help="this settings file (one tool)")
    return p


def run(a):
    if a.agent_cmd == "print":
        sys.stdout.write(render("codex" if a.codex else "claude"))
        return 0
    if a.agent_cmd == "uninstall" or a.hooks or a.mcp:
        from . import hooks
        if getattr(a, "dir", None):
            print("--dir is for the skill; use --settings FILE with --hooks")
            return 2
        return hooks.run(a)
    if a.settings:
        print("--settings goes with --hooks")
        return 2
    tools = [t for t in TOOLS if getattr(a, t)] or list(TOOLS)
    if a.dir:
        mode, base = "dir", os.path.abspath(os.path.expanduser(a.dir))
    elif a.project:
        mode, base = "project", os.path.abspath(os.path.expanduser(a.project))
    else:
        mode, base = "user", None
    ok = all([install_one(t, target(t, mode, base), force=a.force) for t in tools])
    if ok and mode != "dir":
        print("Claude Code: type /aad. Codex: type $aad or pick aad from /skills. Start a new session to load it.")
    return 0 if ok else 1
