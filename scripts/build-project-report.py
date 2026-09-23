"""Build the project report from Markdown; optional dependency: python-docx.

Images are synthetic UI captures from capture-report-images.cjs. Regenerate
and visually review every page after changing the report or its layout.
"""
from pathlib import Path
import re

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs' / 'PROJECT_REPORT.md'
OUTPUT = ROOT / 'docs' / 'ScreenMentor_Project_Report.docx'
doc = Document()
section = doc.sections[0]
section.page_width = Cm(21)
section.page_height = Cm(29.7)
section.top_margin = Cm(1.65)
section.bottom_margin = Cm(1.65)
section.left_margin = Cm(1.9)
section.right_margin = Cm(1.9)
section.footer_distance = Cm(.8)
normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(10.5)
normal.font.color.rgb = RGBColor.from_string('20333F')
normal.paragraph_format.space_after = Pt(7)
normal.paragraph_format.line_spacing = 1.1
for name, size in [('Title', 30), ('Subtitle', 14), ('Heading 1', 21), ('Heading 2', 14)]:
    style = doc.styles[name]
    style.font.name = 'Calibri'
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.paragraph_format.space_after = Pt(12)
    style.paragraph_format.space_before = Pt(0 if name in ['Title', 'Heading 1'] else 9)
    style.paragraph_format.keep_with_next = True
    borders = style.element.find('.//' + qn('w:pBdr'))
    if borders is not None:
        borders.getparent().remove(borders)
doc.styles['Caption'].font.name = 'Calibri'
doc.styles['Caption'].font.size = Pt(9)
doc.styles['Caption'].font.color.rgb = RGBColor.from_string('526875')

# Page numbers help navigate a report printed or passed between reviewers.
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
run = footer.add_run('ScreenMentor  |  ')
run.font.size = Pt(8)
run.font.color.rgb = RGBColor.from_string('607581')
field = OxmlElement('w:fldSimple')
field.set(qn('w:instr'), 'PAGE')
footer._p.append(field)
doc.core_properties.title = 'Отчёт о проекте Граф денег'
doc.core_properties.subject = 'Функции, удобство, данные, результаты и проверка прототипа'
doc.core_properties.author = 'ScreenMentor'
doc.core_properties.keywords = 'HackAlem AI, Граф денег, ScreenMentor'

def rich(paragraph, text):
    for part in re.split(r'(\*\*.*?\*\*)', text):
        if not part:
            continue
        run = paragraph.add_run(part[2:-2] if part.startswith('**') else part)
        run.bold = part.startswith('**')
    return paragraph

def table(lines):
    rows = [[c.strip() for c in line.strip().strip('|').split('|')] for line in lines]
    rows = [row for row in rows if not all(re.fullmatch(r':?-+:?', c) for c in row)]
    count = len(rows[0])
    t = doc.add_table(rows=0, cols=count)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    widths = ([8.6, 8.6] if rows[0][0]=='Компонент' else [5.0, 12.2]) if count==2 else [5.73]*3
    for col, width in zip(t.columns, widths):
        col.width = Cm(width)
    props = t._tbl.tblPr
    borders = OxmlElement('w:tblBorders')
    for edge in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
        item = OxmlElement('w:'+edge)
        for key, val in [('val','single'),('sz','4'),('color','D9D9D9')]:
            item.set(qn('w:'+key),val)
        borders.append(item)
    props.append(borders)
    margins = OxmlElement('w:tblCellMar')
    for edge, value in [('top','95'),('bottom','95'),('left','120'),('right','120')]:
        item=OxmlElement('w:'+edge); item.set(qn('w:w'),value); item.set(qn('w:type'),'dxa'); margins.append(item)
    props.append(margins)
    for index, values in enumerate(rows):
        row = t.add_row()
        trpr = row._tr.get_or_add_trPr()
        trpr.append(OxmlElement('w:cantSplit'))
        if index==0:
            trpr.append(OxmlElement('w:tblHeader'))
        for col, (cell, value) in enumerate(zip(row.cells, values)):
            cell.width = Cm(widths[col])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            shade = OxmlElement('w:shd')
            shade.set(qn('w:fill'), '193D53' if index==0 else ('F1F6F8' if index%2 else 'FFFFFF'))
            cell._tc.get_or_add_tcPr().append(shade)
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.05
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER if count==3 or index==0 else WD_ALIGN_PARAGRAPH.LEFT
            rich(p,value)
            for run in p.runs:
                run.font.size = Pt(9.5)
                if index==0:
                    run.bold=True;run.font.color.rgb=RGBColor(255,255,255)
    spacer=doc.add_paragraph()
    spacer.paragraph_format.space_after=Pt(2)
    spacer.paragraph_format.space_before=Pt(0)
    spacer.paragraph_format.line_spacing=1
    spacer.add_run().font.size=Pt(2)

lines = SOURCE.read_text(encoding='utf-8').splitlines()
i = 0
page = 1
while i < len(lines):
    line = lines[i].strip()
    i += 1
    if not line:
        continue
    if line=='<!-- PAGEBREAK -->':
        doc.add_page_break();page+=1;continue
    if line.startswith('|'):
        block=[line]
        while i<len(lines) and lines[i].strip().startswith('|'):
            block.append(lines[i].strip());i+=1
        table(block);continue
    match = re.match(r'!\[(.*?)\]\((.*?)\)',line)
    if match:
        alt, relative = match.groups()
        filename = (SOURCE.parent / relative).resolve()
        p = doc.add_paragraph()
        p.alignment=WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after=Pt(7)
        width = 3.4 if filename.name=='logo.png' else (10.0 if filename.name=='graph.png' else 17.2)
        shape=p.add_run().add_picture(str(filename),width=Cm(width))
        shape._inline.docPr.set('descr',alt)
        shape._inline.docPr.set('title',alt)
        continue
    if line.startswith('# '):
        p=doc.add_paragraph(line[2:],style='Title');continue
    if line.startswith('## '):
        p=doc.add_paragraph(line[3:],style='Heading 1');continue
    if line.startswith('*') and line.endswith('*') and not line.startswith('**'):
        p=doc.add_paragraph(line[1:-1],style='Caption');continue
    if page==1 and line in ['ScreenMentor','Анализ транзакционной сети и рабочее место аналитика','HackAlem AI · 23 сентября 2026 года']:
        p=doc.add_paragraph(line,style='Subtitle');continue
    p=rich(doc.add_paragraph(),line)
    if line.startswith('Репозиторий команды:') or line.startswith('Кейс организатора:'):
        for run in p.runs:run.font.size=Pt(8)
doc.save(OUTPUT)
print(f'Created {OUTPUT.name}; planned pages: {page}')
