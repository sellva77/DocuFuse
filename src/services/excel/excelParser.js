import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import * as xlsxModule from 'xlsx';
import { validateExcelFile } from './excelValidator.js';
import { calculatePrintablePages, parseRange } from './excelPaginator.js';

const XLSX = xlsxModule;

/**
 * Convert Excel ARGB / RGB hex or theme color to CSS hex (#RRGGBB)
 */
export function formatColor(colorObj, defaultColor = null) {
  if (!colorObj) return defaultColor;
  if (typeof colorObj === 'string') {
    if (colorObj.startsWith('#')) return colorObj;
    if (colorObj.length === 8) return `#${colorObj.slice(2)}`;
    if (colorObj.length === 6) return `#${colorObj}`;
  }
  if (colorObj.argb) {
    const argb = String(colorObj.argb);
    return argb.length === 8 ? `#${argb.slice(2)}` : `#${argb}`;
  }
  if (colorObj.theme !== undefined) {
    // Basic theme colors fallback
    const themeMap = {
      0: '#FFFFFF',
      1: '#000000',
      2: '#E7E6E6',
      3: '#44546A',
      4: '#4472C4',
      5: '#ED7D31',
      6: '#A5A5A5',
      7: '#FFC000',
      8: '#5B9BD5',
      9: '#70AD47',
    };
    return themeMap[colorObj.theme] || defaultColor;
  }
  return defaultColor;
}

/**
 * Format a cell value according to its type and number format
 */
export function formatCellValue(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return '';

  let val = cell.value;

  // Handle formula objects
  if (typeof val === 'object' && val !== null) {
    if ('result' in val) {
      val = val.result;
    } else if ('text' in val) {
      val = val.text;
    } else if (val instanceof Date) {
      // Date object
      return val.toISOString().slice(0, 10);
    } else if ('richText' in val && Array.isArray(val.richText)) {
      return val.richText.map(r => r.text || '').join('');
    }
  }

  if (val === null || val === undefined) return '';

  if (typeof val === 'number') {
    const numFmt = cell.numFmt || '';
    if (numFmt.includes('%')) {
      return `${(val * 100).toFixed(1)}%`;
    }
    if (numFmt.includes('$')) {
      return `$${val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    }
    if (numFmt.includes(',') || numFmt.includes('#')) {
      return val.toLocaleString('en-US');
    }
    // General number
    return Number.isInteger(val) ? String(val) : String(Number(val.toFixed(4)));
  }

  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }

  return String(val);
}

/**
 * Parse an Excel workbook (.xlsx or .xls)
 * @param {string} filePath
 * @returns {Promise<Object>} Parsed workbook model
 */
export async function parseWorkbook(filePath) {
  const validation = validateExcelFile(filePath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  let workbook = new ExcelJS.Workbook();
  const visibilityOverrides = new Map();

  if (ext === '.xls') {
    // Read legacy XLS using SheetJS
    let xlsWb;
    try {
      const fileBuffer = await fs.promises.readFile(filePath);
      xlsWb = XLSX.read(fileBuffer, { type: 'buffer', cellStyles: true, cellDates: true, cellNF: true });
    } catch (err) {
      if (err.message && (err.message.includes('password') || err.message.includes('encrypted'))) {
        throw new Error(`"${fileName}" is password-protected. Please remove password protection before converting.`);
      }
      throw new Error(`Failed to parse legacy Excel file "${fileName}": ${err.message}`);
    }

    // Extract visibility from SheetJS workbook
    if (xlsWb.Workbook && Array.isArray(xlsWb.Workbook.Sheets)) {
      xlsWb.Workbook.Sheets.forEach((s, idx) => {
        const sheetName = xlsWb.SheetNames[idx];
        let state = 'visible';
        if (s.Hidden === 1) state = 'hidden';
        if (s.Hidden === 2) state = 'veryHidden';
        if (sheetName) visibilityOverrides.set(sheetName, state);
      });
    }

    // Convert to XLSX buffer and load into ExcelJS
    try {
      const xlsxBuffer = XLSX.write(xlsWb, { bookType: 'xlsx', type: 'buffer' });
      await workbook.xlsx.load(xlsxBuffer);
    } catch (err) {
      throw new Error(`Failed to process legacy XLS structure for "${fileName}": ${err.message}`);
    }
  } else {
    // Direct XLSX read
    try {
      await workbook.xlsx.readFile(filePath);
    } catch (err) {
      if (err.message && (err.message.includes('encrypted') || err.message.includes('password'))) {
        throw new Error(`"${fileName}" is password-protected. Please remove password protection before converting.`);
      }
      throw new Error(`Failed to read Excel workbook "${fileName}": ${err.message}`);
    }
  }

  if (!workbook.worksheets || workbook.worksheets.length === 0) {
    throw new Error(`Workbook "${fileName}" contains no worksheets.`);
  }

  const sheets = [];

  for (let i = 0; i < workbook.worksheets.length; i++) {
    const ws = workbook.worksheets[i];
    const sheetName = ws.name;

    // Determine visibility state
    let state = ws.state || 'visible';
    if (visibilityOverrides.has(sheetName)) {
      state = visibilityOverrides.get(sheetName);
    }

    // Row breaks
    const rowBreaks = [];
    if (ws.rowBreaks && Array.isArray(ws.rowBreaks)) {
      for (const rb of ws.rowBreaks) {
        if (rb && typeof rb.row === 'number') rowBreaks.push(rb.row);
      }
    }
    // Also check individual rows
    ws.eachRow((row, rowNumber) => {
      if (row.pageBreak) rowBreaks.push(rowNumber);
    });

    // Merges
    const merges = [];
    const mergeMap = new Map(); // key 'r,c' -> merge info
    const coveredCells = new Set(); // key 'r,c' for non-master merged cells

    const modelMerges = ws.model?.merges || [];
    for (const mStr of modelMerges) {
      const p = parseRange(mStr);
      if (p) {
        const mergeObj = {
          rangeStr: mStr,
          startRow: p.startRow,
          endRow: p.endRow,
          startCol: p.startCol,
          endCol: p.endCol,
          rowCount: p.endRow - p.startRow + 1,
          colCount: p.endCol - p.startCol + 1,
        };
        merges.push(mergeObj);
        mergeMap.set(`${p.startRow},${p.startCol}`, mergeObj);

        for (let r = p.startRow; r <= p.endRow; r++) {
          for (let c = p.startCol; c <= p.endCol; c++) {
            if (r !== p.startRow || c !== p.startCol) {
              coveredCells.add(`${r},${c}`);
            }
          }
        }
      }
    }

    // Dimensions
    const rowCount = Math.max(ws.rowCount || 0, ws.actualRowCount || 0);
    const columnCount = Math.max(ws.columnCount || 0, ws.actualColumnCount || 0);

    // Row heights
    const rowHeights = {};
    for (let r = 1; r <= Math.max(rowCount, 1); r++) {
      const row = ws.getRow(r);
      // In Excel, default row height is ~15-18pt
      rowHeights[r] = row.height ? Math.max(14, row.height) : 18;
    }

    // Column widths
    const colWidths = {};
    for (let c = 1; c <= Math.max(columnCount, 1); c++) {
      const col = ws.getColumn(c);
      // Excel width is chars; 1 char ≈ 7.5pt, default ~64pt
      const w = col.width ? Math.max(30, col.width * 7.5) : 64;
      colWidths[c] = w;
    }

    // Cell data
    const cells = {};
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= columnCount; c++) {
        const cell = row.getCell(c);
        const cellKey = `${r},${c}`;
        const isMaster = mergeMap.has(cellKey);
        const isCovered = coveredCells.has(cellKey);

        const displayedText = formatCellValue(cell);
        const font = cell.font || {};
        const fill = cell.fill || {};
        const border = cell.border || {};
        const alignment = cell.alignment || {};

        let bgColor = null;
        if (fill.type === 'pattern' && fill.fgColor) {
          bgColor = formatColor(fill.fgColor);
        } else if (fill.bgColor) {
          bgColor = formatColor(fill.bgColor);
        }

        cells[cellKey] = {
          row: r,
          col: c,
          text: displayedText,
          formula: typeof cell.value === 'object' && cell.value?.formula ? cell.value.formula : null,
          font: {
            name: font.name || 'Helvetica',
            size: font.size || 10,
            bold: !!font.bold,
            italic: !!font.italic,
            underline: !!font.underline,
            color: formatColor(font.color, '#000000'),
          },
          bgColor,
          border: {
            top: border.top ? { style: border.top.style || 'thin', color: formatColor(border.top.color, '#D1D5DB') } : null,
            bottom: border.bottom ? { style: border.bottom.style || 'thin', color: formatColor(border.bottom.color, '#D1D5DB') } : null,
            left: border.left ? { style: border.left.style || 'thin', color: formatColor(border.left.color, '#D1D5DB') } : null,
            right: border.right ? { style: border.right.style || 'thin', color: formatColor(border.right.color, '#D1D5DB') } : null,
          },
          alignment: {
            horizontal: alignment.horizontal || (typeof cell.value === 'number' ? 'right' : 'left'),
            vertical: alignment.vertical || 'middle',
            wrapText: !!alignment.wrapText,
          },
          isMaster,
          isCovered,
          mergeInfo: mergeMap.get(cellKey) || null,
        };
      }
    }

    // Images
    const images = [];
    try {
      const sheetImages = ws.getImages ? ws.getImages() : [];
      for (const img of sheetImages) {
        const imgObj = workbook.getImage(img.imageId);
        if (imgObj && imgObj.buffer) {
          images.push({
            buffer: imgObj.buffer,
            extension: imgObj.extension || 'png',
            range: img.range,
          });
        }
      }
    } catch (_) {}

    const sheetData = {
      id: ws.id || i + 1,
      index: i,
      name: sheetName,
      state, // 'visible', 'hidden', 'veryHidden'
      pageSetup: {
        orientation: ws.pageSetup?.orientation || 'portrait',
        paperSize: ws.pageSetup?.paperSize || 9,
        margins: ws.pageSetup?.margins || { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75 },
        printArea: ws.pageSetup?.printArea || null,
        printTitlesRow: ws.pageSetup?.printTitlesRow || null,
        printTitlesColumn: ws.pageSetup?.printTitlesColumn || null,
        scale: ws.pageSetup?.scale || 100,
        fitToWidth: ws.pageSetup?.fitToWidth || 0,
        fitToHeight: ws.pageSetup?.fitToHeight || 0,
        pageOrder: ws.pageSetup?.pageOrder || 'downThenOver',
      },
      rowCount,
      columnCount,
      rowHeights,
      colWidths,
      rowBreaks,
      merges,
      cells,
      images,
    };

    // Calculate printable pages
    const printablePages = calculatePrintablePages(sheetData);
    sheetData.printablePages = printablePages;
    sheetData.pageCount = printablePages.length;

    sheets.push(sheetData);
  }

  return {
    filePath,
    fileName,
    format: ext.slice(1),
    sheetCount: sheets.length,
    sheets,
  };
}

export default {
  parseWorkbook,
  formatCellValue,
  formatColor,
};
