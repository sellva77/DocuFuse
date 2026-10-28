import fs from 'fs';
import path from 'path';
import os from 'os';
import { PDFDocument, rgb, StandardFonts, PageSizes } from 'pdf-lib';
import mammoth from 'mammoth';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  PageBreak,
  BorderStyle,
  AlignmentType,
} from 'docx';
import { isPdfValid, isDocxValid, isDocValid, isXlsxValid, isXlsValid } from '../utils/fileValidator.js';
import { inspectWorkbook, exportExcelToPdf } from './excel/excelService.js';
import { parseWorkbook } from './excel/excelParser.js';
import { validateExcelFile } from './excel/excelValidator.js';
import { sanitizeTextForPdf } from '../utils/textSanitizer.js';
import pdfParse from 'pdf-parse';

/**
 * Process and merge multiple document files
 */
async function processFiles({ filePaths, files: filesConfigs, outputFormat, outputPath, tempDir, onProgress }) {
  const totalFiles = filePaths.length;
  const progress = (step, detail, percent) => {
    if (onProgress) {
      onProgress({ step, detail, percent, total: totalFiles });
    }
  };

  progress('Validating', 'Checking input files...', 0);

  // Validate all files before processing
  const fileInfos = [];
  for (let i = 0; i < filePaths.length; i++) {
    const fp = filePaths[i];
    const ext = path.extname(fp).toLowerCase();
    const name = path.basename(fp);

    // Magic byte validation
    if (ext === '.pdf' && !isPdfValid(fp)) {
      throw new Error(`"${name}" does not appear to be a valid PDF file. It may be corrupted or password-protected.`);
    }
    if (ext === '.docx' && !isDocxValid(fp)) {
      throw new Error(`"${name}" does not appear to be a valid DOCX file. It may be corrupted or password-protected.`);
    }
    if (ext === '.doc' && !isDocValid(fp)) {
      throw new Error(`"${name}" does not appear to be a valid DOC file. It may be corrupted.`);
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const v = validateExcelFile(fp);
      if (!v.valid) {
        throw new Error(v.error);
      }
    }

    // Match file configuration if provided
    const fileConfig = Array.isArray(filesConfigs)
      ? filesConfigs.find(c => c && (c.path === fp || c.filePath === fp))
      : null;
    const excludedPages = Array.isArray(fileConfig?.excludedPages)
      ? fileConfig.excludedPages.map(Number).filter(n => !isNaN(n) && n > 0)
      : [];

    fileInfos.push({ path: fp, ext, name, index: i, excludedPages });
  }

  progress('Processing', 'Starting merge...', 5);

  if (outputFormat === 'pdf') {
    await mergeToPdf(fileInfos, outputPath, tempDir, progress);
  } else if (outputFormat === 'docx') {
    await mergeToDocx(fileInfos, outputPath, tempDir, progress);
  } else {
    throw new Error(`Unsupported output format: ${outputFormat}`);
  }

  progress('Complete', 'Merge finished successfully!', 100);
}

// ══════════════════════════════════════════════════════════
// PDF MERGE
// ══════════════════════════════════════════════════════════

async function mergeToPdf(fileInfos, outputPath, tempDir, progress) {
  const mergedPdf = await PDFDocument.create();
  const totalFiles = fileInfos.length;

  for (let i = 0; i < fileInfos.length; i++) {
    const file = fileInfos[i];
    const pct = 10 + Math.round((i / totalFiles) * 80);
    progress('Processing', `Processing ${file.name} (${i + 1}/${totalFiles})...`, pct);

    try {
      if (file.ext === '.pdf') {
        await addPdfToMerged(mergedPdf, file.path, file.excludedPages || []);
      } else if (file.ext === '.docx') {
        await addDocxToPdfMerged(mergedPdf, file.path, file.name);
      } else if (file.ext === '.doc') {
        await addDocToPdfMerged(mergedPdf, file.path, file.name);
      } else if (file.ext === '.xlsx' || file.ext === '.xls') {
        await addExcelToPdfMerged(mergedPdf, file.path, tempDir);
      }
    } catch (err) {
      if (err.message.includes('encrypted') || err.message.includes('password')) {
        throw new Error(`"${file.name}" appears to be password-protected and cannot be processed.`);
      }
      throw new Error(`Failed to process "${file.name}": ${err.message}`);
    }
  }

  if (mergedPdf.getPageCount() === 0) {
    throw new Error('No pages were produced from the input files. All pages may have been excluded.');
  }

  progress('Saving', 'Writing output PDF...', 92);
  const pdfBytes = await mergedPdf.save();
  await fs.promises.writeFile(outputPath, pdfBytes);
}

/**
 * Copy pages from a source PDF into the merged PDF, skipping any excluded pages
 */
async function addPdfToMerged(mergedPdf, pdfPath, excludedPages = []) {
  const pdfBytes = await fs.promises.readFile(pdfPath);
  let sourcePdf;
  try {
    sourcePdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  } catch (err) {
    if (err.message && err.message.includes('encrypted')) {
      throw new Error('encrypted');
    }
    // Try with ignoreEncryption
    try {
      sourcePdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    } catch (err2) {
      throw new Error(`Cannot load PDF: ${err2.message}`);
    }
  }

  const pageIndices = sourcePdf.getPageIndices();
  const excludedSet = new Set((excludedPages || []).map(p => Number(p) - 1));
  const keepIndices = pageIndices.filter(idx => !excludedSet.has(idx));

  if (keepIndices.length > 0) {
    const copiedPages = await mergedPdf.copyPages(sourcePdf, keepIndices);
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }
}

/**
 * Convert Excel workbook visible worksheets to PDF and add to merged document
 */
async function addExcelToPdfMerged(mergedPdf, excelPath, tempDir) {
  const inspection = await inspectWorkbook(excelPath);
  const visibleSheets = inspection.sheets.filter(s => s.isVisible);
  const sheetsToExport = visibleSheets.length > 0 ? visibleSheets : inspection.sheets;

  const tempOut = path.join(
    tempDir || os.tmpdir(),
    `excel_merged_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
  );

  await exportExcelToPdf({
    filePath: excelPath,
    sheetConfigs: sheetsToExport.map(s => ({
      sheetIndex: s.index,
      sheetName: s.name,
      selected: true,
      pageRange: 'all',
    })),
    outputPath: tempOut,
  });

  const pdfBytes = await fs.promises.readFile(tempOut);
  const sourcePdf = await PDFDocument.load(pdfBytes);
  const pageIndices = sourcePdf.getPageIndices();
  const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);
  for (const page of copiedPages) {
    mergedPdf.addPage(page);
  }

  // Cleanup temp file
  try {
    await fs.promises.unlink(tempOut);
  } catch (_) {}
}

/**
 * Convert DOCX content to PDF pages and add to merged document.
 * Uses mammoth to extract HTML, then renders text content to PDF pages.
 * Note: Complex formatting (exact fonts, columns, headers/footers) may not
 * be perfectly preserved since we're doing a text-level conversion.
 */
async function addDocxToPdfMerged(mergedPdf, docxPath, fileName) {
  const docxBuffer = await fs.promises.readFile(docxPath);

  // Extract structured content
  const content = await extractDocxContent(docxBuffer);

  if (!content || (content.paragraphs.length === 0 && content.images.length === 0)) {
    // Add a placeholder page indicating empty document
    const page = mergedPdf.addPage(PageSizes.A4);
    const font = await mergedPdf.embedFont(StandardFonts.Helvetica);
    page.drawText(`[Document: ${fileName} — No extractable content]`, {
      x: 50,
      y: page.getHeight() - 50,
      size: 12,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    return;
  }

  await renderContentToPdf(mergedPdf, content, fileName);
}

/**
 * Convert DOC content to PDF pages. 
 * DOC is a legacy binary format. Without LibreOffice/Word we extract
 * what text we can using binary parsing. Formatting will be limited.
 */
async function addDocToPdfMerged(mergedPdf, docPath, fileName) {
  const docBuffer = await fs.promises.readFile(docPath);

  // Try to extract text from DOC binary format
  let text = '';
  try {
    text = extractTextFromDoc(docBuffer);
  } catch (err) {
    // Fallback: note that the file couldn't be processed
    const page = mergedPdf.addPage(PageSizes.A4);
    const font = await mergedPdf.embedFont(StandardFonts.Helvetica);
    page.drawText(`[Document: ${fileName}]`, {
      x: 50,
      y: page.getHeight() - 50,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText('Legacy DOC format — text extraction was limited.', {
      x: 50,
      y: page.getHeight() - 75,
      size: 10,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawText('For best results, save the DOC file as DOCX first.', {
      x: 50,
      y: page.getHeight() - 90,
      size: 10,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    return;
  }

  if (!text.trim()) {
    const page = mergedPdf.addPage(PageSizes.A4);
    const font = await mergedPdf.embedFont(StandardFonts.Helvetica);
    page.drawText(`[Document: ${fileName} — No extractable text content]`, {
      x: 50,
      y: page.getHeight() - 50,
      size: 12,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    return;
  }

  // Render text to PDF pages
  const content = {
    paragraphs: text.split('\n').filter(line => line.trim()).map(line => ({
      type: 'paragraph',
      text: line.trim(),
      style: 'normal',
    })),
    images: [],
  };

  await renderContentToPdf(mergedPdf, content, fileName);
}

/**
 * Render extracted content blocks into PDF pages
 */
async function renderContentToPdf(mergedPdf, content, fileName) {
  const font = await mergedPdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await mergedPdf.embedFont(StandardFonts.HelveticaBold);

  const PAGE_WIDTH = PageSizes.A4[0];
  const PAGE_HEIGHT = PageSizes.A4[1];
  const MARGIN = 50;
  const LINE_HEIGHT_NORMAL = 16;
  const LINE_HEIGHT_HEADING = 24;
  const MAX_TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

  let currentPage = mergedPdf.addPage(PageSizes.A4);
  let yPos = PAGE_HEIGHT - MARGIN;

  const startNewPage = () => {
    currentPage = mergedPdf.addPage(PageSizes.A4);
    yPos = PAGE_HEIGHT - MARGIN;
  };

  for (const para of content.paragraphs) {
    const isHeading = para.style && para.style.startsWith('heading');
    const fontSize = isHeading ? 16 : 11;
    const lineHeight = isHeading ? LINE_HEIGHT_HEADING : LINE_HEIGHT_NORMAL;
    const currentFont = isHeading ? boldFont : font;

    // Sanitize and word-wrap the text
    const safeText = sanitizeTextForPdf(para.text, currentFont);
    const lines = wrapText(safeText, currentFont, fontSize, MAX_TEXT_WIDTH);

    for (const line of lines) {
      if (yPos < MARGIN + lineHeight) {
        startNewPage();
      }

      try {
        currentPage.drawText(line, {
          x: MARGIN,
          y: yPos,
          size: fontSize,
          font: currentFont,
          color: rgb(0, 0, 0),
        });
      } catch {
        try {
          const asciiOnly = line.replace(/[^\x20-\x7E]/g, '?');
          currentPage.drawText(asciiOnly, {
            x: MARGIN,
            y: yPos,
            size: fontSize,
            font: currentFont,
            color: rgb(0, 0, 0),
          });
        } catch (_) {}
      }

      yPos -= lineHeight;
    }

    // Extra spacing after paragraph
    yPos -= lineHeight * 0.3;
  }

  // Embed images
  for (const img of content.images) {
    try {
      let embeddedImage;
      if (img.contentType === 'image/png') {
        embeddedImage = await mergedPdf.embedPng(img.buffer);
      } else if (img.contentType === 'image/jpeg' || img.contentType === 'image/jpg') {
        embeddedImage = await mergedPdf.embedJpg(img.buffer);
      } else {
        continue; // Skip unsupported image types
      }

      const imgDims = embeddedImage.scale(1);
      let drawWidth = imgDims.width;
      let drawHeight = imgDims.height;

      // Scale down if too wide
      if (drawWidth > MAX_TEXT_WIDTH) {
        const scale = MAX_TEXT_WIDTH / drawWidth;
        drawWidth *= scale;
        drawHeight *= scale;
      }

      // Scale down if too tall
      const maxImgHeight = PAGE_HEIGHT - 2 * MARGIN;
      if (drawHeight > maxImgHeight) {
        const scale = maxImgHeight / drawHeight;
        drawWidth *= scale;
        drawHeight *= scale;
      }

      if (yPos - drawHeight < MARGIN) {
        startNewPage();
      }

      currentPage.drawImage(embeddedImage, {
        x: MARGIN,
        y: yPos - drawHeight,
        width: drawWidth,
        height: drawHeight,
      });

      yPos -= drawHeight + 10;
    } catch {
      // Skip images that can't be embedded
    }
  }
}

/**
 * Word-wrap text to fit within a given width
 */
function wrapText(text, font, fontSize, maxWidth) {
  if (!text) return [''];

  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    try {
      const width = font.widthOfTextAtSize(testLine, fontSize);
      if (width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    } catch {
      // If measurement fails, just add the word
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

// ══════════════════════════════════════════════════════════
// DOCX MERGE
// ══════════════════════════════════════════════════════════

async function mergeToDocx(fileInfos, outputPath, tempDir, progress) {
  const allSections = [];
  const totalFiles = fileInfos.length;

  for (let i = 0; i < fileInfos.length; i++) {
    const file = fileInfos[i];
    const pct = 10 + Math.round((i / totalFiles) * 80);
    progress('Processing', `Processing ${file.name} (${i + 1}/${totalFiles})...`, pct);

    try {
      let sectionChildren;

      if (file.ext === '.docx') {
        sectionChildren = await extractDocxForDocxOutput(file.path, file.name);
      } else if (file.ext === '.doc') {
        sectionChildren = await extractDocForDocxOutput(file.path, file.name);
      } else if (file.ext === '.pdf') {
        sectionChildren = await extractPdfForDocxOutput(file.path, file.name, file.excludedPages || []);
      } else if (file.ext === '.xlsx' || file.ext === '.xls') {
        sectionChildren = await extractExcelForDocxOutput(file.path, file.name);
      } else {
        sectionChildren = [
          new Paragraph({
            children: [new TextRun({ text: `[Unsupported format: ${file.name}]`, italics: true, color: '999999' })],
          }),
        ];
      }

      // Add page break between documents (not before the first one)
      if (i > 0 && sectionChildren.length > 0) {
        sectionChildren[0] = addPageBreakBefore(sectionChildren[0]);
      }

      allSections.push(...sectionChildren);
    } catch (err) {
      if (err.message.includes('encrypted') || err.message.includes('password')) {
        throw new Error(`"${file.name}" appears to be password-protected and cannot be processed.`);
      }
      throw new Error(`Failed to process "${file.name}": ${err.message}`);
    }
  }

  if (allSections.length === 0) {
    throw new Error('No content was extracted from the input files.');
  }

  progress('Saving', 'Writing output DOCX...', 92);

  const doc = new Document({
    creator: 'DocuFuse',
    description: 'Merged document created by DocuFuse',
    title: 'Merged Document',
    sections: [
      {
        children: allSections,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.promises.writeFile(outputPath, buffer);
}

/**
 * Extract DOCX content for DOCX output using mammoth HTML + conversion
 */
async function extractDocxForDocxOutput(docxPath, fileName) {
  const docxBuffer = await fs.promises.readFile(docxPath);
  const children = [];

  // Add source header
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `— Source: ${fileName} —`,
          size: 16,
          color: '888888',
          italics: true,
        }),
      ],
      spacing: { after: 200 },
    })
  );

  try {
    // Extract using mammoth for structured content
    const result = await mammoth.extractRawText({ buffer: docxBuffer });
    const text = result.value;

    if (!text.trim()) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: '[No extractable text content]', italics: true, color: '999999' })],
        })
      );
      return children;
    }

    // Also get HTML for structure hints
    const htmlResult = await mammoth.convertToHtml({ buffer: docxBuffer });
    const htmlContent = htmlResult.value;

    // Parse HTML to get structured paragraphs
    const parsed = parseHtmlToDocxElements(htmlContent);
    children.push(...parsed);

    // Extract and include images
    const images = await extractImagesFromDocx(docxBuffer);
    for (const img of images) {
      try {
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                data: img.buffer,
                transformation: {
                  width: Math.min(img.width || 400, 550),
                  height: Math.min(img.height || 300, 750),
                },
                type: img.contentType === 'image/png' ? 'png' : 'jpg',
              }),
            ],
            spacing: { before: 100, after: 100 },
          })
        );
      } catch {
        // Skip images that can't be embedded
      }
    }
  } catch (err) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `[Error extracting content: ${err.message}]`, italics: true, color: 'FF0000' }),
        ],
      })
    );
  }

  return children;
}

/**
 * Extract DOC content for DOCX output
 */
async function extractDocForDocxOutput(docPath, fileName) {
  const docBuffer = await fs.promises.readFile(docPath);
  const children = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `— Source: ${fileName} (Legacy DOC format) —`,
          size: 16,
          color: '888888',
          italics: true,
        }),
      ],
      spacing: { after: 200 },
    })
  );

  try {
    const text = extractTextFromDoc(docBuffer);

    if (!text.trim()) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: '[No extractable text content]', italics: true, color: '999999' })],
        })
      );
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: 'Tip: For best results, open this DOC file in Word and save it as DOCX first.',
              size: 18,
              color: '666666',
              italics: true,
            }),
          ],
        })
      );
      return children;
    }

    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: line.trim() })],
            spacing: { after: 120 },
          })
        );
      }
    }
  } catch (err) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `[Could not fully extract DOC content: ${err.message}]`,
            italics: true,
            color: 'FF0000',
          }),
        ],
      })
    );
  }

  return children;
}

/**
 * Extract Excel content for DOCX output as Word tables and sheet headers.
 */
async function extractExcelForDocxOutput(excelPath, fileName) {
  const children = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `— Source: ${fileName} (Excel Workbook) —`,
          size: 16,
          color: '888888',
          italics: true,
        }),
      ],
      spacing: { after: 140 },
    })
  );

  try {
    const parsed = await parseWorkbook(excelPath);
    const visibleSheets = parsed.sheets.filter(s => s.state === 'visible');
    const sheetsToExport = visibleSheets.length > 0 ? visibleSheets : parsed.sheets;

    for (const sheet of sheetsToExport) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Worksheet: ${sheet.name}`,
              bold: true,
              size: 24,
              color: '107c41',
            }),
          ],
          spacing: { before: 200, after: 100 },
        })
      );

      const tableRows = [];
      const maxRows = Math.min(sheet.rowCount, 200);
      const maxCols = Math.min(sheet.columnCount, 20);

      for (let r = 1; r <= maxRows; r++) {
        const cells = [];
        let hasContent = false;

        for (let c = 1; c <= maxCols; c++) {
          const cell = sheet.cells[`${r},${c}`];
          const val = cell ? (cell.displayedText || '') : '';
          if (val.trim()) hasContent = true;

          cells.push(
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: val,
                      bold: cell?.bold || false,
                      size: 18,
                    }),
                  ],
                  spacing: { after: 40 },
                }),
              ],
            })
          );
        }

        if (hasContent) {
          tableRows.push(new TableRow({ children: cells }));
        }
      }

      if (tableRows.length > 0) {
        children.push(
          new Table({
            rows: tableRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          })
        );
      } else {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: '[Empty worksheet]', italics: true, color: '888888' })],
          })
        );
      }
    }
  } catch (err) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `[Error extracting Excel content: ${err.message}]`,
            italics: true,
            color: 'FF0000',
          }),
        ],
      })
    );
  }

  return children;
}

/**
 * Extract PDF content for DOCX output.
 * Note: PDF to editable DOCX is inherently lossy. Exact layout cannot be reproduced.
 */
async function extractPdfForDocxOutput(pdfPath, fileName, excludedPages = []) {
  const children = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `— Source: ${fileName} (PDF) —`,
          size: 16,
          color: '888888',
          italics: true,
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Note: PDF content has been extracted as text. Exact formatting, layouts, and some images may not be preserved.',
          size: 16,
          color: 'AA6600',
          italics: true,
        }),
      ],
      spacing: { after: 200 },
    })
  );

  try {
    const pdfBuffer = await fs.promises.readFile(pdfPath);
    const data = await pdfParse(pdfBuffer);

    if (!data.text || !data.text.trim()) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: '[PDF contains no extractable text — it may contain only images or scanned content]',
              italics: true,
              color: '999999',
            }),
          ],
        })
      );
      return children;
    }

    // Split by pages (pdf-parse uses form feed characters)
    const pages = data.text.split(/\f/);
    const excludedSet = new Set((excludedPages || []).map(p => Number(p)));

    let includedCount = 0;
    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const pageNum = pageIdx + 1;
      if (excludedSet.has(pageNum)) {
        continue;
      }

      const pageText = pages[pageIdx].trim();
      if (!pageText) continue;

      if (includedCount > 0) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: '', break: 1 })],
            spacing: { before: 400 },
          })
        );
      }
      includedCount++;

      const lines = pageText.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: line.trim() })],
              spacing: { after: 80 },
            })
          );
        }
      }
    }
  } catch (err) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `[Error extracting PDF content: ${err.message}]`, italics: true, color: 'FF0000' }),
        ],
      })
    );
  }

  return children;
}

// ══════════════════════════════════════════════════════════
// CONTENT EXTRACTION HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Extract structured content from DOCX for PDF rendering
 */
async function extractDocxContent(docxBuffer) {
  const paragraphs = [];
  const images = [];

  try {
    // Get HTML for structure
    const htmlResult = await mammoth.convertToHtml({ buffer: docxBuffer });
    const html = htmlResult.value;

    // Parse HTML into content blocks
    const blocks = parseHtmlToBlocks(html);
    paragraphs.push(...blocks);

    // Extract images
    const extractedImages = await extractImagesFromDocx(docxBuffer);
    images.push(...extractedImages);
  } catch (err) {
    // Fallback: try raw text extraction
    try {
      const textResult = await mammoth.extractRawText({ buffer: docxBuffer });
      if (textResult.value) {
        paragraphs.push(
          ...textResult.value.split('\n').filter(l => l.trim()).map(line => ({
            type: 'paragraph',
            text: line.trim(),
            style: 'normal',
          }))
        );
      }
    } catch {
      // Complete failure
    }
  }

  return { paragraphs, images };
}

/**
 * Extract images from a DOCX file (which is a ZIP archive)
 */
async function extractImagesFromDocx(docxBuffer) {
  const images = [];

  try {
    // Use mammoth's image conversion
    const result = await mammoth.convertToHtml({
      buffer: docxBuffer,
      convertImage: mammoth.images.imgElement(async (image) => {
        const buffer = await image.read();
        images.push({
          buffer: Buffer.from(buffer),
          contentType: image.contentType,
          width: 400,
          height: 300,
        });
        return { src: '' }; // We don't need the src
      }),
    });
  } catch {
    // Image extraction failed
  }

  return images;
}

/**
 * Parse HTML string into structured blocks for PDF rendering
 */
function parseHtmlToBlocks(html) {
  const blocks = [];
  if (!html) return blocks;

  // Simple HTML parser - extract text from tags
  // Handles: h1-h6, p, li, table cells
  const tagRegex = /<(h[1-6]|p|li|td|th|br\s*\/?)(?:\s[^>]*)?>([^<]*(?:<(?!\/?\1)[^<]*)*)<\/\1>/gi;
  const selfClosingRegex = /<br\s*\/?>/gi;

  // Split by major block elements
  let cleanHtml = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '</p>\n')
    .replace(/<\/h[1-6]>/gi, (match) => match + '\n')
    .replace(/<\/li>/gi, '</li>\n')
    .replace(/<\/tr>/gi, '</tr>\n');

  // Remove all HTML tags and decode entities
  const lines = cleanHtml
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .filter(line => line.trim());

  // Detect headings from original HTML
  const headingMatches = [...html.matchAll(/<(h[1-6])(?:\s[^>]*)?>(.+?)<\/\1>/gi)];
  const headingTexts = new Set(headingMatches.map(m => stripHtml(m[2]).trim()));

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isHeading = headingTexts.has(trimmed);

    blocks.push({
      type: 'paragraph',
      text: trimmed,
      style: isHeading ? 'heading' : 'normal',
    });
  }

  return blocks;
}

/**
 * Strip HTML tags from a string
 */
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&[a-zA-Z]+;/g, ' ');
}

/**
 * Parse HTML into docx Paragraph elements
 */
function parseHtmlToDocxElements(html) {
  const elements = [];
  if (!html) return elements;

  // Split into blocks
  const blockRegex = /<(h[1-6]|p|li|blockquote|pre)(?:\s[^>]*)?>(.+?)<\/\1>/gis;
  const matches = [...html.matchAll(blockRegex)];

  if (matches.length === 0) {
    // Fallback: strip tags and add as paragraphs
    const text = stripHtml(html).trim();
    if (text) {
      text.split('\n').filter(l => l.trim()).forEach(line => {
        elements.push(
          new Paragraph({
            children: [new TextRun({ text: line.trim() })],
            spacing: { after: 120 },
          })
        );
      });
    }
    return elements;
  }

  for (const match of matches) {
    const tag = match[1].toLowerCase();
    const content = stripHtml(match[2]).trim();
    if (!content) continue;

    if (tag.startsWith('h')) {
      const level = parseInt(tag[1]);
      const headingLevel = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ][level - 1] || HeadingLevel.HEADING_1;

      elements.push(
        new Paragraph({
          children: [new TextRun({ text: content, bold: true })],
          heading: headingLevel,
          spacing: { before: 240, after: 120 },
        })
      );
    } else if (tag === 'li') {
      elements.push(
        new Paragraph({
          children: [new TextRun({ text: `• ${content}` })],
          spacing: { after: 60 },
        })
      );
    } else {
      elements.push(
        new Paragraph({
          children: [new TextRun({ text: content })],
          spacing: { after: 120 },
        })
      );
    }
  }

  return elements;
}

/**
 * Add a page break before a paragraph
 */
function addPageBreakBefore(paragraph) {
  return new Paragraph({
    children: [new TextRun({ text: '', break: 1 })],
    pageBreakBefore: true,
  });
}

/**
 * Extract text from legacy DOC binary format.
 * This is a basic extraction of Unicode/ASCII text from the OLE compound document.
 * Full fidelity requires a complete OLE parser or external tool.
 */
function extractTextFromDoc(buffer) {
  // DOC files use OLE2 compound binary format
  // We'll extract readable text strings from the binary data
  const text = [];
  let i = 0;

  // Try to find the WordDocument stream data
  // Look for readable ASCII/Unicode text sequences
  const minRunLength = 4;
  let currentRun = '';

  while (i < buffer.length) {
    const byte = buffer[i];

    // Check for printable ASCII
    if (byte >= 0x20 && byte <= 0x7E) {
      currentRun += String.fromCharCode(byte);
    } else if (byte === 0x0D || byte === 0x0A) {
      // Newline
      if (currentRun.length >= minRunLength) {
        text.push(currentRun);
      }
      currentRun = '';
    } else if (byte === 0x09) {
      // Tab
      currentRun += ' ';
    } else {
      if (currentRun.length >= minRunLength) {
        text.push(currentRun);
      }
      currentRun = '';
    }

    i++;
  }

  if (currentRun.length >= minRunLength) {
    text.push(currentRun);
  }

  // Filter out binary garbage and OLE metadata
  const filtered = text.filter(line => {
    // Skip lines that look like binary/metadata
    if (line.length < 3) return false;
    if (/^[\x00-\x1F]+$/.test(line)) return false;
    if (/^[A-Z][a-z]+[A-Z]/.test(line) && line.length < 10) return false;

    // Check for reasonable text content (at least 50% alphanumeric+space)
    const alphaCount = (line.match(/[a-zA-Z0-9\s]/g) || []).length;
    return alphaCount / line.length > 0.5;
  });

  return filtered.join('\n');
}

export {
  processFiles,
};

export default {
  processFiles,
};
