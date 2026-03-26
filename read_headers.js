const ExcelJS = require('./node_modules/exceljs/lib/exceljs.nodejs.js');
const fs = require('fs');
const wb = new ExcelJS.Workbook();
wb.xlsx.readFile('./templates/products-and-offers-en_GB-20260302191642.xlsx').then(() => {
  const ws = wb.worksheets[0];
  const lines = [];
  lines.push('Sheet name: ' + ws.name);
  lines.push('Row count: ' + ws.rowCount);
  lines.push('Col count: ' + ws.columnCount);
  for (let n = 1; n <= 5; n++) {
    const row = ws.getRow(n);
    const vals = row.values; // 1-indexed array
    if (!vals) continue;
    const nonEmpty = vals.filter(v => v !== null && v !== undefined && v !== '');
    if (nonEmpty.length >= 2) {
      lines.push('ROW ' + n + ' ' + JSON.stringify(vals));
    }
  }
  const out = lines.join('\n') + '\n';
  fs.writeFileSync('./headers_output.txt', out, 'utf8');
  process.stdout.write(out);
}).catch(e => {
  const msg = 'ERROR: ' + e.message + '\n';
  fs.writeFileSync('./headers_output.txt', msg, 'utf8');
  process.stderr.write(msg);
  process.exit(1);
});
