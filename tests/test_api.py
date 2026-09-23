import io

import pytest
from fastapi.testclient import TestClient

from backend import api
from backend.demo import create_demo


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.delenv('GRAPH_DATA_DIR', raising=False)
    monkeypatch.delenv('GRAPH_ACCESS_PASSWORD', raising=False)
    monkeypatch.setattr(api, 'ARTIFACTS', tmp_path / 'artifacts')
    monkeypatch.setattr(api, 'runs', {})
    with TestClient(api.app) as client:
        yield client


def test_analysis_search_graph_and_exports(client):
    initial = client.get('/api/initial').json()
    assert initial['summary']['synthetic'] is True
    base = '/api/runs/' + initial['run_id']
    rows = client.get(base + '/nodes').json()['items']
    isolate = next(n for n in rows if n['isolated'])
    gid = isolate['gid']
    found = client.get(base + '/nodes', params={'q': gid}).json()
    assert found['total'] == 1
    assert found['items'][0]['gid'] == gid
    graph = client.get(base + '/graph', params={'gid': gid}).json()
    assert graph['nodes'][0]['gid'] == gid and not graph['edges']
    assert client.get(base + '/nodes/' + gid).json()['transactions'] == []
    response = client.get(base + '/exports/nodes_roles.csv')
    assert response.status_code == 200 and gid in response.text
    assert response.headers['cache-control'] == 'no-store'
    assert client.get(base + '/exports/secret.txt').status_code == 404
    assert client.get(base + '/nodes/unknown').status_code == 404
    assert client.get(base + '/graph', params={'gid': gid, 'hops': 9}).status_code == 422


def test_upload_valid_and_invalid_files(client, tmp_path):
    source = create_demo(tmp_path / 'upload')
    files = {name: (name + '.parquet', io.BytesIO((source / (name + '.parquet')).read_bytes()), 'application/octet-stream')
             for name in ['nodes', 'edges', 'transactions']}
    response = client.post('/api/analyze', files=files)
    assert response.status_code == 200, response.text
    assert response.json()['summary']['node_count'] == 26
    invalid = {name: (name + '.parquet', b'not parquet') for name in files}
    response = client.post('/api/analyze', files=invalid)
    assert response.status_code == 422
    assert 'detail' in response.json()


def test_optional_authentication(client, monkeypatch):
    monkeypatch.setenv('GRAPH_ACCESS_PASSWORD', 'test-only-password')
    assert client.get('/api/initial').status_code == 401
    assert client.get('/api/initial', auth=('analyst', 'wrong')).status_code == 401
    assert client.get('/api/initial', auth=('analyst', 'test-only-password')).status_code == 200


def test_investigation_routes_and_report_download(client):
    run_id = client.get('/api/initial').json()['run_id']
    base = '/api/runs/' + run_id
    gid = client.get(base + '/nodes').json()['items'][0]['gid']
    account = base + '/nodes/' + gid
    data = client.get(account + '/investigation').json()
    assert data['gid'] == gid and data['paths']
    assert client.get(account + '/stability').json()['selected']['gid'] == gid
    assert client.get(account + '/assistant?topic=next').json()['mode'] == 'local_rules'
    assert client.get(account + '/assistant?topic=arbitrary').status_code == 422
    report = client.get(account + '/report?download=true')
    assert report.status_code == 200
    assert 'attachment;' in report.headers['content-disposition']
    assert 'text/html' in report.headers['content-type']
    assert gid in report.text
    for suffix in ['investigation', 'stability', 'assistant', 'report']:
        assert client.get(base + '/nodes/unknown/' + suffix).status_code == 404


def test_limited_graph_retains_intermediate_connections(client):
    import networkx as nx
    run_id = client.get('/api/initial').json()['run_id']
    base = '/api/runs/' + run_id
    for node in client.get(base + '/nodes').json()['items']:
        graph = client.get(base + '/graph', params={'gid': node['gid'], 'hops': 2, 'limit': 10}).json()
        assert len(graph['nodes']) <= 10
        observed = nx.Graph()
        observed.add_nodes_from(n['gid'] for n in graph['nodes'])
        observed.add_edges_from((e['source'], e['target']) for e in graph['edges'])
        assert nx.is_connected(observed)
