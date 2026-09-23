from __future__ import annotations

import hashlib
import json
import math
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

ROLE_LABELS = {
    'consolidator': 'Сбор средств', 'transit': 'Транзит',
    'distributor': 'Распределение', 'terminal': 'Конечный получатель · гипотеза',
    'coordinator': 'Связующее звено', 'peripheral': 'Недостаточно признаков',
}
METHOD_VERSION = '1.0.0'
SCHEMAS = {
    'nodes': ['gid', 'depth', 'is_seed'],
    'edges': ['src', 'dst', 'sum_kzt', 'n_tx', 'depth'],
    'transactions': ['src', 'dst', 'date', 'sum_kzt'],
}


class DataError(ValueError):
    pass


def money(value):
    return f'{value:,.2f}'.replace(',', ' ').replace('.', ',') + ' ₸'


def validate(tables):
    for name, columns in SCHEMAS.items():
        frame = tables[name]
        missing = set(columns) - set(frame.columns)
        if missing:
            raise DataError(f'{name}: отсутствуют поля {", ".join(sorted(missing))}')
        if frame[columns].isna().any().any():
            raise DataError(f'{name}: обязательные поля содержат пропуски')
        for col in ['gid', 'src', 'dst', 'depth', 'n_tx']:
            if col in columns and (not pd.api.types.is_integer_dtype(frame[col]) or (frame[col] < 0).any()):
                raise DataError(f'{name}.{col}: нужны неотрицательные целые числа, без float')
        if 'sum_kzt' in columns:
            values = frame.sum_kzt
            if not pd.api.types.is_numeric_dtype(values) or not np.isfinite(values).all() or (values < 0).any():
                raise DataError(f'{name}.sum_kzt: нужны конечные неотрицательные суммы')
            if values.sum() > 9e13 or (np.abs(values * 100 - np.rint(values * 100)) > 1e-5).any():
                raise DataError(f'{name}.sum_kzt: сумма превышает лимит или содержит доли тиына')
    nodes, edges, tx = (tables[k] for k in SCHEMAS)
    if len(nodes) == 0 or len(nodes) > 20000 or len(tx) > 200000 or len(edges) > 100000:
        raise DataError('Размер набора вне лимитов прототипа: 1–20 000 узлов, до 100 000 рёбер и 200 000 операций')
    if not pd.api.types.is_bool_dtype(nodes.is_seed):
        raise DataError('nodes.is_seed: нужен логический тип bool')
    if not nodes.gid.is_unique or edges.duplicated(['src', 'dst']).any():
        raise DataError('Повторяющиеся gid или агрегированные пары рёбер')
    if (nodes.is_seed != (nodes.depth == 0)).any() or (nodes.depth > 4).any():
        raise DataError('Глубины nodes должны быть 0–4, а seed соответствует depth=0')
    if len(edges) and ((edges.n_tx <= 0).any() or (~edges.depth.between(1, 4)).any()):
        raise DataError('edges: n_tx должен быть положительным, depth — от 1 до 4')
    ids = set(nodes.gid)
    for name in ['edges', 'transactions']:
        frame = tables[name]
        if (set(frame.src) | set(frame.dst)) - ids:
            raise DataError(f'{name}: ссылка на счёт, отсутствующий в nodes')
    try:
        tx['date'] = pd.to_datetime(tx.date, errors='raise')
    except Exception as exc:
        raise DataError('transactions.date: невозможно прочитать даты') from exc
    if tx.date.isna().any():
        raise DataError('transactions.date: недопустимые даты')
    if tx.date.dt.tz is not None:
        raise DataError('Укажите даты без часового пояса в согласованной временной зоне набора')
    # Repeated individual payments are intentionally preserved.
    tx['_tiyn'] = np.rint(tx.sum_kzt * 100).astype('int64')
    edges['_tiyn'] = np.rint(edges.sum_kzt * 100).astype('int64')
    agg = tx.groupby(['src', 'dst']).agg(amount=('_tiyn', 'sum'), count=('_tiyn', 'size')).reset_index()
    joined = edges.merge(agg, on=['src', 'dst'], how='outer', indicator=True)
    if not (joined['_merge'] == 'both').all():
        raise DataError('edges и transactions содержат разные пары счетов')
    if not ((joined['_tiyn'] == joined.amount) & (joined.n_tx == joined['count'])).all():
        raise DataError('Суммы или количество операций edges не совпадают с transactions')


@dataclass
class Result:
    summary: dict
    nodes: list[dict]
    edges: list[dict]
    transactions: list[dict]
    clusters: list[dict]
    output_dir: Path


def analyze(data_dir: Path, output_dir: Path, label='Загруженный набор', synthetic=False):
    started = time.perf_counter()
    tables, hashes = {}, {}
    for name in SCHEMAS:
        path = data_dir / f'{name}.parquet'
        if not path.is_file():
            raise DataError(f'Не найден {name}.parquet')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        try:
            tables[name] = pd.read_parquet(path)
        except Exception as exc:
            raise DataError(f'Не удалось прочитать {name}.parquet') from exc
    validate(tables)
    nodes, edges, tx = (tables[k] for k in SCHEMAS)
    duplicate_count = int(tx[SCHEMAS['transactions']].duplicated().sum())
    tx['source_row'] = np.arange(1, len(tx) + 1)
    nodes = nodes.sort_values('gid')
    edges = edges.sort_values(['src', 'dst'])
    tx = tx.sort_values(['date', 'src', 'dst', 'sum_kzt', 'source_row'])
    G, UG = nx.DiGraph(), nx.Graph()
    for row in nodes.itertuples(index=False):
        G.add_node(int(row.gid), depth=int(row.depth), is_seed=bool(row.is_seed))
        UG.add_node(int(row.gid))
    for row in edges.itertuples(index=False):
        G.add_edge(int(row.src), int(row.dst), sum_kzt=float(row.sum_kzt), n_tx=int(row.n_tx))
        if row.src != row.dst and row.sum_kzt > 0:
            old = UG[row.src][row.dst]['weight'] if UG.has_edge(row.src, row.dst) else 0
            UG.add_edge(int(row.src), int(row.dst), weight=old + float(row.sum_kzt))
    seeds = sorted(n for n, a in G.nodes(data=True) if a['is_seed'])
    distances = nx.multi_source_dijkstra_path_length(G, seeds, weight=None) if seeds else {}
    depth_mismatches = sum(distances.get(n) != a['depth'] for n, a in G.nodes(data=True))
    communities = nx.community.louvain_communities(UG, weight='weight', seed=42) if UG.size(weight='weight') > 0 else [{n} for n in UG]
    communities = sorted(communities, key=lambda c: min(c))
    membership = {n: cid for cid, group in enumerate(communities) for n in group}
    pr = nx.pagerank(G, weight='sum_kzt', max_iter=500) if G.number_of_edges() else {n: 1 / len(G) for n in G}
    # Amount is not a path length: intermediary importance is unweighted.
    between = nx.betweenness_centrality(G, k=min(32, len(G)), weight=None, seed=42)
    reaches = Counter()
    for seed in seeds:
        reaches.update(nx.descendants(G, seed) | {seed})
    incoming_days, outgoing_days, out_records = defaultdict(set), defaultdict(set), defaultdict(list)
    last_in, last_out = {}, {}
    transactions = []
    for row in tx.itertuples(index=False):
        day = row.date.normalize()
        incoming_days[row.dst].add(day)
        outgoing_days[row.src].add(day)
        out_records[row.src].append(day)
        last_in[row.dst] = max(last_in.get(row.dst, day), day)
        last_out[row.src] = max(last_out.get(row.src, day), day)
        transactions.append({'id': f'tx:{hashes["transactions"][:10]}:{row.source_row}',
            'source_file': 'transactions.parquet', 'source_row': int(row.source_row),
            'src': str(row.src), 'dst': str(row.dst), 'date': row.date.strftime('%Y-%m-%d'), 'sum_kzt': float(row.sum_kzt)})
    period_end = tx.date.max().normalize() if len(tx) else None
    rows = []
    for gid, attrs in G.nodes(data=True):
        indeg, outdeg = G.in_degree(gid), G.out_degree(gid)
        ink, outk = G.in_degree(gid, weight='sum_kzt'), G.out_degree(gid, weight='sum_kzt')
        intx, outtx = G.in_degree(gid, weight='n_tx'), G.out_degree(gid, weight='n_tx')
        ratio = outk / ink if ink > 0 else None
        truncated = attrs['depth'] == 4 and outdeg == 0
        isolated = indeg == outdeg == 0
        lagged = sum(any(day - pd.Timedelta(days=lag) in incoming_days[gid] for lag in (1, 2)) for day in out_records[gid])
        adjacent = set(G.predecessors(gid)) | set(G.successors(gid))
        cross = len({membership[n] for n in adjacent} - {membership[gid]})
        tail = period_end is not None and gid in last_in and (period_end - last_in[gid]).days < 2
        rows.append(dict(gid=gid, depth=attrs['depth'], is_seed=attrs['is_seed'], in_deg=indeg, out_deg=outdeg,
            in_kzt=float(ink), out_kzt=float(outk), in_tx=int(intx), out_tx=int(outtx), pass_through=ratio,
            pagerank=float(pr[gid]), betweenness=float(between[gid]), seed_branches=int(reaches[gid]),
            cluster_id=membership[gid], cross_communities=cross, truncated_by_depth=truncated, isolated=isolated,
            near_period_end=bool(tail), lagged_out_tx=lagged, active_out_days=len(outgoing_days[gid])))
    frame = pd.DataFrame(rows).set_index('gid')
    for column in ['pagerank', 'betweenness']:
        # Zero structural evidence must remain zero, even when many nodes tie.
        frame[column + '_pct'] = frame[column].rank(pct=True, method='average').where(frame[column] > 0, 0)
    turnover = frame.in_kzt + frame.out_kzt
    flow_pct = turnover.rank(pct=True, method='average').where(turnover > 0, 0)
    records = []
    for gid in frame.index:
        f = frame.loc[gid].to_dict()  # gid is obtained from the exact integer index, never from a mixed numeric row.
        scores = {r: 0.0 for r in ROLE_LABELS if r != 'peripheral'}
        if f['in_deg'] >= 3:
            scores['consolidator'] = .55 * min(f['in_deg'] / 12, 1) + .3 * min(f['seed_branches'] / 5, 1) + .15 * min(f['in_tx'] / 24, 1)
        if f['out_deg'] >= 5:
            scores['distributor'] = .7 * min(f['out_deg'] / 25, 1) + .3 * min(f['out_tx'] / 40, 1)
        ratio = f['pass_through']
        if not f['is_seed'] and f['in_deg'] and f['out_deg'] and pd.notna(ratio) and .5 <= ratio <= 1.5:
            balance = max(0, 1 - abs(ratio - 1) / .5)
            scores['transit'] = .45 * balance + .35 * min(f['lagged_out_tx'] / max(f['out_tx'], 1) / .5, 1) + .2 * min(f['active_out_days'] / 3, 1)
        if f['in_deg'] > 0 and f['out_deg'] == 0 and not f['truncated_by_depth']:
            scores['terminal'] = .35 + .3 * min(f['in_deg'] / 5, 1) + .15 * min(f['in_tx'] / 10, 1) + (.2 if not f['near_period_end'] else 0)
        if f['seed_branches'] >= 2 and f['cross_communities'] >= 2 and f['betweenness_pct'] >= .75 and f['out_deg']:
            scores['coordinator'] = .5 * f['betweenness_pct'] + .3 * min(f['seed_branches'] / 5, 1) + .2 * min(f['cross_communities'] / 4, 1)
        ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        role, strength = ordered[0]
        if strength < .5:
            role, strength = 'peripheral', 0.0
        contributions = {
            'structure': .35 * (.6 * f['pagerank_pct'] + .4 * f['betweenness_pct']),
            'seed_branches': .30 * min(f['seed_branches'] / 5, 1),
            'observed_flow': .20 * float(flow_pct.loc[gid]), 'role_signals': .15 * strength,
        }
        if f['isolated']:
            contributions = {k: 0.0 for k in contributions}
        priority = sum(contributions.values())
        limitations = ['Только внутрибанковские переводы от 5 000 ₸; входящие вне выборки и остатки неизвестны.']
        next_checks = []
        if f['truncated_by_depth']:
            limitations.append('Граница 4-го колена: исходящие не наблюдаются. Это не доказательство накопления средств.')
            next_checks.append('Запросить продолжение исходящих переводов за пределами четвёртого колена.')
        if f['isolated']:
            limitations.append('В реестре есть счёт, но в выгрузке нет ни одной его операции.')
            next_checks.append('Уточнить полноту выгрузки и операции счёта за другие периоды.')
        if f['is_seed'] or f['out_kzt'] > f['in_kzt']:
            limitations.append('Наблюдаемые входящие неполны; out/in не является оценкой баланса.')
            next_checks.append('Запросить полный входящий поток, включая источники за пределами выборки.')
        if f['near_period_end']:
            limitations.append('Последнее поступление близко к концу периода; последующее движение может не попасть в выгрузку.')
            next_checks.append('Запросить операции после последней даты периода.')
        if role == 'transit':
            limitations.append('Близость по календарным дням не доказывает передачу тех же денежных средств.')
        if not next_checks:
            next_checks.append('Проверить назначение наблюдаемых операций и возможное законное объяснение структуры переводов.')
        reason = f'{ROLE_LABELS[role]}. Вход: {f["in_deg"]} контр., {f["in_tx"]} оп.; выход: {f["out_deg"]} контр., {f["out_tx"]} оп.; ветвей seed: {f["seed_branches"]}.'
        if f['truncated_by_depth']:
            reason += ' Граница обхода, продолжение неизвестно.'
        if f['isolated']:
            reason = '0 входящих и 0 исходящих операций; изолированный счёт. Недостаточно данных для роли.'
        record = {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in f.items()}
        record.update(gid=str(int(gid)), role=role, role_label=ROLE_LABELS[role], role_score=round(float(strength), 6),
            priority_score=round(priority, 6), evidence=reason[:200],
            alternatives=[{'role': r, 'label': ROLE_LABELS[r], 'score': round(float(s), 4)} for r, s in ordered if s >= .35 and r != role],
            contributions={k: round(float(v), 6) for k, v in contributions.items()}, limitations=limitations, next_checks=next_checks,
            facts=[{'label': 'Входящие контрагенты', 'value': str(f['in_deg'])},
                {'label': 'Исходящие контрагенты', 'value': str(f['out_deg'])},
                {'label': 'Входящий оборот в выборке', 'value': money(f['in_kzt'])},
                {'label': 'Исходящий оборот в выборке', 'value': money(f['out_kzt'])},
                {'label': 'Исходящие через 1–2 дня после входящих', 'value': str(f['lagged_out_tx'])},
                {'label': 'Достижим из стартовых ветвей', 'value': str(f['seed_branches'])}])
        records.append(record)
    records.sort(key=lambda r: (-r['priority_score'], int(r['gid'])))
    for rank, record in enumerate(records, 1):
        record['rank'] = rank
    lookup = {int(r['gid']): r for r in records}
    graph_edges = [{'id': f'e:{r.src}:{r.dst}', 'source': str(r.src), 'target': str(r.dst),
        'sum_kzt': float(r.sum_kzt), 'n_tx': int(r.n_tx)} for r in edges.itertuples(index=False)]
    clusters = []
    for cid, group in enumerate(communities):
        ranked = sorted(group, key=lambda n: (-lookup[n]['priority_score'], n))
        internal = sum(d['sum_kzt'] for u, v, d in G.edges(data=True) if u in group and v in group)
        roles = Counter(lookup[n]['role'] for n in group)
        seed_count = sum(n in seeds for n in group)
        hypothesis = f'Наблюдаемое сообщество: {len(group)} счетов, {seed_count} seed. Чаще: {ROLE_LABELS[roles.most_common(1)[0][0]]}. Назначение требует проверки.'
        if len(group) == 1 and G.degree(next(iter(group))) == 0:
            hypothesis = 'Изолированный счёт: связи не представлены, назначение не установлено.'
        clusters.append(dict(cluster_id=cid, n_nodes=len(group), n_seed=seed_count,
            sum_kzt_internal=round(internal, 2), top_gids=';'.join(str(n) for n in ranked[:5]), hypothesis=hypothesis))
    output_dir.mkdir(parents=True, exist_ok=True)
    export_fields = ['gid', 'role', 'role_score', 'cluster_id', 'priority_score', 'evidence']
    export_frame = pd.DataFrame([{k: r[k] for k in export_fields} for r in records])
    export_frame.to_csv(output_dir / 'nodes_roles.csv', index=False)
    pd.DataFrame(clusters).to_csv(output_dir / 'clusters.csv', index=False)
    pd.DataFrame([dict(rank=r['rank'], gid=r['gid'], role=r['role'], priority_score=r['priority_score'],
        why=f'{r["evidence"]} Приоритет {r["priority_score"]:.3f}; эвристика проверки.') for r in records[:max(20, min(100, len(records)))]]).to_csv(output_dir / 'top_nodes.csv', index=False)
    warnings = [f'{duplicate_count} повторяющихся строк сохранены: отдельного ID операции нет.',
        'Суммы и число операций совпадают с агрегатами; роли — гипотезы, не установленные факты.',
        'Суммарный оборот не равен ущербу или объёму уникальных денег.']
    dates_only = not len(tx) or bool((tx.date == tx.date.dt.normalize()).all())
    if dates_only:
        warnings.append('Доступны даты без внутридневного времени. Временной признак использует календарные дни.')
    if depth_mismatches:
        warnings.append(f'У {depth_mismatches} узлов глубина отличается от достижимости по представленным рёбрам.')
    summary = dict(label=label, synthetic=synthetic, method_version=METHOD_VERSION, node_count=len(nodes), edge_count=len(edges),
        transaction_count=len(tx), seed_count=len(seeds), total_kzt=round(float(edges.sum_kzt.sum()), 2),
        isolate_count=sum(r['isolated'] for r in records), boundary_count=sum(r['truncated_by_depth'] for r in records),
        weak_components=nx.number_weakly_connected_components(G), cluster_count=len(clusters),
        role_counts=dict(Counter(r['role'] for r in records)), role_labels=ROLE_LABELS, warnings=warnings,
        period_start=tx.date.min().strftime('%d.%m.%Y') if len(tx) else '—',
        period_end=tx.date.max().strftime('%d.%m.%Y') if len(tx) else '—',
        elapsed_seconds=round(time.perf_counter() - started, 3), hashes=hashes,
        parameters={'louvain_seed': 42, 'betweenness_seed': 42, 'betweenness_samples': min(32, len(G)),
                    'weights': {'structure': .35, 'seed_branches': .30, 'observed_flow': .20, 'role_signals': .15}})
    (output_dir / 'manifest.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    return Result(summary, records, graph_edges, transactions, clusters, output_dir)
