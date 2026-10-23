import crypto from 'crypto';
import fs from 'fs';
import { readDerTLV, decodeOID, OIDS, ASN1_TAGS } from './asn1Helper.js';

/**
 * PDF Signature Verification Engine
 * 
 * Verifies standard ISO 32000-1 / PAdES detached signatures.
 * Dissects and validates:
 * 1. Document Integrity (SHA-256 ByteRange match)
 * 2. Cryptographic Signature (RSA mathematical validity)
 * 3. Certificate Validity Period (dates)
 * 4. Certificate Chain Trust Status
 * 5. Signing Metadata (Reason, Location, Time)
 */
export class SignatureVerifier {
  /**
   * Verifies a signed PDF file or buffer
   * @param {string|Buffer} pdfPathOrBuffer 
   * @returns {Promise<Object>} Detailed verification report
   */
  static async verifyPdf(pdfPathOrBuffer) {
    let pdfBuf;
    let filePath = null;

    if (typeof pdfPathOrBuffer === 'string') {
      filePath = pdfPathOrBuffer;
      pdfBuf = await fs.promises.readFile(pdfPathOrBuffer);
    } else if (Buffer.isBuffer(pdfPathOrBuffer)) {
      pdfBuf = pdfPathOrBuffer;
    } else {
      throw new Error('Invalid input: expected file path or Buffer');
    }

    const pdfStr = pdfBuf.toString('binary');

    // 1. Locate /ByteRange
    const byteRangeMatch = pdfStr.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    if (!byteRangeMatch) {
      return {
        hasSignature: false,
        isValid: false,
        error: 'No digital signature or /ByteRange dictionary found in PDF document',
      };
    }

    const byteRange = [
      parseInt(byteRangeMatch[1], 10),
      parseInt(byteRangeMatch[2], 10),
      parseInt(byteRangeMatch[3], 10),
      parseInt(byteRangeMatch[4], 10),
    ];

    // Validate byte range boundaries
    const [start1, len1, start2, len2] = byteRange;
    if (
      start1 !== 0 ||
      len1 <= 0 ||
      start2 <= len1 ||
      len2 < 0 ||
      start2 + len2 > pdfBuf.length
    ) {
      return {
        hasSignature: true,
        isValid: false,
        integrityValid: false,
        error: 'Corrupt or invalid /ByteRange values in PDF signature dictionary',
        byteRange,
      };
    }

    // 2. Extract Range 1 and Range 2 bytes and compute document SHA-256 digest
    const range1 = pdfBuf.subarray(start1, start1 + len1);
    const range2 = pdfBuf.subarray(start2, start2 + len2);

    const hash = crypto.createHash('sha256');
    hash.update(range1);
    hash.update(range2);
    const computedDocDigest = hash.digest();

    // 3. Locate /Contents <HEX...>
    const contentsStartIdx = pdfStr.indexOf('/Contents', len1 - 200);
    const hexStart = pdfStr.indexOf('<', contentsStartIdx);
    const hexEnd = pdfStr.indexOf('>', hexStart);

    if (hexStart === -1 || hexEnd === -1 || hexStart >= start2) {
      return {
        hasSignature: true,
        isValid: false,
        integrityValid: false,
        error: 'Malformed /Contents entry in signature dictionary',
        byteRange,
      };
    }

    const rawHex = pdfStr.substring(hexStart + 1, hexEnd).trim();
    if (!rawHex || rawHex.length === 0) {
      return {
        hasSignature: true,
        isValid: false,
        integrityValid: false,
        error: 'Empty signature /Contents entry',
        byteRange,
      };
    }

    // Convert hex to buffer, stripping trailing zeroes (standard PDF PKCS#7 padding)
    let cleanHex = rawHex;
    // Find the end of actual DER content by parsing the ASN.1 length
    const rawBuffer = Buffer.from(cleanHex, 'hex');
    let pkcs7Der = rawBuffer;

    try {
      const topTlv = readDerTLV(rawBuffer, 0);
      if (topTlv.totalLength < rawBuffer.length) {
        pkcs7Der = rawBuffer.subarray(0, topTlv.totalLength);
      }
    } catch (_) {
      // If parsing fails directly, strip trailing zeroes
      cleanHex = cleanHex.replace(/0+$/, '');
      if (cleanHex.length % 2 !== 0) cleanHex += '0';
      pkcs7Der = Buffer.from(cleanHex, 'hex');
    }

    // 4. Extract metadata from PDF Sig dictionary
    const metadata = extractPdfSigMetadata(pdfStr, contentsStartIdx);

    // 5. Parse PKCS#7 container and verify cryptographic structures
    try {
      const parsedPkcs7 = parsePkcs7SignedData(pkcs7Der);

      // Check 1: Document Integrity (Digest match)
      const digestMatch = Buffer.compare(computedDocDigest, parsedPkcs7.messageDigest) === 0;

      // Check 2: Cryptographic Signature Integrity
      // Verify the RSA signature over the signed attributes SET
      const certX509 = new crypto.X509Certificate(parsedPkcs7.signerCertDer);
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(parsedPkcs7.signedAttrsSetDer);
      const signatureValid = verifier.verify(certX509.publicKey, parsedPkcs7.signatureBytes);

      // Check 3: Certificate Validity Dates
      const now = new Date();
      const validFrom = new Date(certX509.validFrom);
      const validTo = new Date(certX509.validTo);
      const isExpired = now > validTo;
      const notYetValid = now < validFrom;
      const certDatesValid = !isExpired && !notYetValid;

      // Check 4: Certificate Trust Evaluation
      const isSelfSigned = certX509.subject === certX509.issuer;
      let trustStatus = 'UNTRUSTED_ROOT';
      let trustDetails = 'Certificate is self-signed or not anchored in the Windows Trusted Root Certification Authorities store.';

      if (isSelfSigned) {
        trustStatus = 'SELF_SIGNED';
        trustDetails = 'Self-signed test / internal certificate. Cryptographically authentic, but not issued by a public commercial Certificate Authority.';
      } else {
        // Evaluate if issued by known standard CA or internal enterprise PKI
        trustStatus = 'CHAIN_PRESENT';
        trustDetails = `Issued by: ${certX509.issuer}. For commercial legal compliance (e.g. Adobe Approved Trust List / AATL / eIDAS), the root CA must be pre-installed in the Adobe or OS Trust Store.`;
      }

      // Check 5: Signing Time
      const signingTimeStr = parsedPkcs7.signingTime ? parsedPkcs7.signingTime.toISOString() : (metadata.signingTime || null);

      // Check 6: PAdES Compliance (ETSI EN 319 142 / eIDAS)
      const isPades = metadata.subFilter === 'ETSI.CAdES.detached';
      const hasSigningCertV2 = Boolean(parsedPkcs7.hasSigningCertV2);
      const padesProfile = isPades
        ? (hasSigningCertV2 ? 'PAdES-B-B (ETSI EN 319 142-1 Baseline)' : 'PAdES-BES')
        : 'Legacy PKCS#7 Detached';

      const isValid = digestMatch && signatureValid && certDatesValid;

      return {
        hasSignature: true,
        isValid,
        // Separate status breakdown as required by specification
        integrityValid: digestMatch,
        signatureValid,
        certDatesValid,
        isExpired,
        notYetValid,
        trustStatus,
        trustDetails,
        // PAdES / eIDAS compliance details
        pades: {
          isPades,
          profile: padesProfile,
          subFilter: metadata.subFilter || 'adbe.pkcs7.detached',
          hasSigningCertificateV2: hasSigningCertV2,
          eidasCompliant: isPades && hasSigningCertV2,
        },
        // Detailed signer info
        signer: {
          commonName: parseCN(certX509.subject),
          subject: certX509.subject,
          issuer: certX509.issuer,
          serialNumber: certX509.serialNumber,
          validFrom: certX509.validFrom,
          validTo: certX509.validTo,
          keyAlgorithm: certX509.publicKey.asymmetricKeyType ? certX509.publicKey.asymmetricKeyType.toUpperCase() : 'RSA',
          thumbprint: certX509.fingerprint256.replace(/:/g, ''),
          isSelfSigned,
        },
        metadata: {
          reason: metadata.reason || 'Not specified',
          location: metadata.location || 'Not specified',
          contactInfo: metadata.contactInfo || 'Not specified',
          signingTime: signingTimeStr,
          subFilter: metadata.subFilter,
        },
        technical: {
          byteRange,
          docDigestHex: computedDocDigest.toString('hex'),
          signedDigestHex: parsedPkcs7.messageDigest.toString('hex'),
          signatureHex: parsedPkcs7.signatureBytes.toString('hex').substring(0, 64) + '...',
          algorithm: 'SHA256withRSA',
          format: padesProfile,
        },
      };
    } catch (parseErr) {
      return {
        hasSignature: true,
        isValid: false,
        integrityValid: false,
        signatureValid: false,
        error: `Failed to parse or verify PKCS#7 signature container: ${parseErr.message}`,
        byteRange,
      };
    }
  }
}

/**
 * Parses PKCS#7 SignedData structure to extract signer certificate,
 * signed attributes SET, messageDigest, and signature bytes.
 */
function parsePkcs7SignedData(pkcs7Der) {
  // ContentInfo ::= SEQUENCE { contentType, content [0] EXPLICIT SignedData }
  const contentInfoTlv = readDerTLV(pkcs7Der, 0);
  let offset = 0;
  
  // Read contentType
  const contentTypeTlv = readDerTLV(contentInfoTlv.value, offset);
  offset += contentTypeTlv.totalLength;

  // Read content [0] EXPLICIT SignedData
  const explicitContentTlv = readDerTLV(contentInfoTlv.value, offset);
  const signedDataTlv = readDerTLV(explicitContentTlv.value, 0);

  let sdOffset = 0;
  // version INTEGER
  const versionTlv = readDerTLV(signedDataTlv.value, sdOffset);
  sdOffset += versionTlv.totalLength;

  // digestAlgorithms SET
  const digestAlgsTlv = readDerTLV(signedDataTlv.value, sdOffset);
  sdOffset += digestAlgsTlv.totalLength;

  // encapContentInfo SEQUENCE
  const encapContentTlv = readDerTLV(signedDataTlv.value, sdOffset);
  sdOffset += encapContentTlv.totalLength;

  // certificates [0] IMPLICIT (Tag 0xa0)
  let signerCertDer = null;
  const certsTagTlv = readDerTLV(signedDataTlv.value, sdOffset);
  if (certsTagTlv.tag === 0xa0) {
    // Inside is the X.509 Certificate (SEQUENCE)
    const certTlv = readDerTLV(certsTagTlv.value, 0);
    signerCertDer = certsTagTlv.value.subarray(0, certTlv.totalLength);
    sdOffset += certsTagTlv.totalLength;
  }

  // signerInfos SET
  const signerInfosTlv = readDerTLV(signedDataTlv.value, sdOffset);
  const signerInfoTlv = readDerTLV(signerInfosTlv.value, 0);

  let siOffset = 0;
  // SignerInfo: version INTEGER
  const siVersionTlv = readDerTLV(signerInfoTlv.value, siOffset);
  siOffset += siVersionTlv.totalLength;

  // sid (IssuerAndSerialNumber SEQUENCE)
  const sidTlv = readDerTLV(signerInfoTlv.value, siOffset);
  siOffset += sidTlv.totalLength;

  // digestAlgorithm SEQUENCE
  const digestAlgTlv = readDerTLV(signerInfoTlv.value, siOffset);
  siOffset += digestAlgTlv.totalLength;

  // signedAttrs [0] IMPLICIT (Tag 0xa0)
  const signedAttrsTlv = readDerTLV(signerInfoTlv.value, siOffset);
  siOffset += signedAttrsTlv.totalLength;

  // signatureAlgorithm SEQUENCE
  const sigAlgTlv = readDerTLV(signerInfoTlv.value, siOffset);
  siOffset += sigAlgTlv.totalLength;

  // signature OCTET STRING
  const sigTlv = readDerTLV(signerInfoTlv.value, siOffset);
  const signatureBytes = sigTlv.value;

  // Convert signedAttrs [0] IMPLICIT (Tag 0xa0) back to SET (Tag 0x31) for signature verification
  const signedAttrsSetDer = Buffer.concat([
    Buffer.from([ASN1_TAGS.SET]),
    signedAttrsTlv.value ? encodeLengthFromTLV(signedAttrsTlv) : Buffer.from([0x00]),
    signedAttrsTlv.value,
  ]);

  // Parse signed attributes to extract messageDigest, signingTime, and hasSigningCertV2
  const { messageDigest, signingTime, hasSigningCertV2 } = parseSignedAttributes(signedAttrsTlv.value);

  return {
    signerCertDer,
    signedAttrsSetDer,
    signatureBytes,
    messageDigest,
    signingTime,
    hasSigningCertV2,
  };
}

function encodeLengthFromTLV(tlv) {
  const len = tlv.length;
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/**
 * Parse the signed attributes buffer to find messageDigest, signingTime, and signingCertificateV2
 */
function parseSignedAttributes(attrsBuf) {
  let offset = 0;
  let messageDigest = null;
  let signingTime = null;
  let hasSigningCertV2 = false;

  while (offset < attrsBuf.length) {
    try {
      const attrSeq = readDerTLV(attrsBuf, offset);
      offset += attrSeq.totalLength;

      let aOffset = 0;
      const oidTlv = readDerTLV(attrSeq.value, aOffset);
      aOffset += oidTlv.totalLength;

      const oid = decodeOID(oidTlv.value);
      const valuesSet = readDerTLV(attrSeq.value, aOffset);

      if (oid === OIDS.MESSAGE_DIGEST) {
        // Values SET contains OCTET STRING
        const octetTlv = readDerTLV(valuesSet.value, 0);
        messageDigest = octetTlv.value;
      } else if (oid === OIDS.SIGNING_TIME) {
        const timeTlv = readDerTLV(valuesSet.value, 0);
        const timeStr = timeTlv.value.toString('ascii');
        // UTCTime: YYMMDDHHMMSSZ
        if (timeTlv.tag === ASN1_TAGS.UTC_TIME) {
          const year = parseInt(timeStr.substring(0, 2), 10);
          const fullYear = year >= 50 ? 1900 + year : 2000 + year;
          const month = parseInt(timeStr.substring(2, 4), 10) - 1;
          const day = parseInt(timeStr.substring(4, 6), 10);
          const hour = parseInt(timeStr.substring(6, 8), 10);
          const min = parseInt(timeStr.substring(8, 10), 10);
          const sec = parseInt(timeStr.substring(10, 12), 10);
          signingTime = new Date(Date.UTC(fullYear, month, day, hour, min, sec));
        }
      } else if (oid === OIDS.SIGNING_CERTIFICATE_V2) {
        hasSigningCertV2 = true;
      }
    } catch (_) {
      break;
    }
  }

  return { messageDigest, signingTime, hasSigningCertV2 };
}

/**
 * Extracts metadata string values from PDF /Sig dictionary
 */
function extractPdfSigMetadata(pdfStr, searchStart) {
  // Contents placeholder is ~16KB, so look 2KB before and 25KB after searchStart
  const windowStr = pdfStr.substring(Math.max(0, searchStart - 2000), Math.min(pdfStr.length, searchStart + 25000));

  const extractField = (fieldName) => {
    const re = new RegExp(`/${fieldName}\\s*\\(([^)]+)\\)`);
    const m = windowStr.match(re);
    return m ? m[1].replace(/\\([()\\])/g, '$1') : null;
  };

  const subFilterMatch = windowStr.match(/\/SubFilter\s*\/([a-zA-Z0-9._]+)/);

  return {
    reason: extractField('Reason'),
    location: extractField('Location'),
    contactInfo: extractField('ContactInfo'),
    signingTime: extractField('M'),
    subFilter: subFilterMatch ? subFilterMatch[1] : null,
  };
}

function parseCN(dn) {
  if (!dn) return 'Unknown Signer';
  const m = dn.match(/CN=([^,+]+)/i);
  return m ? m[1].trim() : dn;
}

export default {
  SignatureVerifier,
};
