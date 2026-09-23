"""Small, explicitly synthetic dataset. No organizer data is bundled."""
from pathlib import Path
import networkx as nx
import pandas as pd


def create_demo(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    base = 100000000000000001
    payments = []
    def add(a, b, amount, day):
        payments.append(dict(src=base+a, dst=base+b, sum_kzt=float(amount), date=pd.Timestamp(2026, 7, day)))
    for seed in [0, 1, 2]:
        for day in [2, 8, 15]:
            add(seed, 10, 80000 + seed * 10000, day)
    for day in [3, 9, 16]:
        add(10, 11, 220000, day)
        add(11, 12, 210000, day+1)
        for leaf in range(100, 115):
            add(12, leaf, 12000, day+2)
    add(0, 20, 190000, 4)
    add(1, 20, 210000, 8)
    add(2, 20, 170000, 12)
    add(1, 30, 70000, 5)
    add(30, 31, 40000, 6)
    add(31, 30, 30000, 7)
    add(2, 40, 85000, 31)
    frame = pd.DataFrame(payments)
    G = nx.from_pandas_edgelist(frame, 'src', 'dst', create_using=nx.DiGraph)
    seed_ids = [base, base+1, base+2, base+999]
    G.add_nodes_from(seed_ids)
    distances = nx.multi_source_dijkstra_path_length(G, seed_ids, weight=None)
    nodes = pd.DataFrame([dict(gid=gid, depth=distances[gid], is_seed=gid in seed_ids) for gid in sorted(G)])
    edges = frame.groupby(['src', 'dst']).agg(sum_kzt=('sum_kzt', 'sum'), n_tx=('sum_kzt', 'size')).reset_index()
    edges['depth'] = edges.src.map(distances) + 1
    for name, table in [('nodes', nodes), ('edges', edges), ('transactions', frame)]:
        table.to_parquet(path / f'{name}.parquet', index=False)
    return path
