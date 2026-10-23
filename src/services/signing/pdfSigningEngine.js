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
    const signerName = appearance.signerName || certificateInfo.subjectCommonName || 'Authorized Signer';

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
 * Renders a visual signature stamp onto a PDF page
 */
async function renderSignatureStamp(pdfDoc, page, { x, y, width, height, signerName, signingDate }) {
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const scaleW = Math.min(width / 210, 1.4);
  const scaleH = Math.min(height / 65, 1.4);
  const scale = Math.min(scaleW, scaleH);

  const headerSize = Math.max(5.5, Math.min(9.5, 7.5 * scale));
  const nameSize = Math.max(7.5, Math.min(14, 10.5 * scale));
  const dateSize = Math.max(5, Math.min(8.5, 7 * scale));

  // Max characters for signer name
  const maxChars = Math.max(10, Math.floor(width / (nameSize * 0.55)));
  const cleanSigner = signerName.length > maxChars ? signerName.substring(0, maxChars - 2) + '...' : signerName;

  // Format Adobe Acrobat-style standard timestamp: YYYY.MM.DD HH:mm:ss +HH'mm'
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
  const dateStr = `${year}.${month}.${day} ${hours}:${minutes}:${seconds} ${sign}${tzHours}'${tzMins}'`;

  // ABSOLUTELY NO BORDERLINE, NO BACKGROUND BOX - PURE CLEAN BLACK TEXT ONLY
  const lineGap = Math.max(8, Math.round(12 * scale));
  let cursorY = y + height - headerSize - 2;

  // Line 1: "Digitally signed by" (plain black)
  page.drawText('Digitally signed by', {
    x,
    y: cursorY,
    size: headerSize,
    font: fontRegular,
    color: rgb(0, 0, 0),
  });
  cursorY -= lineGap;

  // Line 2: Signer Name (bold plain black)
  if (cursorY > y + 4) {
    page.drawText(cleanSigner, {
      x,
      y: cursorY,
      size: nameSize,
      font: fontBold,
      color: rgb(0, 0, 0),
    });
    cursorY -= lineGap;
  }

  // Line 3: "Date: <date and time>" (plain black)
  if (cursorY > y - 4) {
    page.drawText(`Date: ${dateStr}`, {
      x,
      y: cursorY,
      size: dateSize,
      font: fontRegular,
      color: rgb(0, 0, 0),
    });
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
