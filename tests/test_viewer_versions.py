import json
import threading
import urllib.error
import urllib.request

import pytest
from aad.viewer.server import Sources, Viewer, _bind, load_versions


def test_versions_have_independent_routes_and_default(tmp_path):
    entries=[]
    for i in (1, 2):
        (tmp_path/f'v{i}.stl').write_bytes(f'model-{i}'.encode())
        entries.append(dict(id=f'v{i}', label=f'Version {i}', paths=[f'v{i}.stl']))
    path=tmp_path/'versions.json'
    path.write_text(json.dumps(dict(default='v2',versions=entries)))
    default, versions=load_versions(path)
    server=_bind(default,0,versions)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    base=f'http://127.0.0.1:{server.server_port}'
    def get(path):
        with urllib.request.urlopen(base+path,timeout=3) as r:
            return r.read()
    try:
        assert json.loads(get('/models.json'))['version']=='v2'
        assert get('/v/v1/models/0')==b'model-1'
        assert get('/v/v2/models/0')==b'model-2'
        assert get('/models/0')==b'model-2' # Another tab cannot change the default.
        assert json.loads(get('/v/v1/models.json'))['version']=='v1'
        assert len(json.loads(get('/v/v2/models.json'))['versions'])==2
        assert json.loads(get('/v/v1/status.json'))['complete']
        assert b'id="version"' in get('/v/v1/')
        assert b'setupVersions' in get('/v/v1/view.js')
        with pytest.raises(urllib.error.HTTPError) as e:
            get('/v/missing/models/0')
        assert e.value.code==404
    finally:
        server.shutdown();server.server_close();thread.join()


def test_invalid_or_duplicate_version_ids_rejected(tmp_path):
    (tmp_path/'a.stl').write_bytes(b'mesh')
    path=tmp_path/'versions.json'
    for ids in [('a','a'),('..',),('a/b',)]:
        path.write_text(json.dumps(dict(default=ids[0],versions=[dict(id=i,paths=['a.stl']) for i in ids])))
        with pytest.raises(ValueError):
            load_versions(path)


def test_single_model_viewer_remains_unversioned(tmp_path):
    p=tmp_path/'a.stl';p.write_bytes(b'mesh')
    manifest=Viewer(Sources([str(p)])).manifest()
    assert manifest['versions']==[]
    assert manifest['version'] is None
    assert len(manifest['files'])==1
