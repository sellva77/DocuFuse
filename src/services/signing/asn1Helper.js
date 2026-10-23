import crypto from 'crypto';

/**
 * ASN.1 DER (Distinguished Encoding Rules) Encoding & Decoding Helpers
 * Implements ISO/IEC 8825-1 DER encoding for CMS / PKCS#7 SignedData (RFC 2315 / RFC 5652)
 */

export const ASN1_TAGS = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OBJECT_IDENTIFIER: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
  CONTEXT_SPECIFIC_0: 0xa0,
  CONTEXT_SPECIFIC_1: 0xa1,
  CONTEXT_SPECIFIC_2: 0xa2,
  CONTEXT_SPECIFIC_3: 0xa3,
};

// Common OIDs used in CMS and PDF signing
export const OIDS = {
  // PKCS#7 / CMS
  ID_DATA: '1.2.840.113549.1.7.1',
  ID_SIGNED_DATA: '1.2.840.113549.1.7.2',
  CONTENT_TYPE: '1.2.840.113549.1.9.3',
  MESSAGE_DIGEST: '1.2.840.113549.1.9.4',
  SIGNING_TIME: '1.2.840.113549.1.9.5',
  
  // Digest Algorithms
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA1: '1.3.14.3.2.26',
  
  // Signature Algorithms
  RSA_ENCRYPTION: '1.2.840.113549.1.1.1',
  SHA256_WITH_RSA_ENCRYPTION: '1.2.840.113549.1.1.11',

  // PAdES / CAdES Attributes (ETSI EN 319 122 / RFC 5035)
  SIGNING_CERTIFICATE_V2: '1.2.840.113549.1.9.16.2.47',
};

/**
 * Encode length according to DER rules
 * @param {number} len 
 * @returns {Buffer}
 */
export function encodeLength(len) {
  if (len < 128) {
    return Buffer.from([len]);
  } else if (len < 256) {
    return Buffer.from([0x81, len]);
  } else if (len < 65536) {
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else if (len < 16777216) {
    return Buffer.from([0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  } else {
    return Buffer.from([0x84, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
}

/**
 * Wrap tag and content in DER encoding
 * @param {number} tag 
 * @param {Buffer|Uint8Array|string} content 
 * @returns {Buffer}
 */
export function derTag(tag, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(buf.length), buf]);
}

export function derSequence(...items) {
  const concatenated = Buffer.concat(items.map(item => Buffer.isBuffer(item) ? item : Buffer.from(item)));
  return derTag(ASN1_TAGS.SEQUENCE, concatenated);
}

export function derSet(...items) {
  // In DER, elements in a SET must be sorted by their binary DER encoding
  const buffers = items.map(item => Buffer.isBuffer(item) ? item : Buffer.from(item));
  buffers.sort((a, b) => Buffer.compare(a, b));
  return derTag(ASN1_TAGS.SET, Buffer.concat(buffers));
}

export function derOID(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      bytes.push(val);
    } else {
      const vBytes = [];
      vBytes.push(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        vBytes.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      bytes.push(...vBytes.reverse());
    }
  }
  return derTag(ASN1_TAGS.OBJECT_IDENTIFIER, Buffer.from(bytes));
}

export function derInteger(numOrBuf) {
  if (typeof numOrBuf === 'number') {
    if (numOrBuf >= 0 && numOrBuf < 128) {
      return derTag(ASN1_TAGS.INTEGER, Buffer.from([numOrBuf]));
    }
    let hex = numOrBuf.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    let buf = Buffer.from(hex, 'hex');
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
    return derTag(ASN1_TAGS.INTEGER, buf);
  }
  
  let buf = Buffer.from(numOrBuf);
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTag(ASN1_TAGS.INTEGER, buf);
}

export function derOctetString(buf) {
  return derTag(ASN1_TAGS.OCTET_STRING, buf);
}

export function derBitString(buf, unusedBits = 0) {
  return derTag(ASN1_TAGS.BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

export function derNull() {
  return Buffer.from([ASN1_TAGS.NULL, 0x00]);
}

export function derUTCTime(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const str =
    pad(d.getUTCFullYear() % 100) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z';
  return derTag(ASN1_TAGS.UTC_TIME, Buffer.from(str, 'ascii'));
}

export function derPrintableString(str) {
  return derTag(ASN1_TAGS.PRINTABLE_STRING, Buffer.from(str, 'ascii'));
}

export function derUtf8String(str) {
  return derTag(ASN1_TAGS.UTF8_STRING, Buffer.from(str, 'utf8'));
}

export function derContextExplicit(tagNum, content) {
  return derTag(0xa0 + tagNum, content);
}

export function derContextImplicit(tagNum, content) {
  return derTag(0x80 + tagNum, content);
}

/**
 * Parses DER TLV (Tag, Length, Value) from buffer
 * @param {Buffer} buf 
 * @param {number} offset 
 * @returns {{ tag: number, length: number, headerLength: number, value: Buffer, totalLength: number }}
 */
export function readDerTLV(buf, offset = 0) {
  if (offset >= buf.length) {
    throw new Error('Unexpected end of DER buffer');
  }
  const tag = buf[offset];
  let lengthByte = buf[offset + 1];
  let length = 0;
  let headerLength = 2;

  if ((lengthByte & 0x80) === 0) {
    length = lengthByte;
  } else {
    const numBytes = lengthByte & 0x7f;
    headerLength = 2 + numBytes;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | buf[offset + 2 + i];
    }
  }

  const totalLength = headerLength + length;
  const value = buf.subarray(offset + headerLength, offset + totalLength);
  return { tag, length, headerLength, value, totalLength };
}

/**
 * Decode OID from DER bytes
 * @param {Buffer} buf 
 * @returns {string}
 */
export function decodeOID(buf) {
  if (!buf || buf.length === 0) return '';
  const first = buf[0];
  const parts = [Math.floor(first / 40), first % 40];
  let current = 0;
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i];
    current = (current << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }
  return parts.join('.');
}

/**
 * Parse an X.509 certificate DER buffer to extract Issuer Name DER and Serial Number
 * @param {Buffer} certDer 
 * @returns {{ issuerDer: Buffer, serialNumberDer: Buffer, serialNumberHex: string }}
 */
export function extractCertIssuerAndSerial(certDer) {
  // Certificate ::= SEQUENCE { tbsCertificate TBSCertificate, signatureAlgorithm ..., signatureValue ... }
  const certTlv = readDerTLV(certDer, 0);
  // Inside tbsCertificate:
  const tbsTlv = readDerTLV(certTlv.value, 0);
  
  let offset = 0;
  // Check if version is present [0] EXPLICIT
  let firstItem = readDerTLV(tbsTlv.value, offset);
  if (firstItem.tag === 0xa0) {
    offset += firstItem.totalLength;
    firstItem = readDerTLV(tbsTlv.value, offset);
  }
  
  // First item after version is serialNumber INTEGER
  const serialTlv = firstItem;
  offset += serialTlv.totalLength;
  
  // Next is signature AlgorithmIdentifier
  const sigAlgTlv = readDerTLV(tbsTlv.value, offset);
  offset += sigAlgTlv.totalLength;
  
  // Next is issuer Name (SEQUENCE)
  const issuerTlv = readDerTLV(tbsTlv.value, offset);
  const issuerDer = tbsTlv.value.subarray(offset, offset + issuerTlv.totalLength);

  const serialNumberHex = serialTlv.value.toString('hex').toUpperCase();

  return {
    issuerDer,
    serialNumberDer: serialTlv.value,
    serialNumberHex,
  };
}

/**
 * Build RFC 5035 / ETSI EN 319 122 signing-certificate-v2 attribute
 * Mandatory for PAdES Baseline (PAdES-B-B / PAdES-BES) eIDAS compliance
 *
 * SigningCertificateV2 ::= SEQUENCE {
 *   certs SEQUENCE OF ESSCertIDv2,
 *   policies SEQUENCE OF PolicyInformation OPTIONAL
 * }
 * ESSCertIDv2 ::= SEQUENCE {
 *   hashAlgorithm AlgorithmIdentifier DEFAULT { algorithm id-sha256 },
 *   certHash Hash,
 *   issuerSerial IssuerSerial OPTIONAL
 * }
 *
 * @param {Buffer} certDer - X.509 certificate DER bytes
 * @returns {Buffer} DER-encoded Attribute SEQUENCE
 */
export function buildSigningCertificateV2Attr(certDer) {
  if (!certDer || !Buffer.isBuffer(certDer) || certDer.length === 0) {
    return null;
  }
  const certHash = crypto.createHash('sha256').update(certDer).digest();
  const certHashOctet = derOctetString(certHash);

  // RFC 5035 & ETSI EN 319 122-1 § 5.2.2:
  // ESSCertIDv2 ::= SEQUENCE {
  //   hashAlgorithm AlgorithmIdentifier DEFAULT {algorithm id-sha256},
  //   certHash Hash,
  //   issuerSerial IssuerSerial OPTIONAL
  // }
  // Under DER rules, fields matching DEFAULT (SHA-256) MUST be omitted.
  // ETSI EN 319 122-1 clause 5.2.2: "The hashAlgorithm field shall be absent when SHA-256 is used.
  // The issuerSerial field should be absent."
  const essCertIdV2 = derSequence(certHashOctet);
  const signingCertificateV2 = derSequence(derSequence(essCertIdV2));

  return derSequence(
    derOID(OIDS.SIGNING_CERTIFICATE_V2),
    derSet(signingCertificateV2)
  );
}

/**
 * Build SignedAttributes SET for PAdES / CAdES detached signature
 * For PAdES-B-B / PAdES-BES compliance (ETSI EN 319 142), SignedAttributes contains:
 * 1. contentType (id-data: 1.2.840.113549.1.7.1)
 * 2. signingTime (current UTC time)
 * 3. messageDigest (SHA-256 of the PDF ByteRange bytes)
 * 4. id-aa-signingCertificateV2 (RFC 5035 certificate hash binding for anti-substitution)
 * 
 * @param {Buffer} pdfDigest - SHA-256 digest (32 bytes) of the PDF ByteRange
 * @param {Date} [signingDate] - Signing time
 * @param {Buffer} [certDer] - Signer certificate DER bytes (mandatory for PAdES)
 * @returns {{ signedAttrsSet: Buffer, bytesToSign: Buffer }}
 */
export function buildSignedAttributes(pdfDigest, signingDate = new Date(), certDer = null) {
  // Attribute 1: contentType
  const attrContentType = derSequence(
    derOID(OIDS.CONTENT_TYPE),
    derSet(derOID(OIDS.ID_DATA))
  );

  // Attribute 2: signingTime
  const attrSigningTime = derSequence(
    derOID(OIDS.SIGNING_TIME),
    derSet(derUTCTime(signingDate))
  );

  // Attribute 3: messageDigest
  const attrMessageDigest = derSequence(
    derOID(OIDS.MESSAGE_DIGEST),
    derSet(derOctetString(pdfDigest))
  );

  const attrsList = [attrContentType, attrSigningTime, attrMessageDigest];

  // Attribute 4: signingCertificateV2 (PAdES / eIDAS mandatory)
  if (certDer && Buffer.isBuffer(certDer) && certDer.length > 0) {
    const sigCertV2Attr = buildSigningCertificateV2Attr(certDer);
    if (sigCertV2Attr) {
      attrsList.push(sigCertV2Attr);
    }
  }

  // In DER, SET attributes must be ordered lexicographically by their encoded bytes
  const sortedAttrs = attrsList.sort((a, b) =>
    Buffer.compare(a, b)
  );

  // DER SET with tag 0x31
  const signedAttrsSet = derTag(ASN1_TAGS.SET, Buffer.concat(sortedAttrs));

  return {
    signedAttrsSet,
    // Note: For signing with RSA, the data signed is the DER encoding of SignedAttributes (tag 0x31)
    bytesToSign: signedAttrsSet,
  };
}

/**
 * Build the complete CMS / PKCS#7 SignedData structure
 * 
 * ContentInfo ::= SEQUENCE {
 *   contentType id-signedData (1.2.840.113549.1.7.2),
 *   content [0] EXPLICIT SignedData
 * }
 * 
 * SignedData ::= SEQUENCE {
 *   version INTEGER (1),
 *   digestAlgorithms SET OF AlgorithmIdentifier (sha-256),
 *   encapContentInfo SEQUENCE { contentType id-data (1.2.840.113549.1.7.1) },
 *   certificates [0] IMPLICIT SET OF Certificate,
 *   signerInfos SET OF SignerInfo
 * }
 * 
 * SignerInfo ::= SEQUENCE {
 *   version INTEGER (1),
 *   sid IssuerAndSerialNumber,
 *   digestAlgorithm AlgorithmIdentifier (sha-256),
 *   signedAttrs [0] IMPLICIT SignedAttributes,
 *   signatureAlgorithm AlgorithmIdentifier (rsaEncryption),
 *   signature OCTET STRING
 * }
 * 
 * @param {Object} options
 * @param {Buffer} options.certDer - X.509 certificate DER
 * @param {Buffer} options.signedAttrsSet - DER SET of signed attributes
 * @param {Buffer} options.signatureBytes - Raw cryptographic signature bytes
 * @param {Buffer[]} [options.chainDers] - Additional intermediate/root certificate DERs
 * @returns {Buffer} DER-encoded PKCS#7 ContentInfo
 */
export function buildPkcs7SignedData({ certDer, signedAttrsSet, signatureBytes, chainDers = [] }) {
  // Extract issuer and serial from certificate
  const { issuerDer, serialNumberDer } = extractCertIssuerAndSerial(certDer);

  // AlgorithmIdentifier: SHA-256
  // RFC 5754: Parameters for SHA-256 in CMS digestAlgorithms MUST be absent
  const sha256Alg = derSequence(
    derOID(OIDS.SHA256)
  );

  // AlgorithmIdentifier: RSA Encryption (PKCS#1 v1.5 requires NULL parameter)
  const rsaAlg = derSequence(
    derOID(OIDS.RSA_ENCRYPTION),
    derNull()
  );

  // DigestAlgorithms SET
  const digestAlgorithms = derSet(sha256Alg);

  // EncapsulatedContentInfo: contentType id-data (detached signature, content omitted)
  const encapContentInfo = derSequence(
    derOID(OIDS.ID_DATA)
  );

  // Certificates [0] IMPLICIT SET OF Certificate
  // In DER, SET OF elements must be lexicographically sorted by their encoded bytes
  const allCerts = [certDer, ...chainDers];
  allCerts.sort((a, b) => Buffer.compare(a, b));
  const certsBuffer = Buffer.concat(allCerts);
  // [0] IMPLICIT tag: 0xa0
  const certificatesTag = derTag(0xa0, certsBuffer);

  // SignerIdentifier: IssuerAndSerialNumber
  const sid = derSequence(
    issuerDer,
    derInteger(serialNumberDer)
  );

  // signedAttrs in SignerInfo has [0] IMPLICIT tag: 0xa0
  const setTlv = readDerTLV(signedAttrsSet, 0);
  const signedAttrsImplicit = derTag(0xa0, setTlv.value);

  // SignerInfo
  const signerInfo = derSequence(
    derInteger(1), // version CMSVersion = 1
    sid,
    sha256Alg,
    signedAttrsImplicit,
    rsaAlg,
    derOctetString(signatureBytes)
  );

  const signerInfos = derSet(signerInfo);

  // SignedData
  const signedData = derSequence(
    derInteger(1), // version = 1
    digestAlgorithms,
    encapContentInfo,
    certificatesTag,
    signerInfos
  );

  // ContentInfo: SEQUENCE { id-signedData, [0] EXPLICIT signedData }
  const contentInfo = derSequence(
    derOID(OIDS.ID_SIGNED_DATA),
    derContextExplicit(0, signedData)
  );

  return contentInfo;
}

export default {
  ASN1_TAGS,
  OIDS,
  encodeLength,
  derTag,
  derSequence,
  derSet,
  derOID,
  derInteger,
  derOctetString,
  derBitString,
  derNull,
  derUTCTime,
  derPrintableString,
  derUtf8String,
  derContextExplicit,
  derContextImplicit,
  readDerTLV,
  decodeOID,
  extractCertIssuerAndSerial,
  buildSigningCertificateV2Attr,
  buildSignedAttributes,
  buildPkcs7SignedData,
};
