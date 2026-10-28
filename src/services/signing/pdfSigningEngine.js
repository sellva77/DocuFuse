import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument, rgb, StandardFonts, degrees, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, PDFRef, PDFDict } from 'pdf-lib';
import { buildSignedAttributes, buildPkcs7SignedData } from './asn1Helper.js';
import { normalizedToPdfPoints, validatePdfPlacement, getVisualPageDimensions } from '../../utils/pdfCoordinateUtils.js';

const CONTENTS_PLACEHOLDER_LENGTH = 16384; // 8192 bytes in hex

/**
 * PDF Signing Engine
 * Generates standards-compliant PAdES-B-B (Baseline B) / PAdES-BES electronic signatures
 * in strict accordance with ETSI EN 319 142-1, ISO 32000-2, and European eIDAS regulation.
 */
export class PdfSigningEngine {
  /**
   * Prepares and cryptographically signs a PDF document with PAdES compliance
   * 
   * @param {Object} options
   * @param {Buffer|Uint8Array} options.pdfBuffer - Source PDF bytes
   * @param {Object} options.certificateInfo - Selected certificate metadata
   * @param {Object} options.provider - Concrete CertificateProvider instance
   * @param {string} [options.reason] - Signature reason
   * @param {string} [options.location] - Signature location
   * @param {string} [options.contactInfo] - Contact info / signer email
   * @param {boolean} [options.visibleSignature=true] - Whether to render visible signature badge
   * @param {Object} [options.appearance] - Visual signature placement options
   * @returns {Promise<{ signedPdfBuffer: Buffer, signatureDetails: Object }>}
   */
  static async signPdf({
    pdfBuffer,
    certificateInfo,
    provider,
    reason = 'Document signed digitally',
    location = 'Office',
    contactInfo = '',
    visibleSignature = true,
    appearance = {},
  }) {
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('PDF document buffer is required and cannot be empty');
    }
    if (!certificateInfo) {
      throw new Error('Certificate information is required for signing');
    }
    if (!provider) {
      throw new Error('Certificate provider is required for signing');
    }

    const signingDate = new Date();

    // Resolve signer name considering all DSC certificate name possibilities
    const customFields = appearance.customAppearance?.customFields || {};
    const signerNameSource = customFields.signerNameSource || 'certificate';

    // Extract name from certificate: try subjectCommonName first, then parse CN from subject DN
    const certCommonName = certificateInfo.subjectCommonName || '';
    const certSubject = certificateInfo.subject || '';
    const parsedCn = certSubject.match(/CN=([^,]+)/i)?.[1]?.trim() || '';
    const certificateName = certCommonName || parsedCn || certSubject || '';

    let signerName = '';
    if (signerNameSource === 'none') {
      signerName = ''; // Completely hidden
    } else if (signerNameSource === 'custom') {
      signerName = customFields.signerName || appearance.signerName || certificateName;
    } else {
      // 'certificate' mode: always use the DSC certificate name
      signerName = certificateName || customFields.signerName || appearance.signerName || '';
    }

    // Step 1: Load PDF into pdf-lib to add visual appearance and configure PAdES AcroForm field
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    // Determine target page
    let targetPageIndex = pageCount - 1; // Default to last page
    if (appearance.page === 'first') targetPageIndex = 0;
    else if (typeof appearance.page === 'number' && appearance.page >= 1 && appearance.page <= pageCount) {
      targetPageIndex = appearance.page - 1;
    }

    const targetPage = pdfDoc.getPage(targetPageIndex);
    const { width: pageWidth, height: pageHeight } = targetPage.getSize();
    const rotation = targetPage.getRotation()?.angle || 0;

    let posX = 0, posY = 0, stampWidth = 0, stampHeight = 0;

    if (visibleSignature) {
      // Check for normalized coordinates from interactive canvas placement
      if (
        typeof appearance.normX === 'number' &&
        typeof appearance.normY === 'number' &&
        typeof appearance.normWidth === 'number' &&
        typeof appearance.normHeight === 'number'
      ) {
        // Convert normalized visual coordinates to PDF points
        const pdfRect = normalizedToPdfPoints({
          normX: appearance.normX,
          normY: appearance.normY,
          normWidth: appearance.normWidth,
          normHeight: appearance.normHeight,
          pageWidth,
          pageHeight,
          rotation,
        });

        // Validate the computed placement
        const validation = validatePdfPlacement(
          { x: pdfRect.x, y: pdfRect.y, width: pdfRect.width, height: pdfRect.height },
          pageWidth,
          pageHeight
        );
        if (!validation.valid) {
          throw new Error(`Invalid signature placement: ${validation.error}`);
        }

        posX = pdfRect.x;
        posY = pdfRect.y;
        stampWidth = pdfRect.width;
        stampHeight = pdfRect.height;
      } else if (typeof appearance.pdfX === 'number' && typeof appearance.pdfY === 'number') {
        posX = appearance.pdfX;
        posY = appearance.pdfY;
        stampWidth = appearance.pdfWidth || 210;
        stampHeight = appearance.pdfHeight || 65;
      } else {
        stampWidth = appearance.width || 210;
        stampHeight = appearance.height || 65;
        posX = pageWidth - stampWidth - 25;
        posY = 25;

        const position = appearance.position || 'bottom-right';
        if (position === 'bottom-left') {
          posX = 25;
          posY = 25;
        } else if (position === 'top-right') {
          posX = pageWidth - stampWidth - 25;
          posY = pageHeight - stampHeight - 25;
        } else if (position === 'top-left') {
          posX = 25;
          posY = pageHeight - stampHeight - 25;
        } else if (position === 'custom' && typeof appearance.x === 'number' && typeof appearance.y === 'number') {
          posX = Math.max(0, Math.min(pageWidth - stampWidth, appearance.x));
          posY = Math.max(0, Math.min(pageHeight - stampHeight, appearance.y));
        }
      }

      // Draw aesthetic signature appearance stamp (black text on transparent background)
      await renderSignatureStamp(pdfDoc, targetPage, {
        x: posX,
        y: posY,
        width: stampWidth,
        height: stampHeight,
        signerName,
        reason,
        location,
        signingDate,
        serialNumber: certificateInfo.serialNumber,
        isTest: certificateInfo.isTestCertificate,
        rotation,
        customAppearance: appearance.customAppearance,
        certificateInfo,
      });
    }

    // Step 2: Configure PAdES-compliant AcroForm and Signature Widget Annotation
    // Fixed-length byte range placeholders for deterministic buffer patching
    const byteRangePlaceholder = [
      PDFNumber.of(0),
      PDFNumber.of(1000000000),
      PDFNumber.of(1000000000),
      PDFNumber.of(1000000000),
    ];
    const contentsPlaceholder = PDFHexString.of('0'.repeat(CONTENTS_PLACEHOLDER_LENGTH));

    const pad = (n) => String(n).padStart(2, '0');
    const pdfDateStr = `D:${signingDate.getUTCFullYear()}${pad(signingDate.getUTCMonth() + 1)}${pad(signingDate.getUTCDate())}${pad(signingDate.getUTCHours())}${pad(signingDate.getUTCMinutes())}${pad(signingDate.getUTCSeconds())}+00'00'`;

    // Signature Dictionary with ETSI.CAdES.detached (PAdES specification ETSI EN 319 142)
    const sigDict = pdfDoc.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'ETSI.CAdES.detached',
      ByteRange: byteRangePlaceholder,
      Contents: contentsPlaceholder,
      M: PDFString.of(pdfDateStr),
      ...(reason ? { Reason: PDFString.of(reason) } : {}),
      ...(location ? { Location: PDFString.of(location) } : {}),
      ...(contactInfo ? { ContactInfo: PDFString.of(contactInfo) } : {}),
    });
    const sigDictRef = pdfDoc.context.register(sigDict);

    // Interactive Signature Widget Annotation
    const sigField = pdfDoc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: [posX, posY, posX + stampWidth, posY + stampHeight],
      V: sigDictRef,
      T: PDFString.of(`Signature${targetPageIndex + 1}`),
      F: visibleSignature ? 132 : 2,
      P: targetPage.ref,
    });
    const sigFieldRef = pdfDoc.context.register(sigField);

    // Attach to target page Annotations array
    let annots = targetPage.node.get(PDFName.of('Annots'));
    // Dereference if it's an indirect reference (PDFRef)
    if (annots instanceof PDFRef) {
      annots = pdfDoc.context.lookup(annots);
    }
    if (!annots) {
      targetPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([sigFieldRef]));
    } else if (annots instanceof PDFArray) {
      annots.push(sigFieldRef);
    } else {
      // Unknown type — overwrite with a fresh array containing existing + new
      targetPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([sigFieldRef]));
    }

    // Attach to Document Catalog AcroForm with SigFlags = 3 (SignaturesExist + AppendOnly per PAdES spec)
    let acroForm = pdfDoc.catalog.get(PDFName.of('AcroForm'));
    // Dereference if it's an indirect reference (PDFRef)
    if (acroForm instanceof PDFRef) {
      acroForm = pdfDoc.context.lookup(acroForm);
    }
    if (!acroForm || !(acroForm instanceof PDFDict)) {
      acroForm = pdfDoc.context.obj({
        Fields: [sigFieldRef],
        SigFlags: 3,
      });
      pdfDoc.catalog.set(PDFName.of('AcroForm'), acroForm);
    } else {
      acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
      let fields = acroForm.get(PDFName.of('Fields'));
      // Dereference fields too
      if (fields instanceof PDFRef) {
        fields = pdfDoc.context.lookup(fields);
      }
      if (!fields || !(fields instanceof PDFArray)) {
        acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([sigFieldRef]));
      } else {
        fields.push(sigFieldRef);
      }
    }

    // Step 3: Save PDF and compute ByteRange
    const modifiedPdfBytes = await pdfDoc.save({ useObjectStreams: false });
    const signedBuffer = Buffer.from(modifiedPdfBytes);
    const pdfStr = signedBuffer.toString('binary');

    // Find the signature dictionary (/Type /Sig) to avoid matching page contents
    const sigTypeIdx = pdfStr.lastIndexOf('/Type /Sig');
    const searchStart = sigTypeIdx !== -1 ? sigTypeIdx : 0;

    const byteRangeIdx = pdfStr.indexOf('/ByteRange', searchStart);
    if (byteRangeIdx === -1) {
      throw new Error('Internal error: /ByteRange placeholder not found in PDF structure');
    }
    const byteRangeStart = pdfStr.indexOf('[', byteRangeIdx);
    const byteRangeEnd = pdfStr.indexOf(']', byteRangeStart);

    const contentsIdx = pdfStr.indexOf('/Contents', byteRangeIdx);
    if (contentsIdx === -1) {
      throw new Error('Internal error: /Contents placeholder not found in PDF structure');
    }
    const hexStart = pdfStr.indexOf('<', contentsIdx);
    const hexEnd = pdfStr.indexOf('>', hexStart);

    // ByteRange format: [ 0, len1, offset2, len2 ]
    // Per ISO 32000-1 (PDF 1.7) § 12.8.1:
    // len1 = offset of the opening '<' of /Contents
    // offset2 = offset immediately following closing '>' of /Contents
    // len2 = fileLength - offset2
    // The entire /Contents value (<...>) is excluded from the signed byte range!
    const len1 = hexStart;
    const offset2 = hexEnd + 1;
    const len2 = signedBuffer.length - offset2;

    const pad10 = (n) => String(n).padStart(10, '0');
    const actualByteRangeStr = `[ 0 ${pad10(len1)} ${pad10(offset2)} ${pad10(len2)} ]`;
    signedBuffer.write(actualByteRangeStr, byteRangeStart, actualByteRangeStr.length, 'ascii');

    // Step 4: Compute SHA-256 digest over the byte ranges
    const range1 = signedBuffer.subarray(0, len1);
    const range2 = signedBuffer.subarray(offset2, offset2 + len2);
    
    const hash = crypto.createHash('sha256');
    hash.update(range1);
    hash.update(range2);
    const pdfDigest = hash.digest();

    // Step 5: Build SignedAttributes SET with RFC 5035 / ETSI EN 319 122 signing-certificate-v2
    let certDer = null;
    if (Buffer.isBuffer(certificateInfo.certDer)) {
      certDer = certificateInfo.certDer;
    } else if (typeof certificateInfo.certDerBase64 === 'string' && certificateInfo.certDerBase64.length > 0) {
      certDer = Buffer.from(certificateInfo.certDerBase64, 'base64');
    }

    if (!certDer || certDer.length === 0) {
      throw new Error(`Public certificate DER data is missing for "${certificateInfo.subjectCommonName || certificateInfo.alias || 'selected certificate'}". Required for PAdES CAdES-BES signature.`);
    }

    const { signedAttrsSet, bytesToSign } = buildSignedAttributes(pdfDigest, signingDate, certDer);

    // Step 6: Perform genuine cryptographic signing using the selected provider
    const signResult = await provider.signData(certificateInfo.alias || certificateInfo.id, bytesToSign);

    const finalCertDer = signResult.certDerBuffer || certDer;
    const signatureBytes = signResult.signatureBuffer;

    // Step 7: Build the full CMS / PKCS#7 SignedData structure
    const pkcs7Der = buildPkcs7SignedData({
      certDer: finalCertDer,
      signedAttrsSet,
      signatureBytes,
      chainDers: signResult.chainDers || [],
    });

    // Step 8: Inject PKCS#7 hex into /Contents placeholder
    const pkcs7Hex = pkcs7Der.toString('hex').toUpperCase();
    if (pkcs7Hex.length > CONTENTS_PLACEHOLDER_LENGTH) {
      throw new Error(`Signature container (${pkcs7Hex.length} hex chars) exceeds placeholder allocation (${CONTENTS_PLACEHOLDER_LENGTH})`);
    }

    // Pad remaining space with zeros
    const paddedHex = pkcs7Hex.padEnd(CONTENTS_PLACEHOLDER_LENGTH, '0');
    signedBuffer.write(paddedHex, hexStart + 1, CONTENTS_PLACEHOLDER_LENGTH, 'ascii');

    return {
      signedPdfBuffer: signedBuffer,
      signatureDetails: {
        signerName,
        subject: certificateInfo.subject,
        issuer: certificateInfo.issuer,
        serialNumber: certificateInfo.serialNumber,
        signingTime: signingDate.toISOString(),
        reason,
        location,
        digestAlgorithm: 'SHA-256',
        signatureAlgorithm: signResult.algorithm || 'SHA256withRSA',
        subFilter: 'ETSI.CAdES.detached',
        format: 'PAdES-B-B (ETSI EN 319 142 / eIDAS)',
        hasSigningCertV2: true,
        byteRange: [0, len1, offset2, len2],
        isHardwareToken: certificateInfo.isHardwareToken,
        isTestCertificate: certificateInfo.isTestCertificate,
      },
    };
  }
}

/**
 * Helper to convert HEX color string to pdf-lib rgb()
 */
function parseHexToPdfRgb(hex, fallback = { r: 0, g: 0, b: 0 }) {
  if (!hex || typeof hex !== 'string') return rgb(fallback.r, fallback.g, fallback.b);
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) / 255;
    const g = parseInt(clean[1] + clean[1], 16) / 255;
    const b = parseInt(clean[2] + clean[2], 16) / 255;
    return rgb(r, g, b);
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16) / 255;
    const g = parseInt(clean.slice(2, 4), 16) / 255;
    const b = parseInt(clean.slice(4, 6), 16) / 255;
    return rgb(r, g, b);
  }
  return rgb(fallback.r, fallback.g, fallback.b);
}

/**
 * Helper to draw dashed line in PDF
 */
function drawDashedLine(page, x1, y1, x2, y2, color, thickness = 1, dashLen = 3, gapLen = 2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 0) return;
  const step = dashLen + gapLen;
  const ux = dx / dist;
  const uy = dy / dist;

  for (let offset = 0; offset < dist; offset += step) {
    const curDash = Math.min(dashLen, dist - offset);
    page.drawLine({
      start: { x: x1 + ux * offset, y: y1 + uy * offset },
      end: { x: x1 + ux * (offset + curDash), y: y1 + uy * (offset + curDash) },
      thickness,
      color,
    });
  }
}

/**
 * Helper to draw dashed rectangle in PDF
 */
function drawDashedRect(page, x, y, width, height, color, thickness = 1, dashLen = 3, gapLen = 2) {
  drawDashedLine(page, x, y + height, x + width, y + height, color, thickness, dashLen, gapLen);
  drawDashedLine(page, x, y, x + width, y, color, thickness, dashLen, gapLen);
  drawDashedLine(page, x, y, x, y + height, color, thickness, dashLen, gapLen);
  drawDashedLine(page, x + width, y, x + width, y + height, color, thickness, dashLen, gapLen);
}

/**
 * Renders an aesthetic visual signature stamp onto the target page
 */
async function renderSignatureStamp(pdfDoc, page, {
  x,
  y,
  width,
  height,
  signerName,
  reason,
  location,
  signingDate,
  customAppearance = null,
  certificateInfo = null,
}) {
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const fields = customAppearance?.customFields || {};
  const styling = customAppearance?.styling || {};
  const inkColorRgb = parseHexToPdfRgb(styling.inkColor || '#000000', { r: 0, g: 0, b: 0 });

  // 1. Draw Background
  if (styling.backgroundColor && styling.backgroundColor !== 'transparent') {
    const bgRgb = parseHexToPdfRgb(styling.backgroundColor, { r: 1, g: 1, b: 1 });
    page.drawRectangle({
      x,
      y,
      width,
      height,
      color: bgRgb,
    });
  }

  // 2. Draw Border (matching preview border options)
  if (styling.borderStyle && styling.borderStyle !== 'none') {
    if (styling.borderStyle === 'blue') {
      page.drawRectangle({
        x,
        y,
        width,
        height,
        borderColor: rgb(0.23, 0.51, 0.96),
        borderWidth: 1.5,
      });
    } else if (styling.borderStyle === 'dashed') {
      drawDashedRect(page, x, y, width, height, rgb(0.58, 0.64, 0.72), 1, 3, 2);
    } else {
      // 'solid' (Subtle gray #cbd5e1 matching web preview)
      page.drawRectangle({
        x,
        y,
        width,
        height,
        borderColor: rgb(0.8, 0.83, 0.88),
        borderWidth: 1,
      });
    }
  }

  // Format date according to selected dateFormat
  const padTwo = (n) => String(n).padStart(2, '0');
  const d = signingDate || new Date();
  const year = d.getFullYear();
  const month = padTwo(d.getMonth() + 1);
  const day = padTwo(d.getDate());
  const hours = padTwo(d.getHours());
  const minutes = padTwo(d.getMinutes());
  const seconds = padTwo(d.getSeconds());

  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const tzHours = padTwo(Math.floor(Math.abs(tzOffsetMin) / 60));
  const tzMins = padTwo(Math.abs(tzOffsetMin) % 60);

  let dateStr = `${year}.${month}.${day} ${hours}:${minutes}:${seconds} ${sign}${tzHours}'${tzMins}'`;
  if (fields.dateFormat === 'date_only') {
    dateStr = `${year}.${month}.${day}`;
  } else if (fields.dateFormat === 'iso') {
    dateStr = d.toISOString();
  }

  // Active field values (fully customized)
  const signerNameSource = customAppearance?.customFields?.signerNameSource || 'certificate';
  
  // Resolve active signer name from the appropriate source
  let activeSigner = '';
  if (signerNameSource === 'none') {
    activeSigner = ''; // Hidden
  } else if (signerNameSource === 'custom') {
    activeSigner = fields.signerName || signerName || '';
  } else {
    // 'certificate' mode: prefer certificate info
    const certCn = certificateInfo?.subjectCommonName || '';
    const certSubject = certificateInfo?.subject || '';
    const parsedCn = certSubject.match(/CN=([^,]+)/i)?.[1]?.trim() || '';
    activeSigner = certCn || parsedCn || fields.signerName || signerName || '';
  }

  // Resolve prefix (support custom prefix)
  let signPrefix = fields.signPrefix;
  if (signPrefix === '__custom__') {
    signPrefix = fields.signPrefixCustom || '';
  } else if (signPrefix === undefined) {
    signPrefix = 'Digitally signed by';
  }

  const dnString = fields.distinguishedName || certificateInfo?.subject || (activeSigner ? `cn=${activeSigner}` : '');
  const activeReason = fields.reason !== undefined ? fields.reason : (reason || 'Document signature and certification');
  const activeLocation = fields.location !== undefined ? fields.location : (location || 'Office');
  const activeVersion = fields.versionText || 'DocuFuse 1.0.0';

  const graphicType = customAppearance?.graphicType || 'none';
  const includeText = customAppearance?.includeText || {
    name: true,
    date: true,
    logo: false,
    reason: false,
    distinguishedName: false,
    adobeVersion: false,
    location: false,
    labels: true,
  };
  const showLabels = includeText.labels !== false;
  const textDirection = customAppearance?.textDirection || 'auto';

  // Embed Custom Logo / Seal Image if provided
  let customLogoImage = null;
  if (includeText.logo && fields.customLogoDataUrl && typeof fields.customLogoDataUrl === 'string' && fields.customLogoDataUrl.startsWith('data:image/')) {
    try {
      const commaIdx = fields.customLogoDataUrl.indexOf(',');
      if (commaIdx !== -1) {
        const base64Str = fields.customLogoDataUrl.slice(commaIdx + 1);
        const imgBuffer = Buffer.from(base64Str, 'base64');
        if (fields.customLogoDataUrl.includes('image/jpeg') || fields.customLogoDataUrl.includes('image/jpg')) {
          customLogoImage = await pdfDoc.embedJpg(imgBuffer);
        } else {
          customLogoImage = await pdfDoc.embedPng(imgBuffer);
        }
      }
    } catch (logoErr) {
      console.warn('Could not embed custom logo image:', logoErr);
    }
  }

  // 3. Draw Watermark if logoPosition is 'watermark'
  if (customLogoImage && fields.logoPosition === 'watermark') {
    const wmSize = Math.min(width * 0.6, height * 0.85);
    const aspect = customLogoImage.width / customLogoImage.height;
    const wmW = aspect >= 1 ? wmSize : wmSize * aspect;
    const wmH = aspect >= 1 ? wmSize / aspect : wmSize;
    page.drawImage(customLogoImage, {
      x: x + (width - wmW) / 2,
      y: y + (height - wmH) / 2,
      width: wmW,
      height: wmH,
      opacity: 0.12,
    });
  }

  // Embed graphic if Draw or Image mode
  let embeddedGraphic = null;
  const rawDataUrl = graphicType === 'draw'
    ? customAppearance?.drawnDataUrl
    : (graphicType === 'image' ? customAppearance?.imageDataUrl : null);

  if (rawDataUrl && typeof rawDataUrl === 'string' && rawDataUrl.startsWith('data:image/')) {
    try {
      const commaIdx = rawDataUrl.indexOf(',');
      if (commaIdx !== -1) {
        const base64Str = rawDataUrl.slice(commaIdx + 1);
        const imgBuffer = Buffer.from(base64Str, 'base64');
        if (rawDataUrl.includes('image/jpeg') || rawDataUrl.includes('image/jpg')) {
          embeddedGraphic = await pdfDoc.embedJpg(imgBuffer);
        } else {
          embeddedGraphic = await pdfDoc.embedPng(imgBuffer);
        }
      }
    } catch (imgErr) {
      console.warn('Could not embed custom signature graphic image:', imgErr);
    }
  }

  // Layout geometry: if graphic is present, split box with proper margins
  const hasGraphic = Boolean(embeddedGraphic) || (graphicType === 'text');
  const paddingH = Math.min(8, Math.max(4, width * 0.04));
  const paddingV = Math.min(6, Math.max(2, height * 0.05));

  let graphicWidth = 0;
  let textStartX = x + paddingH;
  let textWidthArea = Math.max(8, width - paddingH * 2);

  if (hasGraphic) {
    graphicWidth = Math.min(width * 0.38, 120);
    textWidthArea = Math.max(8, width - graphicWidth - paddingH * 2 - 8);

    let graphicX = x + paddingH;
    if (textDirection === 'right') {
      // In align-right mode (flex-direction: row-reverse in CSS): text is on left, graphic on right
      textStartX = x + paddingH;
      graphicX = x + width - paddingH - graphicWidth;
    } else {
      graphicX = x + paddingH;
      textStartX = x + paddingH + graphicWidth + 8;
    }

    if (embeddedGraphic) {
      const imgAspect = embeddedGraphic.width / embeddedGraphic.height;
      let drawW = Math.max(2, graphicWidth - 4);
      let drawH = drawW / imgAspect;
      if (drawH > height - paddingV * 2) {
        drawH = Math.max(2, height - paddingV * 2);
        drawW = drawH * imgAspect;
      }
      const imgX = graphicX + (graphicWidth - drawW) / 2;
      const imgY = y + (height - drawH) / 2;

      page.drawImage(embeddedGraphic, {
        x: imgX,
        y: imgY,
        width: drawW,
        height: drawH,
      });
    } else if (graphicType === 'text') {
      const stylName = customAppearance?.textSignature && customAppearance.textSignature !== 'Authorized Signer'
        ? customAppearance.textSignature
        : (activeSigner || '');
      if (stylName) {
        const stylFont = customAppearance?.textStyle === 'serif' ? fontBold : fontItalic;
        const stylSize = Math.max(6, Math.min(18, height * 0.45));
        const stylW = stylFont.widthOfTextAtSize(stylName, stylSize);
        const stylX = graphicX + Math.max(0, (graphicWidth - stylW) / 2);
        const stylY = y + (height - stylSize) / 2;
        page.drawText(stylName, {
          x: stylX,
          y: stylY,
          size: stylSize,
          font: stylFont,
          color: inkColorRgb,
        });
      }
    }
  }

  // Prepare text lines to render (matching exactly what is rendered in preview)
  const lines = [];

  if (includeText.name !== false && signerNameSource !== 'none' && activeSigner) {
    const nameText = signPrefix ? `${signPrefix} ${activeSigner}`.trim() : activeSigner;
    lines.push({
      text: nameText,
      isBold: true,
      baseSize: 10,
    });
  }

  if (includeText.distinguishedName && dnString) {
    lines.push({
      text: `${showLabels ? 'DN: ' : ''}${dnString}`,
      isBold: false,
      baseSize: 7.5,
    });
  }

  if (includeText.date !== false) {
    lines.push({
      text: `${showLabels ? 'Date: ' : ''}${dateStr}`,
      isBold: false,
      baseSize: 8,
    });
  }

  if (includeText.reason && activeReason) {
    lines.push({
      text: `${showLabels ? 'Reason: ' : ''}${activeReason}`,
      isBold: false,
      baseSize: 7.5,
    });
  }

  if (includeText.location && activeLocation) {
    lines.push({
      text: `${showLabels ? 'Location: ' : ''}${activeLocation}`,
      isBold: false,
      baseSize: 7.5,
    });
  }

  if (includeText.adobeVersion && activeVersion) {
    lines.push({
      text: `${showLabels ? 'Version: ' : ''}${activeVersion}`,
      isBold: false,
      baseSize: 7.0,
    });
  }

  // Corner Logo Badge if logoPosition is 'badge'
  if (customLogoImage && fields.logoPosition === 'badge' && includeText.logo) {
    const badgeH = Math.min(14, height * 0.35);
    const badgeW = (customLogoImage.width / customLogoImage.height) * badgeH;
    page.drawImage(customLogoImage, {
      x: x + width - badgeW - paddingH,
      y: y + paddingV,
      width: badgeW,
      height: badgeH,
    });
  }

  if (lines.length > 0) {
    // 1. Calculate required height at 100% scale
    const baseLineGapRatio = 1.35;
    let unscaledTotalHeight = 0;
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        unscaledTotalHeight += lines[i].baseSize;
      } else {
        unscaledTotalHeight += lines[i].baseSize * baseLineGapRatio;
      }
    }

    const availHeight = Math.max(10, height - paddingV * 2);
    const scaleH = availHeight / Math.max(1, unscaledTotalHeight);

    // 2. Calculate required width at 100% scale
    let maxLineWidth = 0;
    for (const lineItem of lines) {
      const f = lineItem.isBold ? fontBold : fontRegular;
      const w = f.widthOfTextAtSize(lineItem.text, lineItem.baseSize);
      if (w > maxLineWidth) maxLineWidth = w;
    }
    const scaleW = textWidthArea / Math.max(1, maxLineWidth);

    // Dynamic scale: fits comfortably without shrinking to microscopic text
    const scale = Math.max(0.5, Math.min(1.05, scaleH, scaleW));

    // Compute actual sizes and line gaps
    const lineGap = Math.max(6, Math.round(11 * scale));
    const actualSizes = lines.map(l => Math.max(4.5, Math.round(l.baseSize * scale * 10) / 10));

    // Total actual vertical block height
    const totalActualHeight = (lines.length - 1) * lineGap + actualSizes[0] * 0.75;

    // Vertical centering: centers the text block in the signature box
    const vertPad = Math.max(2, (height - totalActualHeight) / 2);
    let cursorY = y + height - vertPad - (actualSizes[0] * 0.75);

    for (let i = 0; i < lines.length; i++) {
      const lineItem = lines[i];
      const size = actualSizes[i];
      const font = lineItem.isBold ? fontBold : fontRegular;

      let cleanText = lineItem.text;
      let textWidth = font.widthOfTextAtSize(cleanText, size);
      if (textWidth > textWidthArea) {
        while (cleanText.length > 3 && font.widthOfTextAtSize(cleanText + '...', size) > textWidthArea) {
          cleanText = cleanText.slice(0, -1);
        }
        cleanText += '...';
        textWidth = font.widthOfTextAtSize(cleanText, size);
      }

      let drawX = textStartX;
      if (textDirection === 'right') {
        drawX = textStartX + textWidthArea - textWidth;
      } else if (textDirection === 'center') {
        drawX = textStartX + Math.max(0, (textWidthArea - textWidth) / 2);
      }

      page.drawText(cleanText, {
        x: drawX,
        y: cursorY,
        size,
        font,
        color: inkColorRgb,
      });

      cursorY -= lineGap;
    }
  }
}

/**
 * Injects PDF signature dictionary and allocates placeholder for ByteRange and Contents
 * using standard PDF incremental structure
 */
function preparePdfForSignature(pdfBuf, { reason, location, contactInfo, signingDate }) {
  // Format PDF date string: D:YYYYMMDDHHMMSS+00'00'
  const pad = (n) => String(n).padStart(2, '0');
  const d = signingDate || new Date();
  const pdfDateStr = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}+00'00'`;

  // Allocate ByteRange placeholder: 4 fixed 10-digit numbers: [ 0 0000000000 0000000000 0000000000 ]
  const byteRangePlaceholder = '[ 0 0000000000 0000000000 0000000000 ]';
  const contentsPlaceholder = '0'.repeat(CONTENTS_PLACEHOLDER_LENGTH);

  // Clean strings
  const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  // Build signature dictionary string
  const sigDictStr = [
    '<<',
    '/Type /Sig',
    '/Filter /Adobe.PPKLite',
    '/SubFilter /adbe.pkcs7.detached',
    `/ByteRange ${byteRangePlaceholder}`,
    `/Contents <${contentsPlaceholder}>`,
    `/M (${pdfDateStr})`,
    reason ? `/Reason (${esc(reason)})` : '',
    location ? `/Location (${esc(location)})` : '',
    contactInfo ? `/ContactInfo (${esc(contactInfo)})` : '',
    '>>',
  ].filter(Boolean).join('\n');

  // Allocate object number
  // Find highest object number in existing PDF
  const pdfStr = pdfBuf.toString('binary');
  const objMatches = [...pdfStr.matchAll(/(\d+)\s+0\s+obj/g)];
  let maxObjNum = 1;
  for (const m of objMatches) {
    const num = parseInt(m[1], 10);
    if (num > maxObjNum) maxObjNum = num;
  }
  const sigObjNum = maxObjNum + 1;

  // Find startxref and the previous xref offset
  const startXrefIdx = pdfStr.lastIndexOf('startxref');
  if (startXrefIdx === -1) {
    throw new Error('Invalid PDF: startxref not found');
  }

  const afterStartXref = pdfStr.slice(startXrefIdx);
  const startXrefMatch = afterStartXref.match(/startxref\s+(\d+)/);
  if (!startXrefMatch) {
    throw new Error('Invalid PDF: previous startxref offset could not be parsed');
  }
  const prevXrefOffset = parseInt(startXrefMatch[1], 10);

  // Extract previous trailer dictionary
  const trailerIdx = pdfStr.lastIndexOf('trailer', startXrefIdx);
  let prevRoot = null;
  let prevInfo = null;
  let prevId = null;

  if (trailerIdx !== -1) {
    const trailerChunk = pdfStr.substring(trailerIdx, startXrefIdx);
    const rootMatch = trailerChunk.match(/\/Root\s+(\d+\s+\d+\s+R)/);
    if (rootMatch) prevRoot = rootMatch[1];

    const infoMatch = trailerChunk.match(/\/Info\s+(\d+\s+\d+\s+R)/);
    if (infoMatch) prevInfo = infoMatch[1];

    const idMatch = trailerChunk.match(/\/ID\s*(\[[^\]]+\])/);
    if (idMatch) prevId = idMatch[1];
  }

  // Fallback: search anywhere in pdfStr for /Root if not found in the last trailer
  if (!prevRoot) {
    const rootMatch = pdfStr.match(/\/Root\s+(\d+\s+\d+\s+R)/);
    prevRoot = rootMatch ? rootMatch[1] : '1 0 R';
  }

  // Ensure clean newline after previous %%EOF
  const lastByte = pdfBuf[pdfBuf.length - 1];
  const separator = (lastByte === 0x0A || lastByte === 0x0D) ? '' : '\n';

  // Construct incremental update block
  const sigObjOffset = pdfBuf.length + Buffer.byteLength(separator, 'ascii');
  const sigObjContent = `${sigObjNum} 0 obj\n${sigDictStr}\nendobj\n`;

  const xrefOffset = sigObjOffset + Buffer.byteLength(sigObjContent, 'ascii');
  const pad10 = (n) => String(n).padStart(10, '0');

  // Build standard-compliant incremental trailer dictionary
  const trailerDict = [
    '<<',
    `  /Size ${sigObjNum + 1}`,
    `  /Root ${prevRoot}`,
    `  /Prev ${prevXrefOffset}`,
    prevInfo ? `  /Info ${prevInfo}` : '',
    prevId ? `  /ID ${prevId}` : '',
    '>>',
  ].filter(Boolean).join('\n');

  // Incremental cross-reference table and trailer
  const xrefContent = [
    'xref',
    '0 1',
    '0000000000 65535 f ',
    `${sigObjNum} 1`,
    `${pad10(sigObjOffset)} 00000 n `,
    'trailer',
    trailerDict,
    'startxref',
    `${xrefOffset}`,
    '%%EOF\n',
  ].join('\n');

  // Combine into new buffer
  const combinedBuffer = Buffer.concat([
    pdfBuf,
    Buffer.from(separator, 'ascii'),
    Buffer.from(sigObjContent, 'ascii'),
    Buffer.from(xrefContent, 'ascii'),
  ]);

  // Now calculate exact byte offsets for /ByteRange
  const combinedStr = combinedBuffer.toString('binary');
  const byteRangeIdx = combinedStr.indexOf(byteRangePlaceholder);
  if (byteRangeIdx === -1) {
    throw new Error('Internal error: /ByteRange placeholder not found');
  }

  const contentsStartIdx = combinedStr.indexOf('<' + contentsPlaceholder + '>');
  if (contentsStartIdx === -1) {
    throw new Error('Internal error: /Contents placeholder not found');
  }

  // Contents hex starts right after '<'
  const contentsHexStart = contentsStartIdx + 1;
  // Contents hex ends right before '>'
  const contentsHexEnd = contentsHexStart + CONTENTS_PLACEHOLDER_LENGTH;

  // ByteRange:
  // [ 0, contentsStartIdx + 1, contentsHexEnd + 1, totalLength - (contentsHexEnd + 1) ]
  // Range 1 includes byte 0 through the '<'
  const offset1 = contentsHexStart; // bytes from 0 to '<' inclusive
  // Range 2 starts from '>' through end of file
  const offset2 = contentsHexEnd + 1; // byte position of '>'
  const len2 = combinedBuffer.length - offset2;

  const actualByteRange = [0, offset1, offset2, len2];
  const actualByteRangeStr = `[ 0 ${pad10(offset1)} ${pad10(offset2)} ${pad10(len2)} ]`;

  if (actualByteRangeStr.length !== byteRangePlaceholder.length) {
    throw new Error(`ByteRange length mismatch: expected ${byteRangePlaceholder.length}, got ${actualByteRangeStr.length}`);
  }

  // Patch the ByteRange in place
  combinedBuffer.write(actualByteRangeStr, byteRangeIdx, actualByteRangeStr.length, 'ascii');

  return {
    buffer: combinedBuffer,
    byteRange: actualByteRange,
    contentsOffset: contentsHexStart,
  };
}

export default {
  PdfSigningEngine,
};
