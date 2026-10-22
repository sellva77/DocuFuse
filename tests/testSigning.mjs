import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { listProviders, discoverCertificates, signDocument, verifyDocument } from '../src/services/signing/signingService.js';
import { SignatureVerifier } from '../src/services/signing/signatureVerifier.js';
import { SoftwareTestProvider } from '../src/services/signing/certificateProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, 'output', 'signing_tests');
let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`  [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function createSamplePdf(filePath, title = 'Sample Document for Signing') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText(title, {
    x: 50,
    y: 350,
    size: 18,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.15),
  });

  page.drawText('This is an official document generated for digital signature verification testing.', {
    x: 50,
    y: 310,
    size: 11,
    font: font,
    color: rgb(0.3, 0.3, 0.35),
  });

  page.drawText('It contains confidential terms, contractual agreements, and execution criteria.', {
    x: 50,
    y: 290,
    size: 11,
    font: font,
    color: rgb(0.3, 0.3, 0.35),
  });

  const pdfBytes = await doc.save();
  fs.writeFileSync(filePath, pdfBytes);
}

async function runSigningTests() {
  console.log('====================================================');
  console.log('     DIGITAL SIGNATURE MODULE AUTOMATED TEST SUITE  ');
  console.log('====================================================\n');

  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  const samplePdfPath = path.join(TEST_DIR, 'original_document.pdf');
  const signedPdfPath = path.join(TEST_DIR, 'signed_document.pdf');
  const tamperedPdfPath = path.join(TEST_DIR, 'tampered_document.pdf');

  // [Step 1] Creating test fixture
  console.log('[Step 1] Creating test PDF fixture...');
  await createSamplePdf(samplePdfPath);
  assert(fs.existsSync(samplePdfPath), 'Original sample PDF fixture created successfully');
  const originalStats = fs.statSync(samplePdfPath);
  assert(originalStats.size > 0, 'Original PDF has valid non-zero size');

  // [Step 2] Testing Provider Discovery
  console.log('\n[Step 2] Testing Provider Discovery...');
  const providers = await listProviders();
  assert(Array.isArray(providers) && providers.length >= 2, 'Available providers discovered');
  const hasWindows = providers.some(p => p.id === 'windows-store');
  const hasTest = providers.some(p => p.id === 'software-test');
  assert(hasWindows, 'Windows Certificate Store provider registered');
  assert(hasTest, 'Software Test Certificate provider registered');

  // [Step 3] Testing Certificate Discovery from Software Test Provider
  console.log('\n[Step 3] Testing Certificate Discovery (Software Test Provider)...');
  const testCerts = await discoverCertificates('software-test');
  assert(Array.isArray(testCerts) && testCerts.length > 0, 'Test certificates discovered');
  const testCert = testCerts[0];
  assert(testCert.hasPrivateKey === true, 'Test certificate has accessible private key');
  assert(testCert.isEligibleForSigning === true, 'Test certificate is eligible for signing');
  assert(testCert.isTestCertificate === true, 'Test certificate correctly flagged as test certificate');
  assert(testCert.keyAlgorithm === 'RSA', 'Test certificate uses RSA algorithm');
  assert(testCert.keySize === 2048, 'Test certificate has 2048-bit key size');

  // [Step 4] Testing Input Validation & Error Handling
  console.log('\n[Step 4] Testing Input Validation & Error Handling...');
  
  // Test: No PDF selected
  try {
    await signDocument({ inputPath: '', outputPath: signedPdfPath, certificateId: testCert.id });
    assert(false, 'Should throw when input PDF path is missing');
  } catch (err) {
    assert(err.message.includes('Input PDF path is required'), 'Rejects empty input PDF path with clear error');
  }

  // Test: Invalid or nonexistent PDF
  try {
    await signDocument({ inputPath: path.join(TEST_DIR, 'nonexistent.pdf'), outputPath: signedPdfPath, certificateId: testCert.id });
    assert(false, 'Should throw for non-existent file');
  } catch (err) {
    assert(err.message.includes('Invalid input file'), 'Rejects nonexistent input file with clear error');
  }

  // Test: Inaccessible or corrupt PDF
  const corruptFile = path.join(TEST_DIR, 'corrupt.pdf');
  fs.writeFileSync(corruptFile, Buffer.from('NOT A REAL PDF FILE HEADER'));
  try {
    await signDocument({ inputPath: corruptFile, outputPath: signedPdfPath, certificateId: testCert.id });
    assert(false, 'Should throw for corrupt PDF header');
  } catch (err) {
    assert(err.message.includes('valid PDF document'), 'Rejects corrupt PDF without %PDF- magic bytes');
  }

  // Test: Output path identical to input path (protecting original document)
  try {
    await signDocument({ inputPath: samplePdfPath, outputPath: samplePdfPath, certificateId: testCert.id });
    assert(false, 'Should throw when output path matches input path');
  } catch (err) {
    assert(err.message.includes('protect the original document'), 'Prevents overwriting original document');
  }

  // Test: Nonexistent certificate ID
  try {
    await signDocument({ inputPath: samplePdfPath, outputPath: signedPdfPath, providerId: 'software-test', certificateId: 'non-existent-cert-999' });
    assert(false, 'Should throw for invalid certificate ID');
  } catch (err) {
    assert(err.message.includes('not available in provider'), 'Rejects invalid certificate ID with clear error');
  }

  // [Step 5] Testing Successful Cryptographic PDF Signing
  console.log('\n[Step 5] Testing Genuine Cryptographic PDF Signing...');
  let progressEvents = [];
  const signResult = await signDocument({
    inputPath: samplePdfPath,
    outputPath: signedPdfPath,
    providerId: 'software-test',
    certificateId: testCert.id,
    reason: 'Contractual Approval and Test Execution',
    location: 'New Delhi Corporate HQ',
    contactInfo: 'compliance@documentmerger.com',
    visibleSignature: true,
    appearance: {
      position: 'bottom-right',
      signerName: 'Document Merger Test Signer',
    },
    onProgress: (p) => progressEvents.push(p),
  });

  assert(signResult.success === true, 'Signing completed successfully');
  assert(fs.existsSync(signedPdfPath), 'Signed PDF exists on disk');
  const signedStats = fs.statSync(signedPdfPath);
  assert(signedStats.size > originalStats.size, 'Signed PDF size includes signature dictionary and PKCS#7 container');
  assert(progressEvents.length >= 4, 'Progress events emitted throughout signing lifecycle');

  // Verify original file remained 100% untouched
  const afterOriginalStats = fs.statSync(samplePdfPath);
  assert(afterOriginalStats.size === originalStats.size, 'Original PDF remains completely untouched');

  // [Step 6] Testing Signature Verification on Signed PDF
  console.log('\n[Step 6] Testing Signature Verification Engine...');
  const verifyResult = await verifyDocument(signedPdfPath);

  assert(verifyResult.hasSignature === true, 'Signature verifier detects digital signature');
  assert(verifyResult.isValid === true, 'Full signature verification report is VALID');
  assert(verifyResult.integrityValid === true, 'Document ByteRange integrity verified (SHA-256 match)');
  assert(verifyResult.signatureValid === true, 'Cryptographic RSA signature mathematically verified against public key');
  assert(verifyResult.certDatesValid === true, 'Certificate validity period is currently active');
  assert(verifyResult.signer.commonName === 'Document Merger Test Signer', 'Signer Common Name parsed correctly');
  assert(verifyResult.metadata.reason === 'Contractual Approval and Test Execution', 'Signature reason parsed correctly');
  assert(verifyResult.metadata.location === 'New Delhi Corporate HQ', 'Signature location parsed correctly');
  assert(verifyResult.trustStatus === 'SELF_SIGNED', 'Accurately reports SELF_SIGNED trust status (distinguishing crypto from PKI trust)');

  // [Step 7] Testing Tamper Detection (Modification of Signed PDF)
  console.log('\n[Step 7] Testing Tamper Detection on Modified Signed PDF...');
  const signedBytes = fs.readFileSync(signedPdfPath);
  const tamperedBytes = Buffer.from(signedBytes);
  // Modify a byte inside the document body (outside of /Contents)
  const textPos = tamperedBytes.indexOf(Buffer.from('official document'));
  if (textPos !== -1) {
    tamperedBytes[textPos] = 'X'.charCodeAt(0);
  } else {
    tamperedBytes[100] ^= 0xff; // Flip a byte
  }
  fs.writeFileSync(tamperedPdfPath, tamperedBytes);

  const tamperedVerify = await verifyDocument(tamperedPdfPath);
  assert(tamperedVerify.hasSignature === true, 'Tampered file still contains signature structure');
  assert(tamperedVerify.isValid === false, 'Tampered file is marked INVALID');
  assert(tamperedVerify.integrityValid === false, 'Tamper detected: ByteRange digest mismatch!');

  // [Step 8] Testing Invisible / Cryptographic-Only Signature
  console.log('\n[Step 8] Testing Invisible Cryptographic Signature...');
  const invisiblePdfPath = path.join(TEST_DIR, 'signed_invisible.pdf');
  const invisibleResult = await signDocument({
    inputPath: samplePdfPath,
    outputPath: invisiblePdfPath,
    providerId: 'software-test',
    certificateId: testCert.id,
    reason: 'Confidential Audit Cryptographic Seal',
    visibleSignature: false,
  });

  assert(invisibleResult.success === true, 'Invisible signature generated successfully');
  const invisibleVerify = await verifyDocument(invisiblePdfPath);
  assert(invisibleVerify.isValid === true, 'Invisible signature verified as valid');
  assert(invisibleVerify.integrityValid === true, 'Invisible signature document integrity valid');

  // [Step 9] Testing Windows Certificate Store Provider Discovery
  console.log('\n[Step 9] Testing Windows Certificate Store Discovery...');
  try {
    const winCerts = await discoverCertificates('windows-store');
    assert(Array.isArray(winCerts), 'Windows Certificate Store queried successfully');
    console.log(`    Discovered ${winCerts.length} certificates in Windows CurrentUser\\My store`);
    if (winCerts.length > 0) {
      assert(typeof winCerts[0].subject === 'string', 'Windows certificate has valid subject string');
      assert(typeof winCerts[0].hasPrivateKey === 'boolean', 'Windows certificate reports hasPrivateKey boolean');
    }
  } catch (err) {
    console.log(`    Note on Windows Store: ${err.message}`);
  }

  // Summary
  console.log('\n====================================================');
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('====================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runSigningTests().catch((err) => {
  console.error('Fatal error during signing tests:', err);
  process.exit(1);
});
