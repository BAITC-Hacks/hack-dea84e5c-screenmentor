// Documentation screenshots always use the isolated synthetic dataset.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
  const out=path.resolve(__dirname,'../docs/images');fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1.5});
    await page.goto((process.env.BASE_URL||'http://127.0.0.1:8765')+'/?demo=1');
    await page.locator('#highlight-path').waitFor();
    if(!await page.evaluate(()=>summary.synthetic))throw Error('Report images must use synthetic data');
    // Choose a connected example from calculated metrics, not a private case ID.
    await page.evaluate(async()=>{
      const all=await api(`/api/runs/${runId}/nodes?limit=1000`);
      const target=all.items.sort((a,b)=>b.out_deg-a.out_deg)[0];
      await selectNode(target.gid);
    });
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:path.join(out,'overview.png')});
    await page.locator('#fit-button').click();
    await page.locator('.graph-panel').screenshot({path:path.join(out,'graph.png')});
    const diagram=await browser.newPage({viewport:{width:1200,height:530},deviceScaleFactor:1.5});
    await diagram.setContent(`<!doctype html><html lang="ru"><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:28px;background:white;color:#152d3e;font-family:Arial,sans-serif}h1{font-size:23px;margin:0 0 28px}.steps{display:flex;align-items:center;gap:16px}.step{flex:1;border:1px solid #c5d6df;border-top:5px solid #147e68;border-radius:10px;padding:22px 17px;min-height:192px;background:#f6faf9}strong{font-size:21px;display:block;margin:6px 0 13px}.step p{font-size:17px;line-height:1.55;margin:0;color:#456170}.number{font-size:14px;color:#147e68;font-weight:bold}.arrow{font-size:27px;color:#7594a4}.outputs{margin:27px 0 0;display:flex;gap:24px}.output{flex:1;border-top:2px solid #d3e0e6;padding-top:15px;font-size:18px;line-height:1.5}.output b{display:block;margin-bottom:4px;color:#102e45}.foot{margin-top:24px;font-size:16px;color:#56707c}
      </style><h1>От исходных файлов до проверяемого результата</h1><div class="steps">
      <div class="step"><span class="number">01 ВХОД</span><strong>Три Parquet</strong><p>Счета<br>Связи<br>Операции</p></div><span class="arrow">→</span>
      <div class="step"><span class="number">02 ПРОВЕРКА</span><strong>Качество данных</strong><p>Схемы и ссылки<br>Суммы и количества<br>SHA-256 файлов</p></div><span class="arrow">→</span>
      <div class="step"><span class="number">03 АНАЛИЗ</span><strong>Граф и признаки</strong><p>Центральности<br>Сообщества<br>Временные признаки</p></div><span class="arrow">→</span>
      <div class="step"><span class="number">04 РЕЗУЛЬТАТ</span><strong>Роли и очередь</strong><p>Гипотезы ролей<br>Приоритет<br>Основания и ограничения</p></div></div>
      <div class="outputs"><div class="output"><b>Рабочее место через API</b>Поиск · карта · карточка · исходные операции</div><div class="output"><b>Результат для передачи</b>CSV · XLSX · manifest · HTML-справка · PNG</div></div><div class="foot">Дополнительный разбор дат и чувствительности выполняется по запросу и не изменяет базовый рейтинг.</div></html>`);
    await diagram.screenshot({path:path.join(out,'architecture.png')});
    console.log('Synthetic screenshots and architecture diagram created.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
