import ExcelJS from 'exceljs';
import * as xlsxModule from 'xlsx';
const XLSX = xlsxModule.default || xlsxModule;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
if (!fs.existsSync(FIXTURES_DIR)) fs.mkdirSync(FIXTURES_DIR, { recursive: true });

async function testCapabilities() {
  console.log('Testing ExcelJS and XLSX capabilities...');

  // 1. Create a rich XLSX workbook
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Document Merger';
  wb.created = new Date();

  // Sheet 1: Visible, multi-page data with table, borders, fills, formulas, merges
  const ws1 = wb.addWorksheet('Quarterly Report', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'portrait',
      margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
      printTitlesRow: '1:2', // repeating header rows
      printArea: 'A1:E60',
    },
    state: 'visible',
  });

  // Title spanning A1:E1
  ws1.mergeCells('A1:E1');
  const titleCell = ws1.getCell('A1');
  titleCell.value = 'Quarterly Financial Performance (2026)';
  titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws1.getRow(1).height = 35;

  // Header row
  const headers = ['Quarter', 'Revenue ($)', 'Expenses ($)', 'Profit ($)', 'Margin (%)'];
  const headerRow = ws1.getRow(2);
  headers.forEach((h, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = h;
    cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'medium', color: { argb: 'FF1F2937' } },
      left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
    };
  });
  headerRow.height = 25;

  // Add 55 data rows to span multiple printable pages!
  for (let r = 3; r <= 58; r++) {
    const row = ws1.getRow(r);
    row.height = 20;
    const q = `Q${((r - 3) % 4) + 1} - Line ${r - 2}`;
    const rev = 10000 + (r * 350);
    const exp = 6000 + (r * 180);
    
    row.getCell(1).value = q;
    row.getCell(2).value = rev;
    row.getCell(3).value = exp;
    // Formula for Profit: Revenue - Expenses
    row.getCell(4).value = { formula: `B${r}-C${r}`, result: rev - exp };
    // Formula for Margin: Profit / Revenue
    row.getCell(5).value = { formula: `D${r}/B${r}`, result: Number(((rev - exp) / rev * 100).toFixed(1)) };

    // Format & borders
    for (let c = 1; c <= 5; c++) {
      const cell = row.getCell(c);
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      };
      if (r % 2 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      }
      if (c >= 2 && c <= 4) {
        cell.numFmt = '$#,##0';
        cell.alignment = { horizontal: 'right' };
      } else if (c === 5) {
        cell.numFmt = '0.0%';
        cell.alignment = { horizontal: 'right' };
      }
    }
  }

  // Row break at row 30
  ws1.getRow(30).addPageBreak();

  // Set column widths
  ws1.getColumn(1).width = 20;
  ws1.getColumn(2).width = 16;
  ws1.getColumn(3).width = 16;
  ws1.getColumn(4).width = 16;
  ws1.getColumn(5).width = 14;

  // Sheet 2: Landscape layout
  const ws2 = wb.addWorksheet('Landscape Summary', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'landscape',
      margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 },
    },
    state: 'visible',
  });
  ws2.getCell('A1').value = 'Landscape Analysis';
  ws2.getCell('A1').font = { size: 14, bold: true };
  ws2.getCell('A2').value = 'Wide tabular report testing landscape printing.';

  // Sheet 3: Hidden sheet
  const ws3 = wb.addWorksheet('Confidential Data', {
    state: 'hidden',
  });
  ws3.getCell('A1').value = 'Internal Secrets - Hidden Sheet';

  // Sheet 4: Very hidden sheet
  const ws4 = wb.addWorksheet('VBA Settings', {
    state: 'veryHidden',
  });
  ws4.getCell('A1').value = 'Very hidden configuration sheet';

  const xlsxPath = path.join(FIXTURES_DIR, 'sample_test.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  console.log('Created XLSX fixture:', xlsxPath);

  // 2. Read back using ExcelJS
  const readWb = new ExcelJS.Workbook();
  await readWb.xlsx.readFile(xlsxPath);
  console.log('Read back XLSX with', readWb.worksheets.length, 'worksheets');
  readWb.worksheets.forEach(ws => {
    console.log(`Sheet "${ws.name}": state=${ws.state}, orientation=${ws.pageSetup?.orientation}, rows=${ws.rowCount}`);
  });

  // 3. Create a legacy XLS file using XLSX
  const xlsWb = XLSX.utils.book_new();
  const wsData1 = [
    ['Product', 'Qty', 'Unit Price', 'Total'],
    ['Widget A', 10, 15.5, 155],
    ['Widget B', 25, 8.0, 200],
    ['Widget C', 5, 45.0, 225],
  ];
  const xlsSheet1 = XLSX.utils.aoa_to_sheet(wsData1);
  XLSX.utils.book_append_sheet(xlsWb, xlsSheet1, 'Legacy Inventory');

  const wsData2 = [
    ['Key', 'Value'],
    ['Build', '2026.1'],
  ];
  const xlsSheet2 = XLSX.utils.aoa_to_sheet(wsData2);
  XLSX.utils.book_append_sheet(xlsWb, xlsSheet2, 'Hidden Metadata');
  // Mark sheet 2 as hidden
  xlsWb.Workbook = {
    Sheets: [
      { Hidden: 0 },
      { Hidden: 1 },
    ],
  };

  const xlsBuffer = XLSX.write(xlsWb, { bookType: 'biff8', type: 'buffer' });
  const xlsPath = path.join(FIXTURES_DIR, 'sample_legacy.xls');
  fs.writeFileSync(xlsPath, xlsBuffer);
  console.log('Created legacy XLS fixture:', xlsPath);

  // Read back XLS
  const readXlsWb = XLSX.readFile(xlsPath);
  console.log('Read back XLS with sheet names:', readXlsWb.SheetNames);
  console.log('Workbook sheet visibility:', readXlsWb.Workbook?.Sheets);

  console.log('All capability tests passed!');
}

testCapabilities().catch(console.error);
