"""JSON Schema validation for every .cadreview file (schemas/*.schema.json, draft 2020-12 subset).

A small validator is built in so aad needs no extra dependency: type, enum, const, required, properties,
additionalProperties, items, minItems, maxItems, minimum, maximum, minLength, pattern, anyOf, oneOf and local
$ref ("#/$defs/name" or "<file>.schema.json#/$defs/name"). validate(doc, "pin") raises SchemaError listing
every problem with its JSON path.
"""
import functools
import json
import os
import re

SCHEMA = "cadreview/1"
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schemas")
NAMES = ("pin", "pins", "scope", "packet", "tour", "diff", "baseline")


class SchemaError(ValueError):
    def __init__(self, name, problems):
        self.problems = problems
        super().__init__(f"{name} does not match its schema: " + "; ".join(problems[:8])
                         + (f" (+{len(problems) - 8} more)" if len(problems) > 8 else ""))


@functools.lru_cache(maxsize=None)
def load(name):
    with open(os.path.join(HERE, f"{name}.schema.json")) as fh:
        return json.load(fh)


TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def _is(t, x):
    if t == "integer":
        return isinstance(x, int) and not isinstance(x, bool)
    if t == "number":
        return isinstance(x, (int, float)) and not isinstance(x, bool)
    return isinstance(x, TYPES[t])


def _resolve(ref, root):
    file, _, frag = ref.partition("#")
    doc = load(file.replace(".schema.json", "")) if file else root
    node = doc
    for seg in [s for s in frag.split("/") if s]:
        node = node[seg]
    return node, doc


def _check(s, x, path, root, out):
    if s is True or s == {}:
        return
    if s is False:
        out.append(f"{path}: not allowed")
        return
    if "$ref" in s:
        sub, doc = _resolve(s["$ref"], root)
        _check(sub, x, path, doc, out)
    t = s.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_is(k, x) for k in ts):
            out.append(f"{path}: expected {'/'.join(ts)}, got {type(x).__name__}")
            return
    if "const" in s and x != s["const"]:
        out.append(f"{path}: must be {s['const']!r}")
    if "enum" in s and x not in s["enum"]:
        out.append(f"{path}: {x!r} not one of {s['enum']}")
    if isinstance(x, str):
        if "minLength" in s and len(x) < s["minLength"]:
            out.append(f"{path}: shorter than {s['minLength']}")
        if "pattern" in s and not re.search(s["pattern"], x):
            out.append(f"{path}: does not match {s['pattern']}")
    if _is("number", x):
        if "minimum" in s and x < s["minimum"]:
            out.append(f"{path}: below {s['minimum']}")
        if "maximum" in s and x > s["maximum"]:
            out.append(f"{path}: above {s['maximum']}")
    if isinstance(x, list):
        if "minItems" in s and len(x) < s["minItems"]:
            out.append(f"{path}: fewer than {s['minItems']} items")
        if "maxItems" in s and len(x) > s["maxItems"]:
            out.append(f"{path}: more than {s['maxItems']} items")
        if "items" in s:
            for i, v in enumerate(x):
                _check(s["items"], v, f"{path}[{i}]", root, out)
    if isinstance(x, dict):
        for k in s.get("required", []):
            if k not in x:
                out.append(f"{path}: missing {k!r}")
        props = s.get("properties", {})
        for k, v in x.items():
            if k in props:
                _check(props[k], v, f"{path}.{k}", root, out)
            elif "additionalProperties" in s:
                _check(s["additionalProperties"], v, f"{path}.{k}", root, out)
    for key in ("anyOf", "oneOf"):
        if key in s:
            ok = 0
            for sub in s[key]:
                tmp = []
                _check(sub, x, path, root, tmp)
                ok += not tmp
            if (key == "anyOf" and ok == 0) or (key == "oneOf" and ok != 1):
                out.append(f"{path}: matches {ok} of the {key} alternatives")


def problems(doc, name):
    out = []
    root = load(name)
    _check(root, doc, "$", root, out)
    return out


def validate(doc, name):
    p = problems(doc, name)
    if p:
        raise SchemaError(name, p)
    return doc
