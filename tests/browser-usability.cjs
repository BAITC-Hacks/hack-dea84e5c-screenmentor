// New navigation and help controls; functional checks, not a user usability study.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1600,height:1050}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.BASE_URL||'http://127.0.0.1:8765');
    await page.locator('#highlight-path').waitFor();
    const gid=await page.locator('.detail-id').textContent();
    const initialRows=await page.locator('.node-row').count();
    await page.locator('[data-help="amount"]').click();
    assert.match(await page.locator('#info-body').textContent(),/20 000/);
    await page.keyboard.press('Escape');
    await page.locator('#role-filter').selectOption('terminal');
    await page.locator('#search').fill('999999999999999999999');
    await page.waitForFunction(()=>document.querySelectorAll('.node-row').length===0);
    await page.locator('#clear-filters').click();
    await page.waitForFunction(count=>document.querySelectorAll('.node-row').length===count,initialRows);
    assert.equal(await page.locator('#search').inputValue(),'');
    assert.equal(await page.locator('#role-filter').inputValue(),'');
    const original=await page.evaluate(()=>cy.zoom());
    await page.locator('#zoom-in').click();
    assert.ok(await page.evaluate(previous=>cy.zoom()>previous,original));
    await page.locator('#zoom-out').click();
    assert.ok(Math.abs(await page.evaluate(()=>cy.zoom())-original)<0.00001);
    await page.evaluate(()=>cy.pan({x:99999,y:99999}));
    await page.locator('#fit-button').click();
    assert.ok(await page.evaluate(()=>{
      const b=cy.elements().renderedBoundingBox();
      return b.x1>=-1&&b.y1>=-1&&b.x2<=cy.width()+1&&b.y2<=cy.height()+1;
    }),'Fit keeps every displayed element within the map');
    await page.locator('.graph-key summary').click();
    await page.waitForFunction(()=>Math.abs(cy.height()-document.querySelector('#graph').clientHeight)<2);
    assert.equal(await page.locator('.graph-legend span').count(),6);
    await page.locator('#highlight-path').click();
    assert.equal(await page.locator('#return-neighborhood').isVisible(),true);
    await page.locator('#return-neighborhood').click();
    await page.waitForFunction(()=>document.querySelector('#return-neighborhood').hidden);
    assert.equal(await page.locator('.detail-id').textContent(),gid);
    await page.locator('.score-details summary').click();
    assert.ok(await page.locator('.contribution').first().isVisible());
    await page.locator('#tab-paths').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-timeline').getAttribute('aria-selected'),'true');
    await page.locator('.day-bar').first().waitFor();
    const downloadPromise=page.waitForEvent('download');
    await page.locator('[data-workflow="export"]').click();
    const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),'results.xlsx');
    assert.equal(await download.failure(),null);
    const popupPromise=page.waitForEvent('popup');
    await page.locator('.guide-link').click();
    const guide=await popupPromise;await guide.waitForLoadState();
    assert.equal(await guide.locator('main h2').count(),13);
    await guide.locator('nav a').last().click();
    assert.match(guide.url(),/#section-13$/);
    assert.match(await guide.locator('main').textContent(),/не означает 90%/);
    fs.mkdirSync('artifacts/browser',{recursive:true});
    await guide.goto(new URL('/static/guide.html',page.url()).href);
    await guide.screenshot({path:'artifacts/browser/guide-desktop.png'});
    for(const width of [1600,1280,1024,768,390]){
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}px`);
      assert.ok(await page.locator('.graph-key').evaluate(el=>el.getBoundingClientRect().bottom<=el.closest('.graph-panel').getBoundingClientRect().bottom+1),`Legend clipped at ${width}px`);
      await page.locator('#workspace').screenshot({path:`artifacts/browser/workspace-${width}.png`});
    }
    await guide.setViewportSize({width:390,height:844});
    assert.ok(await guide.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Guide mobile overflow');
    await guide.screenshot({path:'artifacts/browser/guide-mobile.png'});
    assert.deepEqual(errors,[]);
    console.log('Navigation checks passed: help, filters, zoom, fit, legend resize, graph return, calculations, keyboard tabs, export, guide, five screen widths.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
