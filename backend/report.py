"""Standalone, escaped HTML report; browser print can save it as PDF."""
from datetime import datetime, timezone
from html import escape

from .engine import money
from .investigation import investigate, stability


def account_report(run, gid):
    node = next(n for n in run.nodes if n['gid'] == gid)
    detail, sensitivity = investigate(run, gid), stability(run, gid)
    h = lambda value: escape(str(value), quote=True)
    bullets = lambda values: '<ul>' + ''.join(f'<li>{h(v)}</li>' for v in values) + '</ul>'
    paths = []
    for path in detail['paths'][:3]:
        rows = []
        for i, account in enumerate(path['gids']):
            rows.append(f'<rect x="10" y="{i*80+5}" width="340" height="38" rx="6" fill="#edf5f2"/><text x="180" y="{i*80+29}" text-anchor="middle" font-family="monospace" font-size="13">{h(account)}</text>')
            if i < len(path['edges']):
                edge = path['edges'][i]
                rows.append(f'<text x="180" y="{i*80+64}" text-anchor="middle" font-size="11">↓ {h(money(edge["sum_kzt"]))} · {edge["n_tx"]} оп.</text>')
        svg = f'<svg viewBox="0 0 360 {len(path["gids"])*80-25}" role="img" aria-label="Направленная цепочка переводов">{"".join(rows)}</svg>'
        sequence = '; '.join(f'{t["date"]}: строка {t["source_row"]}, {money(t["sum_kzt"])}' for t in path['sequence'])
        paths.append(f'<section class="path"><h3>{h(path["status_label"])}</h3>{svg}<p>{h(sequence or "Последовательность по датам не найдена для этого пути.")}</p></section>')
    payments = [t for t in run.transactions if gid in (t['src'], t['dst'])]
    payment_rows = ''.join(f'<tr><td>{h(t["date"])}<br>строка {t["source_row"]}</td><td>{h(t["src"])}<br>→ {h(t["dst"])}</td><td>{h(money(t["sum_kzt"]))}</td></tr>' for t in payments[:200])
    timeline = ''.join(f'<tr><td>{h(t["date"])}</td><td>{h(money(t["incoming"]))}</td><td>{h(money(t["outgoing"]))}</td></tr>' for t in detail['timeline'])
    ranks = sensitivity['selected']
    hashes = ''.join(f'<p>{h(name)}.parquet<br><code>{h(value)}</code></p>' for name, value in run.summary['hashes'].items())
    facts = ''.join(f'<tr><td>{h(f["label"])}</td><td>{h(f["value"])}</td></tr>' for f in node['facts'])
    labels = {'structure': 'Структурная значимость', 'seed_branches': 'Стартовые ветви', 'observed_flow': 'Оборот', 'role_signals': 'Признаки роли'}
    contributions = ''.join(f'<li>{labels[k]}: +{v*100:.2f}</li>' for k, v in node['contributions'].items())
    return f'''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Справка · {h(gid)}</title>
<style>body{{font:14px/1.6 Arial,sans-serif;color:#203533;max-width:920px;margin:32px auto;padding:0 24px}}h1{{font-size:28px}}h2{{margin-top:32px;border-bottom:1px solid #dbe5e1}}h3{{font-size:14px}}code{{overflow-wrap:anywhere}}.note{{background:#fff5df;padding:14px}}.meta{{color:#63756e}}table{{border-collapse:collapse;width:100%;font-size:12px}}th,td{{padding:8px;border:1px solid #dbe5e1;text-align:left;vertical-align:top;overflow-wrap:anywhere}}.paths{{display:flex;flex-wrap:wrap;gap:16px}}.path{{flex:1;min-width:220px;break-inside:avoid}}svg{{width:100%;max-width:360px}}li{{margin:6px 0}}@media print{{body{{max-width:none;margin:0;padding:0;font-size:11px}}.print-note{{display:none}}h2,h3{{break-after:avoid}}tr{{break-inside:avoid}}thead{{display:table-header-group}}}}@page{{size:A4;margin:16mm}}</style></head><body>
<p class="meta">HACKALEM AI · SCREENMENTOR · ГРАФ ДЕНЕГ</p><h1>Аналитическая справка по счёту</h1><h2><code>{h(gid)}</code></h2>
<p class="print-note">Для сохранения в PDF: Ctrl+P → «Сохранить как PDF». Справка содержит данные выбранного набора.</p>
<p>Набор: {h(run.summary['label'])}{' · СИНТЕТИЧЕСКИЕ ДАННЫЕ' if run.summary['synthetic'] else ''}. Период: {h(run.summary['period_start'])} — {h(run.summary['period_end'])}.<br>Метод {h(run.summary['method_version'])}; сформировано {h(datetime.now(timezone.utc).isoformat(timespec='seconds'))}.</p>
<div class="note">Гипотезы требуют проверки ответственным аналитиком. Справка не устанавливает виновность, принадлежность средств или назначение операций.</div>
<h2>1. Основание для проверки</h2><p>{h(node['evidence'])}</p><p>Гипотеза: <strong>{h(node['role_label'])}</strong>. Выраженность признаков {node['role_score']*100:.1f}/100. Приоритет {node['priority_score']*100:.1f}/100, место {node['rank']}.</p><ul>{contributions}</ul><table>{facts}</table>
<h2>2. Направленные цепочки и даты</h2><p>{h(detail['search_note'])} В справке до трёх примеров.</p><div class="paths">{''.join(paths) or '<p>Пути в пределах выбранного поиска не найдены.</p>'}</div><p>{h(detail['temporal_note'])} Суммы на стрелках — агрегаты каждой пары за весь период, не сумма денег, прошедшая всю цепь.</p>
<h2>3. Поступления и отправления по дням</h2><table><thead><tr><th>Дата</th><th>Входящие</th><th>Исходящие</th></tr></thead><tbody>{timeline or '<tr><td colspan="3">Операций нет.</td></tr>'}</tbody></table>
<h2>4. Устойчивость очереди</h2><p>Место при изменениях весов: {ranks['min_rank']}–{ranks['max_rank']}. Попадание в топ-{sensitivity['top_size']}: {ranks['top_appearances']} из {ranks['scenario_count']} вариантов.</p><p>{h(sensitivity['note'])}</p>
<h2>5. Ограничения и альтернативные объяснения</h2>{bullets(node['limitations'])}<p>Наблюдаемая структура может соответствовать законным расчётам, сбору платежей или выплатам. Для проверки нужны назначение операций и контекст деятельности, которых нет в выгрузке.</p>
<h2>6. Следующие действия</h2>{bullets(node['next_checks'])}
<h2>7. Исходные операции счёта</h2><p>Показаны {min(200, len(payments))} из {len(payments)} операций. Номер строки относится к исходному transactions.parquet, начиная с 1. Повторяющиеся строки сохранены.</p><table><thead><tr><th>Дата / источник</th><th>Отправитель → получатель</th><th>Сумма</th></tr></thead><tbody>{payment_rows or '<tr><td colspan="3">Операций нет.</td></tr>'}</tbody></table>
<h2>8. Воспроизводимость</h2><p>SHA-256 исходных файлов:</p>{hashes}<p>Версия метода и формулы находятся в README проекта. Дополнительные выводы вручную в эту справку не вносились.</p></body></html>'''
