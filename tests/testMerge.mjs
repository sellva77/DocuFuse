import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { processFiles } from '../src/services/documentProcessor.js';
import { validateFile, isPdfValid, isDocxValid, isDocValid } from '../src/utils/fileValidator.js';
import { createTempDir, cleanupTempDir } from '../src/utils/tempManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, 'fixtures');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Setup directories
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function createSamplePdf(filePath, textContent, title = 'Sample PDF') {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 400]);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  page.drawText(title, { x: 50, y: 350, size: 20, font, color: rgb(0.1, 0.2, 0.6) });
  page.drawText(textContent, { x: 50, y: 300, size: 14, font: regularFont, color: rgb(0, 0, 0) });

  const pdfBytes = await pdfDoc.save();
  await fs.promises.writeFile(filePath, pdfBytes);
  return filePath;
}

async function createSampleDocx(filePath, title, bodyText) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: bodyText,
                size: 24,
              }),
            ],
            spacing: { after: 200 },
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

function createSampleDoc(filePath, textContent) {
  const header = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  const padding = Buffer.alloc(512 - header.length, 0);
  const textBuffer = Buffer.from(`Legacy Microsoft Word Document Content:\n${textContent}\nEnd of document.`);
  const fullBuffer = Buffer.concat([header, padding, textBuffer]);
  fs.writeFileSync(filePath, fullBuffer);
  return filePath;
}

function createCorruptFile(filePath) {
  fs.writeFileSync(filePath, Buffer.from('NOT A VALID DOCUMENT CONTENT 1234567890'));
  return filePath;
}

function createEmptyFile(filePath) {
  fs.writeFileSync(filePath, Buffer.alloc(0));
  return filePath;
}

async function runTests() {
  console.log('====================================================');
  console.log('       DOCUMENT MERGER AUTOMATED TEST SUITE        ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName} ${detail ? '(' + detail + ')' : ''}`);
      failed++;
    }
  }

  // 1. Create Fixtures
  console.log('[Step 1] Creating test fixtures...');
  const pdf1 = await createSamplePdf(path.join(TEST_DIR, 'doc1_alpha.pdf'), 'First test document in PDF format.', 'Document 1: Alpha');
  const pdf2 = await createSamplePdf(path.join(TEST_DIR, 'doc2_beta.pdf'), 'Second test document in PDF format.', 'Document 2: Beta');
  const docx1 = await createSampleDocx(path.join(TEST_DIR, 'word1_gamma.docx'), 'Document 3: Gamma', 'This is a Word DOCX test document with headings.');
  const docx2 = await createSampleDocx(path.join(TEST_DIR, 'word2_delta.docx'), 'Document 4: Delta', 'Another DOCX document with detailed content.');
  const doc1 = createSampleDoc(path.join(TEST_DIR, 'legacy_word.doc'), 'Legacy DOC format test content.');
  const corruptFile = createCorruptFile(path.join(TEST_DIR, 'corrupt.pdf'));
  const emptyFile = createEmptyFile(path.join(TEST_DIR, 'empty.pdf'));
  
  // Unicode and spaces in filenames
  const unicodePdf = await createSamplePdf(
    path.join(TEST_DIR, 'Report 2026 - Document Éléphant & 汉字.pdf'),
    'Document with special characters, accents, and unicode.',
    'Unicode Report 2026'
  );

  console.log('  Fixtures created successfully.\n');

  // Test 1: File Validator Magic Bytes
  console.log('[Step 2] Testing File Validator...');
  assert(isPdfValid(pdf1) === true, 'Valid PDF passes magic byte check');
  assert(isPdfValid(corruptFile) === false, 'Corrupt PDF fails magic byte check');
  assert(isDocxValid(docx1) === true, 'Valid DOCX passes magic byte check');
  assert(isDocValid(doc1) === true, 'Valid DOC passes OLE magic byte check');
  
  const emptyVal = validateFile(emptyFile);
  assert(emptyVal.valid === false && emptyVal.error.includes('empty'), 'Empty file rejected with clear error');

  const corruptVal = validateFile(corruptFile);
  assert(corruptVal.valid === true, 'Corrupt file structure detected during processing');

  // Test 2: Merge Multiple PDFs -> PDF Export
  console.log('\n[Step 3] Testing PDF + PDF -> PDF Export...');
  const outPdf1 = path.join(OUTPUT_DIR, 'merged_pdfs.pdf');
  const tempDir1 = createTempDir();
  try {
    await processFiles({
      filePaths: [pdf1, pdf2],
      outputFormat: 'pdf',
      outputPath: outPdf1,
      tempDir: tempDir1,
      onProgress: (p) => {},
    });
    const exists = fs.existsSync(outPdf1);
    const size = exists ? fs.statSync(outPdf1).size : 0;
    assert(exists && size > 500, 'Multiple PDFs merged to single PDF', `size: ${size} bytes`);
  } catch (err) {
    assert(false, 'Multiple PDFs merged to single PDF', err.message);
  } finally {
    cleanupTempDir(tempDir1);
  }

  // Test 3: Multiple DOCX files -> DOCX Export
  console.log('\n[Step 4] Testing DOCX + DOCX -> DOCX Export...');
  const outDocx1 = path.join(OUTPUT_DIR, 'merged_word.docx');
  const tempDir2 = createTempDir();
  try {
    await processFiles({
      filePaths: [docx1, docx2],
      outputFormat: 'docx',
      outputPath: outDocx1,
      tempDir: tempDir2,
      onProgress: (p) => {},
    });
    const exists = fs.existsSync(outDocx1);
    const size = exists ? fs.statSync(outDocx1).size : 0;
    assert(exists && size > 500 && isDocxValid(outDocx1), 'Multiple DOCX merged to single DOCX', `size: ${size} bytes`);
  } catch (err) {
    assert(false, 'Multiple DOCX merged to single DOCX', err.message);
  } finally {
    cleanupTempDir(tempDir2);
  }

  // Test 4: Mixed Input (PDF + DOCX) -> PDF Export
  console.log('\n[Step 5] Testing Mixed Input (PDF + DOCX) -> PDF Export...');
  const outMixedPdf = path.join(OUTPUT_DIR, 'merged_mixed.pdf');
  const tempDir3 = createTempDir();
  try {
    await processFiles({
      filePaths: [pdf1, docx1],
      outputFormat: 'pdf',
      outputPath: outMixedPdf,
      tempDir: tempDir3,
      onProgress: (p) => {},
    });
    const exists = fs.existsSync(outMixedPdf);
    const size = exists ? fs.statSync(outMixedPdf).size : 0;
    assert(exists && size > 500 && isPdfValid(outMixedPdf), 'Mixed PDF and DOCX exported to PDF', `size: ${size} bytes`);
  } catch (err) {
    assert(false, 'Mixed PDF and DOCX exported to PDF', err.message);
  } finally {
    cleanupTempDir(tempDir3);
  }

  // Test 5: Mixed Input (PDF + DOCX) -> DOCX Export
  console.log('\n[Step 6] Testing Mixed Input (PDF + DOCX) -> DOCX Export...');
  const outMixedDocx = path.join(OUTPUT_DIR, 'merged_mixed.docx');
  const tempDir4 = createTempDir();
  try {
    await processFiles({
      filePaths: [docx1, pdf1],
      outputFormat: 'docx',
      outputPath: outMixedDocx,
      tempDir: tempDir4,
      onProgress: (p) => {},
    });
    const exists = fs.existsSync(outMixedDocx);
    const size = exists ? fs.statSync(outMixedDocx).size : 0;
    assert(exists && size > 500 && isDocxValid(outMixedDocx), 'Mixed DOCX and PDF exported to DOCX', `size: ${size} bytes`);
  } catch (err) {
    assert(false, 'Mixed DOCX and PDF exported to DOCX', err.message);
  } finally {
    cleanupTempDir(tempDir4);
  }

  // Test 6: Legacy DOC conversion
  console.log('\n[Step 7] Testing Legacy DOC Input...');
  const outDocPdf = path.join(OUTPUT_DIR, 'legacy_doc_merged.pdf');
  const tempDir5 = createTempDir();
  try {
    await processFiles({
      filePaths: [doc1, pdf1],
      outputFormat: 'pdf',
      outputPath: outDocPdf,
      tempDir: tempDir5,
      onProgress: (p) => {},
    });
    const exists = fs.existsSync(outDocPdf);
    const size = exists ? fs.statSync(outDocPdf).size : 0;
    assert(exists && size > 500 && isPdfValid(outDocPdf), 'Legacy DOC merged with PDF to PDF', `size: ${size} bytes`);
  } catch (err) {
    assert(false, 'Legacy DOC merged with PDF to PDF', err.message);
  } finally {
    cleanupTempDir(tempDir5);
  }

  // Test 7: Handling Corrupt Files
  console.log('\n[Step 8] Testing Corrupt File Rejection...');
  const outCorrupt = path.join(OUTPUT_DIR, 'should_fail.pdf');
  const tempDir6 = createTempDir();
  let caughtError = false;
  try {
    await processFiles({
      filePaths: [corruptFile, pdf1],
      outputFormat: 'pdf',
      outputPath: outCorrupt,
      tempDir: tempDir6,
      onProgress: (p) => {},
    });
  } catch (err) {
    caughtError = true;
    assert(err.message.includes('corrupted') || err.message.includes('valid'), 'Corrupted file rejected with informative error', err.message);
  } finally {
    cleanupTempDir(tempDir6);
  }
  if (!caughtError) {
    assert(false, 'Corrupted file rejected with informative error', 'Did not throw an error');
  }

  // Test 8: Unicode Filenames and Paths Containing Spaces
  console.log('\n[Step 9] Testing Unicode & Space Paths...');
  const outUnicode = path.join(OUTPUT_DIR, 'Résultat Final - 合并.pdf');
  const tempDir7 = createTempDir();
  try {
    await processFiles({
      filePaths: [unicodePdf, pdf2],
      outputFormat: 'pdf',
      outputPath: outUnicode,
      tempDir: tempDir7,
      onProgress: (p) => {},
    });
    const exists = fs.existsSync(outUnicode);
    const size = exists ? fs.statSync(outUnicode).size : 0;
    assert(exists && size > 500 && isPdfValid(outUnicode), 'Unicode & spaces in filenames handled properly', `size: ${size} bytes`);
  } catch (err) {
    assert(false, 'Unicode & spaces in filenames handled properly', err.message);
  } finally {
    cleanupTempDir(tempDir7);
  }

  // Test 9: Order Preservation
  console.log('\n[Step 10] Testing Document Ordering...');
  const outOrder1 = path.join(OUTPUT_DIR, 'order_1_2.pdf');
  const outOrder2 = path.join(OUTPUT_DIR, 'order_2_1.pdf');
  const tempDir8 = createTempDir();
  try {
    await processFiles({
      filePaths: [pdf1, pdf2],
      outputFormat: 'pdf',
      outputPath: outOrder1,
      tempDir: tempDir8,
      onProgress: (p) => {},
    });
    await processFiles({
      filePaths: [pdf2, pdf1],
      outputFormat: 'pdf',
      outputPath: outOrder2,
      tempDir: tempDir8,
      onProgress: (p) => {},
    });
    
    const bytes1 = await fs.promises.readFile(outOrder1);
    const bytes2 = await fs.promises.readFile(outOrder2);
    const docA = await PDFDocument.load(bytes1);
    const docB = await PDFDocument.load(bytes2);
    
    assert(docA.getPageCount() === 2 && docB.getPageCount() === 2, 'Both merged files contain 2 pages');
    assert(!bytes1.equals(bytes2), 'Different input orders produce distinct output bytes reflecting the order');
  } catch (err) {
    assert(false, 'Order preservation test', err.message);
  } finally {
    cleanupTempDir(tempDir8);
  }

  console.log('\n====================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
