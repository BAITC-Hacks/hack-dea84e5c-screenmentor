// Optional documentation build: npm install --no-save marked && node scripts/build-guide.mjs
// USER_GUIDE.md is the source; the generated HTML is committed and works offline.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { marked } = await import(process.env.MARKED_MODULE ? pathToFileURL(process.env.MARKED_MODULE).href : 'marked');
const source = await readFile(new URL('../USER_GUIDE.md', import.meta.url), 'utf8');
const toc = [];
let html = marked.parse(source, {gfm:true});
html = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, title) => {
  const id = `section-${toc.length + 1}`;
  toc.push(`<a href="#${id}">${title}</a>`);
  return `<h2 id="${id}">${title}</h2>`;
}).replaceAll('<table>', '<div class="table-wrap"><table>').replaceAll('</table>', '</table></div>');
const output = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Инструкция — Граф денег</title><link rel="stylesheet" href="/static/guide.css"></head>
<body><header><a class="home" href="/">← Вернуться к проверке счетов</a><span>ГРАФ ДЕНЕГ · ИНСТРУКЦИЯ</span></header>
<div class="layout"><nav aria-label="Содержание инструкции"><strong>Содержание</strong>${toc.join('\n')}</nav>
<main>${html}<p class="back"><a href="/">Вернуться на сайт →</a></p></main></div></body></html>\n`;
await writeFile(new URL('../frontend/guide.html', import.meta.url), output, 'utf8');
console.log(`Guide generated: ${toc.length} sections.`);
