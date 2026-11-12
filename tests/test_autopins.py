"""The agent sees pins automatically: `aad hook`, `aad follow`, `aad agent install --hooks` and `aad mcp`.
Every test points the user state directory at a temp dir (AAD_STATE_DIR) and edits only scratch settings files."""
import argparse
import io
import json
import os
import subprocess
import sys
import time

import pytest

from aad import agents, follow, hook, mcp
from aad.agents import hooks as H
from aad.cli import main
from aad.review import packet as P
from aad.review.store import Store

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PNG = b"\x89PNG\r\n\x1a\nfake"


def pin(n=1, **kw):
    p = dict(schema="cadreview/1", id=f"p{n}", n=n, kind="point", status="open", note="thin wall",
             issue_class="weird_geometry", severity="high", created="2026-11-11T20:00:00Z",
             anchor=dict(part=dict(key="m > bracket", node="bracket", component="bracket", file=0,
                                   path=["m", "bracket"]), local=[1, 2, 3], normal_local=[0, 0, 1],
                         world=[1, 2, 3], normal_world=[0, 0, 1]), parts=[])
    p.update(kw)
    return p


@pytest.fixture
def state(tmp_path, monkeypatch):
    d = tmp_path / "state"
    monkeypatch.setenv("AAD_STATE_DIR", str(d))
    return d


@pytest.fixture
def proj(tmp_path):
    d = tmp_path / "proj"
    st = Store(d)
    st.replace_pins([pin(1), pin(2, status="not_fixed", attempts=1, note="hole 5 mm off")])
    st.set_scope([dict(key="m > bracket", node="bracket")])
    return d


def run_hook(cwd, session="s1", event="UserPromptSubmit", **extra):
    out = io.StringIO()
    payload = dict(session_id=session, cwd=str(cwd), hook_event_name=event, prompt="go", **extra)
    assert hook.main(["claude"], stdin=io.StringIO(json.dumps(payload)), stdout=out) == 0
    return out.getvalue()


def send_packet(proj, pins=None):
    st = Store(proj)
    if pins is not None:
        st.replace_pins(pins)
    doc, d = P.write(st, dict(model=dict(name="bracket_demo")), png_bytes=PNG)
    return doc, d


# ---- the hook ----
def test_hook_first_sight_then_silent_then_new_packet(state, proj):
    first = run_hook(proj)
    assert first.startswith(f"aad review for proj ({proj}): 2 open pin(s) (1 not fixed), scope lock: bracket.")
    assert "#2 [NOT FIXED] point on bracket: hole 5 mm off" in first and "#1 point on bracket: thin wall" in first
    assert "{" not in first.splitlines()[0]                      # never the JSON
    assert run_hook(proj) == ""                                  # nothing changed
    doc, d = send_packet(proj, Store(proj).pins() + [pin(3, note="fillet the inside edge")])
    out = run_hook(proj)
    assert out.startswith(f"aad review for bracket_demo ({proj}): packet sent ")
    assert "New since you last looked: packet sent " in out and "pin #3 added" in out
    assert os.path.join(d, "view.png") in out and f"aad review --project {proj} --json" in out
    assert len(out) < 1500
    assert run_hook(proj) == ""
    assert run_hook(proj, session="s2") != ""                    # another session has not seen it yet


def test_hook_reports_status_scope_and_tour_changes(state, proj):
    run_hook(proj)
    st = Store(proj)
    ps = st.pins()
    ps[0]["status"] = "not_fixed"
    ps[1]["status"] = "resolved"
    st.replace_pins(ps)
    st.set_scope([dict(key="m > plate", node="base_plate")])
    st._write("tour.json", dict(schema="cadreview/1", stops=[dict(id="s1", parts=["bracket"], note="moved")],
                                decisions=dict(s1=dict(decision="reject"))), "tour")
    out = run_hook(proj)
    assert "pin #1 marked Not fixed" in out and "pin #2 resolved" in out
    assert "scope lock changed" in out and "tour s1 rejected" in out and "scope lock: base_plate." in out


def test_hook_no_project_prints_nothing_fast(state, tmp_path):
    (tmp_path / "plain").mkdir()
    t = time.perf_counter()
    assert run_hook(tmp_path / "plain") == ""
    assert time.perf_counter() - t < 0.5
    assert not (state / "seen").exists()                        # nothing recorded for a non-project


def test_hook_clear_resets_what_the_session_saw(state, proj):
    run_hook(proj)
    assert run_hook(proj) == ""
    assert run_hook(proj, event="SessionStart", source="clear") != ""


def test_hook_follow_mapping(state, proj, tmp_path):
    elsewhere = tmp_path / "work" / "sub"
    elsewhere.mkdir(parents=True)
    assert run_hook(elsewhere) == ""
    assert main(["follow", str(proj), "--cwd", str(tmp_path / "work")]) == 0
    out = run_hook(elsewhere)                                    # a subdirectory of the mapped cwd follows too
    assert "2 open pin(s)" in out and str(proj) in out
    assert follow.follows() == {os.path.realpath(tmp_path / "work"): os.path.realpath(proj)}
    assert main(["unfollow", "--cwd", str(tmp_path / "work")]) == 0
    assert follow.follows() == {}


def test_hook_error_path_prints_nothing_and_logs(state, proj, monkeypatch, capsys):
    out = io.StringIO()
    assert hook.main(["claude"], stdin=io.StringIO("{not json"), stdout=out) == 0
    assert out.getvalue() == ""
    monkeypatch.setattr(hook, "snapshot", lambda p: 1 / 0)
    assert run_hook(proj) == ""
    log = (state / "hook.log").read_text()
    assert "JSONDecodeError" in log and "ZeroDivisionError" in log
    assert capsys.readouterr().err == ""


def test_hook_caps_pins_and_lists_keep_and_question_briefly(state, tmp_path):
    p = tmp_path / "many"
    pins = [pin(n, note=f"issue {n} " + "x" * 300) for n in range(1, 13)]
    pins += [pin(13, issue_class="keep", note="keep this boss"), pin(14, issue_class="question", note="why 3 mm?")]
    Store(p).replace_pins(pins)
    out = run_hook(p)
    line = next(x for x in out.splitlines() if x.startswith("Open pins: "))
    assert line.count("; #") == hook.MAX_PINS - 1 and line.endswith("; and 4 more.")
    assert "..." in line and "x" * 120 not in line                 # reasons are cut short
    assert "Keep pins (locked: nothing within 5 mm may change): #13 on bracket." in out
    assert "Question pins (answer only, change nothing): #14 on bracket." in out


def test_hook_prunes_old_sessions(state, proj):
    run_hook(proj, session="old")
    seen = state / "seen"
    (old,) = list(seen.glob("*.json"))
    os.utime(old, (time.time() - 15 * 86400,) * 2)
    os.utime(seen / ".pruned", (time.time() - 7200,) * 2)
    run_hook(proj, session="new")
    assert not old.exists() and len(list(seen.glob("*.json"))) == 1


def test_hook_subprocess_is_quick_and_imports_no_numpy(state, proj):
    env = dict(os.environ, PYTHONPATH=ROOT)
    payload = json.dumps(dict(session_id="t", cwd=str(proj), hook_event_name="UserPromptSubmit", prompt="x"))
    code = ("import io,sys,json; from aad.cli import main; sys.stdin=io.StringIO(sys.argv[1]); main(['hook','claude']);"
            "print(json.dumps(sorted(m for m in sys.modules if m.split('.')[0] in ('numpy','aad'))), file=sys.stderr)")
    t = time.perf_counter()
    r = subprocess.run([sys.executable, "-c", code, payload], capture_output=True, text=True, env=env, timeout=30)
    assert time.perf_counter() - t < 3.0                        # generous for CI; about 30 ms locally
    mods = json.loads(r.stderr.strip().splitlines()[-1])
    assert not any(m.startswith("numpy") or m.startswith("aad.viewer") for m in mods), mods
    assert "2 open pin(s)" in r.stdout


# ---- the installer, on scratch settings files only ----
EXISTING = {
    "model": "x",
    "hooks": {
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "/opt/other/guard.sh"}]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "check-bash"}]}],
    },
}


def install(*args):
    out = io.StringIO()
    a = agents.add_args(argparse.ArgumentParser()).parse_args(list(args))
    code = H.run(a, out=lambda s="": out.write(s + "\n"))
    return code, out.getvalue()


def test_install_hooks_scratch_settings(tmp_path):
    f = tmp_path / "settings.json"
    f.write_text(json.dumps(EXISTING, indent=2) + "\n")
    before = json.loads(f.read_text())
    code, out = install("install", "--hooks", "--claude", "--settings", str(f))
    assert code == 0 and "added to" in out and "remove with: aad agent uninstall --hooks --claude --settings" in out
    backups = list(tmp_path.glob("settings.json.aad-backup-*"))
    assert len(backups) == 1 and json.loads(backups[0].read_text()) == before
    doc = json.loads(f.read_text())
    ups = doc["hooks"]["UserPromptSubmit"]
    assert ups[0] == before["hooks"]["UserPromptSubmit"][0]           # existing entry first and untouched
    assert doc["hooks"]["PreToolUse"] == before["hooks"]["PreToolUse"] and doc["model"] == "x"
    assert list(doc["hooks"]) == ["UserPromptSubmit", "PreToolUse", "SessionStart"]
    assert ups[1]["hooks"][0]["command"].endswith("aad hook claude") and ups[1]["hooks"][0]["type"] == "command"
    assert doc["hooks"]["SessionStart"][0]["matcher"] == "startup|resume|clear|compact|fork"
    text = f.read_text()
    code, out = install("install", "--hooks", "--claude", "--settings", str(f))   # idempotent
    assert code == 0 and "unchanged" in out and f.read_text() == text
    assert len(list(tmp_path.glob("settings.json.aad-backup-*"))) == 1
    code, out = install("uninstall", "--hooks", "--claude", "--settings", str(f))
    assert code == 0 and "removed 2" in out
    assert json.loads(f.read_text()) == before


def test_install_hooks_refuses_unexpected_structure(tmp_path):
    f = tmp_path / "settings.json"
    for bad in ('{"hooks": []}', '{"hooks": {"Stop": {"command": "x"}}}', "[1, 2]", "{ // comment\n}"):
        f.write_text(bad)
        code, out = install("install", "--hooks", "--claude", "--settings", str(f))
        assert code == 1 and out.startswith("refused:") and f.read_text() == bad
    assert not list(tmp_path.glob("*.aad-backup-*"))


def test_install_codex_scratch_and_project_mode(tmp_path):
    code, out = install("install", "--hooks", "--codex", "--project", str(tmp_path))
    path = tmp_path / ".codex" / "hooks.json"
    assert code == 0 and "(new file)" in out and "/hooks" in out
    cmd = json.loads(path.read_text())["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert cmd.endswith("aad hook codex")


def test_install_settings_needs_one_tool(tmp_path):
    code, out = install("install", "--hooks", "--settings", str(tmp_path / "s.json"))
    assert code == 2 and not (tmp_path / "s.json").exists()


def test_install_mcp_only_prints(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    code, out = install("install", "--mcp")
    assert code == 0 and "claude mcp add" in out and "codex mcp add" in out and "[mcp_servers.aad]" in out
    assert list(tmp_path.iterdir()) == []


def test_is_ours_matches_only_aad_hook():
    assert H.is_ours({"command": "/x/.venv/bin/aad hook claude"}, "claude")
    assert H.is_ours({"command": "/usr/bin/python3 -m aad hook codex"}, "codex")
    assert not H.is_ours({"command": "/x/aad hook claude"}, "codex")
    assert not H.is_ours({"command": "notaad hook claude"})
    assert not H.is_ours({"command": "aad hook claude && rm -rf /"})


# ---- the MCP server ----
def rpc(srv, method, params=None, mid=1):
    msg = dict(jsonrpc="2.0", id=mid, method=method)
    if params is not None:
        msg["params"] = params
    return srv.handle(msg)


def test_mcp_handshake_tools_and_review(state, proj):
    srv = mcp.Server(str(proj))
    before = {n: (proj / ".cadreview" / n).read_bytes() for n in ("pins.json", "scope.json")}
    r = rpc(srv, "initialize", dict(protocolVersion="2025-11-25", capabilities={},
                                    clientInfo=dict(name="t", version="1")))["result"]
    assert r["protocolVersion"] == "2025-11-25" and r["serverInfo"]["name"] == "aad" and "tools" in r["capabilities"]
    assert srv.handle(dict(jsonrpc="2.0", method="notifications/initialized")) is None
    assert rpc(srv, "ping")["result"] == {}
    names = [t["name"] for t in rpc(srv, "tools/list")["result"]["tools"]]
    assert names == ["review", "pin", "diff", "tour_template", "write_tour", "packet_image"]
    for t in rpc(srv, "tools/list")["result"]["tools"]:
        assert t["inputSchema"]["type"] == "object"
    res = rpc(srv, "tools/call", dict(name="review", arguments={}))["result"]
    assert not res["isError"] and "2 open pin(s)" in res["content"][0]["text"]
    full = rpc(srv, "tools/call", dict(name="review", arguments=dict(format="full")))["result"]
    assert json.loads(full["content"][0]["text"]) == full["structuredContent"]
    one = rpc(srv, "tools/call", dict(name="pin", arguments=dict(pin=2)))["result"]
    assert one["structuredContent"]["status"] == "not_fixed" and one["structuredContent"]["reason"]
    assert rpc(srv, "tools/call", dict(name="pin", arguments=dict(pin=99)))["result"]["isError"]
    assert rpc(srv, "initialize", dict(protocolVersion="1999-01-01"))["result"]["protocolVersion"] == "2025-11-25"
    assert {n: (proj / ".cadreview" / n).read_bytes() for n in before} == before      # tools never touch pins


def test_mcp_write_tour_validates_and_never_takes_decisions(state, proj):
    srv = mcp.Server(str(proj))
    bad = rpc(srv, "tools/call", dict(name="write_tour", arguments=dict(tour=dict(stops=[dict(id="s1")]))))
    assert bad["result"]["isError"] and "tour not written" in bad["result"]["content"][0]["text"]
    assert not (proj / ".cadreview" / "tour.json").exists()
    dec = rpc(srv, "tools/call", dict(name="write_tour", arguments=dict(tour=dict(
        stops=[dict(id="s1", parts=["bracket"], note="x")], decisions={}))))
    assert dec["result"]["isError"]
    ok = rpc(srv, "tools/call", dict(name="write_tour", arguments=dict(tour=dict(
        title="t", stops=[dict(id="s1", parts=["bracket"], note="moved the hole back")]))))
    assert not ok["result"]["isError"] and json.loads((proj / ".cadreview" / "tour.json").read_text())["stops"]


def test_mcp_packet_image_resources_and_errors(state, proj):
    srv = mcp.Server(str(proj))
    assert rpc(srv, "tools/call", dict(name="packet_image", arguments={}))["result"]["isError"]
    send_packet(proj)
    img = rpc(srv, "tools/call", dict(name="packet_image", arguments={}))["result"]
    assert img["content"][1]["type"] == "image" and img["content"][1]["mimeType"] == "image/png"
    uris = [r["uri"] for r in rpc(srv, "resources/list")["result"]["resources"]]
    assert "aad://review" in uris
    pk = rpc(srv, "resources/read", dict(uri="aad://packet/latest"))["result"]["contents"][0]
    assert json.loads(pk["text"])["model"]["name"] == "bracket_demo"
    assert rpc(srv, "resources/read", dict(uri="aad://nope"))["error"]["code"] == mcp.RESOURCE_NOT_FOUND
    assert rpc(srv, "no/such/method")["error"]["code"] == -32601
    assert rpc(srv, "tools/call", dict(name="resolve", arguments={}))["error"]["code"] == -32602
    assert srv.handle({"id": 3, "method": "ping"})["error"]["code"] == -32600


def test_mcp_over_stdio(state, proj):
    lines = [dict(jsonrpc="2.0", id=1, method="initialize", params=dict(protocolVersion="2025-11-25", capabilities={},
                                                                       clientInfo=dict(name="t", version="1"))),
             dict(jsonrpc="2.0", method="notifications/initialized"),
             dict(jsonrpc="2.0", id=2, method="tools/list"),
             dict(jsonrpc="2.0", id=3, method="tools/call", params=dict(name="review", arguments={}))]
    stdin = "\n".join(json.dumps(x) for x in lines) + "\nnot json\n"
    r = subprocess.run([sys.executable, "-m", "aad", "mcp", "--project", str(proj)], input=stdin, capture_output=True,
                       text=True, env=dict(os.environ, PYTHONPATH=ROOT), timeout=60)
    assert r.returncode == 0, r.stderr
    out = [json.loads(x) for x in r.stdout.splitlines()]
    assert [o.get("id") for o in out] == [1, 2, 3, None]
    assert all(o["jsonrpc"] == "2.0" for o in out) and out[3]["error"]["code"] == -32700
    assert "2 open pin(s)" in out[2]["result"]["content"][0]["text"]
