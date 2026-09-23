from __future__ import annotations

import base64
import os
import secrets
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .demo import create_demo
from .engine import METHOD_VERSION, DataError, Result, analyze
from .investigation import explain, investigate, stability
from .report import account_report

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = Path(os.environ.get('GRAPH_ARTIFACTS_DIR', str(ROOT / 'artifacts')))
runs: dict[str, Result] = {}
initial_id = None
demo_id = None
lock = threading.RLock()
EXPORTS = {'results.xlsx', 'nodes_roles.csv', 'clusters.csv', 'top_nodes.csv', 'manifest.json'}


def new_run(source: Path, label: str, synthetic=False):
    global initial_id
    with lock:
        run_id = uuid.uuid4().hex
        result = analyze(source, ARTIFACTS / run_id, label, synthetic)
        runs[run_id] = result
        if len(runs) > 8:
            # Never evict the initial dataset used by the reset button.
            for old in list(runs):
                if old != initial_id and old != run_id:
                    del runs[old]
                    break
        return run_id


@asynccontextmanager
async def lifespan(app):
    global initial_id
    configured = os.environ.get('GRAPH_DATA_DIR')
    source = Path(configured) if configured else create_demo(ARTIFACTS / 'demo')
    initial_id = await run_in_threadpool(new_run, source, 'Набор кейса · июль 2026' if configured else 'Синтетический пример', not bool(configured))
    yield


app = FastAPI(title='Граф денег', version=METHOD_VERSION, lifespan=lifespan)


@app.middleware('http')
async def optional_access_control(request: Request, call_next):
    password = os.environ.get('GRAPH_ACCESS_PASSWORD')
    if password:
        expected = 'Basic ' + base64.b64encode(('analyst:' + password).encode()).decode()
        if not secrets.compare_digest(request.headers.get('authorization', ''), expected):
            return Response(status_code=401, headers={'WWW-Authenticate': 'Basic realm="Graph analyst"'})
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.exception_handler(DataError)
async def invalid_data(request, exc):
    return JSONResponse({'detail': str(exc)}, status_code=422)


def get_run(run_id):
    if run_id not in runs:
        raise HTTPException(404, 'Запуск не найден. Откройте исходный набор или загрузите файлы снова.')
    return runs[run_id]


@app.get('/api/initial')
def initial():
    return {'run_id': initial_id, 'summary': get_run(initial_id).summary}


@app.get('/api/demo')
def demo():
    """A separate synthetic run; never replace the analyst's initial dataset."""
    global demo_id
    with lock:
        if get_run(initial_id).summary['synthetic']:
            return initial()
        if demo_id not in runs:
            demo_id = new_run(create_demo(ARTIFACTS / 'guided-demo'), 'Синтетический пример', True)
        return {'run_id': demo_id, 'summary': get_run(demo_id).summary}


@app.get('/api/runs/{run_id}')
def run_summary(run_id: str):
    return {'run_id': run_id, 'summary': get_run(run_id).summary}


@app.post('/api/analyze')
async def upload(nodes: UploadFile = File(...), edges: UploadFile = File(...), transactions: UploadFile = File(...)):
    upload_dir = ARTIFACTS / 'uploads' / uuid.uuid4().hex
    upload_dir.mkdir(parents=True)
    total = 0
    for name, uploaded in [('nodes', nodes), ('edges', edges), ('transactions', transactions)]:
        content = await uploaded.read(15 * 1024 * 1024 + 1)
        await uploaded.close()
        total += len(content)
        if len(content) > 15 * 1024 * 1024 or total > 30 * 1024 * 1024:
            raise HTTPException(413, 'Лимит: 15 МБ на файл и 30 МБ на комплект')
        (upload_dir / f'{name}.parquet').write_bytes(content)
    run_id = await run_in_threadpool(new_run, upload_dir, 'Загруженный набор')
    return {'run_id': run_id, 'summary': get_run(run_id).summary}


@app.get('/api/runs/{run_id}/nodes')
def node_list(run_id: str, q: str = '', role: str = '', cluster: int | None = None, limit: int = Query(100, ge=1, le=1000)):
    rows = get_run(run_id).nodes
    selected = [r for r in rows if q.strip() in r['gid'] and (not role or r['role'] == role) and (cluster is None or r['cluster_id'] == cluster)]
    return {'items': selected[:limit], 'total': len(selected), 'shown': min(limit, len(selected))}


@app.get('/api/runs/{run_id}/clusters')
def clusters(run_id: str):
    return get_run(run_id).clusters


@app.get('/api/runs/{run_id}/nodes/{gid}')
def node_detail(run_id: str, gid: str):
    run = get_run(run_id)
    record = next((r for r in run.nodes if r['gid'] == gid), None)
    if record is None:
        raise HTTPException(404, 'Счёт не найден в этом наборе')
    payments = [t for t in run.transactions if t['src'] == gid or t['dst'] == gid]
    return {'node': record, 'transactions': payments}


def account_run(run_id, gid):
    run = get_run(run_id)
    if not any(n['gid'] == gid for n in run.nodes):
        raise HTTPException(404, 'Счёт не найден')
    return run


@app.get('/api/runs/{run_id}/nodes/{gid}/investigation')
def investigation(run_id: str, gid: str):
    return investigate(account_run(run_id, gid), gid)


@app.get('/api/runs/{run_id}/nodes/{gid}/stability')
def sensitivity(run_id: str, gid: str):
    return stability(account_run(run_id, gid), gid)


@app.get('/api/runs/{run_id}/nodes/{gid}/assistant')
def assistant(run_id: str, gid: str, topic: str = Query('priority', pattern='^(priority|role|next|chronology)$')):
    return explain(account_run(run_id, gid), gid, topic)


@app.get('/api/runs/{run_id}/nodes/{gid}/report')
def report(run_id: str, gid: str, download: bool = False):
    result = account_report(account_run(run_id, gid), gid)
    headers = {'Content-Disposition': f'attachment; filename="account-{gid}.html"'} if download else {}
    return HTMLResponse(result, headers=headers)


@app.get('/api/runs/{run_id}/graph')
def graph(run_id: str, gid: str, hops: int = Query(1, ge=1, le=2), limit: int = Query(100, ge=10, le=400)):
    run = get_run(run_id)
    lookup = {r['gid']: r for r in run.nodes}
    if gid not in lookup:
        raise HTTPException(404, 'Счёт не найден')
    eligible, frontier, parent = {gid}, {gid}, {}
    for _ in range(hops):
        neighbors = set()
        for e in run.edges:
            if e['source'] in frontier:
                neighbors.add(e['target'])
                if e['target'] not in eligible:
                    parent.setdefault(e['target'], e['source'])
            if e['target'] in frontier:
                neighbors.add(e['source'])
                if e['source'] not in eligible:
                    parent.setdefault(e['source'], e['target'])
        frontier = neighbors - eligible
        eligible |= neighbors
    ordered = sorted(eligible - {gid}, key=lambda n: (-lookup[n]['priority_score'], int(n)))
    visible, display = {gid}, [gid]
    for candidate in ordered:
        chain, current = [], candidate
        while current not in visible:
            chain.append(current)
            current = parent[current]
        if len(visible) + len(chain) <= limit:
            for item in reversed(chain):
                visible.add(item)
                display.append(item)
    return {'nodes': [lookup[n] for n in display],
            'edges': [e for e in run.edges if e['source'] in visible and e['target'] in visible],
            'eligible': len(eligible), 'hidden': len(eligible - visible), 'hops': hops}


@app.get('/api/runs/{run_id}/exports/{name}')
def export(run_id: str, name: str):
    run = get_run(run_id)
    if name not in EXPORTS:
        raise HTTPException(404, 'Неизвестный файл')
    media_type = ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' if name.endswith('.xlsx')
                  else 'application/json' if name.endswith('.json') else 'text/csv; charset=utf-8')
    return FileResponse(run.output_dir / name, filename=name, media_type=media_type)


@app.get('/api/health')
def health():
    return {'status': 'ok', 'method': METHOD_VERSION}


@app.get('/')
def index():
    return FileResponse(ROOT / 'frontend' / 'index.html')


app.mount('/static', StaticFiles(directory=ROOT / 'frontend'), name='static')
