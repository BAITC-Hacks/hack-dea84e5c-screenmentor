import networkx as nx
import pandas as pd
import pytest

from backend.demo import create_demo
from backend.engine import analyze
from backend.investigation import explain, investigate, stability, temporal_sequence
from backend.report import account_report

BASE = 100000000000000001


def graph_fixture(tmp_path, payments, seeds):
    folder = tmp_path / 'input'
    folder.mkdir()
    # Independent branch establishes an observation window through July 31.
    payments = payments + [(900, 901, 5000, 31)]
    seeds = seeds + [900]
    tx = pd.DataFrame([{'src': BASE+a, 'dst': BASE+b, 'sum_kzt': float(amount), 'date': pd.Timestamp(2026, 7, day)}
                       for a, b, amount, day in payments])
    graph = nx.DiGraph()
    graph.add_edges_from((int(t.src), int(t.dst)) for t in tx.itertuples())
    graph.add_nodes_from(BASE+s for s in seeds)
    distances = nx.multi_source_dijkstra_path_length(graph, [BASE+s for s in seeds], weight=None)
    nodes = pd.DataFrame([{'gid': gid, 'depth': distances[gid], 'is_seed': gid-BASE in seeds} for gid in sorted(graph)])
    edges = tx.groupby(['src', 'dst']).agg(sum_kzt=('sum_kzt', 'sum'), n_tx=('sum_kzt', 'size')).reset_index()
    edges['depth'] = edges.src.map(distances) + 1
    for name, frame in [('nodes', nodes), ('edges', edges), ('transactions', tx)]:
        frame.to_parquet(folder / (name + '.parquet'), index=False)
    return analyze(folder, tmp_path / 'output')


@pytest.mark.parametrize('in_day,out_day,status,role', [
    (2, 3, 'ordered', 'transit'),
    (2, 2, 'same_day_unknown', 'peripheral'),
    (3, 1, 'incompatible', 'peripheral'),
])
def test_chronology_and_transit_require_actual_order(tmp_path, in_day, out_day, status, role):
    run = graph_fixture(tmp_path, [(0, 10, 10000, in_day), (10, 20, 10000, out_day)], [0])
    node = next(n for n in run.nodes if n['gid'] == str(BASE+10))
    assert node['role'] == role
    investigation = investigate(run, str(BASE+20))
    path = investigation['paths'][0]
    assert path['gids'] == [str(BASE), str(BASE+10), str(BASE+20)]
    assert path['status'] == status
    expected_length = 0 if status == 'incompatible' else 2
    assert len(path['sequence']) == expected_length


def test_greedy_sequence_chooses_feasible_payments_not_just_first_row():
    groups = [[{'date': '2026-07-02', 'source_row': 1}, {'date': '2026-07-08', 'source_row': 2}],
              [{'date': '2026-07-01', 'source_row': 3}, {'date': '2026-07-04', 'source_row': 4}]]
    assert [t['source_row'] for t in temporal_sequence(groups)] == [1, 4]


def test_single_receipt_is_not_terminal(tmp_path):
    run = graph_fixture(tmp_path, [(0, 10, 10000, 2)], [0])
    node = next(n for n in run.nodes if n['gid'] == str(BASE+10))
    assert node['role'] == 'peripheral'


def test_repeated_receipts_can_support_terminal_hypothesis(tmp_path):
    run = graph_fixture(tmp_path, [(0, 10, 10000, 2), (1, 10, 10000, 4), (0, 10, 10000, 6)], [0, 1])
    node = next(n for n in run.nodes if n['gid'] == str(BASE+10))
    assert node['role'] == 'terminal'
    assert node['observation_days_after_last_in'] == 25


def test_many_receipts_then_small_outgoing_support_collection(tmp_path):
    run = graph_fixture(tmp_path, [(i, 10, 10000, 2) for i in range(8)] + [(10, 20, 5000, 4)], list(range(8)))
    assert next(n for n in run.nodes if n['gid'] == str(BASE+10))['role'] == 'consolidator'


def test_fan_out_supports_distribution(tmp_path):
    payments = [(0, 10, 1000000, 1)] + [(10, i, 10000, day) for i in range(20, 40) for day in [2, 5]]
    run = graph_fixture(tmp_path, payments, [0])
    assert next(n for n in run.nodes if n['gid'] == str(BASE+10))['role'] == 'distributor'


def test_evidence_timeline_and_paths_reference_real_rows(tmp_path):
    run = analyze(create_demo(tmp_path / 'demo'), tmp_path / 'output', synthetic=True)
    lookup = {t['id']: t for t in run.transactions}
    for node in run.nodes:
        data = investigate(run, node['gid'])
        assert len(data['paths']) <= 8
        assert data['evidence']['incoming']['count'] == node['in_tx']
        assert data['evidence']['outgoing']['count'] == node['out_tx']
        assert data['evidence']['lagged']['count'] == node['lagged_out_tx']
        assert sum(day['incoming'] for day in data['timeline']) == pytest.approx(node['in_kzt'])
        assert sum(day['outgoing'] for day in data['timeline']) == pytest.approx(node['out_kzt'])
        for path in data['paths']:
            assert len(set(path['gids'])) == len(path['gids'])
            assert all(lookup[t['id']] == t for t in path['operations'] + path['sequence'])
            assert [(e['source'], e['target']) for e in path['edges']] == list(zip(path['gids'], path['gids'][1:]))
            assert node['gid'] in path['gids']
        for pair in data['evidence']['lagged']['pairs']:
            assert all(1 <= (pd.Timestamp(pair['outgoing']['date'])-pd.Timestamp(t['date'])).days <= 2 for t in pair['possible_incoming'])


def test_stability_baselines_and_explanation_citations(tmp_path):
    run = analyze(create_demo(tmp_path / 'demo'), tmp_path / 'output')
    original = [dict(n) for n in run.nodes]
    top = run.nodes[0]
    report = stability(run, top['gid'])
    assert len(report['scenarios']) == 8
    assert report['selected']['min_rank'] <= top['rank'] <= report['selected']['max_rank']
    for scenario in report['scenarios']:
        assert sum(scenario['weights'].values()) == pytest.approx(1)
        assert len(scenario['top_gids']) == 20
        assert scenario['overlap_count'] == len(set(scenario['top_gids']) & {n['gid'] for n in run.nodes[:20]})
    assert run.nodes == original
    ids = {t['id'] for t in run.transactions}
    for topic in ['priority', 'role', 'next', 'chronology']:
        answer = explain(run, top['gid'], topic)
        assert answer['mode'] == 'local_rules'
        assert all(t['id'] in ids for t in answer['citations'])
    with pytest.raises(ValueError):
        explain(run, top['gid'], 'unsupported')


def test_report_escapes_user_metadata_and_preserves_sources(tmp_path):
    run = analyze(create_demo(tmp_path / 'demo'), tmp_path / 'output', label='<script>alert(1)</script>', synthetic=True)
    gid = run.nodes[0]['gid']
    report = account_report(run, gid)
    assert '<script>' not in report
    assert '&lt;script&gt;' in report
    assert 'СИНТЕТИЧЕСКИЕ ДАННЫЕ' in report
    assert gid in report and run.summary['hashes']['transactions'] in report
    assert '<svg' in report and 'Ctrl+P' in report
