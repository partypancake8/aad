"""`aad agent`: the /aad skill that orients a coding agent on aad."""
import os

import pytest

from aad import agents
from aad.cli import main

RULES = [  # one phrase from each of the ten rules in AGENTS.md
    "At the start of every CAD turn run `aad review --json`",
    "A pin with no note is complete.",
    "Work on `not_fixed` and repinned pins first",
    "Question pins (`instruction`: \"answer only, change nothing\")",
    "Only parts in the scope lock may change.",
    "A `regression` pin means something that was right before is broken again.",
    "After the build, run `aad review diff`.",
    "Write a change tour:",
    "Never resolve, delete or edit the reviewer's pins",
    "Never loosen a check, tolerance or test to make a build pass.",
]


def frontmatter(text):
    assert text.startswith("---\n")
    head, _, body = text[4:].partition("\n---\n")
    fields = dict(line.split(": ", 1) for line in head.splitlines())
    return fields, body


def test_install_dir_writes_both_with_the_ten_rules(tmp_path, capsys):
    assert main(["agent", "install", "--claude", "--codex", "--dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    for tool in ("claude", "codex"):
        path = tmp_path / tool / "aad" / "SKILL.md"
        assert path.is_file() and f"wrote {path} ({tool})" in out
        text = path.read_text()
        fields, body = frontmatter(text)
        assert fields["name"] == "aad" and "CAD review for" in fields["description"]
        for phrase in RULES:
            assert phrase in body, (tool, phrase)
        assert "not a request to do anything" in body          # orientation only
        assert "—" not in text                              # no em dashes
        assert agents.get_notes(text) == ""                     # local notes empty for everyone else


def test_both_tools_share_the_body():
    c, x = agents.render("claude"), agents.render("codex")
    assert frontmatter(c)[1] == frontmatter(x)[1]


def test_existing_different_file_needs_force_and_keeps_local_notes(tmp_path, capsys):
    path = tmp_path / "claude" / "aad" / "SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text("my own aad skill\n")
    assert main(["agent", "install", "--claude", "--dir", str(tmp_path)]) == 1
    assert "skipped" in capsys.readouterr().out and path.read_text() == "my own aad skill\n"

    assert main(["agent", "install", "--claude", "--dir", str(tmp_path), "--force"]) == 0
    assert path.read_text() == agents.render("claude")

    # local notes survive a reinstall, with or without --force
    path.write_text(agents.set_notes(path.read_text(), "- viewer for this machine runs on port 9000"))
    assert main(["agent", "install", "--claude", "--dir", str(tmp_path)]) == 0
    assert "unchanged" in capsys.readouterr().out
    stale = path.read_text().replace("## Vocabulary", "## Old vocabulary")
    path.write_text(stale)
    assert main(["agent", "install", "--claude", "--dir", str(tmp_path)]) == 1
    assert main(["agent", "install", "--claude", "--dir", str(tmp_path), "--force"]) == 0
    text = path.read_text()
    assert "## Old vocabulary" not in text and agents.get_notes(text) == "- viewer for this machine runs on port 9000"


def test_targets(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "cx"))
    assert agents.target("claude", "user") == str(tmp_path / "cc" / "skills" / "aad" / "SKILL.md")
    assert agents.target("codex", "user") == str(tmp_path / "cx" / "skills" / "aad" / "SKILL.md")
    assert agents.target("claude", "project", "/p") == os.path.join("/p", ".claude", "skills", "aad", "SKILL.md")
    assert agents.target("codex", "project", "/p") == os.path.join("/p", ".agents", "skills", "aad", "SKILL.md")


def test_print(capsys):
    assert main(["agent", "print", "--codex"]) == 0
    assert capsys.readouterr().out == agents.render("codex")
    with pytest.raises(ValueError):
        agents.render("other")
