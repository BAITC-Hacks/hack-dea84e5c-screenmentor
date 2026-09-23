const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.BASE_URL||'http://127.0.0.1:8765');await page.locator('#highlight-path').waitFor();
    const first=await page.locator('.detail-id').textContent();
    assert.ok(await page.evaluate(()=>cy.nodes().length<=30));
    assert.equal(await page.locator('#graph-back').isDisabled(),true);
    assert.equal(await page.locator('#graph-labels').isChecked(),true);
    assert.ok(await page.evaluate(()=>cy.nodes().not('.focused').every(n=>n.style('text-opacity')==='1')));
    assert.ok(await page.locator('.brandmark img').evaluate(img=>img.complete&&img.naturalWidth>0));
    const next=await page.evaluate(()=>cy.nodes().not('.focused').sort((a,b)=>a.degree()-b.degree()).first().id());
    await page.evaluate(id=>cy.getElementById(id).emit('mouseover'),next);
    assert.match(await page.locator('#graph-tooltip').textContent(),new RegExp(next));
    assert.ok(await page.evaluate(()=>cy.elements('.muted-connection').length>0));
    await page.evaluate(id=>cy.getElementById(id).emit('mouseout'),next);
    assert.equal(await page.locator('#graph-tooltip').isVisible(),false);
    // Click the real canvas node, then use controls inside the graph panel.
    await page.locator('#graph').scrollIntoViewIfNeeded();
    const position=await page.evaluate(id=>cy.getElementById(id).renderedPosition(),next);
    await page.locator('#graph').click({position});
    await page.waitForFunction(id=>selectedDetail?.node.gid===id&&document.querySelector('#graph-loading').hidden,next);
    await page.locator('#graph-back').click();await page.waitForFunction(id=>selectedDetail?.node.gid===id,first);
    await page.locator('#graph-forward').click();await page.waitForFunction(id=>selectedDetail?.node.gid===id,next);
    await page.locator('[data-history-index="0"]').click();await page.waitForFunction(id=>selectedDetail?.node.gid===id,first);
    const historyLength=await page.evaluate(()=>work.history.length);
    for(const direction of ['incoming','outgoing']){
      await page.locator('#graph-direction').selectOption(direction);await page.locator('#graph-loading').waitFor({state:'hidden'});
      assert.ok(await page.evaluate(direction=>cy.edges().every(e=>e.data(direction==='incoming'?'target':'source')===selectedId),direction));
      assert.equal(await page.evaluate(()=>work.history.length),historyLength);
    }
    if(await page.locator('#expand-button').isVisible()){
      const before=await page.evaluate(()=>cy.nodes().length);await page.locator('#expand-button').click();await page.locator('#graph-loading').waitFor({state:'hidden'});
      assert.ok(await page.evaluate(count=>cy.nodes().length>count,before));
      await page.locator('#less-graph').click();await page.locator('#graph-loading').waitFor({state:'hidden'});assert.ok(await page.evaluate(()=>cy.nodes().length<=30));
    }
    await page.locator('#graph-labels').check();assert.ok(await page.evaluate(()=>cy.nodes().every(n=>n.hasClass('labels-visible'))));
    await page.reload();await page.locator('#highlight-path').waitFor();
    assert.equal(await page.locator('#graph-direction').inputValue(),'outgoing');assert.equal(await page.locator('#graph-labels').isChecked(),true);
    await page.locator('#graph-labels').uncheck();
    await page.reload();await page.locator('#highlight-path').waitFor();
    assert.equal(await page.locator('#graph-labels').isChecked(),false);
    assert.ok(await page.evaluate(()=>cy.nodes().not('.focused').every(n=>n.style('text-opacity')==='0')));
    // Previous release saved hidden labels by default. Migrate without losing navigation.
    await page.evaluate(()=>{const key=work.key+':view',saved=JSON.parse(localStorage.getItem(key));delete saved.graphLabelsVersion;localStorage.setItem(key,JSON.stringify(saved));});
    await page.reload();await page.locator('#highlight-path').waitFor();
    assert.equal(await page.locator('#graph-labels').isChecked(),true);
    assert.equal(await page.locator('#graph-direction').inputValue(),'outgoing');
    assert.equal(await page.locator('.detail-id').textContent(),first);
    assert.ok(await page.evaluate(()=>cy.nodes().not('.focused').every(n=>n.style('text-opacity')==='1')));
    await page.locator('#highlight-path').click();assert.equal(await page.locator('#graph-direction').isDisabled(),true);
    await page.locator('#return-neighborhood').click();await page.locator('#graph-loading').waitFor({state:'hidden'});assert.equal(await page.locator('#graph-direction').isDisabled(),false);
    assert.ok(await page.evaluate(()=>new Set(graphShortIdentifiers([{gid:'100000000000000001'},{gid:'200000000000000001'}]).values()).size===2));
    fs.mkdirSync('artifacts/graph-navigation',{recursive:true});
    await page.locator('#graph-direction').selectOption('all');await page.locator('#graph-loading').waitFor({state:'hidden'});
    await page.locator('#graph-labels').check();
    for(const width of [1600,1280,1024,390]){
      await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}`);
      await page.locator('.graph-panel').screenshot({path:`artifacts/graph-navigation/graph-${width}.png`});
      if(width===1600||width===390){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`artifacts/graph-navigation/brand-${width}.png`});}
    }
    assert.deepEqual(errors,[]);
    console.log('Graph navigation passed: canvas selection, back/forward, history links, incoming/outgoing, display limits, hover, labels, reload, focused-path return, short-ID collisions, responsive layout.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
