import fs from 'fs';
import path from 'path';
import { validateFile, isPdfValid } from '../../utils/fileValidator.js';
import { getCertificateProvider, getSupportedProviders } from './certificateProvider.js';
import { PdfSigningEngine } from './pdfSigningEngine.js';
import { SignatureVerifier } from './signatureVerifier.js';

/**
 * High-Level Digital Signing Service
 * Orchestrates provider discovery, document signing, output persistence, and post-sign verification
 */

/**
 * List all supported certificate providers and their availability
 */
export async function listProviders() {
  return await getSupportedProviders();
}

/**
 * Discover available digital signature certificates from the designated provider
 * @param {string} providerId - 'windows-store' | 'software-test' | 'pkcs11-module'
 * @returns {Promise<Array<Object>>}
 */
export async function discoverCertificates(providerId = 'windows-store') {
  const provider = getCertificateProvider(providerId);
  return await provider.discoverCertificates();
}

/**
 * Digitally signs a PDF document and writes the signed file to a user-approved path
 * 
 * @param {Object} options
 * @param {string} options.inputPath - Path to original PDF
 * @param {string} options.outputPath - Destination path for signed PDF
 * @param {string} [options.providerId='windows-store'] - Selected provider ID
 * @param {string} options.certificateId - Selected certificate alias or ID
 * @param {string} [options.reason] - Signing reason
 * @param {string} [options.location] - Signing location
 * @param {string} [options.contactInfo] - Signer contact information
 * @param {boolean} [options.visibleSignature=true] - Render visible signature stamp
 * @param {Object} [options.appearance] - Placement and visual options
 * @param {Function} [options.onProgress] - Progress callback: ({ step, detail, percent }) => void
 * @returns {Promise<{ success: boolean, outputPath: string, outputSize: number, signatureDetails: Object, verification: Object }>}
 */
export async function signDocument({
  inputPath,
  outputPath,
  providerId = 'windows-store',
  certificateId,
  certificateInfo: passedCertInfo = null,
  reason = 'Document signed digitally',
  location = 'Office',
  contactInfo = '',
  visibleSignature = true,
  appearance = {},
  onProgress = () => {},
}) {
  // 1. Validate inputs
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('Input PDF path is required');
  }
  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new Error('Output path is required');
  }
  if (!certificateId && !passedCertInfo) {
    throw new Error('Please select an eligible signing certificate');
  }

  const normalizedInput = path.normalize(inputPath);
  const normalizedOutput = path.normalize(outputPath);

  if (normalizedInput === normalizedOutput) {
    throw new Error('Output file path must be different from the original PDF to protect the original document');
  }

  // 2. Validate input PDF
  const validation = validateFile(normalizedInput, ['.pdf']);
  if (!validation.valid) {
    throw new Error(`Invalid input file: ${validation.error}`);
  }

  if (!isPdfValid(normalizedInput)) {
    throw new Error('The selected file does not appear to be a valid PDF document');
  }

  // 3. Validate output directory
  const outputDir = path.dirname(normalizedOutput);
  try {
    await fs.promises.access(outputDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot write to output directory: ${outputDir}`);
  }

  onProgress({ step: 'Loading', detail: 'Reading source PDF document...', percent: 15 });

  const pdfBuffer = await fs.promises.readFile(normalizedInput);

  // 4. Resolve provider and certificate
  onProgress({ step: 'Connecting', detail: 'Accessing cryptographic provider and certificate...', percent: 30 });

  const provider = getCertificateProvider(providerId);

  // Use pre-fetched certificate info if available, otherwise re-discover.
  // Pre-fetched info avoids race conditions where the smart card driver may not
  // immediately re-enumerate the certificate, even though the token is connected
  // and the private key is accessible for signing (which triggers the PIN prompt).
  let certInfo = null;
  if (passedCertInfo && (passedCertInfo.alias || passedCertInfo.id)) {
    certInfo = passedCertInfo;
  } else {
    const certList = await provider.discoverCertificates();
    certInfo = certList.find(c => c.id === certificateId || c.alias === certificateId);
  }

  if (!certInfo) {
    throw new Error(`Selected certificate (${certificateId}) is not available in provider ${provider.name}. Please reconnect your token.`);
  }

  if (!certInfo.hasPrivateKey) {
    throw new Error(`The certificate "${certInfo.subjectCommonName || certInfo.subject}" does not have an accessible private key.`);
  }

  if (certInfo.isExpired) {
    throw new Error(`The certificate expired on ${certInfo.validTo} and cannot be used for signing.`);
  }

  // 5. Perform PDF Signing
  onProgress({
    step: 'Signing',
    detail: certInfo.isHardwareToken
      ? 'Awaiting token authentication (please enter PIN in the hardware prompt if requested)...'
      : 'Generating cryptographic signature...',
    percent: 60,
  });

  const { signedPdfBuffer, signatureDetails } = await PdfSigningEngine.signPdf({
    pdfBuffer,
    certificateInfo: certInfo,
    provider,
    reason,
    location,
    contactInfo,
    visibleSignature,
    appearance,
  });

  // 6. Write to destination file
  onProgress({ step: 'Saving', detail: 'Writing signed PDF to destination...', percent: 85 });

  await fs.promises.writeFile(normalizedOutput, signedPdfBuffer);

  const stats = await fs.promises.stat(normalizedOutput);
  if (stats.size === 0) {
    throw new Error('Signing produced an empty output file');
  }

  // 7. Verify generated signature
  onProgress({ step: 'Verifying', detail: 'Validating cryptographic signature and document integrity...', percent: 95 });

  const verification = await SignatureVerifier.verifyPdf(normalizedOutput);

  if (!verification.isValid) {
    // If signature verification fails, we must NOT report success!
    throw new Error(`Signed document failed post-signature verification: ${verification.error || 'Cryptographic integrity check failed'}`);
  }

  onProgress({ step: 'Complete', detail: 'Document signed and verified successfully!', percent: 100 });

  return {
    success: true,
    outputPath: normalizedOutput,
    outputSize: stats.size,
    signatureDetails,
    verification,
  };
}

/**
 * Validates any existing or signed PDF file
 * @param {string} filePath 
 * @returns {Promise<Object>}
 */
export async function verifyDocument(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('File path is required');
  }
  const normalized = path.normalize(filePath);
  const validation = validateFile(normalized, ['.pdf']);
  if (!validation.valid) {
    throw new Error(`Invalid file: ${validation.error}`);
  }

  return await SignatureVerifier.verifyPdf(normalized);
}

export default {
  listProviders,
  discoverCertificates,
  signDocument,
  verifyDocument,
};
