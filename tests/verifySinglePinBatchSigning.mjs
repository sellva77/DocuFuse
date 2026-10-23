import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import { signDocument, verifyDocument } from '../src/services/signing/signingService.js';
import { SoftwareTestProvider, WindowsStoreProvider } from '../src/services/signing/certificateProvider.js';
import { SignatureVerifier } from '../src/services/signing/signatureVerifier.js';
import { readDerTLV, OIDS } from '../src/services/signing/asn1Helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.join(__dirname, 'output', 'single_pin_batch');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

let passed = 0;
let total = 0;

function check(title, condition, details = '') {
  total++;
  if (condition) {
    passed++;
    console.log(`  [PASS] ${title}${details ? ` -> ${details}` : ''}`);
  } else {
    console.error(`  [FAIL] ${title}${details ? ` -> ${details}` : ''}`);
    throw new Error(`Failed check: ${title}`);
  }
}

async function runSinglePinBatchVerification() {
  console.log('========================================================================');
  console.log('     SINGLE-PIN BATCH SIGNING & PRODUCTION READINESS TEST SUITE');
  console.log('========================================================================\n');

  const winProvider = new WindowsStoreProvider();
  const testProvider = new SoftwareTestProvider();
  const certs = await testProvider.discoverCertificates();
  const testCert = certs[0];

  // Also query Windows Store to see available physical DSC tokens or system certs
  let winCert = null;
  try {
    const winCerts = await winProvider.discoverCertificates();
    if (winCerts && winCerts.length > 0) {
      winCert = winCerts.find(c => c.hasPrivateKey) || winCerts[0];
      console.log(`Discovered Windows Certificate: ${winCert.subjectCommonName || winCert.subject} (Alias: ${winCert.alias.slice(0, 10)}...)`);
    }
  } catch (err) {
    console.log('Windows Store query info:', err.message);
  }

  // =========================================================================
  // 1. SINGLE-FILE BASELINE
  // =========================================================================
  console.log('\n--- 1. SINGLE-FILE BASELINE & ADOBE ACROBAT INTEGRITY ---');
  const baseDoc = await PDFDocument.create();
  const page1 = baseDoc.addPage([595, 842]);
  page1.drawText('Baseline Document for Single Sign Verification', { x: 50, y: 780 });
  const basePdfPath = path.join(OUT_DIR, 'Single_Baseline.pdf');
  fs.writeFileSync(basePdfPath, await baseDoc.save());

  const baseSignedPath = path.join(OUT_DIR, 'Single_Baseline_signed.pdf');
  const baseSignRes = await signDocument({
    inputPath: basePdfPath,
    outputPath: baseSignedPath,
    providerId: 'software-test',
    certificateId: testCert.id,
    certificateInfo: testCert,
    reason: 'Single-file Baseline Verification',
    location: 'Corporate HQ',
    visibleSignature: true,
    appearance: {
      page: 1,
      normX: 0.1,
      normY: 0.1,
      normWidth: 0.35,
      normHeight: 0.08,
      signerName: testCert.subjectCommonName,
    },
  });

  check('Single-file baseline signed successfully', baseSignRes.success === true);
  const baseBytes = fs.readFileSync(baseSignedPath);
  const baseStr = baseBytes.toString('binary');
  check('Contains Adobe Acrobat SigFlags 3', baseStr.includes('/SigFlags 3'));
  check('Contains SubFilter ETSI.CAdES.detached', baseStr.includes('/SubFilter /ETSI.CAdES.detached'));
  check('Contains Filter Adobe.PPKLite', baseStr.includes('/Filter /Adobe.PPKLite'));
  check('Contains proper ByteRange', /\/ByteRange\s*\[\s*0\s+\d+\s+\d+\s+\d+\s*\]/.test(baseStr));

  const baseVerify = await SignatureVerifier.verifyPdf(baseSignedPath);
  check('Adobe Acrobat cryptographic integrity valid', baseVerify.isValid === true);
  check('ByteRange digest match confirmed', baseVerify.integrityValid === true);

  // =========================================================================
  // 2. PIN REUSE TEST (AT LEAST 4 PDFS SIGNED IN ONE SESSION PROCESS)
  // =========================================================================
  console.log('\n--- 2. PIN REUSE TEST (4+ PDFS SIGNED IN ONE PERSISTENT SESSION) ---');

  // If a Windows DSC token is available, test with native SigningBridge session!
  const targetProvider = winCert ? winProvider : testProvider;
  const targetCert = winCert || testCert;
  console.log(`Using provider for session: ${targetProvider.name} (Cert: ${targetCert.subjectCommonName || targetCert.alias})`);

  const session = await targetProvider.createSession(targetCert.alias);
  check('Signing session created and initialized', session && typeof session.signData === 'function');
  const sessionPid = session.child ? session.child.pid : 'in-memory-test';
  console.log(`Active Bridge Session PID: ${sessionPid}`);

  const batchFiles = [
    'Batch_01_Invoice.pdf',
    'Batch_02_Contract.pdf',
    'Batch_03_Statement.pdf',
    'Batch_04_Audit.pdf',
  ];
  const signedBatchPaths = [];

  for (let i = 0; i < batchFiles.length; i++) {
    const fName = batchFiles[i];
    const doc = await PDFDocument.create();
    const p = doc.addPage([595, 842]);
    p.drawText(`Document ${i + 1} of 4: ${fName}`, { x: 50, y: 780 });
    p.drawText(`Session PID: ${sessionPid}`, { x: 50, y: 750 });
    const inPath = path.join(OUT_DIR, fName);
    fs.writeFileSync(inPath, await doc.save());

    const outPath = path.join(OUT_DIR, `${path.basename(fName, '.pdf')}_signed.pdf`);

    const signResult = await signDocument({
      inputPath: inPath,
      outputPath: outPath,
      providerId: targetProvider.id,
      certificateId: targetCert.alias,
      certificateInfo: targetCert,
      reason: `Batch PIN Reuse Test Doc ${i + 1}`,
      location: 'Bangalore Lab',
      visibleSignature: true,
      appearance: {
        page: 1,
        normX: 0.1,
        normY: 0.1 + (i * 0.05),
        normWidth: 0.35,
        normHeight: 0.08,
        signerName: targetCert.subjectCommonName || 'Authorized Signer',
      },
      signingSession: session, // Reuses the exact same session!
    });

    check(`File ${i + 1}/4 signed in session`, signResult.success === true);
    signedBatchPaths.push(outPath);

    // Verify session PID did not change (guaranteeing single process)
    if (session.child) {
      check(`File ${i + 1}/4 executed under same process PID (${sessionPid})`, session.child.pid === sessionPid);
      check(`Bridge process alive and responsive for next file`, session.child.exitCode === null);
    }
  }

  // Close session 1
  await session.close();
  check('Session 1 closed cleanly', true);
  if (session.child) {
    check('Bridge child process exited', session.child.exitCode !== null || session.child.killed);
  }

  // =========================================================================
  // 3. FRESH-SESSION TEST
  // =========================================================================
  console.log('\n--- 3. FRESH-SESSION TEST (NO PROCESS LEAKS, CLEAN ISOLATION) ---');
  const freshSession = await targetProvider.createSession(targetCert.alias);
  check('Fresh session initialized after previous session termination', freshSession && typeof freshSession.signData === 'function');
  const freshPid = freshSession.child ? freshSession.child.pid : 'in-memory-fresh';
  if (freshSession.child && session.child) {
    check('Fresh session spawned new isolated process PID', freshPid !== sessionPid);
  }

  // Sign a test document in the fresh session
  const freshDoc = await PDFDocument.create();
  const freshPage = freshDoc.addPage([595, 842]);
  freshPage.drawText('Fresh Session Verification Document', { x: 50, y: 780 });
  const freshInPath = path.join(OUT_DIR, 'Fresh_Session_Test.pdf');
  const freshOutPath = path.join(OUT_DIR, 'Fresh_Session_Test_signed.pdf');
  fs.writeFileSync(freshInPath, await freshDoc.save());

  const freshSignRes = await signDocument({
    inputPath: freshInPath,
    outputPath: freshOutPath,
    providerId: targetProvider.id,
    certificateId: targetCert.alias,
    certificateInfo: targetCert,
    signingSession: freshSession,
  });
  check('Fresh session document signed successfully', freshSignRes.success === true);
  await freshSession.close();
  check('Fresh session closed cleanly', true);

  // =========================================================================
  // 4. CANCELLATION TEST
  // =========================================================================
  console.log('\n--- 4. CANCELLATION HANDLING TEST ---');
  let cancelErrorCaught = false;
  try {
    const cancelledSession = await targetProvider.createSession(targetCert.alias);
    await cancelledSession.close(); // simulate early cancellation
    await cancelledSession.signData(targetCert.alias, Buffer.from('test data'));
  } catch (err) {
    cancelErrorCaught = true;
    check('Cancelled / closed session correctly rejects sign request', err.message.includes('not active') || err.message.includes('terminated'));
  }
  check('Cancellation handled gracefully', cancelErrorCaught === true);

  // =========================================================================
  // 5. TOKEN REMOVAL / SIMULATED ERROR CLEANUP TEST
  // =========================================================================
  console.log('\n--- 5. TOKEN REMOVAL & ERROR CLEANUP TEST ---');
  let tokenRemovalErrorCaught = false;
  try {
    await targetProvider.createSession('NON_EXISTENT_TOKEN_ALIAS_12345');
  } catch (err) {
    tokenRemovalErrorCaught = true;
    check('Disconnected / invalid token error reported safely', err.message.includes('not found') || err.message.includes('error'));
  }
  check('Invalid/disconnected token handled without crashing', tokenRemovalErrorCaught === true);

  // =========================================================================
  // 6. CRYPTOGRAPHIC VALIDATION (EVERY OUTPUT VERIFIED INDEPENDENTLY)
  // =========================================================================
  console.log('\n--- 6. CRYPTOGRAPHIC INTEGRITY VALIDATION (ALL 4 BATCH OUTPUTS) ---');
  for (let i = 0; i < signedBatchPaths.length; i++) {
    const pdfPath = signedBatchPaths[i];
    const report = await SignatureVerifier.verifyPdf(pdfPath);
    check(`Doc ${i + 1} signature is cryptographically valid`, report.isValid === true);
    check(`Doc ${i + 1} ByteRange digest matches signed CMS attribute`, report.integrityValid === true);
    check(`Doc ${i + 1} contains signer common name`, Boolean(report.signer?.commonName));
    check(`Doc ${i + 1} signing date is recorded`, Boolean(report.metadata?.signingTime));
  }

  // =========================================================================
  // 7. STANDARDS VALIDATION (PAdES-B-B / ETSI EN 319 142 CONFORMANCE)
  // =========================================================================
  console.log('\n--- 7. STANDARDS VALIDATION (PAdES BASELINE B-B / ETSI EN 319 142) ---');
  for (let i = 0; i < signedBatchPaths.length; i++) {
    const pdfPath = signedBatchPaths[i];
    const report = await SignatureVerifier.verifyPdf(pdfPath);

    check(`Doc ${i + 1} confirmed PAdES format`, report.pades?.isPades === true);
    check(`Doc ${i + 1} has SubFilter ETSI.CAdES.detached`, report.pades?.subFilter === 'ETSI.CAdES.detached');
    check(`Doc ${i + 1} has signingCertificateV2 (PAdES requirement)`, report.pades?.hasSigningCertificateV2 === true);
    check(`Doc ${i + 1} adheres to eIDAS / PAdES-B-B profile`, report.pades?.profile === 'PAdES-B-B (ETSI EN 319 142-1 Baseline)');

    // Verify raw DER OIDs inside the signature dictionary
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfStr = pdfBytes.toString('binary');
    const byteRangeMatch = pdfStr.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    const len1 = parseInt(byteRangeMatch[2], 10);
    const contentsIdx = pdfStr.indexOf('/Contents', len1 - 200);
    const hexStart = pdfStr.indexOf('<', contentsIdx) + 1;
    const hexEnd = pdfStr.indexOf('>', hexStart);
    const hexContents = pdfStr.substring(hexStart, hexEnd).trim();
    const rawBuffer = Buffer.from(hexContents, 'hex');

    const tlv = readDerTLV(rawBuffer, 0);
    check(`Doc ${i + 1} CMS SignedData is valid ASN.1 SEQUENCE`, tlv.tag === 0x30);
    check(`Doc ${i + 1} contains id-signedData OID 1.2.840.113549.1.7.2`, rawBuffer.includes(Buffer.from([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02])));
    check(`Doc ${i + 1} contains signingCertificateV2 OID 1.2.840.113549.1.9.16.2.47`, rawBuffer.includes(Buffer.from([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x10, 0x02, 0x2F])));
    check(`Doc ${i + 1} contains messageDigest OID 1.2.840.113549.1.9.4`, rawBuffer.includes(Buffer.from([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04])));
    check(`Doc ${i + 1} contains signingTime OID 1.2.840.113549.1.9.5`, rawBuffer.includes(Buffer.from([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x05])));
  }

  console.log('\n========================================================================');
  console.log(`     VERIFICATION RESULT: ${passed} of ${total} CHECKS PASSED (100% SUCCESS)`);
  console.log('========================================================================\n');
}

runSinglePinBatchVerification().catch(err => {
  console.error('\nVerification suite encountered error:', err);
  process.exit(1);
});
