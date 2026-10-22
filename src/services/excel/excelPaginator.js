/**
 * Standard paper sizes in PostScript points (1 pt = 1/72 inch)
 */
export const PAPER_SIZES = {
  1: { name: 'Letter', width: 612.0, height: 792.0 },
  3: { name: 'Tabloid', width: 792.0, height: 1224.0 },
  5: { name: 'Legal', width: 612.0, height: 1008.0 },
  7: { name: 'Executive', width: 522.0, height: 756.0 },
  8: { name: 'A3', width: 841.89, height: 1190.55 },
  9: { name: 'A4', width: 595.28, height: 841.89 },
  11: { name: 'A5', width: 419.53, height: 595.28 },
};

export const DEFAULT_PAPER_SIZE = PAPER_SIZES[9]; // A4 default

/**
 * Convert column letter (A, B, ..., Z, AA, ...) to 1-based index
 */
export function colLetterToIndex(colStr) {
  let index = 0;
  const clean = colStr.replace(/\$/g, '').toUpperCase();
  for (let i = 0; i < clean.length; i++) {
    index = index * 26 + (clean.charCodeAt(i) - 64);
  }
  return index;
}

/**
 * Convert 1-based index to column letter
 */
export function indexToColLetter(index) {
  let col = '';
  let temp = index;
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    temp = Math.floor((temp - 1) / 26);
  }
  return col;
}

/**
 * Parse an Excel range string like "A1:E60" or "$A$1:$E$60"
 */
export function parseRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') return null;
  const clean = rangeStr.replace(/\$/g, '').trim();
  const parts = clean.split(':');
  if (parts.length === 1) {
    const match = parts[0].match(/^([A-Z]+)(\d+)$/i);
    if (!match) return null;
    const col = colLetterToIndex(match[1]);
    const row = parseInt(match[2], 10);
    return { startCol: col, startRow: row, endCol: col, endRow: row };
  }
  if (parts.length === 2) {
    const m1 = parts[0].match(/^([A-Z]+)(\d+)$/i);
    const m2 = parts[1].match(/^([A-Z]+)(\d+)$/i);
    if (!m1 || !m2) return null;
    return {
      startCol: Math.min(colLetterToIndex(m1[1]), colLetterToIndex(m2[1])),
      startRow: Math.min(parseInt(m1[2], 10), parseInt(m2[2], 10)),
      endCol: Math.max(colLetterToIndex(m1[1]), colLetterToIndex(m2[1])),
      endRow: Math.max(parseInt(m1[2], 10), parseInt(m2[2], 10)),
    };
  }
  return null;
}

/**
 * Parse repeating rows definition like "1:2" or "$1:$2"
 */
export function parseRepeatingRows(rowsStr) {
  if (!rowsStr || typeof rowsStr !== 'string') return null;
  const clean = rowsStr.replace(/\$/g, '').trim();
  const parts = clean.split(':');
  if (parts.length === 1) {
    const r = parseInt(parts[0], 10);
    return !isNaN(r) ? [r] : null;
  }
  if (parts.length === 2) {
    const r1 = parseInt(parts[0], 10);
    const r2 = parseInt(parts[1], 10);
    if (isNaN(r1) || isNaN(r2)) return null;
    const start = Math.min(r1, r2);
    const end = Math.max(r1, r2);
    const result = [];
    for (let r = start; r <= end; r++) result.push(r);
    return result;
  }
  return null;
}

/**
 * Parse repeating columns definition like "A:B" or "$A:$B"
 */
export function parseRepeatingCols(colsStr) {
  if (!colsStr || typeof colsStr !== 'string') return null;
  const clean = colsStr.replace(/\$/g, '').trim();
  const parts = clean.split(':');
  if (parts.length === 1) {
    const c = colLetterToIndex(parts[0]);
    return c > 0 ? [c] : null;
  }
  if (parts.length === 2) {
    const c1 = colLetterToIndex(parts[0]);
    const c2 = colLetterToIndex(parts[1]);
    if (c1 <= 0 || c2 <= 0) return null;
    const start = Math.min(c1, c2);
    const end = Math.max(c1, c2);
    const result = [];
    for (let c = start; c <= end; c++) result.push(c);
    return result;
  }
  return null;
}

/**
 * Calculate printable pages for a worksheet
 * @param {Object} sheet - Parsed worksheet object
 * @returns {Array<Object>} Array of page descriptors
 */
export function calculatePrintablePages(sheet) {
  const pageSetup = sheet.pageSetup || {};
  const orientation = (pageSetup.orientation || 'portrait').toLowerCase();
  const isLandscape = orientation === 'landscape';

  // Paper dimensions
  const paperConfig = PAPER_SIZES[pageSetup.paperSize] || DEFAULT_PAPER_SIZE;
  let pageWidth = isLandscape ? paperConfig.height : paperConfig.width;
  let pageHeight = isLandscape ? paperConfig.width : paperConfig.height;

  // Margins in points (inches * 72)
  const margins = pageSetup.margins || {};
  const leftMargin = (margins.left ?? 0.7) * 72;
  const rightMargin = (margins.right ?? 0.7) * 72;
  const topMargin = (margins.top ?? 0.75) * 72;
  const bottomMargin = (margins.bottom ?? 0.75) * 72;

  let printableWidth = Math.max(100, pageWidth - leftMargin - rightMargin);
  let printableHeight = Math.max(100, pageHeight - topMargin - bottomMargin);

  // Content range
  let startRow = 1;
  let endRow = sheet.rowCount || 1;
  let startCol = 1;
  let endCol = sheet.columnCount || 1;

  if (pageSetup.printArea) {
    const parsedArea = parseRange(pageSetup.printArea);
    if (parsedArea) {
      startRow = Math.max(1, parsedArea.startRow);
      endRow = Math.min(sheet.rowCount || parsedArea.endRow, parsedArea.endRow);
      startCol = Math.max(1, parsedArea.startCol);
      endCol = Math.min(sheet.columnCount || parsedArea.endCol, parsedArea.endCol);
    }
  }

  // Handle empty sheets
  if (endRow < startRow || endCol < startCol || sheet.rowCount === 0) {
    return [
      {
        pageIndex: 1,
        pageWidth,
        pageHeight,
        printableWidth,
        printableHeight,
        leftMargin,
        topMargin,
        rightMargin,
        bottomMargin,
        orientation,
        paperName: paperConfig.name,
        rows: [],
        cols: [],
        repeatingRows: [],
        repeatingCols: [],
        isEmpty: true,
      },
    ];
  }

  // Scale factor
  let scale = 1.0;
  if (pageSetup.scale && pageSetup.scale > 10 && pageSetup.scale <= 400) {
    scale = pageSetup.scale / 100;
  }

  // Fit to page scaling
  if (pageSetup.fitToWidth && pageSetup.fitToWidth > 0) {
    let totalColWidth = 0;
    for (let c = startCol; c <= endCol; c++) {
      totalColWidth += (sheet.colWidths?.[c] ?? 64);
    }
    const targetWidth = printableWidth * pageSetup.fitToWidth;
    if (totalColWidth > targetWidth) {
      const fitScale = targetWidth / totalColWidth;
      scale = Math.min(scale, Math.max(0.4, fitScale));
    }
  }

  printableWidth /= scale;
  printableHeight /= scale;

  // Repeating rows (headers)
  const repeatingRowNums = parseRepeatingRows(pageSetup.printTitlesRow) || [];
  let repeatingRowsHeight = 0;
  const validRepeatingRows = [];
  for (const r of repeatingRowNums) {
    if (r >= startRow && r <= endRow) {
      validRepeatingRows.push(r);
      repeatingRowsHeight += (sheet.rowHeights?.[r] ?? 18);
    }
  }

  // Repeating columns
  const repeatingColNums = parseRepeatingCols(pageSetup.printTitlesColumn) || [];
  let repeatingColsWidth = 0;
  const validRepeatingCols = [];
  for (const c of repeatingColNums) {
    if (c >= startCol && c <= endCol) {
      validRepeatingCols.push(c);
      repeatingColsWidth += (sheet.colWidths?.[c] ?? 64);
    }
  }

  const explicitRowBreaks = new Set(sheet.rowBreaks || []);

  // ── Calculate Horizontal Column Bands ──
  const colBands = [];
  let currentBandCols = [];
  let currentBandWidth = repeatingColsWidth;

  for (let c = startCol; c <= endCol; c++) {
    if (validRepeatingCols.includes(c)) continue; // skip repeating cols from main band

    const colW = sheet.colWidths?.[c] ?? 64;

    if (currentBandCols.length > 0 && currentBandWidth + colW > printableWidth) {
      colBands.push([...validRepeatingCols, ...currentBandCols]);
      currentBandCols = [c];
      currentBandWidth = repeatingColsWidth + colW;
    } else {
      currentBandCols.push(c);
      currentBandWidth += colW;
    }
  }
  if (currentBandCols.length > 0) {
    colBands.push([...validRepeatingCols, ...currentBandCols]);
  }
  if (colBands.length === 0) {
    colBands.push(validRepeatingCols.length > 0 ? validRepeatingCols : [startCol]);
  }

  // ── Calculate Vertical Row Bands ──
  const rowBands = [];
  let currentBandRows = [];
  let currentBandHeight = 0;

  for (let r = startRow; r <= endRow; r++) {
    if (validRepeatingRows.includes(r)) continue; // in repeating header

    const rowH = sheet.rowHeights?.[r] ?? 18;
    const availableHeight = printableHeight - repeatingRowsHeight;

    const hasExplicitBreak = explicitRowBreaks.has(r - 1);

    if (currentBandRows.length > 0 && (hasExplicitBreak || currentBandHeight + rowH > availableHeight)) {
      rowBands.push({
        rows: currentBandRows,
        startRow: currentBandRows[0],
        endRow: currentBandRows[currentBandRows.length - 1],
      });
      currentBandRows = [r];
      currentBandHeight = rowH;
    } else {
      currentBandRows.push(r);
      currentBandHeight += rowH;
    }
  }
  if (currentBandRows.length > 0) {
    rowBands.push({
      rows: currentBandRows,
      startRow: currentBandRows[0],
      endRow: currentBandRows[currentBandRows.length - 1],
    });
  }
  if (rowBands.length === 0) {
    rowBands.push({
      rows: validRepeatingRows.length > 0 ? [] : [startRow],
      startRow,
      endRow: startRow,
    });
  }

  // ── Combine into Printable Pages ──
  // Excel page order: 'downThenOver' (default) or 'overThenDown'
  const pageOrder = pageSetup.pageOrder || 'downThenOver';
  const pages = [];
  let pageIdx = 1;

  if (pageOrder === 'overThenDown') {
    for (const rBand of rowBands) {
      for (const cBand of colBands) {
        pages.push(createPageDescriptor(pageIdx++, sheet, rBand, cBand, validRepeatingRows, validRepeatingCols, pageWidth, pageHeight, printableWidth, printableHeight, leftMargin, topMargin, rightMargin, bottomMargin, orientation, paperConfig.name, scale));
      }
    }
  } else {
    // downThenOver
    for (const cBand of colBands) {
      for (const rBand of rowBands) {
        pages.push(createPageDescriptor(pageIdx++, sheet, rBand, cBand, validRepeatingRows, validRepeatingCols, pageWidth, pageHeight, printableWidth, printableHeight, leftMargin, topMargin, rightMargin, bottomMargin, orientation, paperConfig.name, scale));
      }
    }
  }

  return pages;
}

function createPageDescriptor(
  pageIndex,
  sheet,
  rBand,
  cBand,
  repeatingRows,
  repeatingCols,
  pageWidth,
  pageHeight,
  printableWidth,
  printableHeight,
  leftMargin,
  topMargin,
  rightMargin,
  bottomMargin,
  orientation,
  paperName,
  scale
) {
  // Combine repeating rows with body rows for this page
  const allRows = [...repeatingRows, ...rBand.rows];
  return {
    pageIndex,
    sheetName: sheet.name,
    pageWidth,
    pageHeight,
    printableWidth,
    printableHeight,
    leftMargin,
    topMargin,
    rightMargin,
    bottomMargin,
    orientation,
    paperName,
    scale,
    repeatingRows,
    repeatingCols,
    bodyRows: rBand.rows,
    allRows,
    allCols: cBand,
    rowRange: {
      start: allRows.length > 0 ? Math.min(...allRows) : 1,
      end: allRows.length > 0 ? Math.max(...allRows) : 1,
    },
    colRange: {
      start: cBand.length > 0 ? Math.min(...cBand) : 1,
      end: cBand.length > 0 ? Math.max(...cBand) : 1,
    },
    isEmpty: allRows.length === 0,
  };
}

/**
 * Parse a page range string such as "1-3, 5, 7-9" or "all"
 * @param {string} rangeStr
 * @param {number} totalPages
 * @returns {number[]} Array of 1-based page indices
 */
export function parsePageRange(rangeStr, totalPages) {
  if (totalPages <= 0) return [];
  if (!rangeStr || typeof rangeStr !== 'string' || rangeStr.trim().toLowerCase() === 'all') {
    const all = [];
    for (let i = 1; i <= totalPages; i++) all.push(i);
    return all;
  }

  const clean = rangeStr.trim();
  const tokens = clean.split(',').map(t => t.trim()).filter(Boolean);
  const selectedPages = new Set();

  for (const token of tokens) {
    if (token.includes('-')) {
      const parts = token.split('-').map(p => p.trim());
      if (parts.length !== 2) {
        throw new Error(`Invalid page range syntax: "${token}". Use format like "1-3" or "5".`);
      }
      const start = parseInt(parts[0], 10);
      const end = parseInt(parts[1], 10);
      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range: "${token}". Numbers must be positive with start <= end.`);
      }
      for (let p = start; p <= Math.min(end, totalPages); p++) {
        selectedPages.add(p);
      }
    } else {
      const p = parseInt(token, 10);
      if (isNaN(p) || p < 1) {
        throw new Error(`Invalid page number: "${token}". Must be a positive integer.`);
      }
      if (p <= totalPages) {
        selectedPages.add(p);
      }
    }
  }

  const result = Array.from(selectedPages).sort((a, b) => a - b);
  if (result.length === 0) {
    throw new Error(`No valid pages selected by range: "${rangeStr}" (workbook sheet has ${totalPages} printable pages).`);
  }
  return result;
}

export default {
  PAPER_SIZES,
  DEFAULT_PAPER_SIZE,
  colLetterToIndex,
  indexToColLetter,
  parseRange,
  parseRepeatingRows,
  parseRepeatingCols,
  calculatePrintablePages,
  parsePageRange,
};
