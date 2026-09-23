'use strict';
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => Number(value).toLocaleString('ru-RU');
const money = value => Number(value).toLocaleString('ru-RU', {maximumFractionDigits:2}) + ' ₸';
const colors = {consolidator:'#54c8b0',transit:'#71bced',distributor:'#efb16b',terminal:'#c5cdde',coordinator:'#b298ed',peripheral:'#859eae'};
const roleNames={consolidator:'Сбор средств',transit:'Транзит',distributor:'Распределение',terminal:'Получатель · гипотеза',coordinator:'Связующее звено',peripheral:'Недостаточно признаков'};
const roleName=role=>roleNames[role]||role;
let runId, summary, selectedId, selectedDetail, cy, listVersion=0, detailVersion=0, graphLimit=30;

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `Ошибка ${response.status}`;
    try {const body = await response.json(); message = typeof body.detail === 'string' ? body.detail : 'Проверьте комплект загружаемых файлов.';} catch {}
    throw new Error(message);
  }
  return response.json();
}
function showError(error) { $('message').textContent = error.message || String(error); $('message').hidden = false; }
function clearError() { $('message').hidden = true; }
function showInfo(title, html) { $('info-title').textContent = title; $('info-body').innerHTML = html; if (!$('info-dialog').open) $('info-dialog').showModal(); }

async function activate(data) {
  detailVersion++; listVersion++;
  runId=data.run_id; summary=data.summary; selectedId=null; selectedDetail=null;
  beginWorkspace(data);
  resetInvestigation(null);
  clearError();
  $('dataset-label').textContent = summary.label;
  $('dataset-label').classList.toggle('synthetic', summary.synthetic);
  $('period').textContent = `${summary.period_start} — ${summary.period_end}`;
  $('runtime').textContent = `Рассчитано за ${fmt(summary.elapsed_seconds)} с`;
  $('stat-nodes').textContent = fmt(summary.node_count);
  $('stat-seeds').textContent = `${fmt(summary.seed_count)} стартовых · ${fmt(summary.isolate_count)} без связей`;
  $('stat-transactions').textContent = fmt(summary.transaction_count);
  $('stat-edges').textContent = `${fmt(summary.edge_count)} направленных связей`;
  $('stat-volume').textContent = money(summary.total_kzt);
  $('stat-boundary').textContent = fmt(summary.boundary_count);
  $('role-filter').innerHTML = '<option value="">Все роли</option>' + Object.entries(summary.role_labels).map(([role,label])=>`<option value="${escapeHTML(role)}">${escapeHTML(roleName(role))} (${summary.role_counts[role]||0})</option>`).join('');
  $('search').value=''; $('cluster-filter').value=''; $('hops').value='1';$('graph-direction').value='all';$('graph-labels').checked=true;
  const currentRun=runId;
  const clusters=await api(`/api/runs/${currentRun}/clusters`);
  if (currentRun!==runId) return;
  $('cluster-filter').innerHTML='<option value="">Все группы</option>'+clusters.sort((a,b)=>b.n_nodes-a.n_nodes).map(c=>`<option value="${c.cluster_id}">Группа ${c.cluster_id+1} · ${c.n_nodes} счетов</option>`).join('');
  const restored=restoreWorkspaceView();
  await loadList(!restored);
  if(restored){try{await selectNode(restored,false,{restore:true});}catch{await loadList(true);}}
}

async function loadList(selectFirst=false) {
  saveWorkspaceView();
  const version=++listVersion;
  const params=new URLSearchParams({q:$('search').value.trim(),role:$('role-filter').value,limit:'100'});
  if ($('cluster-filter').value!=='') params.set('cluster',$('cluster-filter').value);
  const data=await api(`/api/runs/${runId}/nodes?${params}`);
  if(version!==listVersion)return;
  $('queue-count').textContent=fmt(data.total);
  $('list-foot').textContent=`Показано ${data.shown} из ${fmt(data.total)} · сортировка по приоритету`;
  $('node-list').innerHTML=data.items.length?data.items.map(n=>`<button class="node-row${n.gid===selectedId?' selected':''}" data-gid="${escapeHTML(n.gid)}" title="${escapeHTML(n.gid)}"><span class="rank">${n.rank}</span><span class="row-content"><span class="row-id">${escapeHTML(n.gid)}</span><span class="row-role"><i class="role-dot" style="background:${colors[n.role]}"></i>${escapeHTML(roleName(n.role))}</span></span><span class="row-score">${Math.round(n.priority_score*100)}</span></button>`).join(''):'<div class="empty">Счета не найдены.<br>Проверьте номер или сбросьте фильтры.</div>';
  $('node-list').querySelectorAll('[data-gid]').forEach(b=>b.addEventListener('click',()=>selectNode(b.dataset.gid).catch(showError)));
  decorateSavedAccounts();
  if(selectFirst&&data.items.length)await selectNode(data.items[0].gid);
}

async function selectNode(gid, keepLimit=false, navigation={}) {
  const version=++detailVersion;
  selectedId=gid;
  selectedDetail=null;
  setWorkspaceBusy(true);
  $('node-detail').innerHTML='<div class="empty">Загружаем карточку выбранного счёта…</div>';
  if(cy){cy.destroy();cy=null;}
  resetInvestigation(gid);
  if(!keepLimit)graphLimit=30;
  $('node-list').querySelectorAll('[data-gid]').forEach(b=>b.classList.toggle('selected',b.dataset.gid===gid));
  $('graph-loading').hidden=false;
  try {
    const base=`/api/runs/${runId}`;
    const [detail,graph]=await Promise.all([api(`${base}/nodes/${encodeURIComponent(gid)}`),api(`${base}/graph?${new URLSearchParams({gid,hops:$('hops').value,limit:graphLimit,direction:$('graph-direction').value})}`)]);
    if(version!==detailVersion)return;
    selectedDetail=detail;
    renderDetail(detail);
    renderGraph(graph,gid);
    workspaceSelected(detail,navigation);
  } finally {if(version===detailVersion){$('graph-loading').hidden=true;setWorkspaceBusy(false);}}
}

function renderDetail(detail) {
  const n=detail.node, score=Math.round(n.priority_score*100);
  const contributions={structure:'Положение среди связей',seed_branches:'Связь со стартовыми счетами',observed_flow:'Объём наблюдаемых переводов',role_signals:'Признаки предполагаемой роли'};
  const reasons={
    consolidator:`На счёт поступали переводы от ${n.in_deg} других счетов. Система видит признаки сбора средств.`,
    distributor:`Со счёта переводили деньги на ${n.out_deg} других счетов. Система видит признаки распределения средств.`,
    transit:`Есть ${n.lagged_out_tx} исходящих операций через 1–2 дня после поступлений. Это признак для проверки транзита, а не доказательство движения тех же денег.`,
    terminal:'Видны повторные поступления от нескольких счетов в разные дни, но исходящих операций в выгрузке нет. Конечное назначение счёта нужно уточнить.',
    coordinator:`Через наблюдаемые связи счёт достижим из ${n.seed_branches} стартовых счетов и соединяет разные группы. Это основание изучить его положение в сети.`,
    peripheral:n.isolated?'В списке есть этот счёт, но его операции не представлены. Сначала нужно уточнить полноту данных.':`Есть входящие от ${n.in_deg} и исходящие на ${n.out_deg} счетов. Признаков недостаточно для выбора конкретной роли.`,
  };
  const factLabels=['Счетов-отправителей','Счетов-получателей','Получено по выгрузке','Отправлено по выгрузке','Отправления спустя 1–2 дня','Стартовых счетов, откуда есть путь'];
  $('node-detail').innerHTML=`
    <div class="detail-id-label"><span>ИДЕНТИФИКАТОР ИЗ ВЫГРУЗКИ</span><button class="copy-button" id="copy-id">Копировать</button></div>
    <div class="detail-id">${escapeHTML(n.gid)}</div>
    <div class="badges"><span class="badge">${escapeHTML(roleName(n.role))}</span>${n.is_seed?'<span class="badge neutral">Стартовый счёт</span>':''}${n.truncated_by_depth?'<span class="badge amber">Край выгрузки</span>':''}${n.isolated?'<span class="badge amber">Нет операций</span>':''}<span class="badge neutral">Группа ${n.cluster_id+1}</span></div>
    <div class="case-reason"><strong>ЧТО ОБРАТИЛО НА СЕБЯ ВНИМАНИЕ</strong>${escapeHTML(reasons[n.role])}</div>
    <div class="score-line"><span>Приоритет проверки · место ${n.rank}</span><strong>${score}<small> / 100</small></strong></div>
    <div class="score-bar"><i style="width:${score}%"></i></div>
    <div class="explain-note">Чем выше баллы, тем раньше счёт в очереди. Это не вероятность нарушения. Роль — предположение по имеющимся данным.</div>
    <div class="detail-section"><h3 class="section-label">НАБЛЮДАЕМЫЕ ПЕРЕВОДЫ</h3><div class="facts">${n.facts.map((f,i)=>`<div class="fact"><span>${factLabels[i]}</span><strong>${escapeHTML(f.value)}</strong></div>`).join('')}</div><button class="evidence-button" id="show-payments">Открыть все операции счёта (${detail.transactions.length}) ↗</button></div>
    <div class="detail-section"><h3 class="section-label">ЧТО ПРОВЕРИТЬ ДАЛЬШЕ</h3>${n.next_checks.map(v=>`<p class="next-check">${escapeHTML(v)}</p>`).join('')}</div>
    <div class="detail-section"><h3 class="section-label">ЧЕГО НЕ ВИДНО В ДАННЫХ</h3><div class="limitations">${n.limitations.map(v=>`<p>${escapeHTML(v.replace('out/in','отношение отправленных сумм к полученным'))}</p>`).join('')}</div></div>
    <details class="score-details"><summary>Как получены баллы и роль</summary><div class="detail-section">${Object.entries(contributions).map(([k,v])=>`<div class="contribution"><span>${v}</span><strong>+${(n.contributions[k]*100).toFixed(1)}</strong></div>`).join('')}<p class="explain-note">Выраженность признаков роли: ${Math.round(n.role_score*100)} / 100. Оценки основаны на правилах; это не статистическая уверенность.</p>${n.alternatives.length?`<h3 class="section-label">ДРУГИЕ ВОЗМОЖНЫЕ РОЛИ</h3>${n.alternatives.map(a=>`<div class="contribution"><span>${escapeHTML(roleName(a.role))}</span><strong>${Math.round(a.score*100)} / 100</strong></div>`).join('')}`:''}</div></details>`;
  $('copy-id').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(n.gid);$('copy-id').textContent='Скопировано';}catch{showInfo('Идентификатор счёта',`<p><code>${escapeHTML(n.gid)}</code></p>`);}});
  $('show-payments').addEventListener('click',showPayments);
  attachInvestigationActions(detail);
  attachAccountTools(detail);
}

function renderGraph(graph,gid) {
  const directionNames={all:'Все направления',incoming:'Откуда поступали деньги',outgoing:'Куда отправляли деньги'};
  $('graph-subtitle').textContent=graph.path_label||`${directionNames[graph.direction||'all']} · ${graph.hops===1?'прямые связи':'до двух переходов'}`;
  $('graph-count').textContent=`${graph.nodes.length} из ${graph.eligible} счетов · ${graph.edges.length} связей${graph.hidden?' · скрыто '+graph.hidden:''}`;
  $('expand-button').hidden=Boolean(graph.path_label)||!graph.hidden||graphLimit>=400;
  $('return-neighborhood').hidden=!graph.path_label;
  $('graph-direction').disabled=Boolean(graph.path_label);
  $('less-graph').hidden=Boolean(graph.path_label)||graphLimit<=30;
  $('graph-tooltip').hidden=true;
  if(cy)cy.destroy();
  const shortIds=graphShortIdentifiers(graph.nodes);
  const elements=[...graph.nodes.map((n,i)=>({data:{id:n.gid,label:shortIds.get(n.gid),focusLabel:roleName(n.role)+'\n'+shortIds.get(n.gid),color:colors[n.role],size:n.gid===gid?38:14+17*n.priority_score},position:{x:250+190*Math.cos(i*2*Math.PI/graph.nodes.length),y:220+190*Math.sin(i*2*Math.PI/graph.nodes.length)},classes:[n.gid===gid?'focused':'',n.is_seed?'seed':'',n.truncated_by_depth?'boundary':''].join(' ')})),...graph.edges.map(e=>({data:{...e,width:Math.min(3,Math.max(.7,Math.log10(e.sum_kzt+1)/3))}}))];
  cy=cytoscape({container:$('graph'),elements,minZoom:.1,maxZoom:4,wheelSensitivity:4,style:[
    {selector:'node',style:{'background-color':'data(color)',width:'data(size)',height:'data(size)',label:'data(label)','text-opacity':0,'font-size':9,color:'#aec2ce','text-valign':'bottom','text-margin-y':6,'text-background-color':'#182a3b','text-background-opacity':.85,'text-background-padding':2,'border-width':0}},
    {selector:'edge',style:{width:'data(width)','line-color':'#49697e','target-arrow-color':'#65869b','target-arrow-shape':'triangle','curve-style':'bezier',opacity:.68,'arrow-scale':.65}},
    {selector:'.seed',style:{shape:'diamond','border-width':1,'border-color':'#d6e7ea'}},
    {selector:'.boundary',style:{'border-width':2,'border-color':'#bda26d','border-style':'dashed'}},
    {selector:'node.labels-visible, node.inspected',style:{'text-opacity':1}},
    {selector:'.focused',style:{'border-width':3,'border-color':'#effbf4','font-size':11,color:'#edf7f6','z-index':5,label:'data(focusLabel)','text-wrap':'wrap','text-opacity':1}},
    {selector:'.muted-connection',style:{opacity:.12,'text-opacity':0}},
    {selector:'edge.inspected, edge:selected',style:{'line-color':'#9de4c5','target-arrow-color':'#9de4c5',opacity:1,width:3}}
  ],layout:{name:'cose',animate:false,randomize:false,padding:45,nodeRepulsion:()=>85000,idealEdgeLength:()=>85,gravity:.35,numIter:500}});
  cy.on('tap','node',event=>{const id=event.target.id();if(id!==selectedId)selectNode(id).catch(showError);});
  cy.on('tap','edge',event=>{const e=event.target.data();showInfo('Наблюдаемая связь',`<p><code>${escapeHTML(e.source)}</code><br>↓<br><code>${escapeHTML(e.target)}</code></p><div class="info-metric"><span>Сумма переводов</span><strong>${money(e.sum_kzt)}</strong></div><div class="info-metric"><span>Операции</span><strong>${fmt(e.n_tx)}</strong></div><p class="muted">Агрегат из edges.parquet, сверенный с transactions.parquet.</p>`);});
  attachGraphNavigation(graph,gid);
}

function showPayments(){
  if(!selectedDetail)return;
  const payments=selectedDetail.transactions;
  showInfo('Подтверждающие переводы',`<p>Счёт <code>${escapeHTML(selectedId)}</code>. ${payments.length} операций. Строка — позиция в исходном transactions.parquet, начиная с 1.</p><div class="proof-wrap"><table class="proof-table"><thead><tr><th>Дата / строка</th><th>Отправитель → получатель</th><th>Сумма</th></tr></thead><tbody>${payments.map(t=>`<tr><td>${escapeHTML(t.date)}<div class="proof-meta">строка ${t.source_row}</div></td><td><button class="tx-gid" data-gid="${escapeHTML(t.src)}">${escapeHTML(t.src)}</button><br>↓<br><button class="tx-gid" data-gid="${escapeHTML(t.dst)}">${escapeHTML(t.dst)}</button></td><td>${money(t.sum_kzt)}</td></tr>`).join('')||'<tr><td colspan="3">Операции для этого счёта в выборке отсутствуют.</td></tr>'}</tbody></table></div><p class="muted">Повторяющиеся строки сохранены. Ссылка на строку относится к текущему исходному файлу; его SHA-256 записан в manifest.json.</p>`);
  $('info-body').querySelectorAll('[data-gid]').forEach(b=>b.addEventListener('click',()=>{$('info-dialog').close();selectNode(b.dataset.gid).catch(showError);}));
}

function showQuality(){
  if(!summary)return;
  showInfo('Качество и границы данных',`<div class="info-metric"><span>Набор</span><strong>${escapeHTML(summary.label)}</strong></div><div class="info-metric"><span>Несвязанные между собой части карты</span><strong>${summary.weak_components}</strong></div><div class="info-metric"><span>Группы связанных счетов</span><strong>${summary.cluster_count}</strong></div><div class="info-metric"><span>Счета без операций</span><strong>${summary.isolate_count}</strong></div>${summary.warnings.map(w=>`<div class="quality-item">${escapeHTML(w)}</div>`).join('')}<p class="muted">Проверены обязательные поля, идентификаторы, ссылки между таблицами, суммы в тиынах и число операций. В наборе нет проверенных экспертами ролей, поэтому точность определения ролей пока не измерена.</p>`);
}

function showMethod(){
  showInfo('Как устроен расчёт',`<p>Метод 1.1: документированные правила по наблюдаемому графу. Внешняя языковая модель не используется; помощник объясняет рассчитанные факты.</p><div class="quality-item"><strong>Приоритет:</strong> 35% положения в сети + 30% связей со стартовыми счетами + 20% объёма переводов + 15% признаков предполагаемой роли. Это очередь внимания, а не вероятность виновности.</div><div class="quality-item"><strong>Роли:</strong> сбор, распределение, транзит, предполагаемый конечный получатель, связующее звено и недостаток признаков. Для транзита нужны исходящие через 1–2 дня после входящих; для конечного получателя — повторные поступления от нескольких контрагентов в разные дни и окно наблюдения от 3 дней.</div><div class="quality-item"><strong>Граница:</strong> отсутствие исходящих на четвёртом колене не подтверждает остановку денег.</div><div class="quality-item"><strong>Сообщества:</strong> Алгоритм объединяет тесно связанные счета в группы. Группа не обязательно означает организацию. Направления переводов сохраняются на карте; подробные настройки приведены в README.</div><div class="quality-item"><strong>Воспроизводимость:</strong> версии, хеши файлов и параметры сохранены в manifest.json. Полные правила и ограничения описаны в README.</div>`);
}

document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('upload-button').addEventListener('click',()=>{$('upload-error').textContent='';$('upload-dialog').showModal();});
$('upload-form').addEventListener('submit',async event=>{
  event.preventDefault();$('analyze-button').disabled=true;$('analyze-button').textContent='Проверяем файлы и рассчитываем…';$('upload-error').textContent='';
  try{const data=await api('/api/analyze',{method:'POST',body:new FormData(event.target)});await activate(data);$('upload-dialog').close();}
  catch(error){$('upload-error').textContent=error.message;}
  finally{$('analyze-button').disabled=false;$('analyze-button').textContent='Проверить файлы и начать анализ';}
});
$('export-button').addEventListener('click',()=>{if(!runId)return;$('export-links').innerHTML=[['results.xlsx','Для Excel: все результаты, кириллица и точные номера счетов'],['nodes_roles.csv','CSV: роли и приоритеты всех счетов'],['clusters.csv','CSV: сообщества и гипотезы'],['top_nodes.csv','CSV: очередь проверки'],['manifest.json','Параметры и хеши исходных файлов']].map(([name,label])=>`<a class="export-link" href="/api/runs/${runId}/exports/${name}" download><span><strong>${name==='results.xlsx'?'Скачать для Excel (.xlsx)':name}</strong><br><small>${label}</small></span><span>↓</span></a>`).join('');$('export-dialog').showModal();});
$('quality-button').addEventListener('click',showQuality);$('method-button').addEventListener('click',showMethod);
$('reset-button').addEventListener('click',()=>api('/api/initial').then(activate).catch(showError));
$('fit-button').addEventListener('click',()=>cy&&cy.fit(undefined,40));
$('hops').addEventListener('change',()=>selectedId&&selectNode(selectedId).catch(showError));
$('expand-button').addEventListener('click',()=>{graphLimit=Math.min(graphLimit+30,400);selectNode(selectedId,true).catch(showError);});
let searchTimer;
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadList().catch(showError),180);});
['role-filter','cluster-filter'].forEach(id=>$(id).addEventListener('change',()=>loadList().catch(showError)));
window.addEventListener('resize',()=>{if(cy){cy.resize();cy.fit(undefined,40);}});
// workspace.js initializes the page after all interface modules have loaded.
