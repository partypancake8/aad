"""`aad mcp`: a stdio MCP server with the review tools, for agents that work through tool calls.

Model Context Protocol revision 2025-11-25 (the initialize handshake revision; 2025-06-18, 2025-03-26 and
2024-11-05 are accepted too). JSON-RPC 2.0 messages, one per line on stdin and stdout, standard library only.
Methods: initialize, notifications/initialized, ping, tools/list, tools/call, resources/list, resources/read.
`server/discover` (the probe of the per-request revisions that followed) gets "method not found", which tells a
client that speaks both to fall back to initialize.

Tools mirror the CLI and never resolve, edit or delete the reviewer's pins or scope lock:
  review         open pins, scope lock, baseline and diff summary (format brief | full)
  pin            one pin in full, by number or id
  diff           the current build against the reviewed baseline, or a named revision (nothing is saved)
  tour_template  an empty tour for the current build
  write_tour     validate a tour against the tour schema and write .cadreview/tour.json
  packet_image   the latest packet's view.png as an image
Resources: aad://review (the review state as JSON), aad://packet/latest (packet.json),
aad://packet/latest/view.png.
"""
import base64
import contextlib
import io
import json
import os
import sys

from . import __version__, follow

PROTOCOL = "2025-11-25"
SUPPORTED = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL = -32700, -32600, -32601, -32602, -32603
RESOURCE_NOT_FOUND = -32002

INSTRUCTIONS = ("aad is a CAD review tool: a person pins problems on a 3D model and you read them here. Call "
                "`review` at the start of a CAD turn, `pin` for one pin in full, `diff` after a rebuild (explain "
                "any collateral), then `tour_template` and `write_tour`. Only parts in the scope lock may change. "
                "Never resolve, edit or delete the reviewer's pins or scope lock. The tools mirror `aad review`.")

_PROJECT = {"type": "string", "description": "CAD project directory holding .cadreview/ (default: the server's "
                                             "project, from --project or its working directory)"}
_RO = dict(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)

TOOLS = [
    dict(name="review", title="Review state",
         description="Open pins in review order, scope lock, keep and question pins, diff baseline, latest diff "
                     "summary and packets. format=brief (default) is a short text summary; format=full is the "
                     "same JSON as `aad review --json`.",
         inputSchema={"type": "object", "properties": {
             "project": _PROJECT,
             "format": {"type": "string", "enum": ["brief", "full"], "default": "brief"}},
             "additionalProperties": False},
         annotations=_RO),
    dict(name="pin", title="One pin",
         description="One pin in full: anchor (part, local point and normal in mm), edge polyline, issue class, "
                     "reason, class meaning, status, escalation and repin history.",
         inputSchema={"type": "object", "properties": {
             "project": _PROJECT,
             "pin": {"type": ["integer", "string"], "description": "pin number (3) or id (p3)"}},
             "required": ["pin"], "additionalProperties": False},
         annotations=_RO),
    dict(name="diff", title="Diff against the reviewed build",
         description="Per-part diff of the current build against the build the reviewer last looked at (or the "
                     "previous build), collateral against the scope lock first, with detector warnings. "
                     "`against` names a stored revision instead (its id or build id). Nothing is saved.",
         inputSchema={"type": "object", "properties": {
             "project": _PROJECT,
             "against": {"type": "string", "description": "revision id or build id (default: the reviewed "
                                                          "baseline)"}},
             "additionalProperties": False},
         annotations=_RO),
    dict(name="tour_template", title="Tour template",
         description="An empty change tour for the current build (one stop per changed part of the latest diff), "
                     "to fill in and pass to write_tour.",
         inputSchema={"type": "object", "properties": {"project": _PROJECT}, "additionalProperties": False},
         annotations=_RO),
    dict(name="write_tour", title="Write the change tour",
         description="Validate a change tour against the tour schema and write it to .cadreview/tour.json. One "
                     "stop per change with a note saying what changed and why. Decisions belong to the reviewer "
                     "and are refused.",
         inputSchema={"type": "object", "properties": {
             "project": _PROJECT,
             "tour": {"type": "object", "description": "the tour: {schema?, build, title, author, stops: [{id, "
                                                        "parts, note, kind?, ghost?, camera?, issue_class?}]}"}},
             "required": ["tour"], "additionalProperties": False},
         annotations=dict(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)),
    dict(name="packet_image", title="Packet screenshot",
         description="The latest packet's view.png (pins numbered) as an image, or a named packet's.",
         inputSchema={"type": "object", "properties": {
             "project": _PROJECT, "packet": {"type": "string", "description": "packet id (default: the latest)"}},
             "additionalProperties": False},
         annotations=_RO),
]

RESOURCES = [
    dict(uri="aad://review", name="review", title="Review state", mimeType="application/json",
         description="The same JSON as `aad review --json` for the server's project."),
    dict(uri="aad://packet/latest", name="packet", title="Latest packet", mimeType="application/json",
         description="packet.json of the newest packet the reviewer sent."),
    dict(uri="aad://packet/latest/view.png", name="packet-image", title="Latest packet screenshot",
         mimeType="image/png", description="The newest packet's screenshot, pins numbered."),
]


class ToolError(Exception):
    """A tool execution error: reported in the result with isError, so the agent can correct itself."""


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


class Server:
    def __init__(self, project=None):
        self.default = project
        self.initialized = False
        self.protocol = PROTOCOL

    # ---- projects
    def store(self, project=None):
        from .review.store import Store
        p = project or self.default or follow.find_review_project(os.getcwd())
        if not p:
            raise ToolError("no review project: pass `project` (a directory holding .cadreview/) or start the "
                            "server with --project DIR")
        p = os.path.abspath(os.path.expanduser(p))
        if not os.path.isdir(p):
            raise ToolError(f"{p} is not a directory")
        if not os.path.isdir(os.path.join(p, ".cadreview")):
            q = follow.find_review_project(p)
            if not q:
                raise ToolError(f"{p} has no .cadreview/ (open the model once with `aad view --project {p}`)")
            p = q
        return Store(p)

    # ---- tools
    def t_review(self, args):
        st = self.store(args.get("project"))
        fmt = args.get("format") or "brief"
        if fmt not in ("brief", "full"):
            raise ToolError("format is brief or full")
        if fmt == "full":
            from .review import cli
            s = cli.status(st)
            return [_text(json.dumps(s, indent=1))], s
        from . import hook
        snap = hook.snapshot(st.project)
        if not snap["open"] and not snap["latest"]:
            return [_text(f"aad review for {snap['model']} ({st.project}): no open pins and no packet yet.")], None
        return [_text(hook.block(st.project, snap, []))], None

    def t_pin(self, args):
        from .review.store import issue_classes, with_reason
        st = self.store(args.get("project"))
        want = str(args.get("pin", "")).strip().lstrip("#")
        if not want:
            raise ToolError("pin is required (a number like 3 or an id like p3)")
        for p in st.pins():
            if p["id"] == want or str(p["n"]) == want:
                q = with_reason(p, issue_classes())
                return [_text(json.dumps(q, indent=1))], q
        raise ToolError(f"no pin {want} in {st.project}")

    def t_diff(self, args):
        from .review import diff as D
        from .review.store import build_id
        st = self.store(args.get("project"))
        cur = st.current() or {}
        b_paths = [p for p in cur.get("files") or [] if os.path.exists(p)]
        if not b_paths:
            raise ToolError("no current build in the project (open the viewer once with --project)")
        b_build = build_id(b_paths)
        sc = st.scope()["parts"]
        scope = [x["node"] for x in sc] if sc else None
        want = args.get("against")
        packet = None
        if want:
            hit = next((b for b in st.baselines() if want in (b.get("id"), b.get("build"))), None)
            if not hit:
                raise ToolError(f"no stored revision {want}; ids: " +
                                ", ".join(f"{b['id']} (build {b.get('build')})" for b in st.baselines()[:10]))
            bl, kind, label = hit, "build", f"revision {hit['id']} (build {hit.get('build')})"
        else:
            bl, kind, label = st.default_baseline(b_build)
            if not bl:
                raise ToolError("no baseline yet: the previous build appears after a rebuild, the reviewed one "
                                "after a packet")
            packet = bl.get("packet")
        doc = D.diff(bl["paths"], b_paths, scope=scope, a_label=label, b_label="current build", a_id=bl["id"],
                     a_build=bl.get("build"), b_build=b_build, a_kind=kind, a_packet=packet)
        used = f"baseline: {label}, build {bl.get('build')}" + (f", packet {packet}" if packet else "")
        return [_text(used + "\n" + D.format_text(doc))], D.summary(doc)

    def t_tour_template(self, args):
        import argparse
        from .review import cli
        st = self.store(args.get("project"))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cli.cmd_tour_template(argparse.Namespace(project=st.project))
        doc = json.loads(buf.getvalue())
        return [_text(json.dumps(doc, indent=1))], doc

    def t_write_tour(self, args):
        from .review.schema import SCHEMA, SchemaError
        from .review.store import now
        st = self.store(args.get("project"))
        tour = args.get("tour")
        if not isinstance(tour, dict):
            raise ToolError("tour must be a JSON object with stops")
        if "decisions" in tour:
            raise ToolError("decisions belong to the reviewer: leave `decisions` out of the tour")
        doc = dict(tour)
        doc.setdefault("schema", SCHEMA)
        doc.setdefault("created", now())
        if doc.get("build") is None and "build" not in tour:
            doc["build"] = (st.current() or {}).get("build")
        try:
            path = st._write("tour.json", doc, "tour")
        except SchemaError as e:
            raise ToolError(f"tour not written: {e}")
        return [_text(f"wrote {path}: {len(doc['stops'])} stop(s); the reviewer accepts, rejects or repins each "
                      "one in the viewer")], dict(path=path, stops=len(doc["stops"]))

    def t_packet_image(self, args):
        st = self.store(args.get("project"))
        pk = st.packets()
        if args.get("packet"):
            pk = [p for p in pk if p["id"] == args["packet"]]
        if not pk:
            raise ToolError("no packet" + (f" {args['packet']}" if args.get("packet") else " sent yet"))
        img = pk[0]["screenshot"]
        if not os.path.exists(img):
            raise ToolError(f"packet {pk[0]['id']} has no view.png")
        with open(img, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        return [_text(f"packet {pk[0]['id']}: {img} (pins are numbered)"),
                dict(type="image", data=data, mimeType="image/png")], None

    # ---- resources
    def read_resource(self, uri):
        try:
            st = self.store()
        except ToolError as e:
            raise RpcError(RESOURCE_NOT_FOUND, "Resource not found", dict(uri=uri, reason=str(e)))
        if uri == "aad://review":
            from .review import cli
            return dict(uri=uri, mimeType="application/json", text=json.dumps(cli.status(st), indent=1))
        pk = st.packets()
        if uri in ("aad://packet/latest", "aad://packet/latest/view.png") and pk:
            if uri.endswith(".png"):
                if os.path.exists(pk[0]["screenshot"]):
                    with open(pk[0]["screenshot"], "rb") as fh:
                        return dict(uri=uri, mimeType="image/png", blob=base64.b64encode(fh.read()).decode())
            else:
                with open(pk[0]["packet"], encoding="utf-8") as fh:
                    return dict(uri=uri, mimeType="application/json", text=fh.read())
        raise RpcError(RESOURCE_NOT_FOUND, "Resource not found", dict(uri=uri))

    # ---- dispatch
    def handle(self, msg):
        """One JSON-RPC message (a dict). Returns the response dict, or None for a notification."""
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            return _error(msg.get("id") if isinstance(msg, dict) else None, INVALID_REQUEST, "Invalid Request")
        mid, method, params = msg.get("id"), msg["method"], msg.get("params") or {}
        is_note = "id" not in msg
        try:
            result = self.dispatch(method, params if isinstance(params, dict) else {})
        except RpcError as e:
            return None if is_note else _error(mid, e.code, e.message, e.data)
        except Exception as e:                    # a bug here must not kill the server
            return None if is_note else _error(mid, INTERNAL, f"Internal error: {type(e).__name__}: {e}")
        return None if is_note else dict(jsonrpc="2.0", id=mid, result=result)

    def dispatch(self, method, params):
        if method == "initialize":
            want = params.get("protocolVersion")
            self.protocol = want if want in SUPPORTED else PROTOCOL
            return dict(protocolVersion=self.protocol,
                        capabilities=dict(tools=dict(listChanged=False),
                                          resources=dict(subscribe=False, listChanged=False)),
                        serverInfo=dict(name="aad", title="aad (agent aided design) review", version=__version__),
                        instructions=INSTRUCTIONS)
        if method == "notifications/initialized":
            self.initialized = True
            return None
        if method.startswith("notifications/"):
            return None
        if method == "ping":
            return {}
        if method == "tools/list":
            return dict(tools=TOOLS)
        if method == "tools/call":
            return self.call_tool(params)
        if method == "resources/list":
            return dict(resources=RESOURCES)
        if method == "resources/templates/list":
            return dict(resourceTemplates=[])
        if method == "resources/read":
            uri = params.get("uri")
            if not isinstance(uri, str):
                raise RpcError(INVALID_PARAMS, "resources/read needs a uri")
            return dict(contents=[self.read_resource(uri)])
        raise RpcError(METHOD_NOT_FOUND, f"Method not found: {method}")

    def call_tool(self, params):
        name = params.get("name")
        fn = getattr(self, f"t_{name}", None) if isinstance(name, str) and any(t["name"] == name for t in TOOLS) \
            else None
        if fn is None:
            raise RpcError(INVALID_PARAMS, f"Unknown tool: {name}")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            raise RpcError(INVALID_PARAMS, "arguments must be an object")
        try:
            with contextlib.redirect_stdout(io.StringIO()):     # stdout is the protocol channel
                content, structured = fn(args)
        except ToolError as e:
            return dict(content=[_text(str(e))], isError=True)
        except Exception as e:
            return dict(content=[_text(f"{name} failed: {type(e).__name__}: {e}")], isError=True)
        out = dict(content=content, isError=False)
        if isinstance(structured, dict):
            out["structuredContent"] = structured
        return out


def _text(s):
    return dict(type="text", text=s)


def _error(mid, code, message, data=None):
    err = dict(code=code, message=message)
    if data is not None:
        err["data"] = data
    return dict(jsonrpc="2.0", id=mid, error=err)


def serve(project=None, stdin=None, stdout=None):
    """Read newline-delimited JSON-RPC from stdin until EOF; write one response line per request."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    srv = Server(project and os.path.abspath(os.path.expanduser(project)))
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            resp = _error(None, PARSE_ERROR, "Parse error")
        else:
            resp = (_error(None, INVALID_REQUEST, "Invalid Request: batches are not supported")
                    if isinstance(msg, list) else srv.handle(msg))
        if resp is not None:
            stdout.write(json.dumps(resp, separators=(",", ":")) + "\n")
            stdout.flush()
    return 0
