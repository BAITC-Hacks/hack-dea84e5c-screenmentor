// Run against a local server. Optional env: BASE_URL, PLAYWRIGHT_MODULE, CHROMIUM_PATH.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    const errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8765');
    await page.locator('.detail-id').waitFor();
    await page.locator('#graph-loading').waitFor({state:'hidden'});
    assert.equal(await page.locator('#message').isVisible(), false);
    const gid = await page.locator('.detail-id').textContent();
    assert.match(gid, /^\d{16,}$/);
    await page.locator('#search').fill(gid);
    await page.waitForFunction(()=>document.querySelectorAll('.node-row').length===1);
    assert.equal(await page.locator('.node-row').getAttribute('data-gid'),gid);
    await page.locator('#show-payments').click();
    assert.ok(await page.locator('.proof-table tbody tr').count()>0);
    await page.locator('#info-dialog [data-close]').click();
    await page.locator('#hops').selectOption('2');
    await page.locator('#graph-loading').waitFor({state:'hidden'});
    const excelDownloadPromise=page.waitForEvent('download');
    await page.locator('#export-button').click();
    const excelDownload=await excelDownloadPromise;
    assert.equal(excelDownload.suggestedFilename(),'results.xlsx');
    assert.equal(await excelDownload.failure(),null);
    await page.locator('#export-options-button').click();
    assert.equal(await page.locator('.export-link').count(),5);
    assert.equal(await page.locator('.export-link:visible').count(),1);
    const downloadPromise=page.waitForEvent('download');
    await page.locator('.export-link').first().click();
    const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),'results.xlsx');
    assert.equal(await download.failure(),null);
    await page.locator('.technical-exports summary').click();
    assert.equal(await page.locator('.export-link:visible').count(),5);
    assert.match(await page.locator('.csv-format-note').textContent(),/не хранит границы/);
    await page.locator('#export-dialog [data-close]').click();
    await page.locator('#search').fill('999999999999999999999');
    await page.waitForFunction(()=>document.querySelectorAll('.node-row').length===0);
    await page.locator('#search').fill('');
    await page.waitForFunction(()=>document.querySelectorAll('.node-row').length>0);
    fs.mkdirSync('artifacts/browser',{recursive:true});
    await page.screenshot({path:'artifacts/browser/desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Mobile horizontal overflow');
    await page.screenshot({path:'artifacts/browser/mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Browser smoke passed: load, exact search, evidence, graph, direct XLSX download, separate CSV options, empty search, mobile width; no page errors.');
  } finally {
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
