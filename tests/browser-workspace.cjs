// Exercises persistent annotations, navigation, comparison, PNG and the guided demo.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const base=process.env.BASE_URL||'http://127.0.0.1:8765';

(async()=>{
  const python=process.env.PYTHON|| (process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const setup=spawnSync(python,['-c',[
    'from pathlib import Path','import pandas as pd','from backend.demo import create_demo',
    "a=create_demo(Path('artifacts/workspace-browser/input-a'))",
    "b=create_demo(Path('artifacts/workspace-browser/input-b'))",
    "for name in ['edges','transactions']:",
    " p=b/(name+'.parquet'); t=pd.read_parquet(p); t['sum_kzt']*=2; t.to_parquet(p,index=False)",
  ].join('\n')],{encoding:'utf8'});
  assert.equal(setup.status,0,setup.stderr);
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try{
    const context=await browser.newContext({viewport:{width:1600,height:1050}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('#highlight-path').waitFor();
    const initial=await (await context.request.get(base+'/api/initial')).json();
    const exported={};
    for(const name of ['nodes_roles.csv','clusters.csv','top_nodes.csv'])exported[name]=await (await context.request.get(`${base}/api/runs/${initial.run_id}/exports/${name}`)).body();
    const initialGid=await page.locator('.detail-id').textContent();
    // Working case annotations must survive a new synthetic demo tab.
    await page.locator('#favorite-account').click();
    await page.locator('#edit-note').click();
    const note='Запросить данные. <img src=x onerror="window.noteInjection=true">';
    await page.locator('#note-text').fill(note);await page.locator('#note-status').selectOption('need_data');
    await page.locator('#notes-dialog [data-close]').click();
    await page.locator('#saved-accounts').click();
    assert.match(await page.locator('#saved-list').textContent(),/Запросить данные/);
    assert.equal(await page.locator('#saved-list img').count(),0);
    await page.locator('#saved-dialog [data-close]').click();
    const popupPromise=page.waitForEvent('popup');await page.locator('.demo-link').click();const demo=await popupPromise;
    await demo.locator('#tour-next:not([disabled])').waitFor();
    assert.equal(await demo.locator('.detail-id').textContent(),'100000000000000011');
    assert.match(await demo.locator('#dataset-label').textContent(),/Синтетический/);
    assert.equal(await demo.locator('#saved-count').textContent(),initial.summary.synthetic?'1':'0');
    for(let step=2;step<=5;step++){
      if(step===3)await demo.setViewportSize({width:390,height:844});
      await demo.locator('#tour-next').click();
      await demo.waitForFunction(step=>document.querySelector('#tour-title').textContent.startsWith(step+' из 5')&&!document.querySelector('#tour-next').disabled,step);
      if(step===3){await demo.locator('[data-source-row]').first().click();assert.match(await demo.locator('#info-body').textContent(),/SHA-256/);await demo.locator('#info-dialog [data-close]').click();}
      if(step===4)assert.match(await demo.locator('.badges').textContent(),/Край выгрузки/);
      assert.ok(await demo.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Tour overflow');
    }
    await demo.locator('#tour-next').click();assert.equal(await demo.locator('#tour-panel').isVisible(),false);
    await demo.close();
    assert.equal(await page.locator('.detail-id').textContent(),initialGid);
    assert.equal(await page.evaluate(()=>runId),initial.run_id);
    // Restore selected account and filters, including after refreshing the tab.
    const first=await page.evaluate(()=>selectedDetail.node);
    await page.locator('#search').fill(first.gid);
    await page.locator('#role-filter').selectOption(first.role);
    await page.locator('#cluster-filter').selectOption(String(first.cluster_id));
    await page.locator('#hops').selectOption('2');await page.locator('#graph-loading').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelectorAll('.node-row').length===1);
    await page.reload();await page.locator('#highlight-path').waitFor();
    assert.equal(await page.locator('#search').inputValue(),first.gid);
    assert.equal(await page.locator('#role-filter').inputValue(),first.role);
    assert.equal(await page.locator('#cluster-filter').inputValue(),String(first.cluster_id));
    assert.equal(await page.locator('#hops').inputValue(),'2');
    assert.equal(await page.locator('#favorite-account').getAttribute('aria-pressed'),'true');
    await page.locator('#edit-note').click();assert.equal(await page.locator('#note-text').inputValue(),note);await page.locator('#notes-dialog [data-close]').click();
    await page.locator('#clear-filters').click();await page.waitForFunction(()=>document.querySelectorAll('.node-row').length>1);
    await page.locator('#add-comparison').click();
    const secondId=await page.locator('.node-row').nth(1).getAttribute('data-gid');
    await page.locator('.node-row').nth(1).click();await page.waitForFunction(id=>document.querySelector('.detail-id')?.textContent===id,secondId);
    await page.locator('#account-back').click();await page.waitForFunction(id=>document.querySelector('.detail-id')?.textContent===id,first.gid);
    await page.locator('#account-forward').click();await page.waitForFunction(id=>document.querySelector('.detail-id')?.textContent===id,secondId);
    await page.locator('#add-comparison').click();await page.locator('.comparison-table').waitFor();
    assert.equal(await page.locator('.comparison-table tbody tr').count(),11);
    assert.match(await page.locator('.comparison-table').textContent(),new RegExp(first.gid));
    assert.match(await page.locator('.comparison-table').textContent(),new RegExp(secondId));
    assert.equal(await page.locator('.comparison-table tbody tr').nth(2).locator('td').first().textContent(),String(first.rank));
    await page.locator('#compare-dialog').screenshot({path:'artifacts/workspace-browser/comparison.png'});
    await page.locator('#compare-dialog [data-close]').click();
    const downloadPromise=page.waitForEvent('download');await page.locator('#save-graph').click();const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),`graph-${secondId}.png`);
    await download.saveAs('artifacts/workspace-browser/graph.png');
    const png=fs.readFileSync('artifacts/workspace-browser/graph.png');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(png.readUInt32BE(16)>=900);
    // Same IDs in distinct real uploads must have independent annotations.
    async function upload(folder){
      const previous=await page.evaluate(()=>runId);await page.locator('#upload-button').click();
      for(const name of ['nodes','edges','transactions'])await page.locator(`input[name="${name}"]`).setInputFiles(path.resolve(folder,name+'.parquet'));
      await page.locator('#analyze-button').click();await page.waitForFunction(id=>runId!==id&&selectedDetail!==null,previous);await page.locator('#graph-loading').waitFor({state:'hidden'});
    }
    await upload('artifacts/workspace-browser/input-a');
    const aGid=await page.locator('.detail-id').textContent();
    await page.locator('#edit-note').click();await page.locator('#note-text').fill('Только набор A');await page.locator('#notes-dialog [data-close]').click();
    const aRun=await page.evaluate(()=>runId);await page.reload();await page.locator('.detail-id').waitFor();assert.equal(await page.evaluate(()=>runId),aRun);
    await upload('artifacts/workspace-browser/input-b');await page.evaluate(id=>selectNode(id),aGid);
    await page.locator('#edit-note').click();assert.equal(await page.locator('#note-text').inputValue(),'');await page.locator('#note-text').fill('Только набор B');await page.locator('#notes-dialog [data-close]').click();
    await upload('artifacts/workspace-browser/input-a');await page.evaluate(id=>selectNode(id),aGid);
    await page.locator('#edit-note').click();assert.equal(await page.locator('#note-text').inputValue(),'Только набор A');await page.locator('#notes-dialog [data-close]').click();
    await page.evaluate(()=>sessionStorage.setItem('moneygraph:active-run','0'.repeat(32)));
    await page.reload();await page.locator('.detail-id').waitFor();
    assert.equal(await page.evaluate(()=>runId),initial.run_id);
    assert.match(await page.locator('#workspace-status').textContent(),/Предыдущий запуск недоступен/);
    for(const name of Object.keys(exported))assert.deepEqual(await (await context.request.get(`${base}/api/runs/${initial.run_id}/exports/${name}`)).body(),exported[name]);
    assert.equal((await (await context.request.get(base+'/api/initial')).json()).run_id,initial.run_id);
    for(const width of [1600,1024,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow ${width}`);await page.screenshot({path:`artifacts/workspace-browser/page-${width}.png`,fullPage:true});}
    assert.deepEqual(errors,[]);
    // A blocked browser store must retain the current draft and report failure.
    const blocked=await browser.newContext();await blocked.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Blocked','QuotaExceededError');};});
    const blockedPage=await blocked.newPage();await blockedPage.goto(base);await blockedPage.locator('#edit-note').waitFor();await blockedPage.locator('#edit-note').click();await blockedPage.locator('#note-text').fill('Черновик');await blockedPage.locator('#note-status').selectOption('review');assert.match(await blockedPage.locator('#note-save-status').textContent(),/Не сохранено/);await blockedPage.locator('#notes-dialog [data-close]').click();await blockedPage.locator('#edit-note').click();assert.equal(await blockedPage.locator('#note-text').inputValue(),'Черновик');
    await blocked.close();
    console.log('Workspace passed: annotations, escaping, history, comparison, PNG, all tour steps, reload, upload restoration, same-ID dataset isolation, storage failure, responsive layout, unchanged CSV.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
