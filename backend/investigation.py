"""Bounded, reproducible investigations over already validated observations."""
from collections import defaultdict, deque
from datetime import date

BASE_WEIGHTS = {'structure': .35, 'seed_branches': .30, 'observed_flow': .20, 'role_signals': .15}
TEMPORAL_LABELS = {
    'ordered': 'Даты допускают последовательность',
    'same_day_unknown': 'Порядок внутри дня неизвестен',
    'incompatible': 'Даты не подтверждают этот маршрут',
}


def temporal_sequence(groups, strict=True):
    """Earliest-feasible greedy choice is complete for a fixed path, with no amount matching."""
    selected, previous = [], None
    for payments in groups:
        chosen = next((t for t in sorted(payments, key=lambda t: (t['date'], t['source_row']))
                       if previous is None or t['date'] > previous or (not strict and t['date'] == previous)), None)
        if chosen is None:
            return None
        selected.append(chosen)
        previous = chosen['date']
    return selected


def investigate(run, gid, limit=8, max_hops=6):
    lookup = {n['gid']: n for n in run.nodes}
    node = lookup[gid]
    forward, reverse, payments, edges = defaultdict(list), defaultdict(list), defaultdict(list), {}
    for edge in run.edges:
        a, b = edge['source'], edge['target']
        forward[a].append(b)
        reverse[b].append(a)
        edges[a, b] = edge
    for t in run.transactions:
        payments[t['src'], t['dst']].append(t)
    order = lambda n: (-lookup[n]['priority_score'], int(n))
    for adjacency in (forward, reverse):
        for neighbors in adjacency.values():
            neighbors.sort(key=order)
    # One shortest directed route per upstream seed; no unbounded all-paths search.
    distance, next_node, queue = {gid: 0}, {}, deque([gid])
    while queue:
        current = queue.popleft()
        if distance[current] >= max_hops:
            continue
        for predecessor in reverse[current]:
            if predecessor not in distance:
                distance[predecessor] = distance[current] + 1
                next_node[predecessor] = current
                queue.append(predecessor)
    candidate_paths = []
    for seed in sorted((n for n in distance if lookup[n]['is_seed'] and n != gid), key=order):
        path = [seed]
        while path[-1] != gid:
            path.append(next_node[path[-1]])
        candidate_paths.append(('upstream', path))
    # A starting account also needs a useful downstream view, at most three hops.
    if node['is_seed']:
        paths, queue = {gid: [gid]}, deque([gid])
        while queue:
            current = queue.popleft()
            if len(paths[current]) > 3:
                continue
            for successor in forward[current]:
                if successor not in paths:
                    paths[successor] = paths[current] + [successor]
                    queue.append(successor)
        endpoints = sorted((n for n in paths if n != gid), key=lambda n: (-len(paths[n]), *order(n)))
        candidate_paths.extend(('downstream', paths[n]) for n in endpoints[:limit])
    candidates = []
    for direction, path in candidate_paths:
        pairs = list(zip(path, path[1:]))
        groups = [payments[pair] for pair in pairs]
        sequence = temporal_sequence(groups)
        status = 'ordered'
        if sequence is None:
            sequence = temporal_sequence(groups, strict=False)
            status = 'same_day_unknown' if sequence is not None else 'incompatible'
        candidates.append({'direction': direction, 'gids': path, 'edges': [edges[pair] for pair in pairs],
                           'status': status, 'status_label': TEMPORAL_LABELS[status],
                           'sequence': sequence or [], 'operations': [t for group in groups for t in group],
                           'nodes': [lookup[n] for n in path]})
    candidates.sort(key=lambda p: (list(TEMPORAL_LABELS).index(p['status']), len(p['gids']), tuple(map(int, p['gids']))))
    for i, path in enumerate(candidates[:limit], 1):
        path['id'] = f'path-{i}'
    local = [t for t in run.transactions if gid in (t['src'], t['dst'])]
    incoming = [t for t in local if t['dst'] == gid]
    outgoing = [t for t in local if t['src'] == gid]
    in_days = defaultdict(list)
    for t in incoming:
        in_days[date.fromisoformat(t['date'])].append(t)
    lag_pairs = []
    for out in outgoing:
        out_day = date.fromisoformat(out['date'])
        matching = [t for day, values in in_days.items() if (out_day-day).days in (1, 2) for t in values]
        if matching:
            lag_pairs.append({'outgoing': out, 'possible_incoming': matching})
    days = defaultdict(lambda: {'incoming_tiyn': 0, 'outgoing_tiyn': 0, 'in_count': 0, 'out_count': 0})
    for t in local:
        day = days[t['date']]
        if t['dst'] == gid:
            day['incoming_tiyn'] += round(t['sum_kzt'] * 100)
            day['in_count'] += 1
        if t['src'] == gid:
            day['outgoing_tiyn'] += round(t['sum_kzt'] * 100)
            day['out_count'] += 1
    timeline = [{'date': day, 'incoming': values['incoming_tiyn']/100, 'outgoing': values['outgoing_tiyn']/100,
                 'in_count': values['in_count'], 'out_count': values['out_count']} for day, values in sorted(days.items())]
    evidence = {
        'incoming': {'label': 'Входящие переводы', 'transactions': incoming, 'count': len(incoming), 'counterparties': len({t['src'] for t in incoming})},
        'outgoing': {'label': 'Исходящие переводы', 'transactions': outgoing, 'count': len(outgoing), 'counterparties': len({t['dst'] for t in outgoing})},
        'lagged': {'label': 'Исходящие через 1–2 дня после входящих', 'transactions': [p['outgoing'] for p in lag_pairs], 'count': len(lag_pairs), 'pairs': lag_pairs},
    }
    for group in evidence.values():
        observed = list(group['transactions'])
        if 'pairs' in group:
            observed.extend(t for pair in group['pairs'] for t in pair['possible_incoming'])
        pairs = {(t['src'], t['dst']) for t in observed}
        ids = {gid} | {n for pair in pairs for n in pair}
        visible = [gid] + sorted(ids - {gid}, key=order)[:399]
        visible_set = set(visible)
        group['graph'] = {'nodes': [lookup[n] for n in visible],
                          'edges': [edges[pair] for pair in sorted(pairs) if set(pair) <= visible_set],
                          'eligible': len(ids), 'hidden': len(ids) - len(visible), 'hops': 1, 'path_label': group['label']}
    return {'gid': gid, 'paths': candidates[:limit], 'candidate_count': len(candidates), 'shown': min(limit, len(candidates)),
            'timeline': timeline, 'evidence': evidence,
            'search_note': 'Один кратчайший путь от каждого достижимого seed, до 6 рёбер; для выбранного seed — также до 8 исходящих путей глубиной до 3. Показаны до 8 примеров. Альтернативные пути не перебираются.',
            'temporal_note': 'Проверяется существование последовательности операций по датам на выбранном пути. Совпадение дат не устанавливает порядок внутри дня; суммы не сопоставляются как движение одних и тех же денег.'}


def stability(run, gid=None):
    nodes = run.nodes
    size = min(20, len(nodes))
    baseline = [n['gid'] for n in nodes[:size]]
    by_id = {n['gid']: n for n in nodes}
    base_set, rank_ranges, appearances = set(baseline), defaultdict(list), defaultdict(int)
    scenarios = []
    for feature in BASE_WEIGHTS:
        for multiplier in (.8, 1.2):
            raw = {k: v * (multiplier if k == feature else 1) for k, v in BASE_WEIGHTS.items()}
            total = sum(raw.values())
            weights = {k: v / total for k, v in raw.items()}
            scores = {n['gid']: sum(n['contributions'][k] / BASE_WEIGHTS[k] * weights[k] for k in weights) for n in nodes}
            ordered = sorted(nodes, key=lambda n: (-round(scores[n['gid']], 6), int(n['gid'])))
            top = [n['gid'] for n in ordered[:size]]
            ranks = {n['gid']: rank for rank, n in enumerate(ordered, 1)}
            for n in nodes:
                rank_ranges[n['gid']].append(ranks[n['gid']])
            for n in top:
                appearances[n] += 1
            scenarios.append({'feature': feature, 'multiplier': multiplier, 'weights': weights, 'top_gids': top,
                              'overlap_count': len(base_set & set(top)),
                              'overlap_fraction': len(base_set & set(top)) / size,
                              'selected_rank': ranks.get(gid)})
    comparisons = []
    for metric, label, key in [('turnover', 'Только оборот', lambda n: n['in_kzt'] + n['out_kzt']),
                               ('degree', 'Только число связей', lambda n: n['in_deg'] + n['out_deg'])]:
        top = [n['gid'] for n in sorted(nodes, key=lambda n: (-key(n), int(n['gid'])))[:size]]
        comparisons.append({'metric': metric, 'label': label, 'top_gids': top, 'overlap_count': len(base_set & set(top)),
                            'only_our_top': [n for n in baseline if n not in top]})
    selected = None
    if gid is not None:
        ranks = rank_ranges[gid] + [by_id[gid]['rank']]
        selected = {'gid': gid, 'base_rank': by_id[gid]['rank'], 'min_rank': min(ranks), 'max_rank': max(ranks),
                    'top_appearances': appearances[gid], 'scenario_count': len(scenarios)}
    return {'top_size': size, 'scenarios': scenarios, 'selected': selected, 'comparisons': comparisons,
            'note': 'Чувствительность только к весам: один вес меняется на ±20%, затем веса нормируются. Роли и граф фиксированы. Это не проверка точности и не доверительный интервал.'}


def explain(run, gid, topic):
    """Local guided assistant: no language model, no invented answers to arbitrary questions."""
    node = next(n for n in run.nodes if n['gid'] == gid)
    investigation = investigate(run, gid)
    if topic == 'priority':
        text = f'Место {node["rank"]}; приоритет {node["priority_score"]*100:.1f}/100. '
        labels = {'structure': 'структура', 'seed_branches': 'стартовые ветви', 'observed_flow': 'оборот', 'role_signals': 'признаки роли'}
        text += '; '.join(f'{labels[k]}: +{v*100:.1f}' for k, v in node['contributions'].items()) + '. Это очередь проверки, а не вероятность нарушения.'
        evidence = investigation['evidence']['incoming']['transactions'] + investigation['evidence']['outgoing']['transactions']
    elif topic == 'role':
        text = f'{node["role_label"]}. {node["evidence"]} Выраженность признаков: {node["role_score"]*100:.1f}/100. '
        text += 'Назначение операций и законные объяснения требуют проверки.'
        key = 'lagged' if node['role'] == 'transit' else 'outgoing' if node['role'] == 'distributor' else 'incoming'
        evidence = investigation['evidence'][key]['transactions']
    elif topic == 'next':
        text = ' '.join(node['next_checks'] + node['limitations'])
        evidence = []
    elif topic == 'chronology':
        counts = {status: sum(p['status'] == status for p in investigation['paths']) for status in TEMPORAL_LABELS}
        text = f'Среди {investigation["shown"]} показанных путей: ' + '; '.join(f'{label.lower()} — {counts[status]}' for status, label in TEMPORAL_LABELS.items()) + '. ' + investigation['temporal_note']
        evidence = [t for p in investigation['paths'] for t in p['sequence']]
    else:
        raise ValueError('Неизвестная тема')
    unique = {t['id']: t for t in evidence}
    return {'topic': topic, 'text': text, 'mode': 'local_rules', 'mode_label': 'Помощник по рассчитанным фактам · без LLM',
            'citations': list(unique.values())[:20], 'total_citations': len(unique),
            'method_version': run.summary['method_version'], 'source_hash': run.summary['hashes']['transactions']}
