"""Minimal binary glTF (GLB) mesh reader and writer, numpy only.

read_parts(path) returns one Part per mesh-carrying node: the node name (unique, " #2" suffixes in file order like
the viewer), world-space float64 vertices (node transforms applied through the hierarchy) and int64 triangles.
All triangle primitives of a node are merged. Supported: float32 POSITION, u8/u16/u32 indices or none, node
matrix or TRS. Not supported (raises GLBError): sparse accessors, quantized or Draco-compressed positions.

write_parts(path, parts) writes a GLB with one node and one mesh per part (identity transforms, optional
per-part RGB colour, or RGBA where an alpha below 1 writes a blended, clear material), which is what the demo
fixture and the tests use.
"""
import json
import struct
from dataclasses import dataclass, field

import numpy as np

GLB_MAGIC = b"glTF"
CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class GLBError(ValueError):
    pass


@dataclass
class Part:
    name: str
    vertices: np.ndarray            # (n, 3) float64, world mm
    triangles: np.ndarray           # (m, 3) int64
    index: int = 0                  # order in the file
    extras: dict = field(default_factory=dict)
    matrix: np.ndarray = None       # (4, 4) node-to-world transform (None: identity, e.g. STL)


def _load(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 20 or data[:4] != GLB_MAGIC:
        raise GLBError(f"not a GLB file: {path}")
    _magic, _ver, length = struct.unpack("<4sII", data[:12])
    if length != len(data):
        raise GLBError(f"GLB length {length} != file size {len(data)} (file still being written?): {path}")
    off, js, binary = 12, None, b""
    while off < len(data):
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        chunk = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        elif ctype == 0x004E4942:
            binary = chunk
        off += 8 + clen
    if js is None:
        raise GLBError(f"GLB without a JSON chunk: {path}")
    return js, binary


def _accessor(js, binary, idx):
    a = js["accessors"][idx]
    if "sparse" in a:
        raise GLBError("sparse accessors are not supported")
    dt = CT.get(a["componentType"])
    if dt is None:
        raise GLBError(f"unsupported componentType {a['componentType']}")
    nc, count = NCOMP[a["type"]], a["count"]
    if "bufferView" not in a:
        return np.zeros((count, nc), dtype=dt)
    bv = js["bufferViews"][a["bufferView"]]
    if bv.get("buffer", 0) != 0:
        raise GLBError("external buffers are not supported")
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    item = np.dtype(dt).itemsize * nc
    stride = bv.get("byteStride") or item
    if stride == item:
        arr = np.frombuffer(binary, dtype=dt, count=count * nc, offset=start).reshape(count, nc)
    else:
        raw = np.frombuffer(binary, dtype=np.uint8, count=stride * (count - 1) + item, offset=start)
        idx = (np.arange(count)[:, None] * stride + np.arange(item)[None, :])
        arr = raw[idx].copy().view(dt).reshape(count, nc)
    return arr


def _node_matrix(n):
    if "matrix" in n:
        return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    t = n.get("translation", [0, 0, 0])
    q = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    x, y, z, w = q
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m[:3, :3] = r * np.array(s)[None, :]
    m[:3, 3] = t
    return m


def read_parts(path):
    """Mesh nodes of a GLB as Part objects (world coordinates), in node order."""
    js, binary = _load(path)
    nodes = js.get("nodes", [])
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    cache = {}

    def world(i):
        if i not in cache:
            m = _node_matrix(nodes[i])
            cache[i] = world(parent[i]) @ m if i in parent else m
        return cache[i]

    parts, names = [], {}
    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        mesh = js["meshes"][n["mesh"]]
        vs, ts, base = [], [], 0
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                continue
            if "extensions" in prim and "KHR_draco_mesh_compression" in prim["extensions"]:
                raise GLBError("Draco-compressed meshes are not supported")
            pa = js["accessors"][prim["attributes"]["POSITION"]]
            if pa["componentType"] != 5126:
                raise GLBError("quantized POSITION accessors are not supported")
            v = _accessor(js, binary, prim["attributes"]["POSITION"]).astype(np.float64)
            if "indices" in prim:
                t = _accessor(js, binary, prim["indices"]).astype(np.int64).reshape(-1, 3)
            else:
                t = np.arange(len(v), dtype=np.int64).reshape(-1, 3)
            vs.append(v)
            ts.append(t + base)
            base += len(v)
        if not vs:
            continue
        v = np.concatenate(vs)
        m = world(i)
        v = v @ m[:3, :3].T + m[:3, 3]
        t = np.concatenate(ts)
        if np.linalg.det(m[:3, :3]) < 0:          # mirrored node: keep outward winding
            t = t[:, [0, 2, 1]]
        nm = n.get("name") or mesh.get("name") or f"node{i}"
        k, j = nm, 2
        while k in names:
            k, j = f"{nm} #{j}", j + 1
        names[k] = True
        parts.append(Part(name=k, vertices=v, triangles=t, index=len(parts), extras=n.get("extras") or {}, matrix=m))
    return parts


def write_parts(path, parts):
    """Write {name: (vertices, triangles[, rgb])} (or a list of Part) as a GLB, one node per part."""
    items = []
    if isinstance(parts, dict):
        for name, val in parts.items():
            v, t = val[0], val[1]
            rgb = val[2] if len(val) > 2 else None
            items.append((name, np.asarray(v, np.float32), np.asarray(t, np.uint32), rgb))
    else:
        for p in parts:
            items.append((p.name, np.asarray(p.vertices, np.float32), np.asarray(p.triangles, np.uint32), None))
    blob = bytearray()
    js = dict(asset=dict(version="2.0", generator="aad.review.glb"), scene=0, scenes=[dict(nodes=[])],
              nodes=[], meshes=[], accessors=[], bufferViews=[], buffers=[], materials=[])
    for name, v, t, rgb in items:
        def view(arr, target):
            while len(blob) % 4:
                blob.append(0)
            off = len(blob)
            blob.extend(arr.tobytes())
            js["bufferViews"].append(dict(buffer=0, byteOffset=off, byteLength=arr.nbytes, target=target))
            return len(js["bufferViews"]) - 1
        pv = view(v, 34962)
        js["accessors"].append(dict(bufferView=pv, componentType=5126, count=len(v), type="VEC3",
                                    min=v.min(0).tolist(), max=v.max(0).tolist()))
        pa = len(js["accessors"]) - 1
        iv = view(t.reshape(-1), 34963)
        js["accessors"].append(dict(bufferView=iv, componentType=5125, count=int(t.size), type="SCALAR"))
        ia = len(js["accessors"]) - 1
        prim = dict(attributes=dict(POSITION=pa), indices=ia, mode=4)
        if rgb is not None:
            rgba = [*rgb, 1.0] if len(rgb) == 3 else list(rgb)
            mat = dict(pbrMetallicRoughness=dict(baseColorFactor=rgba, metallicFactor=0.1, roughnessFactor=0.6),
                       name=name)
            if rgba[3] < 1:                         # a clear part (alpha below 1): blended, both sides drawn
                mat.update(alphaMode="BLEND", doubleSided=True)
            js["materials"].append(mat)
            prim["material"] = len(js["materials"]) - 1
        js["meshes"].append(dict(name=name, primitives=[prim]))
        js["nodes"].append(dict(name=name, mesh=len(js["meshes"]) - 1))
        js["scenes"][0]["nodes"].append(len(js["nodes"]) - 1)
    while len(blob) % 4:
        blob.append(0)
    js["buffers"].append(dict(byteLength=len(blob)))
    if not js["materials"]:
        del js["materials"]
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)
    total = 12 + 8 + len(jb) + 8 + len(blob)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", GLB_MAGIC, 2, total))
        fh.write(struct.pack("<II", len(jb), 0x4E4F534A) + jb)
        fh.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))
    return path
