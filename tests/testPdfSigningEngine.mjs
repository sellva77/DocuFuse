import { PDFDocument } from 'pdf-lib';
import { PdfSigningEngine } from '../src/services/signing/pdfSigningEngine.js';
import { SoftwareTestProvider } from '../src/services/signing/certificateProvider.js';
import { SignatureVerifier } from '../src/services/signing/signatureVerifier.js';

async function testEngine() {
  const provider = new SoftwareTestProvider();
  const certs = await provider.discoverCertificates();
  const certInfo = certs[0];

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText('Testing PdfSigningEngine PAdES-B-B Generation', { x: 50, y: 750 });
  const pdfBytes = await doc.save();

  const { signedPdfBuffer, signatureDetails } = await PdfSigningEngine.signPdf({
    pdfBuffer: Buffer.from(pdfBytes),
    certificateInfo: certInfo,
    provider,
    reason: 'PAdES-B-B eIDAS Compliant Signing Test',
    location: 'Bengaluru, India',
    visibleSignature: true,
    appearance: {
      signerName: 'Test Signer',
      normX: 0.1,
      normY: 0.1,
      normWidth: 0.35,
      normHeight: 0.1,
    },
  });

  console.log('Signature details format:', signatureDetails.format);
  console.log('Signature details subFilter:', signatureDetails.subFilter);
  console.log('Signed PDF buffer length:', signedPdfBuffer.length);

  const verification = await SignatureVerifier.verifyPdf(signedPdfBuffer);
  console.log('Verification isValid:', verification.isValid);
  console.log('Verification integrityValid:', verification.integrityValid);
  console.log('Verification signatureValid:', verification.signatureValid);
  console.log('Verification isPades:', verification.pades?.isPades);
  console.log('Verification padesProfile:', verification.pades?.profile);
  console.log('Verification eidasCompliant:', verification.pades?.eidasCompliant);
}

testEngine().catch(console.error);
