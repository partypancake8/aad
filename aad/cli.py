"""aad command line: view, review, demo and agent.

  aad view <model.glb | dir | versions.json> [--project DIR] [--port N] [--versions FILE] [--no-open]
  aad review [--project DIR] [--json]          open pins, scope lock, diff baseline, latest diff, camera, packets
  aad review diff [A.glb [B.glb]]              per-part diff with collateral against the scope lock
  aad review resolve <pin>                     mark a pin resolved
  aad review tour-template                     an empty tour.json for the current build
  aad demo [DIR] [--port N] [--no-open]        copy the bracket demo to DIR (default: a temp dir) and serve it
  aad agent install [--claude] [--codex]       install the /aad skill that orients Claude Code or Codex on aad
  aad agent print [--claude | --codex]         print that skill
  aad agent install --hooks | --mcp            the pins-change hook (settings entries) / print the MCP config
  aad hook claude | codex                      hook command: review context when the pins changed (stdin: hook JSON)
  aad follow <project dir> | --list            sessions started in this directory follow that project
  aad unfollow                                 forget this directory's follow mapping
  aad mcp [--project DIR]                      stdio MCP server with the review tools
"""
import argparse
import os
import shutil
import sys
import tempfile

from . import __version__

DEMO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "examples", "bracket_demo")
DEFAULT_PORT = 7891


def cmd_view(a):
    from .viewer import server
    paths = list(a.paths)
    if len(paths) == 1 and paths[0].lower().endswith(".json") and os.path.isfile(paths[0]) and not a.versions:
        a.versions, paths = paths[0], []             # `aad view versions.json`
    a.paths = paths
    return server.run(a)


def cmd_review(a):
    from .review import cli
    return cli.run(a)


def cmd_agent(a):
    from . import agents
    return agents.run(a)


def copy_demo(dest):
    """Copy the bundled bracket demo (good/, bad/, versions.json) into `dest` and lock the scope to the bracket,
    so the first diff shows the planted edit to the base plate as collateral. Returns `dest`."""
    from .review.store import Store
    os.makedirs(dest, exist_ok=True)
    for name in ("good", "bad"):
        shutil.copytree(os.path.join(DEMO, name), os.path.join(dest, name), dirs_exist_ok=True)
    shutil.copy2(os.path.join(DEMO, "versions.json"), os.path.join(dest, "versions.json"))
    st = Store(dest)
    if not st.scope()["parts"]:
        st.set_scope([dict(key="bracket_demo.glb > bracket", node="bracket")],
                     note="demo: only the bracket may change")
    return dest


def cmd_demo(a):
    from .viewer import server
    dest = os.path.abspath(os.path.expanduser(a.dir)) if a.dir else tempfile.mkdtemp(prefix="aad-demo-")
    copy_demo(dest)
    server.log(f"bracket demo copied to {dest}")
    server.log("open the Diff tab: base_plate changed outside the scope lock and is flagged as collateral")
    code, res = server.serve([os.path.join(dest, "bad", "bracket_demo.glb")], port=a.port or DEFAULT_PORT,
                             open_browser=not a.no_open, versions=os.path.join(dest, "versions.json"), project=dest)
    return code


def cmd_follow(a):
    from . import follow
    return follow.run_follow(a)


def cmd_unfollow(a):
    from . import follow
    return follow.run_unfollow(a)


def cmd_mcp(a):
    from . import mcp
    return mcp.serve(project=a.project)


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    if args[:1] == ["hook"]:                      # runs before every prompt: no viewer or numpy import
        from . import hook
        return hook.main(args[1:])
    ap = argparse.ArgumentParser(prog="aad", description="agent aided design: a review workspace for CAD written "
                                                         "by coding agents")
    ap.add_argument("--version", action="version", version=f"aad {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    from .viewer import server
    p = server.add_args(sub.add_parser("view", help="open the viewer on a model, a directory or a versions.json"))
    p.set_defaults(fn=cmd_view)
    from .review import cli as review_cli
    p = review_cli.add_args(sub.add_parser("review", help="review state for a coding agent (pins, scope, diff)"))
    p.set_defaults(fn=cmd_review)
    p = sub.add_parser("demo", help="copy the bracket demo to a directory and serve it")
    p.add_argument("dir", nargs="?", help="where to copy the demo (default: a new temp directory)")
    p.add_argument("--port", type=int, help=f"port on 127.0.0.1 (default {DEFAULT_PORT})")
    p.add_argument("--no-open", action="store_true", help="do not open a browser tab")
    p.set_defaults(fn=cmd_demo)
    from . import agents
    p = agents.add_args(sub.add_parser("agent", help="the /aad skill for Claude Code and Codex (install, print)"))
    p.set_defaults(fn=cmd_agent)
    p = sub.add_parser("hook", help="hook command for Claude Code or Codex: review context when the pins changed")
    p.add_argument("tool", choices=("claude", "codex"))
    p = sub.add_parser("follow", help="sessions started in this directory follow a review project")
    from . import follow
    follow.add_args(p).set_defaults(fn=cmd_follow)
    p = sub.add_parser("unfollow", help="forget this directory's follow mapping")
    follow.add_args(p, unfollow=True).set_defaults(fn=cmd_unfollow)
    p = sub.add_parser("mcp", help="stdio MCP server with the review tools")
    p.add_argument("--project", help="default review project (default: from the working directory)")
    p.set_defaults(fn=cmd_mcp)
    a = ap.parse_args(args)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
