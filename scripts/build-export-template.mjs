import fs from 'node:fs/promises';
import {Workbook, SpreadsheetFile} from '@oai/artifact-tool';

// Author the reusable export layout. Runtime export fills typed cells in this
// template with Python's standard XML/ZIP libraries; Node is not a server dependency.
const book=Workbook.create();
const layouts=[
  ['Приоритеты',['rank','gid','role','priority_score','why'],[1,'100000000000000001','transit',0.123456,'Объяснение приоритета'],[10,25,20,20,90],['0','@','@','0.000000','@']],
  ['Все счета',['gid','role','role_score','cluster_id','priority_score','evidence'],['100000000000000001','transit',0.123456,0,0.123456,'Подтверждающие факты'],[25,20,18,14,20,90],['@','@','0.000000','0','0.000000','@']],
  ['Сообщества',['cluster_id','n_nodes','n_seed','sum_kzt_internal','top_gids','hypothesis'],[0,1,1,1234.56,'100000000000000001','Гипотеза сообщества'],[14,14,14,24,40,90],['0','0','0','#,##0.00','@','@']],
  ['О выгрузке',['Параметр','Значение'],['Версия метода','1.1.0'],[35,100],['@','@']],
];
for(const [name,headers,samples,widths,formats] of layouts){
  const sheet=book.worksheets.add(name);
  sheet.showGridLines=false;
  sheet.getRangeByIndexes(0,0,2,headers.length).values=[headers,samples];
  sheet.getRangeByIndexes(0,0,2,headers.length).format.font={name:'Arial',size:10,color:'#203533'};
  sheet.getRangeByIndexes(0,0,1,headers.length).format={fill:'#233F50',font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},rowHeight:28};
  for(let col=0;col<headers.length;col++){
    sheet.getRangeByIndexes(0,col,2,1).format.columnWidth=widths[col];
    sheet.getRangeByIndexes(1,col,1,1).setNumberFormat(formats[col]);
    sheet.getRangeByIndexes(1,col,1,1).format.wrapText=true;
  }
  sheet.freezePanes.freezeRows(1);
  sheet.getRangeByIndexes(1,0,1,headers.length).format.rowHeight=42;
}
book.recalculate();
await (await SpreadsheetFile.exportXlsx(book)).save('backend/assets/export-template.xlsx');
console.log((await book.inspect({kind:'region',sheetId:'Все счета',range:'A1:F2',maxChars:1200})).ndjson);
const preview=await book.render({sheetName:'Все счета',range:'A1:F2',scale:1,format:'png'});
await fs.writeFile('artifacts/xlsx-template/template.png',new Uint8Array(await preview.arrayBuffer()));
