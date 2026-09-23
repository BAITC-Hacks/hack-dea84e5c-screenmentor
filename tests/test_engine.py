import csv

import pandas as pd
import pytest

from backend.demo import create_demo
from backend.engine import DataError, SCHEMAS, analyze, validate


@pytest.fixture
def source(tmp_path):
    return create_demo(tmp_path / 'input')


def tables(source):
    return {name: pd.read_parquet(source / f'{name}.parquet') for name in SCHEMAS}


def test_exact_ids_isolates_boundary_and_exports(source, tmp_path):
    result = analyze(source, tmp_path / 'out')
    original = tables(source)
    expected = {str(gid) for gid in original['nodes'].gid}
    assert {n['gid'] for n in result.nodes} == expected
    assert all(isinstance(n['gid'], str) for n in result.nodes)
    assert all(t['src'] in expected and t['dst'] in expected for t in result.transactions)
    isolates = [n for n in result.nodes if n['isolated']]
    assert len(isolates) == 1
    assert isolates[0]['priority_score'] == 0
    boundary = [n for n in result.nodes if n['truncated_by_depth']]
    assert len(boundary) == 15
    assert all(n['role'] != 'terminal' for n in boundary)
    assert all(len(n['evidence']) <= 200 for n in result.nodes)
    assert all(0 <= n['role_score'] <= 1 and 0 <= n['priority_score'] <= 1 for n in result.nodes)
    with (tmp_path / 'out' / 'nodes_roles.csv').open(encoding='utf-8', newline='') as file:
        assert {r['gid'] for r in csv.DictReader(file)} == expected
    with (tmp_path / 'out' / 'top_nodes.csv').open(encoding='utf-8', newline='') as file:
        assert len(list(csv.DictReader(file))) >= 20
    assert sum(c['n_nodes'] for c in result.clusters) == len(expected)


def test_repeated_payments_are_preserved(source, tmp_path):
    data = tables(source)
    row = data['transactions'].iloc[[0]]
    data['transactions'] = pd.concat([data['transactions'], row], ignore_index=True)
    src, dst = int(row.src.iloc[0]), int(row.dst.iloc[0])
    pair = (data['edges'].src == src) & (data['edges'].dst == dst)
    data['edges'].loc[pair, 'n_tx'] += 1
    data['edges'].loc[pair, 'sum_kzt'] += float(row.sum_kzt.iloc[0])
    for name, frame in data.items():
        frame.to_parquet(source / f'{name}.parquet', index=False)
    result = analyze(source, tmp_path / 'out')
    assert len(result.transactions) == len(data['transactions'])
    assert len({r['id'] for r in result.transactions}) == len(result.transactions)
    assert result.summary['warnings'][0].startswith('1 ')


@pytest.mark.parametrize('mutation', ['sum', 'count', 'float_id', 'unknown_id', 'nan', 'duplicate_gid'])
def test_invalid_data_is_rejected(source, mutation):
    data = tables(source)
    if mutation == 'sum':
        data['edges'].loc[0, 'sum_kzt'] += .01
    elif mutation == 'count':
        data['edges'].loc[0, 'n_tx'] += 1
    elif mutation == 'float_id':
        data['nodes']['gid'] = data['nodes'].gid.astype(float)
    elif mutation == 'unknown_id':
        data['transactions'].loc[0, 'dst'] = 999
    elif mutation == 'nan':
        data['transactions'].loc[0, 'sum_kzt'] = float('nan')
    else:
        data['nodes'].loc[1, 'gid'] = data['nodes'].gid.iloc[0]
    with pytest.raises(DataError):
        validate(data)


def test_scores_and_clusters_do_not_depend_on_input_row_order(source, tmp_path):
    first = analyze(source, tmp_path / 'first')
    for name, frame in tables(source).items():
        frame.sample(frac=1, random_state=7).to_parquet(source / f'{name}.parquet', index=False)
    second = analyze(source, tmp_path / 'second')
    assert first.nodes == second.nodes
    assert first.clusters == second.clusters
    for name in ['nodes_roles.csv', 'clusters.csv', 'top_nodes.csv']:
        assert (tmp_path / 'first' / name).read_bytes() == (tmp_path / 'second' / name).read_bytes()


def test_dataset_with_only_isolated_seed_is_supported(tmp_path):
    source = tmp_path / 'input'
    source.mkdir()
    pd.DataFrame({'gid': [100000000000000001], 'depth': [0], 'is_seed': [True]}).to_parquet(source / 'nodes.parquet')
    pd.DataFrame({k: pd.Series(dtype=v) for k, v in {'src': 'int64', 'dst': 'int64', 'sum_kzt': 'float64', 'n_tx': 'int64', 'depth': 'int64'}.items()}).to_parquet(source / 'edges.parquet')
    pd.DataFrame({k: pd.Series(dtype=v) for k, v in {'src': 'int64', 'dst': 'int64', 'sum_kzt': 'float64', 'date': 'datetime64[ns]'}.items()}).to_parquet(source / 'transactions.parquet')
    result = analyze(source, tmp_path / 'out')
    assert result.summary['isolate_count'] == 1
    assert result.summary['transaction_count'] == 0
    assert result.nodes[0]['role'] == 'peripheral'
