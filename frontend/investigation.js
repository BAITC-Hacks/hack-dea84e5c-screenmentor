'use strict';
let investigationState={version:0,gid:null,data:null,promise:null,tab:'paths'}, investigationTicket=0;
const featureLabels={structure:'Структура',seed_branches:'Стартовые ветви',observed_flow:'Оборот',role_signals:'Признаки роли'};

function resetInvestigation(gid){
  investigationState={version:investigationState.version+1,gid,run:runId,data:null,promise:null,tab:'paths'};
  investigationTicket++;
  $('investigation-gid').textContent=gid||'—';
  $('investigation-body').innerHTML='<div class="empty">'+(gid?'Загружаем разбор выбранного счёта…':'Выберите счёт для разбора.')+'</div>';
  const base=gid?`/api/runs/${runId}/nodes/${encodeURIComponent(gid)}/report`:null;
  for(const id of ['report-open','report-download']){
    if(base)$(id).href=base+(id==='report-download'?'?download=true':'');else $(id).removeAttribute('href');
  }
  setInvestigationTab('paths');
}
function setInvestigationTab(tab){
  investigationState.tab=tab;
  document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===tab)));
  $('investigation-body').setAttribute('aria-labelledby','tab-'+tab);
}
async function investigationData(){
  const state=investigationState;
  if(!state.gid)return null;
  if(!state.promise)state.promise=api(`/api/runs/${state.run}/nodes/${encodeURIComponent(state.gid)}/investigation`).then(data=>{state.data=data;return data;}).catch(error=>{state.promise=null;throw error;});
  const data=await state.promise;
  return state===investigationState?data:null;
}
function attachInvestigationActions(){
  const jump=document.createElement('button');jump.className='button primary analysis-jump';jump.textContent='Разобрать цепочки и основания ↓';jump.id='investigation-jump';
  jump.addEventListener('click',()=>{$('investigation-panel').scrollIntoView({behavior:'smooth',block:'start'});openInvestigationTab('paths').catch(showError);});
  $('node-detail').querySelector('.badges').after(jump);
  const kinds=['incoming','outgoing','incoming','outgoing','lagged'];
  $('node-detail').querySelectorAll('.fact').forEach((element,i)=>{
    if(!kinds[i])return;
    element.dataset.evidence=kinds[i];element.tabIndex=0;element.setAttribute('role','button');
    const open=()=>{$('investigation-panel').scrollIntoView({behavior:'smooth'});openInvestigationTab('evidence',kinds[i]).catch(showError);};
    element.addEventListener('click',open);element.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
  });
  openInvestigationTab('paths').catch(showError);
}
async function openInvestigationTab(tab,kind='incoming'){
  const ticket=++investigationTicket;
  setInvestigationTab(tab);
  $('investigation-body').innerHTML='<div class="empty">Готовим факты…</div>';
  const data=await investigationData();
  if(!data||ticket!==investigationTicket)return;
  if(tab==='paths')renderPaths(data);
  if(tab==='timeline')renderTimeline(data);
  if(tab==='evidence')renderEvidence(data,kind);
  if(tab==='stability'){
    const result=await api(`/api/runs/${runId}/nodes/${selectedId}/stability`);
    if(ticket===investigationTicket)renderStability(result);
  }
  if(tab==='assistant')renderAssistant();
}
function transactionTable(payments,limit=100){
  return `<p class="investigation-note">Показаны ${Math.min(limit,payments.length)} из ${payments.length} операций. Номер строки относится к исходному transactions.parquet.</p><div class="table-scroll"><table class="investigation-table"><thead><tr><th>Дата / источник</th><th>Отправитель → получатель</th><th>Сумма</th></tr></thead><tbody>${payments.slice(0,limit).map(t=>`<tr><td>${escapeHTML(t.date)}<br><button class="source-button" data-source-row="${t.source_row}">Строка ${t.source_row} ↗</button></td><td><code>${escapeHTML(t.src)}</code><br>→ <code>${escapeHTML(t.dst)}</code></td><td>${money(t.sum_kzt)}</td></tr>`).join('')||'<tr><td colspan="3">Подтверждающих операций нет.</td></tr>'}</tbody></table></div>`;
}
function bindSourceRows(payments,container=$('investigation-body')){
  const byRow=new Map(payments.map(t=>[String(t.source_row),t]));
  container.querySelectorAll('[data-source-row]').forEach(button=>button.addEventListener('click',()=>{
    const t=byRow.get(button.dataset.sourceRow);if(!t)return;
    showInfo('Исходная операция',`<p><strong>transactions.parquet · строка ${t.source_row}</strong></p><p><code>${escapeHTML(t.src)}</code><br>↓<br><code>${escapeHTML(t.dst)}</code></p><p>${escapeHTML(t.date)} · <strong>${money(t.sum_kzt)}</strong></p><p class="muted">Ссылка: <code>${escapeHTML(t.id)}</code><br>SHA-256 файла: <code style="overflow-wrap:anywhere">${escapeHTML(summary.hashes.transactions)}</code></p>`);
  }));
}
function renderPaths(data){
  $('investigation-body').innerHTML=`<p class="investigation-note">${escapeHTML(data.search_note)} Показаны ${data.shown} из ${data.candidate_count} рассмотренных маршрутов.</p>${data.paths.length?`<div class="path-layout"><div class="path-list">${data.paths.map((p,i)=>`<button class="path-option" data-path-index="${i}"><strong>${p.direction==='upstream'?'От стартового счёта':'От выбранного seed'} · ${p.edges.length} шаг.</strong><span class="path-status ${p.status}">${escapeHTML(p.status_label)}</span><small>…${escapeHTML(p.gids[0].slice(-8))} → …${escapeHTML(p.gids.at(-1).slice(-8))}</small></button>`).join('')}</div><div class="path-detail" id="path-detail"></div></div>`:'<div class="empty">Цепочки в пределах поиска не найдены. Можно проверить операции и полноту выгрузки.</div>'}<p class="investigation-note" style="margin-top:20px">${escapeHTML(data.temporal_note)}</p>`;
  $('investigation-body').querySelectorAll('[data-path-index]').forEach(button=>button.addEventListener('click',()=>renderPath(data,Number(button.dataset.pathIndex))));
  if(data.paths.length)renderPath(data,0);
}
function renderPath(data,index){
  const path=data.paths[index];
  $('investigation-body').querySelectorAll('[data-path-index]').forEach(b=>b.classList.toggle('active',Number(b.dataset.pathIndex)===index));
  $('path-detail').innerHTML=`<h3>Проверяем маршрут по конкретным операциям</h3><span class="path-status ${path.status}">${escapeHTML(path.status_label)}</span><div class="route-strip">${path.nodes.map((n,i)=>`<div class="route-account"><code>${escapeHTML(n.gid)}</code><small>${escapeHTML(n.role_label)}</small></div>${i<path.edges.length?`<div class="route-arrow"><b>→</b>${money(path.edges[i].sum_kzt)}<br>${path.edges[i].n_tx} оп.</div>`:''}`).join('')}</div><p class="investigation-note">Суммы на стрелках — весь оборот каждой пары за период. Их нельзя складывать как объём денег, прошедший всю цепочку.</p><div class="investigation-tools"><button class="button primary" id="highlight-path">Показать эту цепочку на графе ↑</button><button class="button" id="path-all-payments">Все операции связей</button></div><div id="path-payments">${path.sequence.length?'<p><strong>Один пример последовательности по датам:</strong></p>'+transactionTable(path.sequence):'<div class="quality-item">Для этого пути не существует даже последовательности с неубывающими датами. Связи есть, но предложенный порядок переводов не подтверждается.</div>'}</div>`;
  bindSourceRows(path.sequence,$('path-detail'));
  $('highlight-path').addEventListener('click',()=>{renderGraph({nodes:path.nodes,edges:path.edges,eligible:path.nodes.length,hidden:0,hops:path.edges.length,path_label:path.status_label},selectedId);$('graph').scrollIntoView({behavior:'smooth',block:'center'});});
  $('path-all-payments').addEventListener('click',()=>{$('path-payments').innerHTML=transactionTable(path.operations);bindSourceRows(path.operations,$('path-payments'));});
}
function renderTimeline(data){
  const maximum=Math.max(1,...data.timeline.flatMap(day=>[day.incoming,day.outgoing]));
  $('investigation-body').innerHTML=`<p class="investigation-note">Поступления и отправления выбранного счёта по календарным дням. Внутридневной порядок и остаток на счёте неизвестны. Показаны дни с операциями.</p><div class="table-scroll"><table class="investigation-table"><thead><tr><th>Дата</th><th>Входящие</th><th>Исходящие</th><th>Операции</th></tr></thead><tbody>${data.timeline.map(day=>`<tr><td>${escapeHTML(day.date)}</td><td>${money(day.incoming)}<div class="day-bar" style="width:${day.incoming/maximum*100}%"></div></td><td>${money(day.outgoing)}<div class="day-bar out" style="width:${day.outgoing/maximum*100}%"></div></td><td>${day.in_count} вход. / ${day.out_count} исх.</td></tr>`).join('')||'<tr><td colspan="4">Операции отсутствуют.</td></tr>'}</tbody></table></div>`;
}
function renderEvidence(data,kind){
  const group=data.evidence[kind];
  $('investigation-body').innerHTML=`<p class="investigation-note">Выберите факт: ниже появятся только операции, на которых он основан.</p><div class="investigation-tools">${Object.entries(data.evidence).map(([key,g])=>`<button class="evidence-fact ${key===kind?'active':''}" data-evidence-kind="${key}"><span>${escapeHTML(g.label)}</span><strong>${g.count}</strong>${g.counterparties===undefined?'':`<small>${g.counterparties} контрагентов</small>`}</button>`).join('')}</div><button id="highlight-evidence" class="button">Подсветить подтверждающие связи ↑</button>${kind==='lagged'?'<p class="investigation-note" style="margin-top:15px">Каждая исходящая операция учитывается один раз. Возможные входящие за 1–2 дня показаны отдельно; принадлежность средств не установлена.</p>':''}${transactionTable(group.transactions)}${kind==='lagged'?`<div class="investigation-tools">${group.pairs.slice(0,30).map((pair,i)=>`<button class="button" data-lag-pair="${i}">Строка ${pair.outgoing.source_row}: ${pair.possible_incoming.length} возможных входящих ↗</button>`).join('')}</div><p class="investigation-note">Кнопки для первых ${Math.min(30,group.pairs.length)} из ${group.pairs.length} временных сопоставлений.</p>`:''}`;
  $('investigation-body').querySelectorAll('[data-evidence-kind]').forEach(b=>b.addEventListener('click',()=>renderEvidence(data,b.dataset.evidenceKind)));
  $('highlight-evidence').addEventListener('click',()=>{renderGraph(group.graph,selectedId);$('graph').scrollIntoView({behavior:'smooth',block:'center'});});
  $('investigation-body').querySelectorAll('[data-lag-pair]').forEach(b=>b.addEventListener('click',()=>{
    const pair=group.pairs[Number(b.dataset.lagPair)];
    showInfo('Временная связь с исходящей операцией',`<p>Исходящая: строка ${pair.outgoing.source_row}, ${escapeHTML(pair.outgoing.date)}, ${money(pair.outgoing.sum_kzt)}. Предшествующие входящие:</p>${transactionTable(pair.possible_incoming)}`);
    bindSourceRows(pair.possible_incoming,$('info-body'));
  }));
  bindSourceRows(group.transactions);
}
function renderStability(data){
  const s=data.selected;
  $('investigation-body').innerHTML=`<p class="investigation-note">${escapeHTML(data.note)}</p><div class="stability-summary"><div>Базовое место<strong>${s.base_rank}</strong></div><div>Диапазон мест<strong>${s.min_rank}–${s.max_rank}</strong></div><div>В топ-${data.top_size} при изменениях<strong>${s.top_appearances} / ${s.scenario_count}</strong></div></div><div class="table-scroll"><table class="investigation-table"><thead><tr><th>Изменение веса</th><th>Место счёта</th><th>Совпадение с базовым топ-${data.top_size}</th></tr></thead><tbody>${data.scenarios.map(row=>`<tr><td>${featureLabels[row.feature]} ${row.multiplier<1?'−20%':'+20%'}</td><td>${row.selected_rank}</td><td>${row.overlap_count} / ${data.top_size}</td></tr>`).join('')}</tbody></table></div><h3>Сравнение с простыми очередями</h3><p class="investigation-note">Различие состава не доказывает превосходство метода. Ниже — дополнительные счета нашего топа для экспертной проверки.</p>${data.comparisons.map(c=>`<div class="quality-item"><strong>${escapeHTML(c.label)}</strong> · общих счетов ${c.overlap_count} из ${data.top_size}<div class="comparison-gids">${c.only_our_top.map(gid=>`<button class="text-button" data-compare-gid="${escapeHTML(gid)}">${escapeHTML(gid)} ↗</button>`).join('')||'Состав топа совпадает.'}</div></div>`).join('')}`;
  $('investigation-body').querySelectorAll('[data-compare-gid]').forEach(b=>b.addEventListener('click',()=>selectNode(b.dataset.compareGid).catch(showError)));
}
function renderAssistant(){
  $('investigation-body').innerHTML='<p class="investigation-note">Помощник по рассчитанным фактам · работает локально, без языковой модели. Выберите вопрос: ответ опирается на результаты текущего набора.</p><div class="assistant-topics"><button class="button" data-topic="priority">Почему такой приоритет?</button><button class="button" data-topic="role">Чем подтверждена роль?</button><button class="button" data-topic="chronology">Сходятся ли даты цепочек?</button><button class="button" data-topic="next">Что проверить дальше?</button></div><div id="assistant-response" aria-live="polite"></div>';
  let answerTicket=0;
  const state=investigationState,tabTicket=investigationTicket;
  $('investigation-body').querySelectorAll('[data-topic]').forEach(b=>b.addEventListener('click',async()=>{
    const ticket=++answerTicket;$('assistant-response').textContent='Готовим объяснение…';
    try{
      const answer=await api(`/api/runs/${state.run}/nodes/${state.gid}/assistant?topic=${b.dataset.topic}`);
      if(state!==investigationState||ticket!==answerTicket||tabTicket!==investigationTicket)return;
      $('assistant-response').innerHTML=`<div class="assistant-answer">${escapeHTML(answer.text)}</div><p class="investigation-note">Метод ${escapeHTML(answer.method_version)}. Примеры операций: ${answer.citations.length} из ${answer.total_citations}. Операции подтверждают наблюдения; полные правила рейтинга доступны в методологии.</p>${answer.citations.length?transactionTable(answer.citations):''}`;
      bindSourceRows(answer.citations,$('assistant-response'));
    }catch(error){if(state===investigationState&&tabTicket===investigationTicket)$('assistant-response').textContent=error.message;}
  }));
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>openInvestigationTab(button.dataset.tab).catch(showError)));
