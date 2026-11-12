"""The viewer's local-only guard: wrong Host (DNS rebinding), cross-site and non-JSON writes are refused, and no
response carries a CORS header."""
import http.client
import json
import os
import threading

import pytest
from aad.viewer.server import Sources, Viewer, _bind

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAD = os.path.join(ROOT, "aad", "examples", "bracket_demo", "bad", "bracket_demo.glb")


@pytest.fixture()
def server(tmp_path):
    V = Viewer(Sources([BAD]), project=str(tmp_path))
    srv = _bind(V, 0)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    try:
        yield srv.server_port
    finally:
        srv.shutdown()
        srv.server_close()
        th.join()


def call(port, method, path, host=None, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        c.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else (body or b"")
        for k, v in (headers or {}).items():
            c.putheader(k, v)
        if method == "POST":
            c.putheader("Content-Length", str(len(data)))
        c.endheaders(data if method == "POST" else None)
        r = c.getresponse()
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read()
    finally:
        c.close()


JSON = {"Content-Type": "application/json"}


def test_wrong_host_is_refused(server):
    for host in ("evil.example", f"evil.example:{server}", f"127.0.0.1:{server + 1}", "127.0.0.1"):
        assert call(server, "GET", "/models.json", host=host)[0] == 403, host
        assert call(server, "GET", "/review/state.json", host=host)[0] == 403, host
        assert call(server, "POST", "/review/scope", host=host, body=dict(parts=[]), headers=JSON)[0] == 403, host
    for host in (f"127.0.0.1:{server}", f"localhost:{server}", f"[::1]:{server}", f"LOCALHOST:{server}"):
        assert call(server, "GET", "/models.json", host=host)[0] == 200, host


def test_cross_site_and_simple_writes_are_refused(server):
    own = f"http://127.0.0.1:{server}"
    body = dict(parts=[])
    for ct in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", None):
        h = {"Content-Type": ct} if ct else {}
        st, hd, txt = call(server, "POST", "/review/scope", body=body, headers=h)
        assert st == 403 and hd["content-type"].startswith("text/plain") and b"application/json" in txt, ct
    assert call(server, "POST", "/log", body=dict(level="info", msg="x"), headers={"Content-Type": "text/plain"})[0] == 403
    assert call(server, "POST", "/review/scope", body=body, headers=dict(JSON, Origin="https://evil.example"))[0] == 403
    assert call(server, "POST", "/review/scope", body=body, headers=dict(JSON, Origin="null"))[0] == 403
    assert call(server, "POST", "/review/scope", body=body,
                headers=dict(JSON, Origin=own, **{"Sec-Fetch-Site": "cross-site"}))[0] == 403
    assert call(server, "POST", "/review/scope", body=body, headers=dict(JSON, **{"Sec-Fetch-Site": "same-site"}))[0] == 403
    assert call(server, "PUT", "/review/scope", headers=dict(JSON, Origin="https://evil.example"))[0] == 403


def test_same_origin_json_writes_still_work(server):
    own = f"http://127.0.0.1:{server}"
    st, _, b = call(server, "POST", "/review/scope", body=dict(parts=[]),
                    headers=dict(JSON, Origin=own, **{"Sec-Fetch-Site": "same-origin"}))
    assert st == 200, b
    assert call(server, "POST", "/log", body=dict(level="info", msg="x"),
                headers={"Content-Type": "application/json; charset=utf-8"})[0] == 200
    assert call(server, "POST", "/review/scope", body=dict(parts=[]),
                headers=dict(JSON, Origin=f"http://localhost:{server}"))[0] == 200     # CLI and tools send no Origin
    assert call(server, "POST", "/review/scope", body=dict(parts=[]), headers=dict(JSON, **{"Sec-Fetch-Site": "none"}))[0] == 200


def test_no_cors_headers_and_safe_response_headers(server):
    own = f"http://127.0.0.1:{server}"
    seen = [call(server, "GET", "/models.json", headers={"Origin": "https://evil.example"}),
            call(server, "GET", "/", headers={"Origin": own}),
            call(server, "GET", "/models.json", host="evil.example"),
            call(server, "POST", "/review/scope", body=dict(parts=[]), headers=dict(JSON, Origin=own)),
            call(server, "POST", "/review/scope", body=dict(parts=[]), headers={"Content-Type": "text/plain"}),
            call(server, "GET", "/nope")]
    for st, hd, _ in seen:
        assert not [k for k in hd if k.startswith("access-control-")], hd
        assert hd.get("x-content-type-options") == "nosniff" and hd.get("cross-origin-resource-policy") == "same-origin", hd
