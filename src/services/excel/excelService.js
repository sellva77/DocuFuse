import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parseWorkbook } from './excelParser.js';
import { parsePageRange } from './excelPaginator.js';
import { renderPageToPdf, generatePagePreview } from './excelRenderer.js';
import { validateExcelFile } from './excelValidator.js';

/**
 * Inspect an Excel workbook and return its worksheets and print pagination metadata
 * @param {string} filePath - Absolute path to .xlsx or .xls file
 * @returns {Promise<Object>} Inspection result with worksheets and pagination info
 */
export async function inspectWorkbook(filePath) {
  const parsed = await parseWorkbook(filePath);

  const sheetsSummary = parsed.sheets.map(s => ({
    id: s.id,
    index: s.index,
    name: s.name,
    state: s.state, // 'visible', 'hidden', 'veryHidden'
    isVisible: s.state === 'visible',
    isHidden: s.state === 'hidden',
    isVeryHidden: s.state === 'veryHidden',
    pageCount: s.pageCount,
    rowCount: s.rowCount,
    columnCount: s.columnCount,
    orientation: s.pageSetup.orientation,
    paperSize: s.pageSetup.paperSize,
    printArea: s.pageSetup.printArea,
    hasRepeatingRows: !!s.pageSetup.printTitlesRow,
    hasRepeatingCols: !!s.pageSetup.printTitlesColumn,
    hasPageBreaks: s.rowBreaks.length > 0,
    selected: s.state === 'visible', // Visible sheets selected by default
    pageRange: 'all', // Default to all printable pages
  }));

  return {
    filePath: parsed.filePath,
    fileName: parsed.fileName,
    format: parsed.format,
    sheetCount: parsed.sheetCount,
    sheets: sheetsSummary,
  };
}

/**
 * Get preview data for a specific worksheet and page
 * @param {string} filePath
 * @param {number} sheetIndex
 * @param {number} pageNumber - 1-based page number
 */
export async function getWorksheetPreview(filePath, sheetIndex, pageNumber = 1) {
  const parsed = await parseWorkbook(filePath);
  const sheet = parsed.sheets.find(s => s.index === sheetIndex);
  if (!sheet) {
    throw new Error(`Worksheet with index ${sheetIndex} not found in "${parsed.fileName}".`);
  }

  const pNum = Math.max(1, Math.min(pageNumber, sheet.pageCount));
  const pageDesc = sheet.printablePages[pNum - 1];
  if (!pageDesc) {
    throw new Error(`Page ${pNum} does not exist in worksheet "${sheet.name}".`);
  }

  const preview = generatePagePreview(sheet, pageDesc);
  return {
    ...preview,
    totalPages: sheet.pageCount,
    sheetName: sheet.name,
    sheetState: sheet.state,
  };
}

/**
 * Export selected worksheets and pages from an Excel workbook to a single PDF
 * @param {Object} options
 * @param {string} options.filePath - Path to Excel workbook
 * @param {Array<Object>} options.sheetConfigs - Ordered list of sheet configurations
 * @param {string} options.outputPath - Destination path for PDF
 * @param {Function} options.onProgress - Progress callback: ({ step, detail, percent }) => void
 * @returns {Promise<Object>} Export result
 */
export async function exportExcelToPdf({ filePath, sheetConfigs, outputPath, onProgress }) {
  const progress = (step, detail, percent) => {
    if (onProgress) onProgress({ step, detail, percent });
  };

  progress('Validating', 'Validating Excel workbook and output path...', 5);

  const validation = validateExcelFile(filePath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (!outputPath || typeof outputPath !== 'string' || outputPath.trim() === '') {
    throw new Error('Invalid output path for PDF export.');
  }

  const normalizedOutput = path.normalize(outputPath);
  const outputDir = path.dirname(normalizedOutput);
  try {
    await fs.promises.access(outputDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot write to output directory: "${outputDir}".`);
  }

  if (!Array.isArray(sheetConfigs) || sheetConfigs.length === 0) {
    throw new Error('No worksheets were configured for export.');
  }

  // Filter selected worksheets (preserving order)
  const selectedConfigs = sheetConfigs.filter(sc => sc.selected !== false);
  if (selectedConfigs.length === 0) {
    throw new Error('Please select at least one worksheet to export.');
  }

  progress('Parsing', 'Reading workbook data and formatting...', 15);
  const parsed = await parseWorkbook(filePath);

  // Match configs with parsed sheets
  const configuredSheets = [];
  for (const config of selectedConfigs) {
    const sheet = parsed.sheets.find(s => s.index === config.sheetIndex || s.name === config.sheetName);
    if (!sheet) {
      throw new Error(`Configured worksheet "${config.sheetName || config.sheetIndex}" was not found in workbook.`);
    }
    configuredSheets.push({
      sheet,
      pageRangeStr: config.pageRange || 'all',
      config,
    });
  }

  progress('Rendering', 'Creating PDF document...', 30);
  const pdfDoc = await PDFDocument.create();

  // Standard fonts
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const boldItalicFont = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
  const fonts = { regularFont, boldFont, italicFont, boldItalicFont };

  // Pre-embed images for each worksheet
  const embeddedImagesMap = new Map();
  for (const { sheet } of configuredSheets) {
    if (Array.isArray(sheet.images)) {
      for (let idx = 0; idx < sheet.images.length; idx++) {
        const img = sheet.images[idx];
        const key = `${sheet.name}_${idx}`;
        try {
          let embedded;
          if (img.extension === 'png') {
            embedded = await pdfDoc.embedPng(img.buffer);
          } else {
            embedded = await pdfDoc.embedJpg(img.buffer);
          }
          embeddedImagesMap.set(key, embedded);
        } catch (_) {
          // Unsupported or corrupted embedded image - skip gracefully
        }
      }
    }
  }

  // Render worksheets in the specified order
  let totalPagesRendered = 0;
  const totalSheets = configuredSheets.length;

  for (let sIdx = 0; sIdx < totalSheets; sIdx++) {
    const { sheet, pageRangeStr } = configuredSheets[sIdx];
    const pct = 35 + Math.round((sIdx / totalSheets) * 50);
    progress('Rendering', `Rendering worksheet "${sheet.name}" (${sIdx + 1}/${totalSheets})...`, pct);

    // Parse requested page range for this worksheet
    const selectedPages = parsePageRange(pageRangeStr, sheet.pageCount);

    for (const pageNum of selectedPages) {
      const pageDesc = sheet.printablePages[pageNum - 1];
      if (pageDesc) {
        await renderPageToPdf(pdfDoc, sheet, pageDesc, fonts, embeddedImagesMap);
        totalPagesRendered++;
      }
    }
  }

  if (totalPagesRendered === 0) {
    throw new Error('No printable pages were generated from the selected worksheets and page ranges.');
  }

  progress('Saving', 'Writing PDF file...', 90);
  const pdfBytes = await pdfDoc.save();
  await fs.promises.writeFile(normalizedOutput, pdfBytes);

  // Validate output file
  const stats = await fs.promises.stat(normalizedOutput);
  if (stats.size === 0) {
    throw new Error('Generated PDF file is empty (0 bytes).');
  }

  // Validate that the final PDF can be opened and has pages
  try {
    const verifiedPdf = await PDFDocument.load(pdfBytes);
    if (verifiedPdf.getPageCount() !== totalPagesRendered) {
      throw new Error(`Page count mismatch in generated PDF. Expected ${totalPagesRendered}, got ${verifiedPdf.getPageCount()}.`);
    }
  } catch (err) {
    throw new Error(`Validation error: Generated PDF could not be opened: ${err.message}`);
  }

  progress('Complete', 'PDF conversion completed successfully!', 100);

  return {
    success: true,
    outputPath: normalizedOutput,
    outputSize: stats.size,
    pageCount: totalPagesRendered,
  };
}

export default {
  inspectWorkbook,
  getWorksheetPreview,
  exportExcelToPdf,
};
