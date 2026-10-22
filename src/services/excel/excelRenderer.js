import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import { sanitizeTextForPdf } from '../../utils/textSanitizer.js';

/**
 * Convert hex color string (#RRGGBB or #RGB) to pdf-lib rgb()
 */
export function hexToRgb(hexStr, defaultRgb = rgb(0, 0, 0)) {
  if (!hexStr || typeof hexStr !== 'string') return defaultRgb;
  let clean = hexStr.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map(c => c + c).join('');
  }
  if (clean.length === 8) {
    // Drop alpha channel if present
    clean = clean.slice(2);
  }
  if (clean.length !== 6) return defaultRgb;

  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  if (isNaN(r) || isNaN(g) || isNaN(b)) return defaultRgb;
  return rgb(r, g, b);
}

/**
 * Get border thickness in points based on style
 */
export function getBorderThickness(style) {
  switch (style) {
    case 'medium':
      return 1.5;
    case 'thick':
      return 2.5;
    case 'double':
      return 2.0;
    case 'hair':
    case 'dotted':
    case 'dashed':
      return 0.5;
    case 'thin':
    default:
      return 0.75;
  }
}

/**
 * Render a single printable page to a PDFDocument
 */
export async function renderPageToPdf(pdfDoc, sheet, pageDesc, fonts, embeddedImagesMap) {
  const page = pdfDoc.addPage([pageDesc.pageWidth, pageDesc.pageHeight]);
  const scale = pageDesc.scale || 1.0;

  const { regularFont, boldFont, italicFont, boldItalicFont } = fonts;

  function getFont(fontDesc) {
    if (fontDesc.bold && fontDesc.italic) return boldItalicFont;
    if (fontDesc.bold) return boldFont;
    if (fontDesc.italic) return italicFont;
    return regularFont;
  }

  // Pre-calculate column X offsets and widths for this page
  const colX = {};
  const colW = {};
  let currentX = pageDesc.leftMargin;

  for (const c of pageDesc.allCols) {
    const rawW = sheet.colWidths?.[c] ?? 64;
    const scaledW = rawW * scale;
    colX[c] = currentX;
    colW[c] = scaledW;
    currentX += scaledW;
  }

  // Pre-calculate row Y offsets and heights for this page
  // In PDF, Y=0 is bottom, Y=pageHeight is top
  const rowY = {};
  const rowH = {};
  let currentY = pageDesc.pageHeight - pageDesc.topMargin;

  for (const r of pageDesc.allRows) {
    const rawH = sheet.rowHeights?.[r] ?? 18;
    const scaledH = rawH * scale;
    rowY[r] = currentY; // top of the row
    rowH[r] = scaledH;
    currentY -= scaledH;
  }

  // Render Backgrounds & Merges first
  for (const r of pageDesc.allRows) {
    const yTop = rowY[r];
    const h = rowH[r];

    for (const c of pageDesc.allCols) {
      const cellKey = `${r},${c}`;
      const cell = sheet.cells?.[cellKey];
      if (!cell || cell.isCovered) continue;

      const x = colX[c];
      let width = colW[c];
      let height = h;

      // Handle merged cells spanning across this page
      if (cell.isMaster && cell.mergeInfo) {
        const m = cell.mergeInfo;
        width = 0;
        for (let mc = m.startCol; mc <= m.endCol; mc++) {
          if (colW[mc]) width += colW[mc];
        }
        height = 0;
        for (let mr = m.startRow; mr <= m.endRow; mr++) {
          if (rowH[mr]) height += rowH[mr];
        }
      }

      // Draw cell background
      if (cell.bgColor) {
        page.drawRectangle({
          x,
          y: yTop - height,
          width,
          height,
          color: hexToRgb(cell.bgColor, rgb(1, 1, 1)),
        });
      }
    }
  }

  // Render Cell Borders
  for (const r of pageDesc.allRows) {
    const yTop = rowY[r];
    const h = rowH[r];

    for (const c of pageDesc.allCols) {
      const cellKey = `${r},${c}`;
      const cell = sheet.cells?.[cellKey];
      if (!cell || cell.isCovered) continue;

      const x = colX[c];
      let width = colW[c];
      let height = h;

      if (cell.isMaster && cell.mergeInfo) {
        const m = cell.mergeInfo;
        width = 0;
        for (let mc = m.startCol; mc <= m.endCol; mc++) {
          if (colW[mc]) width += colW[mc];
        }
        height = 0;
        for (let mr = m.startRow; mr <= m.endRow; mr++) {
          if (rowH[mr]) height += rowH[mr];
        }
      }

      const border = cell.border || {};

      // Top border
      if (border.top) {
        const thick = getBorderThickness(border.top.style);
        page.drawLine({
          start: { x, y: yTop },
          end: { x: x + width, y: yTop },
          thickness: thick,
          color: hexToRgb(border.top.color, rgb(0.8, 0.8, 0.8)),
        });
      }

      // Bottom border
      if (border.bottom) {
        const thick = getBorderThickness(border.bottom.style);
        page.drawLine({
          start: { x, y: yTop - height },
          end: { x: x + width, y: yTop - height },
          thickness: thick,
          color: hexToRgb(border.bottom.color, rgb(0.8, 0.8, 0.8)),
        });
      }

      // Left border
      if (border.left) {
        const thick = getBorderThickness(border.left.style);
        page.drawLine({
          start: { x, y: yTop },
          end: { x, y: yTop - height },
          thickness: thick,
          color: hexToRgb(border.left.color, rgb(0.8, 0.8, 0.8)),
        });
      }

      // Right border
      if (border.right) {
        const thick = getBorderThickness(border.right.style);
        page.drawLine({
          start: { x: x + width, y: yTop },
          end: { x: x + width, y: yTop - height },
          thickness: thick,
          color: hexToRgb(border.right.color, rgb(0.8, 0.8, 0.8)),
        });
      }
    }
  }

  // Render Cell Text
  const paddingX = 4 * scale;
  const paddingY = 3 * scale;

  for (const r of pageDesc.allRows) {
    const yTop = rowY[r];
    const h = rowH[r];

    for (const c of pageDesc.allCols) {
      const cellKey = `${r},${c}`;
      const cell = sheet.cells?.[cellKey];
      if (!cell || cell.isCovered || !cell.text) continue;

      const x = colX[c];
      let width = colW[c];
      let height = h;

      if (cell.isMaster && cell.mergeInfo) {
        const m = cell.mergeInfo;
        width = 0;
        for (let mc = m.startCol; mc <= m.endCol; mc++) {
          if (colW[mc]) width += colW[mc];
        }
        height = 0;
        for (let mr = m.startRow; mr <= m.endRow; mr++) {
          if (rowH[mr]) height += rowH[mr];
        }
      }

      const font = getFont(cell.font || {});
      const fontSize = Math.max(6, Math.min(22, (cell.font?.size || 10) * scale));
      const textColor = hexToRgb(cell.font?.color, rgb(0, 0, 0));
      const maxTextWidth = Math.max(10, width - paddingX * 2);

      let textToDraw = sanitizeTextForPdf(cell.text, font);
      let textWidth = 0;
      try {
        textWidth = font.widthOfTextAtSize(textToDraw, fontSize);
      } catch {
        textToDraw = sanitizeTextForPdf(textToDraw, null);
        try {
          textWidth = font.widthOfTextAtSize(textToDraw, fontSize);
        } catch {
          textWidth = maxTextWidth;
        }
      }

      // Truncate if exceeds cell width (clean clipping)
      if (textWidth > maxTextWidth) {
        while (textToDraw.length > 3) {
          try {
            if (font.widthOfTextAtSize(textToDraw + '...', fontSize) <= maxTextWidth) break;
          } catch {
            break;
          }
          textToDraw = textToDraw.slice(0, -1);
        }
        textToDraw = textToDraw + '...';
        try {
          textWidth = font.widthOfTextAtSize(textToDraw, fontSize);
        } catch {
          textWidth = maxTextWidth;
        }
      }

      // Horizontal alignment
      const align = cell.alignment?.horizontal || 'left';
      let drawX = x + paddingX;
      if (align === 'center') {
        drawX = x + Math.max(paddingX, (width - textWidth) / 2);
      } else if (align === 'right') {
        drawX = x + Math.max(paddingX, width - textWidth - paddingX);
      }

      // Vertical alignment
      const vAlign = cell.alignment?.vertical || 'middle';
      const fontHeight = fontSize * 0.8;
      let drawY = yTop - (height + fontHeight) / 2; // middle
      if (vAlign === 'top') {
        drawY = yTop - paddingY - fontHeight;
      } else if (vAlign === 'bottom') {
        drawY = yTop - height + paddingY;
      }

      try {
        page.drawText(textToDraw, {
          x: drawX,
          y: drawY,
          size: fontSize,
          font,
          color: textColor,
        });
      } catch {
        // Ultimate fallback: draw ascii-only string
        try {
          const asciiOnly = textToDraw.replace(/[^\x20-\x7E]/g, '?');
          page.drawText(asciiOnly, {
            x: drawX,
            y: drawY,
            size: fontSize,
            font,
            color: textColor,
          });
        } catch (_) {}
      }
    }
  }

  // Render Embedded Images
  if (Array.isArray(sheet.images)) {
    for (let idx = 0; idx < sheet.images.length; idx++) {
      const img = sheet.images[idx];
      const embeddedImg = embeddedImagesMap.get(`${sheet.name}_${idx}`);
      if (!embeddedImg || !img.range) continue;

      const tlCol = img.range.tl?.col;
      const tlRow = img.range.tl?.row;
      if (tlCol === undefined || tlRow === undefined) continue;

      // Check if image belongs on this page
      if (colX[tlCol] !== undefined && rowY[tlRow] !== undefined) {
        const imgX = colX[tlCol];
        const imgY = rowY[tlRow];
        // Calculate image size
        const imgW = (img.range.ext?.width ? img.range.ext.width / 9525 : 120) * scale;
        const imgH = (img.range.ext?.height ? img.range.ext.height / 9525 : 80) * scale;

        page.drawImage(embeddedImg, {
          x: imgX,
          y: imgY - imgH,
          width: imgW,
          height: imgH,
        });
      }
    }
  }

  // Page Footer (Sheet Name & Page Number)
  const footerText = `${sheet.name} — Page ${pageDesc.pageIndex}`;
  const footerFontSize = 8 * scale;
  const footerWidth = regularFont.widthOfTextAtSize(footerText, footerFontSize);
  page.drawText(footerText, {
    x: pageDesc.pageWidth - pageDesc.rightMargin - footerWidth,
    y: Math.max(12, pageDesc.bottomMargin / 2),
    size: footerFontSize,
    font: regularFont,
    color: rgb(0.5, 0.5, 0.55),
  });
}

/**
 * Generate preview data (SVG/HTML representation) for renderer preview display
 */
export function generatePagePreview(sheet, pageDesc) {
  const scale = 1.0;
  const width = pageDesc.pageWidth;
  const height = pageDesc.pageHeight;

  const colX = {};
  const colW = {};
  let currentX = pageDesc.leftMargin;
  for (const c of pageDesc.allCols) {
    const rawW = sheet.colWidths?.[c] ?? 64;
    colX[c] = currentX;
    colW[c] = rawW;
    currentX += rawW;
  }

  const rowY = {};
  const rowH = {};
  let currentY = pageDesc.topMargin;
  for (const r of pageDesc.allRows) {
    const rawH = sheet.rowHeights?.[r] ?? 18;
    rowY[r] = currentY;
    rowH[r] = rawH;
    currentY += rawH;
  }

  const rects = [];
  const lines = [];
  const texts = [];

  for (const r of pageDesc.allRows) {
    const yTop = rowY[r];
    const h = rowH[r];

    for (const c of pageDesc.allCols) {
      const cellKey = `${r},${c}`;
      const cell = sheet.cells?.[cellKey];
      if (!cell || cell.isCovered) continue;

      const x = colX[c];
      let cellW = colW[c];
      let cellH = h;

      if (cell.isMaster && cell.mergeInfo) {
        const m = cell.mergeInfo;
        cellW = 0;
        for (let mc = m.startCol; mc <= m.endCol; mc++) {
          if (colW[mc]) cellW += colW[mc];
        }
        cellH = 0;
        for (let mr = m.startRow; mr <= m.endRow; mr++) {
          if (rowH[mr]) cellH += rowH[mr];
        }
      }

      // Background
      if (cell.bgColor) {
        rects.push({
          x,
          y: yTop,
          width: cellW,
          height: cellH,
          fill: cell.bgColor,
        });
      }

      // Borders
      const border = cell.border || {};
      if (border.top) {
        lines.push({ x1: x, y1: yTop, x2: x + cellW, y2: yTop, stroke: border.top.color || '#D1D5DB', strokeWidth: getBorderThickness(border.top.style) });
      }
      if (border.bottom) {
        lines.push({ x1: x, y1: yTop + cellH, x2: x + cellW, y2: yTop + cellH, stroke: border.bottom.color || '#D1D5DB', strokeWidth: getBorderThickness(border.bottom.style) });
      }
      if (border.left) {
        lines.push({ x1: x, y1: yTop, x2: x, y2: yTop + cellH, stroke: border.left.color || '#D1D5DB', strokeWidth: getBorderThickness(border.left.style) });
      }
      if (border.right) {
        lines.push({ x1: x + cellW, y1: yTop, x2: x + cellW, y2: yTop + cellH, stroke: border.right.color || '#D1D5DB', strokeWidth: getBorderThickness(border.right.style) });
      }

      // Text
      if (cell.text) {
        texts.push({
          x: x + 4,
          y: yTop + cellH / 2 + 4,
          text: cell.text,
          fontSize: cell.font?.size || 10,
          bold: cell.font?.bold,
          color: cell.font?.color || '#000000',
          align: cell.alignment?.horizontal || 'left',
          cellWidth: cellW - 8,
        });
      }
    }
  }

  return {
    pageIndex: pageDesc.pageIndex,
    sheetName: sheet.name,
    pageWidth: width,
    pageHeight: height,
    orientation: pageDesc.orientation,
    rects,
    lines,
    texts,
  };
}

export default {
  renderPageToPdf,
  generatePagePreview,
  hexToRgb,
  getBorderThickness,
};
