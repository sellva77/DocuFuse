/**
 * testPlacement.mjs — Signature Placement & Coordinate Mapping Tests
 *
 * Validates:
 * 1. Coordinate conversion between normalized visual and PDF point spaces
 * 2. Page rotation handling (0°, 90°, 180°, 270°)
 * 3. Boundary clamping and minimum size enforcement
 * 4. End-to-end signing with custom user-defined coordinates
 * 5. Signature verification on custom-placed signed PDFs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    results.push(`  [PASS] ${name}`);
  } else {
    failed++;
    results.push(`  [FAIL] ${name}`);
  }
}

const TEMP_DIR = path.join(__dirname, '_temp_placement');

async function main() {
  console.log('====================================================');
  console.log('   SIGNATURE PLACEMENT & COORDINATE MAPPING TESTS   ');
  console.log('====================================================\n');

  // Setup temp directory
  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // Import modules
  const {
    getVisualPageDimensions,
    normalizeRect,
    clampRectToBounds,
    screenToNormalized,
    normalizedToScreen,
    normalizedToPdfPoints,
    validatePdfPlacement,
  } = await import('../src/utils/pdfCoordinateUtils.js');

  const { PDFDocument, degrees } = await import('pdf-lib');
  const { PdfSigningEngine } = await import('../src/services/signing/pdfSigningEngine.js');
  const { getCertificateProvider } = await import('../src/services/signing/certificateProvider.js');
  const { SignatureVerifier } = await import('../src/services/signing/signatureVerifier.js');

  // ──────────────────────────────────────────────────────
  // Step 1: Visual Page Dimensions with Rotation
  // ──────────────────────────────────────────────────────
  console.log('[Step 1] Testing getVisualPageDimensions...');
  {
    const d0 = getVisualPageDimensions(612, 792, 0);
    assert(d0.visualWidth === 612 && d0.visualHeight === 792, 'Rotation 0: visual dims match unrotated page');

    const d90 = getVisualPageDimensions(612, 792, 90);
    assert(d90.visualWidth === 792 && d90.visualHeight === 612, 'Rotation 90: width and height swap');

    const d180 = getVisualPageDimensions(612, 792, 180);
    assert(d180.visualWidth === 612 && d180.visualHeight === 792, 'Rotation 180: visual dims same as unrotated');

    const d270 = getVisualPageDimensions(612, 792, 270);
    assert(d270.visualWidth === 792 && d270.visualHeight === 612, 'Rotation 270: width and height swap');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 2: normalizeRect and clampRectToBounds
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 2] Testing normalizeRect and clampRectToBounds...');
  {
    const n1 = normalizeRect({ x: 100, y: 100, width: -50, height: -30 });
    assert(n1.x === 50 && n1.y === 70 && n1.width === 50 && n1.height === 30,
      'normalizeRect corrects negative width/height');

    const clamped = clampRectToBounds({ x: -10, y: -5, width: 200, height: 100 }, { width: 600, height: 800 });
    assert(clamped.x >= 0 && clamped.y >= 0 && clamped.x + clamped.width <= 600 && clamped.y + clamped.height <= 800,
      'clampRectToBounds keeps rect within bounds');

    const clampedSmall = clampRectToBounds({ x: 0, y: 0, width: 5, height: 5 }, { width: 600, height: 800 }, 20);
    assert(clampedSmall.width >= 20 && clampedSmall.height >= 20,
      'clampRectToBounds enforces minimum size');

    const clampedOverflow = clampRectToBounds({ x: 590, y: 790, width: 100, height: 100 }, { width: 600, height: 800 });
    assert(clampedOverflow.x + clampedOverflow.width <= 600 && clampedOverflow.y + clampedOverflow.height <= 800,
      'clampRectToBounds corrects overflow at edges');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 3: screenToNormalized and normalizedToScreen roundtrip
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 3] Testing screen ↔ normalized roundtrip...');
  {
    const screenRect = { x: 150, y: 200, width: 300, height: 100 };
    const containerW = 800;
    const containerH = 1000;

    const norm = screenToNormalized(screenRect, containerW, containerH);
    assert(
      Math.abs(norm.normX - 150 / 800) < 0.001 &&
      Math.abs(norm.normY - 200 / 1000) < 0.001 &&
      Math.abs(norm.normWidth - 300 / 800) < 0.001 &&
      Math.abs(norm.normHeight - 100 / 1000) < 0.001,
      'screenToNormalized produces correct fractions'
    );

    const back = normalizedToScreen(norm, containerW, containerH);
    assert(
      Math.abs(back.x - 150) < 0.01 &&
      Math.abs(back.y - 200) < 0.01 &&
      Math.abs(back.width - 300) < 0.01 &&
      Math.abs(back.height - 100) < 0.01,
      'normalizedToScreen roundtrips back to original screen coords'
    );

    // Different container size
    const back2 = normalizedToScreen(norm, 400, 500);
    assert(
      Math.abs(back2.x - 75) < 0.01 &&
      Math.abs(back2.y - 100) < 0.01 &&
      Math.abs(back2.width - 150) < 0.01 &&
      Math.abs(back2.height - 50) < 0.01,
      'normalizedToScreen adapts proportionally to different container size'
    );
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 4: normalizedToPdfPoints across rotations
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 4] Testing normalizedToPdfPoints across rotations...');
  {
    const pw = 612, ph = 792;

    // Rotation 0: bottom-right corner (norm: right, bottom)
    const r0 = normalizedToPdfPoints({
      normX: 0.5, normY: 0.5, normWidth: 0.3, normHeight: 0.1,
      pageWidth: pw, pageHeight: ph, rotation: 0,
    });
    // normX=0.5 → x = 0.5 * 612 = 306
    // normY=0.5 → y = 792 - (0.5*792 + 0.1*792) = 792 - 475.2 = 316.8
    assert(Math.abs(r0.x - 306) < 1 && Math.abs(r0.y - 316.8) < 1, 'Rotation 0: x/y placement correct');
    assert(Math.abs(r0.width - 183.6) < 1 && Math.abs(r0.height - 79.2) < 1, 'Rotation 0: width/height correct');

    // Rotation 90: visual is 792 x 612
    const r90 = normalizedToPdfPoints({
      normX: 0, normY: 0, normWidth: 0.25, normHeight: 0.1,
      pageWidth: pw, pageHeight: ph, rotation: 90,
    });
    // visual top-left → PDF: x=vy=0, y=vx=0, width=vh, height=vw
    assert(r90.x >= 0 && r90.y >= 0, 'Rotation 90: top-left visual maps to valid PDF coords');
    assert(r90.width > 0 && r90.height > 0, 'Rotation 90: dimensions are positive');

    // Rotation 180
    const r180 = normalizedToPdfPoints({
      normX: 0, normY: 0, normWidth: 0.5, normHeight: 0.2,
      pageWidth: pw, pageHeight: ph, rotation: 180,
    });
    // In 180°, visual top-left is PDF bottom-right area
    assert(r180.x >= 0 && r180.y >= 0, 'Rotation 180: coords are non-negative');
    assert(r180.x + r180.width <= pw + 1, 'Rotation 180: rect within page width');
    assert(r180.y + r180.height <= ph + 1, 'Rotation 180: rect within page height');

    // Rotation 270
    const r270 = normalizedToPdfPoints({
      normX: 0.1, normY: 0.1, normWidth: 0.3, normHeight: 0.15,
      pageWidth: pw, pageHeight: ph, rotation: 270,
    });
    assert(r270.x >= 0 && r270.y >= 0, 'Rotation 270: coords are non-negative');
    assert(r270.width > 0 && r270.height > 0, 'Rotation 270: dimensions positive');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 5: validatePdfPlacement
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 5] Testing validatePdfPlacement...');
  {
    const v1 = validatePdfPlacement({ x: 100, y: 100, width: 200, height: 60 }, 612, 792);
    assert(v1.valid === true, 'Valid placement passes validation');

    const v2 = validatePdfPlacement({ x: 100, y: 100, width: 10, height: 10 }, 612, 792);
    assert(v2.valid === false && v2.error.includes('too small'), 'Too-small rectangle rejected');

    const v3 = validatePdfPlacement({ x: 600, y: 780, width: 100, height: 50 }, 612, 792);
    assert(v3.valid === false && v3.error.includes('exceeds'), 'Out-of-bounds rectangle rejected');

    const v4 = validatePdfPlacement(null, 612, 792);
    assert(v4.valid === false, 'Null rect rejected');

    const v5 = validatePdfPlacement({ x: 'a', y: 0, width: 100, height: 50 }, 612, 792);
    assert(v5.valid === false, 'Non-numeric coordinates rejected');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 6: End-to-end signing with custom normalized placement
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 6] Testing cryptographic signing with custom placement...');
  {
    // Create a sample PDF
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawText('Test PDF for custom signature placement', { x: 50, y: 700, size: 14 });
    const pdfBytes = await doc.save();
    const inputPath = path.join(TEMP_DIR, 'custom_placement_input.pdf');
    fs.writeFileSync(inputPath, Buffer.from(pdfBytes));

    // Sign with custom normalized coords (bottom-right area)
    const provider = getCertificateProvider('software-test');
    const certs = await provider.discoverCertificates();
    const cert = certs.find(c => c.isEligibleForSigning);
    assert(cert !== undefined, 'Test certificate available for signing');

    const outputPath = path.join(TEMP_DIR, 'custom_placement_signed.pdf');
    const { signedPdfBuffer, signatureDetails } = await PdfSigningEngine.signPdf({
      pdfBuffer: Buffer.from(pdfBytes),
      certificateInfo: cert,
      provider,
      reason: 'Custom placement test',
      location: 'Test Lab',
      visibleSignature: true,
      appearance: {
        normX: 0.55,
        normY: 0.85,
        normWidth: 0.35,
        normHeight: 0.08,
        page: 1,
        signerName: cert.subjectCommonName,
      },
    });

    fs.writeFileSync(outputPath, signedPdfBuffer);
    assert(fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0, 'Custom-placed signed PDF written to disk');

    // Verify the signature
    const verification = await SignatureVerifier.verifyPdf(outputPath);
    assert(verification.isValid === true, 'Custom-placed signature verifies as VALID');
    assert(verification.integrityValid === true, 'Document integrity intact after custom placement');
    assert(verification.signatureValid === true, 'Cryptographic signature valid on custom-placed PDF');

    // Verify the stamp was placed (signed PDF should be larger than unsigned)
    const signedSize = fs.statSync(outputPath).size;
    const inputSize = fs.statSync(inputPath).size;
    assert(signedSize > inputSize, 'Signed PDF is larger than input (includes signature + stamp)');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 7: Signing with custom placement on rotated page
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 7] Testing signing with custom placement on rotated pages...');
  {
    for (const rot of [90, 180, 270]) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.setRotation(degrees(rot));
      page.drawText(`Rotated ${rot}`, { x: 50, y: 700, size: 14 });
      const pdfBytes = await doc.save();

      const provider = getCertificateProvider('software-test');
      const certs = await provider.discoverCertificates();
      const cert = certs.find(c => c.isEligibleForSigning);

      const { signedPdfBuffer } = await PdfSigningEngine.signPdf({
        pdfBuffer: Buffer.from(pdfBytes),
        certificateInfo: cert,
        provider,
        reason: `Rotation ${rot} test`,
        location: 'Lab',
        visibleSignature: true,
        appearance: {
          normX: 0.6,
          normY: 0.8,
          normWidth: 0.3,
          normHeight: 0.1,
          page: 1,
          signerName: cert.subjectCommonName,
        },
      });

      const outputPath = path.join(TEMP_DIR, `rotated_${rot}_signed.pdf`);
      fs.writeFileSync(outputPath, signedPdfBuffer);

      const verification = await SignatureVerifier.verifyPdf(outputPath);
      assert(verification.isValid === true, `Rotation ${rot}: custom-placed signature verified`);
    }
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 8: Tamper detection on custom-placed signed PDF
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 8] Testing tamper detection on custom-placed signed PDF...');
  {
    const signedPath = path.join(TEMP_DIR, 'custom_placement_signed.pdf');
    const tamperedPath = path.join(TEMP_DIR, 'custom_placement_tampered.pdf');

    const buf = fs.readFileSync(signedPath);
    const tampered = Buffer.from(buf);
    // Tamper with document content within the ByteRange
    const textPos = tampered.indexOf(Buffer.from('Test PDF'));
    if (textPos !== -1) {
      tampered[textPos] = 'X'.charCodeAt(0);
    } else {
      tampered[50] ^= 0xFF;
    }
    fs.writeFileSync(tamperedPath, tampered);

    const verification = await SignatureVerifier.verifyPdf(tamperedPath);
    assert(verification.isValid === false, 'Tampered custom-placed PDF correctly detected as INVALID');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // ──────────────────────────────────────────────────────
  // Step 9: Invisible signing still works (no placement needed)
  // ──────────────────────────────────────────────────────
  console.log('\n[Step 9] Testing invisible signing without placement...');
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawText('Invisible signature test', { x: 50, y: 700, size: 14 });
    const pdfBytes = await doc.save();

    const provider = getCertificateProvider('software-test');
    const certs = await provider.discoverCertificates();
    const cert = certs.find(c => c.isEligibleForSigning);

    const { signedPdfBuffer } = await PdfSigningEngine.signPdf({
      pdfBuffer: Buffer.from(pdfBytes),
      certificateInfo: cert,
      provider,
      reason: 'Invisible',
      location: 'Test',
      visibleSignature: false,
      appearance: {},
    });

    const outputPath = path.join(TEMP_DIR, 'invisible_placement.pdf');
    fs.writeFileSync(outputPath, signedPdfBuffer);

    const verification = await SignatureVerifier.verifyPdf(outputPath);
    assert(verification.isValid === true, 'Invisible signature (no placement) verified as VALID');
  }
  results.forEach(r => console.log(r));
  results.length = 0;

  // Cleanup
  try {
    fs.rmSync(TEMP_DIR, { recursive: true });
  } catch { /* ignore */ }

  // Summary
  console.log(`\n====================================================`);
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log(`====================================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
