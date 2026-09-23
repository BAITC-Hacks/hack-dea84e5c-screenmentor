'use strict';
// Analyst annotations are separate from server calculations and keyed by input hashes.
const workStatuses={'':'Не отмечен',review:'Проверить',need_data:'Нужны данные',viewed:'Просмотрен'};
const validGid=value=>typeof value==='string'&&/^\d{1,64}$/.test(value);
let work=null, workBusy=false, comparisonTicket=0, noteTarget=null, tourStep=0, tourTicket=0;
const memoryStorage=new Map();
const unsavedKeys=new Set();

function storageRead(key,fallback){
  if(unsavedKeys.has(key))return memoryStorage.get(key)||fallback;
  try {const raw=localStorage.getItem(key);return raw?JSON.parse(raw):fallback;}
  catch{return memoryStorage.get(key)||fallback;}
}
function storageWrite(key,value){
  memoryStorage.set(key,value);
  try{localStorage.setItem(key,JSON.stringify(value));unsavedKeys.delete(key);return true;}
  catch{unsavedKeys.add(key);$('workspace-status').hidden=false;$('workspace-status').textContent='Браузер не смог сохранить данные. Новые отметки и настройки доступны только до закрытия страницы.';return false;}
}
function cleanedNotes(raw){
  const result=Object.create(null);
  if(!raw||typeof raw!=='object')return result;
  for(const [gid,value] of Object.entries(raw)){
    if(!validGid(gid)||!value||typeof value!=='object')continue;
    result[gid]={favorite:value.favorite===true,status:Object.hasOwn(workStatuses,value.status)?value.status:'',text:typeof value.text==='string'?value.text.slice(0,4000):''};
  }
  return result;
}
function readWorkNotes(){return work?cleanedNotes(storageRead(work.key+':notes',work.notes)):Object.create(null);}
function beginWorkspace(data){
  comparisonTicket++;noteTarget=null;
  if(!$('tour-panel').hidden)endTour();
  if(!data.summary.synthetic){const url=new URL(location.href);url.searchParams.delete('demo');url.searchParams.delete('tour');history.replaceState(null,'',url);}
  for(const id of ['notes-dialog','saved-dialog','compare-dialog'])$(id).close();
  const key='moneygraph:workspace:v1:'+['nodes','edges','transactions'].map(name=>data.summary.hashes[name]).join(':');
  work={key,notes:cleanedNotes(storageRead(key+':notes',{})),history:[],index:-1,compare:[]};
  $('workspace-status').hidden=true;
  try{if(!new URLSearchParams(location.search).has('demo'))sessionStorage.setItem('moneygraph:active-run',data.run_id);}catch{}
  refreshWorkTools();
}
function restoreWorkspaceView(){
  const saved=storageRead(work.key+':view',{});
  if(!saved||typeof saved!=='object')return null;
  $('search').value=typeof saved.query==='string'?saved.query.slice(0,100):'';
  for(const [id,field] of [['role-filter','role'],['cluster-filter','cluster'],['hops','hops']]){
    if([...$(id).options].some(o=>o.value===saved[field]))$(id).value=saved[field];
  }
  work.history=Array.isArray(saved.history)?saved.history.filter(validGid).slice(-30):[];
  work.index=Number.isInteger(saved.index)?Math.min(Math.max(saved.index,-1),work.history.length-1):-1;
  work.compare=Array.isArray(saved.compare)?[...new Set(saved.compare.filter(validGid))].slice(0,2):[];
  refreshWorkTools();
  return validGid(saved.selected)?saved.selected:null;
}
function saveWorkspaceView(){
  if(!work)return;
  storageWrite(work.key+':view',{query:$('search').value,role:$('role-filter').value,cluster:$('cluster-filter').value,hops:$('hops').value,selected:selectedDetail?.node.gid||work.history[work.index]||null,history:work.history,index:work.index,compare:work.compare});
}
function setWorkspaceBusy(value){workBusy=value;refreshWorkTools();}
function workspaceSelected(detail,navigation){
  const gid=detail.node.gid;
  if(Number.isInteger(navigation.historyIndex)&&work.history[navigation.historyIndex]===gid)work.index=navigation.historyIndex;
  else if(!(navigation.restore&&work.history[work.index]===gid)&&work.history[work.index]!==gid){
    work.history=work.history.slice(0,work.index+1);work.history.push(gid);work.history=work.history.slice(-30);work.index=work.history.length-1;
  }
  saveWorkspaceView();refreshWorkTools();
}
function refreshWorkTools(){
  if(!work)return;
  $('account-back').disabled=workBusy||work.index<=0;
  $('account-forward').disabled=workBusy||work.index>=work.history.length-1;
  $('account-back').title=work.index>0?'К счёту '+work.history[work.index-1]:'Нет предыдущего счёта';
  $('account-forward').title=work.index<work.history.length-1?'К счёту '+work.history[work.index+1]:'Нет следующего счёта';
  $('save-graph').disabled=workBusy||!selectedDetail||!cy;
  $('saved-count').textContent=String(Object.keys(work.notes).length);
  $('compare-count').textContent=`${work.compare.length} / 2`;
  const favorite=$('favorite-account'),compare=$('add-comparison');
  if(favorite){const active=Boolean(work.notes[selectedId]?.favorite);favorite.textContent=active?'★ В избранном':'☆ В избранное';favorite.setAttribute('aria-pressed',String(active));}
  if(compare){const active=work.compare.includes(selectedId);compare.textContent=active?'✓ В сравнении':'＋ Сравнить';compare.setAttribute('aria-pressed',String(active));}
  const noteSummary=$('account-note-summary');
  if(noteSummary){const note=work.notes[selectedId];noteSummary.hidden=!(note?.status||note?.text);noteSummary.textContent=note?'Моя отметка: '+workStatuses[note.status]+(note.text?' · есть заметка':''):'';}
  decorateSavedAccounts();
}
function decorateSavedAccounts(){
  if(!work)return;
  $('node-list').querySelectorAll('[data-gid]').forEach(row=>{
    const note=work.notes[row.dataset.gid];row.classList.toggle('bookmarked',Boolean(note?.favorite));
    row.title=row.dataset.gid+(note?.favorite?' · В избранном':'')+(note?.status?' · '+workStatuses[note.status]:'');
  });
}
function changeNote(gid,patch){
  work.notes=readWorkNotes();
  const value={favorite:false,status:'',text:'',...work.notes[gid],...patch};
  if(!value.favorite&&!value.status&&!value.text.trim())delete work.notes[gid];else work.notes[gid]=value;
  const saved=storageWrite(work.key+':notes',work.notes);refreshWorkTools();return saved;
}
function attachAccountTools(detail){
  const tools=document.createElement('div');tools.className='account-tools';
  tools.innerHTML='<button class="button" id="favorite-account">☆ В избранное</button><button class="button" id="edit-note">Заметка</button><button class="button" id="add-comparison">＋ Сравнить</button>';
  $('node-detail').querySelector('.badges').after(tools);
  const noteSummary=document.createElement('p');noteSummary.id='account-note-summary';noteSummary.hidden=true;tools.after(noteSummary);
  $('favorite-account').addEventListener('click',()=>changeNote(detail.node.gid,{favorite:!readWorkNotes()[detail.node.gid]?.favorite}));
  $('edit-note').addEventListener('click',()=>openNote(detail.node.gid));
  $('add-comparison').addEventListener('click',()=>{
    const gid=detail.node.gid;
    if(work.compare.includes(gid))work.compare=work.compare.filter(id=>id!==gid);
    else if(work.compare.length<2)work.compare.push(gid);
    else{showComparison().catch(showError);return;}
    saveWorkspaceView();refreshWorkTools();
    if(work.compare.length===2)showComparison().catch(showError);
  });
  refreshWorkTools();
}
function openNote(gid){
  work.notes=readWorkNotes();noteTarget={key:work.key,gid};
  const value=work.notes[gid]||{};
  $('notes-gid').textContent=gid;$('note-status').value=value.status||'';$('note-text').value=value.text||'';
  $('note-save-status').textContent='Изменения сохраняются автоматически в этом браузере.';
  $('notes-dialog').showModal();
}
function saveNoteEditor(){
  if(!noteTarget||noteTarget.key!==work?.key)return;
  const saved=changeNote(noteTarget.gid,{status:$('note-status').value,text:$('note-text').value});
  $('note-save-status').textContent=saved?'Сохранено в этом браузере.':'Не сохранено на устройстве. Скопируйте текст перед закрытием страницы.';
}
function showSavedAccounts(){
  work.notes=readWorkNotes();refreshWorkTools();
  const rows=Object.entries(work.notes).sort((a,b)=>Number(b[1].favorite)-Number(a[1].favorite)||a[0].localeCompare(b[0]));
  $('saved-list').innerHTML=rows.length?rows.map(([gid,n])=>`<div class="saved-item"><button class="text-button saved-select" data-saved-gid="${escapeHTML(gid)}">${n.favorite?'★ ':''}${escapeHTML(gid)} ↗</button><span>${escapeHTML(workStatuses[n.status])}</span><p>${escapeHTML(n.text)||'Без комментария'}</p></div>`).join(''):'<p>Пока нет отметок. Откройте счёт и нажмите «В избранное» или «Заметка».</p>';
  $('saved-list').querySelectorAll('[data-saved-gid]').forEach(b=>b.addEventListener('click',()=>{$('saved-dialog').close();selectNode(b.dataset.savedGid).then(()=>$('node-detail').scrollIntoView({behavior:'smooth',block:'center'})).catch(showError);}));
  $('saved-dialog').showModal();
}
async function showComparison(){
  if(!work)return;
  const ticket=++comparisonTicket, currentRun=runId, ids=[...work.compare];
  if(!$('compare-dialog').open)$('compare-dialog').showModal();
  $('compare-body').innerHTML='<p>Загружаем рассчитанные показатели…</p>';
  try{
    const details=await Promise.all(ids.map(gid=>api(`/api/runs/${currentRun}/nodes/${encodeURIComponent(gid)}`)));
    if(ticket!==comparisonTicket||currentRun!==runId)return;
    const removeButtons=ids.map(id=>`<button class="button" data-remove-comparison="${escapeHTML(id)}">Убрать ${escapeHTML(id)}</button>`).join('');
    if(details.length<2)$('compare-body').innerHTML=`<p>Выбрано ${details.length} из 2 счетов. Закройте окно, откройте нужный счёт и нажмите «＋ Сравнить» в его карточке.</p><div class="comparison-actions">${removeButtons}</div>`;
    else{
      const fields=[['Предполагаемая роль',d=>roleName(d.node.role)],['Приоритет, баллы из 100',d=>String(Math.round(d.node.priority_score*100))],['Место в очереди',d=>String(d.node.rank)],['Счетов-отправителей',d=>String(d.node.in_deg)],['Счетов-получателей',d=>String(d.node.out_deg)],['Получено по выгрузке',d=>d.node.facts[2].value],['Отправлено по выгрузке',d=>d.node.facts[3].value],['Исходящих через 1–2 дня',d=>String(d.node.lagged_out_tx)],['Стартовых счетов, откуда есть путь',d=>String(d.node.seed_branches)],['Что проверить дальше',d=>d.node.next_checks.join('\n')],['Ограничения',d=>d.node.limitations.join('\n').replace('out/in','отношение отправлений к поступлениям')]];
      $('compare-body').innerHTML=`<p>Показатели из одной выгрузки: ${escapeHTML(summary.label)}, ${escapeHTML(summary.period_start)} — ${escapeHTML(summary.period_end)}. Баллы помогают выбрать порядок проверки; большее значение не означает установленное нарушение.</p><div class="table-scroll"><table class="comparison-table"><thead><tr><th>Показатель</th>${ids.map(id=>`<th><button class="text-button" data-open-comparison="${escapeHTML(id)}">${escapeHTML(id)} ↗</button></th>`).join('')}</tr></thead><tbody>${fields.map(([label,value])=>`<tr><th>${label}</th>${details.map(d=>`<td>${escapeHTML(value(d))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="comparison-actions">${removeButtons}</div>`;
    }
    $('compare-body').querySelectorAll('[data-remove-comparison]').forEach(b=>b.addEventListener('click',()=>{work.compare=work.compare.filter(id=>id!==b.dataset.removeComparison);saveWorkspaceView();refreshWorkTools();showComparison().catch(showError);}));
    $('compare-body').querySelectorAll('[data-open-comparison]').forEach(b=>b.addEventListener('click',()=>{$('compare-dialog').close();selectNode(b.dataset.openComparison).catch(showError);}));
  }catch(error){if(ticket===comparisonTicket){$('compare-body').innerHTML=`<p>${escapeHTML(error.message)}</p><button class="button" id="clear-comparison">Очистить сравнение</button>`;$('clear-comparison').onclick=()=>{work.compare=[];saveWorkspaceView();refreshWorkTools();showComparison().catch(showError);};}}
}

async function saveGraphImage(){
  if(!cy||!selectedDetail||workBusy)return;
  const gid=selectedId, chart=cy.png({full:false,scale:2,bg:'#182a3b'});
  const title=`Счёт ${gid} · ${summary.label}`;
  const subtitle=`${summary.period_start} — ${summary.period_end} · ${$('graph-count').textContent}`;
  const mode=$('graph-subtitle').textContent;
  const snapshot=new Image();snapshot.src=chart;await snapshot.decode();
  const width=Math.max(900,snapshot.width), canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=snapshot.height+270;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#182a3b';ctx.fillRect(0,0,width,canvas.height);
  ctx.fillStyle='#eef8f6';ctx.font='bold 22px Arial';ctx.fillText(title,24,34,width-48);
  ctx.font='17px Arial';ctx.fillText(subtitle,24,65,width-48);ctx.fillText(mode,24,93,width-48);
  ctx.drawImage(snapshot,(width-snapshot.width)/2,112);
  Object.entries(roleNames).forEach(([role,name],i)=>{const x=24+(i%3)*(width-48)/3,y=canvas.height-120+Math.floor(i/3)*30;ctx.fillStyle=colors[role];ctx.fillRect(x,y-12,10,10);ctx.fillStyle='#d4e5ed';ctx.font='15px Arial';ctx.fillText(name,x+18,y,(width-48)/3-25);});
  ctx.fillStyle='#b7cdd7';ctx.font='14px Arial';ctx.fillText('Ромб — стартовый счёт. Пунктир — край выгрузки. Светлая рамка — выбранный счёт.',24,canvas.height-50,width-48);
  ctx.fillStyle='#b7cdd7';ctx.font='14px Arial';ctx.fillText('Снимок видимой области. Цвет — гипотеза роли. Подписи узлов сокращены; оценки не доказывают нарушение.',24,canvas.height-22,width-48);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('Не удалось сохранить изображение.');
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`graph-${gid}.png`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}

const tourSteps=[
  {title:'1 из 5 · Откуда приходят деньги',text:'Это искусственный пример. На выбранный счёт приходят переводы от трёх стартовых счетов. Посмотрите отправителей и объяснение в карточке: предполагаемая роль учитывает также последующие отправления.',gid:'100000000000000011',target:'#node-detail'},
  {title:'2 из 5 · Проверьте последовательность',text:'На следующем счёте есть поступления и отправления. Посмотрите цепочку от стартового счёта и даты отдельных операций. Подходящие даты не доказывают передачу тех же денег.',gid:'100000000000000012',tab:'paths',target:'#investigation-panel'},
  {title:'3 из 5 · Откройте исходную строку',text:'Нажмите «Строка …» в таблице: увидите отправителя, получателя, дату, сумму и ссылку на исходный файл. Закройте окно операции, чтобы продолжить обучение.',gid:'100000000000000012',tab:'evidence',target:'#investigation-panel'},
  {title:'4 из 5 · Заметьте границу выгрузки',text:'Этот счёт находится на четвёртом переходе. Исходящих в примере нет, но считать его конечным получателем только по этому признаку нельзя. Прочитайте ограничения и следующий запрос данных.',gid:'100000000000000101',target:'#node-detail'},
  {title:'5 из 5 · Сохраните проверяемый результат',text:'Откройте справку по счёту ниже или скачайте таблицы через «Скачать результаты». В справке есть основания и ограничения. Рабочая выгрузка осталась в прежней вкладке.',gid:'100000000000000012',tab:'paths',target:'#investigation-panel'},
];
async function showTourStep(index){
  const ticket=++tourTicket;tourStep=index;const step=tourSteps[index];
  $('tour-panel').hidden=false;$('tour-title').textContent=step.title;$('tour-description').textContent=step.text;$('tour-error').hidden=true;
  $('tour-back').disabled=true;$('tour-next').disabled=true;
  try{
    await selectNode(step.gid);
    if(ticket!==tourTicket)return;
    if(step.tab)await openInvestigationTab(step.tab);
    if(ticket!==tourTicket)return;
    const target=document.querySelector(step.target);
    target.scrollIntoView({behavior:'smooth',block:'center'});
    if(index===3)$('node-detail').querySelector('.limitations').scrollIntoView({behavior:'smooth',block:'center'});
  }catch(error){if(ticket===tourTicket){$('tour-error').hidden=false;$('tour-error').textContent=error.message;}}
  finally{if(ticket===tourTicket){$('tour-back').disabled=index===0;$('tour-next').disabled=false;$('tour-next').textContent=index===tourSteps.length-1?'Завершить':'Далее →';}}
}
function endTour(){tourTicket++;$('tour-panel').hidden=true;const url=new URL(location.href);url.searchParams.delete('tour');history.replaceState(null,'',url);}
async function initializeWorkspace(){
  const params=new URLSearchParams(location.search);let data,restoreMessage='';
  if(params.has('demo'))data=await api('/api/demo');
  else{
    let previous;try{previous=sessionStorage.getItem('moneygraph:active-run');}catch{}
    if(previous&&/^[a-f0-9]{32}$/.test(previous)){
      try{data=await api(`/api/runs/${previous}`);}catch{restoreMessage='Предыдущий запуск недоступен. Открыт исходный набор. Для загруженных ранее файлов повторите загрузку; заметки сохраняются для той же выгрузки.';}
    }
    if(!data)data=await api('/api/initial');
  }
  await activate(data);
  if(restoreMessage){$('workspace-status').hidden=false;$('workspace-status').textContent=restoreMessage;}
  if(params.has('demo')&&params.has('tour')&&summary.synthetic)await showTourStep(0);
}
$('account-back').addEventListener('click',()=>{const index=work.index-1;if(index>=0)selectNode(work.history[index],false,{historyIndex:index}).catch(showError);});
$('account-forward').addEventListener('click',()=>{const index=work.index+1;if(index<work.history.length)selectNode(work.history[index],false,{historyIndex:index}).catch(showError);});
$('saved-accounts').addEventListener('click',showSavedAccounts);
$('compare-accounts').addEventListener('click',()=>showComparison().catch(showError));
$('save-graph').addEventListener('click',()=>saveGraphImage().catch(showError));
$('note-text').addEventListener('input',saveNoteEditor);$('note-status').addEventListener('change',saveNoteEditor);
$('clear-note').addEventListener('click',()=>{$('note-text').value='';$('note-status').value='';saveNoteEditor();});
$('tour-back').addEventListener('click',()=>showTourStep(Math.max(0,tourStep-1)));
$('tour-next').addEventListener('click',()=>tourStep===tourSteps.length-1?endTour():showTourStep(tourStep+1));
$('tour-close').addEventListener('click',endTour);
initializeWorkspace().catch(showError);
