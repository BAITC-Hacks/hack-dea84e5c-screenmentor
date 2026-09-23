'use strict';

function graphShortIdentifiers(nodes){
  const result=new Map();
  // Extend ambiguous suffixes rather than give two visible accounts the same label.
  for(const node of nodes){
    let length=Math.min(6,node.gid.length);
    while(length<node.gid.length&&nodes.some(other=>other.gid!==node.gid&&other.gid.slice(-length)===node.gid.slice(-length)))length++;
    result.set(node.gid,(length<node.gid.length?'…':'')+node.gid.slice(-length));
  }
  return result;
}
function refreshGraphNavigation(){
  if(!work)return;
  for(const [target,source] of [['graph-back','account-back'],['graph-forward','account-forward']]){
    $(target).disabled=$(source).disabled;$(target).title=$(source).title;
  }
  const first=Math.max(0,work.index-2);
  const ids=graphShortIdentifiers([...new Set(work.history)].map(gid=>({gid})));
  $('graph-history').innerHTML=work.history.slice(first,work.index+1).map((gid,offset)=>{
    const index=first+offset, label=(work.labels[gid]||'Счёт')+' · '+ids.get(gid);
    return `<button type="button" class="graph-visit" data-history-index="${index}" title="${escapeHTML(gid)}" aria-label="${escapeHTML(label+'; полный номер '+gid)}" ${index===work.index?'aria-current="step" disabled':''}>${escapeHTML(label)}</button>`;
  }).join('<span aria-hidden="true">›</span>');
  $('graph-history').querySelectorAll('[data-history-index]').forEach(b=>{b.disabled=b.disabled||workBusy;b.addEventListener('click',()=>{const index=Number(b.dataset.historyIndex);selectNode(work.history[index],false,{historyIndex:index}).catch(showError);});});
}
function attachGraphNavigation(graph,gid){
  const chart=cy, lookup=new Map(graph.nodes.map(n=>[n.gid,n]));
  chart.nodes().toggleClass('labels-visible',$('graph-labels').checked);
  const clear=()=>{chart.elements().removeClass('inspected muted-connection');$('graph-tooltip').hidden=true;};
  chart.on('mouseover','node',event=>{
    const target=event.target, node=lookup.get(target.id());if(!node)return;
    const near=target.closedNeighborhood().add(chart.getElementById(gid));
    chart.batch(()=>{chart.elements().removeClass('inspected muted-connection');chart.elements().difference(near).addClass('muted-connection');near.addClass('inspected');});
    $('graph-tooltip').innerHTML=`<strong>${escapeHTML(roleName(node.role))}</strong><code>${escapeHTML(node.gid)}</code><span>От ${node.in_deg} счетов · на ${node.out_deg} счетов${node.truncated_by_depth?' · край выгрузки':''}</span><small>По всему набору. Нажмите, чтобы открыть этот счёт.</small>`;
    $('graph-tooltip').hidden=false;
  });
  chart.on('mouseout','node',clear);
  chart.on('pan zoom',clear);
  chart.on('tap',event=>{if(event.target===chart)clear();});
}
$('graph-back').addEventListener('click',()=>$('account-back').click());
$('graph-forward').addEventListener('click',()=>$('account-forward').click());
$('graph-direction').addEventListener('change',()=>selectedId&&selectNode(selectedId).catch(showError));
$('graph-labels').addEventListener('change',()=>{if(cy)cy.nodes().toggleClass('labels-visible',$('graph-labels').checked);saveWorkspaceView();});
$('less-graph').addEventListener('click',()=>{graphLimit=30;if(selectedId)selectNode(selectedId,true).catch(showError);});
