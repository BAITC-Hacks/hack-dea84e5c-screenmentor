'use strict';
const helpContent={
  accounts:['Счета в наборе','Количество записей из списка счетов. В него входят и счета, для которых в выгрузке нет операций. Стартовые счета — точки, с которых начался сбор связей. Это не означает установленного нарушения.'],
  payments:['Операции и связи','Операция — один перевод с датой и суммой. Связь — направление от одного счёта к другому за весь период. Пять переводов от A к B дадут пять операций и одну связь.'],
  amount:['Сумма всех переводов','Если 10 000 ₸ перевели от A к B, затем от B к C, сумма операций будет 20 000 ₸. Поэтому показатель нельзя считать размером ущерба или объёмом уникальных денег.'],
  boundary:['Почему продолжение переводов неизвестно','Выгрузка заканчивается после четырёх переходов от стартовых счетов. На этой границе отсутствие исходящих операций может означать, что продолжение не попало в данные. Система не присваивает роль конечного получателя только из-за такого обрыва.'],
};
document.querySelectorAll('[data-help]').forEach(button=>button.addEventListener('click',()=>{const [title,body]=helpContent[button.dataset.help];showInfo(title,`<p>${escapeHTML(body)}</p>`);}));
$('clear-filters').addEventListener('click',()=>{$('search').value='';$('role-filter').value='';$('cluster-filter').value='';loadList().catch(showError);});
document.querySelectorAll('[data-workflow]').forEach(button=>button.addEventListener('click',()=>{
  if(button.dataset.workflow==='select'){$('workspace').scrollIntoView({behavior:'smooth'});$('search').focus({preventScroll:true});}
  if(button.dataset.workflow==='inspect')$('investigation-panel').scrollIntoView({behavior:'smooth'});
  if(button.dataset.workflow==='export')$('export-button').click();
}));
function zoomGraph(factor){if(cy)cy.zoom({level:Math.min(cy.maxZoom(),Math.max(cy.minZoom(),cy.zoom()*factor)),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});}
$('zoom-in').addEventListener('click',()=>zoomGraph(1.3));
$('zoom-out').addEventListener('click',()=>zoomGraph(1/1.3));
$('return-neighborhood').addEventListener('click',()=>selectedId&&selectNode(selectedId).catch(showError));
const analysisTabs=[...document.querySelectorAll('[data-tab]')];
// The legend changes the canvas size without a window resize. Keep coordinates accurate.
new ResizeObserver(()=>{if(cy)cy.resize();}).observe($('graph'));
analysisTabs.forEach((button,index)=>button.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const target=event.key==='Home'?0:event.key==='End'?analysisTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+analysisTabs.length)%analysisTabs.length;
  analysisTabs[target].focus();analysisTabs[target].click();
}));
