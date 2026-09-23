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
    excel = client.get(base + '/exports/results.xlsx')
    assert excel.status_code == 200 and excel.content.startswith(b'PK')
    assert excel.headers['content-type'] == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'results.xlsx' in excel.headers['content-disposition']
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


def test_restore_run_metadata_and_missing_run(client):
    initial = client.get('/api/initial').json()
    assert client.get('/api/runs/' + initial['run_id']).json() == initial
    assert client.get('/api/runs/missing-run').status_code == 404


def test_guided_demo_is_cached_and_does_not_replace_working_run(client, tmp_path, monkeypatch):
    # Model a server started with a case, distinct from the synthetic training run.
    original_id = api.new_run(create_demo(tmp_path / 'case-input'), 'Working case', False)
    monkeypatch.setattr(api, 'initial_id', original_id)
    original = client.get('/api/initial').json()
    before = {name: client.get(f'/api/runs/{original_id}/exports/{name}').content
              for name in ['nodes_roles.csv', 'clusters.csv', 'top_nodes.csv']}
    demo = client.get('/api/demo').json()
    assert demo['summary']['synthetic'] is True
    assert demo['run_id'] != original_id
    assert client.get('/api/demo').json() == demo
    assert client.get('/api/initial').json() == original
    for name, content in before.items():
        assert client.get(f'/api/runs/{original_id}/exports/{name}').content == content


def test_public_access_ignores_legacy_password(client, monkeypatch):
    monkeypatch.setenv('GRAPH_ACCESS_PASSWORD', 'test-only-password')
    for path in ('/', '/api/health', '/api/initial', '/static/guide.html'):
        response = client.get(path)
        assert response.status_code == 200
        assert 'www-authenticate' not in response.headers
        assert response.headers['x-content-type-options'] == 'nosniff'
    assert client.get('/api/initial', auth=('analyst', 'old-password')).status_code == 200


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


@pytest.mark.parametrize('direction', ['incoming', 'outgoing'])
@pytest.mark.parametrize('hops', [1, 2])
def test_directional_graph_follows_payment_arrows_before_limiting(client, direction, hops):
    import networkx as nx
    run_id = client.get('/api/initial').json()['run_id']
    run = api.get_run(run_id)
    original = nx.DiGraph()
    original.add_nodes_from(n['gid'] for n in run.nodes)
    original.add_edges_from((e['source'], e['target']) for e in run.edges)
    traversal = original.reverse() if direction == 'incoming' else original
    for gid in original:
        expected = set(nx.single_source_shortest_path_length(traversal, gid, cutoff=hops))
        for limit in [10, 400]:
            response = client.get(f'/api/runs/{run_id}/graph', params={'gid': gid, 'direction': direction, 'hops': hops, 'limit': limit})
            assert response.status_code == 200
            graph = response.json()
            shown = {n['gid'] for n in graph['nodes']}
            assert graph['eligible'] == len(expected)
            assert graph['hidden'] == len(expected) - len(shown)
            assert shown <= expected and len(shown) <= limit
            if limit == 400:
                assert shown == expected
            observed = nx.DiGraph()
            observed.add_nodes_from(shown)
            observed.add_edges_from((e['source'], e['target']) for e in graph['edges'])
            if direction == 'incoming':
                observed = observed.reverse()
            assert set(nx.single_source_shortest_path_length(observed, gid, cutoff=hops)) == shown
            if hops == 1:
                assert all(e['target' if direction == 'incoming' else 'source'] == gid for e in graph['edges'])
    assert client.get(f'/api/runs/{run_id}/graph', params={'gid': gid, 'direction': 'wrong'}).status_code == 422
