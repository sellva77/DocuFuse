import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import * as xlsxModule from 'xlsx';
import { PDFDocument } from 'pdf-lib';
import { inspectWorkbook, getWorksheetPreview, exportExcelToPdf } from '../src/services/excel/excelService.js';
import { validateExcelFile } from '../src/services/excel/excelValidator.js';
import { parsePageRange, calculatePrintablePages } from '../src/services/excel/excelPaginator.js';

const XLSX = xlsxModule.default || xlsxModule;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(FIXTURES_DIR)) fs.mkdirSync(FIXTURES_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function createMultiSheetXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Test Suite';

  // Sheet 1: Portrait, Multi-page, Merged cells, Formulas, Formatted table, Repeating Header, Row breaks
  const ws1 = wb.addWorksheet('Sales Performance', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'portrait',
      margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75 },
      printTitlesRow: '1:2',
      printArea: 'A1:E70',
    },
    state: 'visible',
  });

  // Title merge A1:E1
  ws1.mergeCells('A1:E1');
  const tCell = ws1.getCell('A1');
  tCell.value = 'Annual Sales & Margin Analysis';
  tCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  tCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
  tCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws1.getRow(1).height = 30;

  // Header row 2
  const headers = ['Region', 'Units Sold', 'Revenue ($)', 'Cost ($)', 'Net Profit ($)'];
  const hRow = ws1.getRow(2);
  headers.forEach((h, i) => {
    const c = hRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    c.border = {
      top: { style: 'thin', color: { argb: 'FF93C5FD' } },
      bottom: { style: 'medium', color: { argb: 'FF1E3A8A' } },
      left: { style: 'thin', color: { argb: 'FF93C5FD' } },
      right: { style: 'thin', color: { argb: 'FF93C5FD' } },
    };
  });
  hRow.height = 22;

  // Rows 3 to 70: generates multiple pages!
  for (let r = 3; r <= 70; r++) {
    const row = ws1.getRow(r);
    const region = ['North', 'South', 'East', 'West', 'Central'][(r - 3) % 5];
    const units = 100 + (r * 15);
    const rev = units * 45;
    const cost = units * 28;

    row.getCell(1).value = `${region} #${r - 2}`;
    row.getCell(2).value = units;
    row.getCell(3).value = rev;
    row.getCell(4).value = cost;
    // Formula for Profit: Revenue - Cost
    row.getCell(5).value = { formula: `C${r}-D${r}`, result: rev - cost };

    for (let c = 1; c <= 5; c++) {
      const cell = row.getCell(c);
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      };
      if (r % 2 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
      if (c >= 2 && c <= 5) {
        cell.alignment = { horizontal: 'right' };
      }
    }
  }

  // Explicit row break at row 35
  ws1.getRow(35).addPageBreak();

  // Sheet 2: Landscape layout
  const ws2 = wb.addWorksheet('Executive Summary', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'landscape',
      margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 },
    },
    state: 'visible',
  });
  ws2.getCell('A1').value = 'Executive Overview - Landscape Report';
  ws2.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF0F172A' } };
  ws2.getCell('A3').value = 'This page is formatted in Landscape orientation.';

  // Sheet 3: Hidden worksheet
  const ws3 = wb.addWorksheet('Confidential Formulas', {
    state: 'hidden',
  });
  ws3.getCell('A1').value = 'Proprietary calculation constants';

  // Sheet 4: Very hidden worksheet
  const ws4 = wb.addWorksheet('Audit Log', {
    state: 'veryHidden',
  });
  ws4.getCell('A1').value = 'Audit events and system hashes';

  await wb.xlsx.writeFile(filePath);
  return filePath;
}

function createLegacyXls(filePath) {
  const wb = XLSX.utils.book_new();
  const data1 = [
    ['Account', 'Department', 'Budget', 'Actual'],
    ['1001', 'Engineering', 450000, 420000],
    ['1002', 'Marketing', 180000, 195000],
    ['1003', 'Operations', 220000, 210000],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(data1);
  XLSX.utils.book_append_sheet(wb, ws1, 'Dept Budget');

  const data2 = [
    ['Confidential', 'Rate'],
    ['Discount', 0.15],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(data2);
  XLSX.utils.book_append_sheet(wb, ws2, 'Private Rates');

  wb.Workbook = {
    Sheets: [
      { Hidden: 0 },
      { Hidden: 1 }, // hidden
    ],
  };

  const buffer = XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function runExcelTests() {
  console.log('====================================================');
  console.log('      EXCEL TO PDF CONVERSION MODULE TEST SUITE     ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName} ${detail ? '(' + detail + ')' : ''}`);
      failed++;
    }
  }

  // 1. Fixture Creation
  console.log('[Step 1] Creating Excel test fixtures...');
  const multiSheetXlsx = path.join(FIXTURES_DIR, 'test_workbook_multi.xlsx');
  await createMultiSheetXlsx(multiSheetXlsx);

  const legacyXls = path.join(FIXTURES_DIR, 'test_workbook_legacy.xls');
  createLegacyXls(legacyXls);

  // Unicode and space path
  const unicodeXlsx = path.join(FIXTURES_DIR, 'Rapport Financier 2026 - 中国 & España.xlsx');
  await createMultiSheetXlsx(unicodeXlsx);

  // Corrupt file
  const corruptXlsx = path.join(FIXTURES_DIR, 'corrupt_excel.xlsx');
  fs.writeFileSync(corruptXlsx, Buffer.from('NOT AN EXCEL FILE CONTENT 99999'));

  // Empty file
  const emptyXlsx = path.join(FIXTURES_DIR, 'empty_excel.xlsx');
  fs.writeFileSync(emptyXlsx, Buffer.alloc(0));

  // Password-protected simulated OLE
  const passwordXlsx = path.join(FIXTURES_DIR, 'password_protected.xlsx');
  const oleHeader = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  const encPkg = Buffer.from('EncryptedPackage EncryptionInfo');
  fs.writeFileSync(passwordXlsx, Buffer.concat([oleHeader, encPkg]));

  console.log('  Fixtures created.\n');

  // Test 1: File Validator
  console.log('[Step 2] Testing Excel File Validator...');
  const v1 = validateExcelFile(multiSheetXlsx);
  assert(v1.valid === true && v1.format === 'xlsx', 'Valid XLSX passes file validator');

  const v2 = validateExcelFile(legacyXls);
  assert(v2.valid === true && v2.format === 'xls', 'Valid XLS passes file validator');

  const vCorrupt = validateExcelFile(corruptXlsx);
  assert(vCorrupt.valid === false && vCorrupt.error.includes('corrupted'), 'Corrupt Excel rejected with clear error');

  const vEmpty = validateExcelFile(emptyXlsx);
  assert(vEmpty.valid === false && vEmpty.error.includes('empty'), 'Empty Excel rejected with clear error');

  const vPass = validateExcelFile(passwordXlsx);
  assert(vPass.valid === false && vPass.error.includes('password-protected'), 'Password-protected workbook detected');

  // Test 2: Page Range Parser
  console.log('\n[Step 3] Testing Page Range Parser...');
  const r1 = parsePageRange('1-3, 5, 7-9', 10);
  assert(JSON.stringify(r1) === JSON.stringify([1, 2, 3, 5, 7, 8, 9]), 'Page range "1-3, 5, 7-9" parsed accurately');

  const rAll = parsePageRange('all', 4);
  assert(JSON.stringify(rAll) === JSON.stringify([1, 2, 3, 4]), '"all" page range selects all pages');

  let rangeErrorCaught = false;
  try {
    parsePageRange('invalid-range', 5);
  } catch (e) {
    rangeErrorCaught = true;
  }
  assert(rangeErrorCaught, 'Invalid page range syntax throws informative error');

  // Test 3: Workbook Inspection (Worksheet listing, visibility, pagination)
  console.log('\n[Step 4] Testing Workbook Inspection...');
  const inspection = await inspectWorkbook(multiSheetXlsx);
  assert(inspection.sheetCount === 4, 'Detected all 4 worksheets in multi-sheet workbook');

  const s1 = inspection.sheets.find(s => s.name === 'Sales Performance');
  const s2 = inspection.sheets.find(s => s.name === 'Executive Summary');
  const s3 = inspection.sheets.find(s => s.name === 'Confidential Formulas');
  const s4 = inspection.sheets.find(s => s.name === 'Audit Log');

  assert(s1 && s1.isVisible === true && s1.pageCount >= 2, 'Sheet 1 is visible and calculates multiple printable pages', `pageCount: ${s1?.pageCount}`);
  assert(s2 && s2.orientation === 'landscape', 'Sheet 2 orientation identified as landscape');
  assert(s3 && s3.isHidden === true && s3.selected === false, 'Sheet 3 identified as hidden and unselected by default');
  assert(s4 && s4.isVeryHidden === true && s4.selected === false, 'Sheet 4 identified as very-hidden and unselected by default');

  // Test 4: Worksheet Preview Generation
  console.log('\n[Step 5] Testing Worksheet Preview Generation...');
  const preview = await getWorksheetPreview(multiSheetXlsx, 0, 1);
  assert(preview && preview.pageIndex === 1 && preview.texts.length > 0, 'Generated page preview for worksheet', `texts: ${preview.texts.length}`);

  // Test 5: Full PDF Export (Worksheet Selection, Custom Ordering, Page Ranges)
  console.log('\n[Step 6] Testing PDF Export with Custom Ordering & Page Ranges...');
  const outPdf1 = path.join(OUTPUT_DIR, 'excel_export_custom_order.pdf');
  // Order: Executive Summary (Landscape) FIRST, then Sales Performance (Pages 1 & 2 only)
  const exportResult = await exportExcelToPdf({
    filePath: multiSheetXlsx,
    sheetConfigs: [
      { sheetIndex: 1, sheetName: 'Executive Summary', selected: true, pageRange: 'all' },
      { sheetIndex: 0, sheetName: 'Sales Performance', selected: true, pageRange: '1-2' },
      { sheetIndex: 2, sheetName: 'Confidential Formulas', selected: false }, // unselected
      { sheetIndex: 3, sheetName: 'Audit Log', selected: false }, // unselected
    ],
    outputPath: outPdf1,
    onProgress: (p) => {},
  });

  assert(exportResult.success === true, 'Excel export completed successfully');
  assert(fs.existsSync(outPdf1) && exportResult.outputSize > 1000, 'Output PDF file exists and has valid size', `size: ${exportResult.outputSize} bytes`);

  // Verify resulting PDF structure
  const pdfBytes = await fs.promises.readFile(outPdf1);
  const verifiedPdf = await PDFDocument.load(pdfBytes);
  // Executive Summary (1 page) + Sales Performance (2 pages) = 3 pages total
  assert(verifiedPdf.getPageCount() === 3, 'Combined PDF contains exactly the 3 requested pages across worksheets');

  // Verify first page is landscape and second page is portrait!
  const p1 = verifiedPdf.getPage(0);
  const p2 = verifiedPdf.getPage(1);
  assert(p1.getWidth() > p1.getHeight(), 'Page 1 correctly exported in Landscape orientation');
  assert(p2.getWidth() < p2.getHeight(), 'Page 2 correctly exported in Portrait orientation');

  // Test 6: Legacy XLS Export
  console.log('\n[Step 7] Testing Legacy XLS to PDF Export...');
  const outXlsPdf = path.join(OUTPUT_DIR, 'legacy_xls_exported.pdf');
  const xlsInspection = await inspectWorkbook(legacyXls);
  assert(xlsInspection.sheetCount === 2, 'Legacy XLS sheets inspected accurately');

  const xlsExport = await exportExcelToPdf({
    filePath: legacyXls,
    sheetConfigs: [
      { sheetIndex: 0, sheetName: 'Dept Budget', selected: true, pageRange: 'all' },
      { sheetIndex: 1, sheetName: 'Private Rates', selected: false },
    ],
    outputPath: outXlsPdf,
    onProgress: (p) => {},
  });

  const xlsPdfBytes = await fs.promises.readFile(outXlsPdf);
  const xlsPdfDoc = await PDFDocument.load(xlsPdfBytes);
  assert(xlsExport.success && xlsPdfDoc.getPageCount() === 1, 'Legacy XLS converted to single-page PDF successfully');

  // Test 7: Exporting Hidden Sheet with Explicit Selection
  console.log('\n[Step 8] Testing Inclusion of Hidden Worksheet when explicitly selected...');
  const outHiddenPdf = path.join(OUTPUT_DIR, 'excel_export_with_hidden.pdf');
  const hiddenExport = await exportExcelToPdf({
    filePath: multiSheetXlsx,
    sheetConfigs: [
      { sheetIndex: 2, sheetName: 'Confidential Formulas', selected: true, pageRange: 'all' },
      { sheetIndex: 3, sheetName: 'Audit Log', selected: true, pageRange: 'all' },
    ],
    outputPath: outHiddenPdf,
    onProgress: (p) => {},
  });
  const hiddenPdfDoc = await PDFDocument.load(await fs.promises.readFile(outHiddenPdf));
  assert(hiddenExport.success && hiddenPdfDoc.getPageCount() === 2, 'Hidden worksheets exported when user selects them');

  // Test 8: Unicode Filenames and Paths Containing Spaces
  console.log('\n[Step 9] Testing Unicode Filenames and Paths Containing Spaces...');
  const outUnicodePdf = path.join(OUTPUT_DIR, 'Rapport Final - 导出.pdf');
  const unicodeExport = await exportExcelToPdf({
    filePath: unicodeXlsx,
    sheetConfigs: [
      { sheetIndex: 0, sheetName: 'Sales Performance', selected: true, pageRange: '1' },
    ],
    outputPath: outUnicodePdf,
    onProgress: (p) => {},
  });
  assert(unicodeExport.success && fs.existsSync(outUnicodePdf), 'Unicode & spaces in filenames handled properly');

  // Test 9: Worksheet Ordering Preservation
  console.log('\n[Step 10] Testing Worksheet Order Preservation...');
  const outOrderA = path.join(OUTPUT_DIR, 'order_sheet_0_then_1.pdf');
  const outOrderB = path.join(OUTPUT_DIR, 'order_sheet_1_then_0.pdf');

  await exportExcelToPdf({
    filePath: multiSheetXlsx,
    sheetConfigs: [
      { sheetIndex: 0, sheetName: 'Sales Performance', selected: true, pageRange: '1' },
      { sheetIndex: 1, sheetName: 'Executive Summary', selected: true, pageRange: '1' },
    ],
    outputPath: outOrderA,
  });

  await exportExcelToPdf({
    filePath: multiSheetXlsx,
    sheetConfigs: [
      { sheetIndex: 1, sheetName: 'Executive Summary', selected: true, pageRange: '1' },
      { sheetIndex: 0, sheetName: 'Sales Performance', selected: true, pageRange: '1' },
    ],
    outputPath: outOrderB,
  });

  const pdfA = await PDFDocument.load(await fs.promises.readFile(outOrderA));
  const pdfB = await PDFDocument.load(await fs.promises.readFile(outOrderB));
  // In order A, page 1 is Portrait (Sales Performance). In order B, page 1 is Landscape (Executive Summary).
  assert(pdfA.getPage(0).getWidth() < pdfA.getPage(0).getHeight(), 'Order A: First page is Portrait (Sales Performance)');
  assert(pdfB.getPage(0).getWidth() > pdfB.getPage(0).getHeight(), 'Order B: First page is Landscape (Executive Summary)');

  // Test 11: Non-WinAnsi Unicode Symbols (Indian Rupee ₹, Special Currency & Glyphs)
  console.log('\n[Step 11] Testing Indian Rupee Symbol (₹) & Non-WinAnsi Glyphs in Excel Cells...');
  const rupeeWb = new ExcelJS.Workbook();
  const rupeeWs = rupeeWb.addWorksheet('Payroll INR', {
    pageSetup: { paperSize: 9, orientation: 'portrait' }
  });
  rupeeWs.getCell('A1').value = 'Employee Salary Statement (INR)';
  rupeeWs.getCell('A2').value = 'Base Salary';
  rupeeWs.getCell('B2').value = '₹ 1,50,000.00';
  rupeeWs.getCell('A3').value = 'Provident Fund';
  rupeeWs.getCell('B3').value = '₹ 18,000.00';
  rupeeWs.getCell('A4').value = 'Net Disbursed';
  rupeeWs.getCell('B4').value = '₹ 1,32,000.00 (Approved ✔)';

  const rupeeXlsxPath = path.join(FIXTURES_DIR, 'rupee_salary_test.xlsx');
  await rupeeWb.xlsx.writeFile(rupeeXlsxPath);

  const rupeePdfOut = path.join(OUTPUT_DIR, 'rupee_salary_output.pdf');
  const rupeeExportRes = await exportExcelToPdf({
    filePath: rupeeXlsxPath,
    sheetConfigs: [
      { sheetIndex: 0, sheetName: 'Payroll INR', selected: true, pageRange: 'all' }
    ],
    outputPath: rupeePdfOut,
  });

  assert(rupeeExportRes.success, 'Excel sheet with Rupee symbol (₹) converted without WinAnsi encoding error');
  assert(fs.existsSync(rupeePdfOut) && fs.statSync(rupeePdfOut).size > 500, 'Generated PDF with Rupee symbol exists and is valid');

  console.log('\n====================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runExcelTests().catch((err) => {
  console.error('Fatal Excel test error:', err);
  process.exit(1);
});
