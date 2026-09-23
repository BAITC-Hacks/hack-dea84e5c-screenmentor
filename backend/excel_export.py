"""Fill the bundled XLSX layout with explicit cell types, without Excel guessing.

The layout was authored with @oai/artifact-tool. At runtime standard OOXML
XML/ZIP filling keeps the Python service independent of a Node installation.
"""
import csv
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('x', NS)
TAG = lambda name: f'{{{NS}}}{name}'
TEMPLATE = Path(__file__).parent / 'assets' / 'export-template.xlsx'
INTEGER_FIELDS = {'rank', 'cluster_id', 'n_nodes', 'n_seed'}
NUMBER_FIELDS = {'role_score', 'priority_score', 'sum_kzt_internal'}
SHEETS = ['top_nodes.csv', 'nodes_roles.csv', 'clusters.csv']


def _rows(path):
    with path.open(encoding='utf-8-sig', newline='') as source:
        records = csv.DictReader(source)
        for record in records:
            row = []
            for field, value in record.items():
                if field in INTEGER_FIELDS:
                    value = int(value)
                elif field in NUMBER_FIELDS:
                    # Preserve unusually large monetary values as text rather
                    # than let Excel truncate their significant digits.
                    decimal = Decimal(value)
                    if len(decimal.normalize().as_tuple().digits) <= 15:
                        value = decimal
                row.append(value)
            yield row


def _fill_sheet(xml, rows, filtering=True):
    root = ET.fromstring(xml)
    data = root.find(TAG('sheetData'))
    header, prototype = list(data)
    styles = [cell.get('s', '0') for cell in prototype]
    data.remove(prototype)
    count = 1
    for count, values in enumerate(rows, 2):
        row = ET.SubElement(data, TAG('row'), {'r': str(count), 'ht': '48', 'customHeight': '1'})
        for col, value in enumerate(values):
            attrs = {'r': f'{chr(65+col)}{count}', 's': styles[col]}
            if isinstance(value, (int, Decimal)):
                cell = ET.SubElement(row, TAG('c'), {**attrs, 't': 'n'})
                ET.SubElement(cell, TAG('v')).text = str(value)
            else:
                # inlineStr prevents both auto-rounding and formula evaluation.
                cell = ET.SubElement(row, TAG('c'), {**attrs, 't': 'inlineStr'})
                text = ET.SubElement(ET.SubElement(cell, TAG('is')), TAG('t'), {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
                text.text = str(value)
    reference = f'A1:{chr(64+len(styles))}{count}'
    dimension = root.find(TAG('dimension'))
    if dimension is not None:
        dimension.set('ref', reference)
    if filtering:
        filter_node = ET.Element(TAG('autoFilter'), {'ref': reference})
        root.insert(list(root).index(data)+1, filter_node)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def write_workbook(output_dir, summary):
    output_dir = Path(output_dir)
    metadata = [
        ['Набор', summary['label']], ['Версия метода', summary['method_version']],
        ['Период', f'{summary["period_start"]} — {summary["period_end"]}'],
        ['Всего счетов', summary['node_count']], ['Всего сообществ', summary['cluster_count']],
        ['Содержание', 'Все счета и сообщества выгружены полностью. Лист «Приоритеты» содержит первые 100 счетов или весь набор, если он меньше.'],
        ['Идентификаторы', 'gid и top_gids сохранены как текст: все цифры сохраняются при открытии и сохранении в Excel.'],
        ['Числовые поля', 'Оценки, количества и суммы сохранены числами. Значения с более чем 15 значащими цифрами сохраняются текстом для точности.'],
        ['cluster_id', 'Нумерация с 0; в приложении сообщество отображается с 1.'],
        ['role_score / priority_score', 'Оценки по правилам от 0 до 1; не вероятность нарушения.'],
        ['sum_kzt_internal', 'Сумма переводов внутри сообщества в тенге.'],
        ['Роли', 'consolidator — сбор; transit — транзит; distributor — распределение; terminal — конечный получатель (гипотеза); coordinator — связующее звено; peripheral — недостаточно признаков.'],
        *[[f'SHA-256 {name}.parquet', value] for name, value in summary['hashes'].items()],
    ]
    replacements = {f'xl/worksheets/sheet{i}.xml': _rows(output_dir / filename) for i, filename in enumerate(SHEETS, 1)}
    replacements['xl/worksheets/sheet4.xml'] = metadata
    destination = output_dir / 'results.xlsx'
    with ZipFile(TEMPLATE) as source, ZipFile(destination, 'w', compression=ZIP_DEFLATED) as target:
        for entry in source.infolist():
            content = source.read(entry.filename)
            if entry.filename in replacements:
                content = _fill_sheet(content, replacements[entry.filename], entry.filename != 'xl/worksheets/sheet4.xml')
            target.writestr(entry.filename, content)
    return destination
