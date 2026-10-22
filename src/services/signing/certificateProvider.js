import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { derSequence, derSet, derTag, derOID, derInteger, derUTCTime, derBitString, derOctetString, derNull, derUtf8String, derPrintableString, OIDS, ASN1_TAGS } from './asn1Helper.js';

const getDirname = () => {
  try {
    if (typeof __dirname !== 'undefined') return __dirname;
    return path.dirname(fileURLToPath(import.meta.url));
  } catch (_) {
    return process.cwd();
  }
};

/**
 * Base Provider Interface for Digital Signature Certificate Tokens
 */
export class BaseCertificateProvider {
  constructor(id, name, description) {
    this.id = id;
    this.name = name;
    this.description = description;
  }

  async isAvailable() {
    return true;
  }

  async discoverCertificates() {
    throw new Error('discoverCertificates must be implemented by subclass');
  }

  async signData(aliasOrId, dataBuffer) {
    throw new Error('signData must be implemented by subclass');
  }
}

/**
 * Helper to locate the signing bridge (prioritizing native Windows executable / PowerShell, falling back to JAR if present)
 */
function getSigningBridgePath() {
  // 1. Native Windows Executable (.exe) - No Java or runtime required!
  const exePaths = [
    path.join(process.resourcesPath || '', 'resources', 'SigningBridge.exe'),
    path.join(process.resourcesPath || '', 'SigningBridge.exe'),
    path.join(process.cwd(), 'resources', 'SigningBridge.exe'),
    path.join(process.cwd(), 'signing-bridge', 'SigningBridge.exe'),
    path.join(getDirname(), '..', '..', '..', 'resources', 'SigningBridge.exe'),
    path.join(getDirname(), '..', '..', '..', 'signing-bridge', 'SigningBridge.exe'),
  ];

  for (const p of exePaths) {
    try {
      if (fs.existsSync(p)) return { type: 'native', path: p };
    } catch (_) {}
  }

  // 2. Native Windows PowerShell Script (.ps1) - Built into every Windows OS!
  const psPaths = [
    path.join(process.resourcesPath || '', 'resources', 'SigningBridge.ps1'),
    path.join(process.resourcesPath || '', 'SigningBridge.ps1'),
    path.join(process.cwd(), 'resources', 'SigningBridge.ps1'),
    path.join(process.cwd(), 'signing-bridge', 'SigningBridge.ps1'),
    path.join(getDirname(), '..', '..', '..', 'resources', 'SigningBridge.ps1'),
    path.join(getDirname(), '..', '..', '..', 'signing-bridge', 'SigningBridge.ps1'),
  ];

  for (const p of psPaths) {
    try {
      if (fs.existsSync(p)) return { type: 'powershell', path: p };
    } catch (_) {}
  }

  // 3. Fallback: Java JAR or Class (if available)
  const jarPaths = [
    path.join(process.resourcesPath || '', 'resources', 'signing-bridge.jar'),
    path.join(process.resourcesPath || '', 'signing-bridge.jar'),
    path.join(process.cwd(), 'resources', 'signing-bridge.jar'),
    path.join(process.cwd(), 'signing-bridge', 'signing-bridge.jar'),
    path.join(getDirname(), '..', '..', '..', 'resources', 'signing-bridge.jar'),
    path.join(getDirname(), '..', '..', '..', 'signing-bridge', 'signing-bridge.jar'),
  ];

  for (const p of jarPaths) {
    try {
      if (fs.existsSync(p)) return { type: 'jar', path: p };
    } catch (_) {}
  }

  const classPaths = [
    path.join(process.cwd(), 'signing-bridge'),
    path.join(getDirname(), '..', '..', '..', 'signing-bridge'),
  ];

  for (const cp of classPaths) {
    try {
      if (fs.existsSync(path.join(cp, 'SigningBridge.class'))) {
        return { type: 'class', path: cp };
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Executes the SigningBridge (Native Windows EXE / PowerShell / Java)
 */
function runJavaBridge(command, args = [], timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const bridge = getSigningBridgePath();
    if (!bridge) {
      return reject(new Error('SigningBridge component not found. Please ensure Windows signing bridge is packaged.'));
    }

    let spawnCmd = '';
    let cmdArgs = [];

    if (bridge.type === 'native') {
      spawnCmd = bridge.path;
      cmdArgs = [command, ...args];
    } else if (bridge.type === 'powershell') {
      spawnCmd = 'powershell.exe';
      cmdArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridge.path, command, ...args];
    } else if (bridge.type === 'jar' || bridge.type === 'class') {
      spawnCmd = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java';
      cmdArgs = ['-cp', bridge.path, 'SigningBridge', command, ...args];
    }

    let stdout = '';
    let stderr = '';
    let child = null;

    try {
      child = spawn(spawnCmd, cmdArgs, {
        windowsHide: false, // Allows Windows / DSC vendor native PIN dialog to appear on top
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return reject(new Error(`Failed to launch signing bridge (${bridge.type}): ${err.message}`));
    }

    const timer = setTimeout(() => {
      if (child) {
        child.kill();
        reject(new Error('Signing bridge operation timed out. (Did the DSC token PIN dialog remain open?)'));
      }
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Signing bridge execution error: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `Signing bridge exited with code ${code}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.success) {
          return reject(new Error(parsed.error || 'Signing bridge reported an error'));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Invalid response from signing bridge: ${stdout || stderr}`));
      }
    });
  });
}

/**
 * Windows Certificate Store Provider (USB DSC Tokens via Windows-MY / SunMSCAPI)
 * 
 * Interacts with Windows CryptoAPI / CNG through Java's SunMSCAPI provider.
/**
 * Scans removable/virtual CD drives on Windows for connected USB DSC token installers
 * (e.g. HyperPKI HYP2003, ePass2003, ProxKey, mToken, SafeNet)
 */
export function detectConnectedTokenDrives() {
  if (process.platform !== 'win32') return { found: false };
  const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of letters) {
    const root = `${letter}:\\`;
    try {
      if (!fs.existsSync(root)) continue;
      const files = fs.readdirSync(root);

      for (const f of files) {
        const lower = f.toLowerCase();
        if (lower.includes('hypp2003') || lower.includes('hyperpki')) {
          return {
            found: true,
            drive: root,
            setupFileName: f,
            setupFilePath: path.join(root, f),
            tokenName: 'HyperPKI HYP2003 USB Token',
          };
        }
        if (lower.includes('epass2003') || lower.includes('eps2003')) {
          return {
            found: true,
            drive: root,
            setupFileName: f,
            setupFilePath: path.join(root, f),
            tokenName: 'ePass 2003 USB Token',
          };
        }
        if (lower.includes('proxkey') || lower.includes('watchdata')) {
          return {
            found: true,
            drive: root,
            setupFileName: f,
            setupFilePath: path.join(root, f),
            tokenName: 'Watchdata ProxKey USB Token',
          };
        }
        if (lower.includes('mtoken') || lower.includes('cryptoid')) {
          return {
            found: true,
            drive: root,
            setupFileName: f,
            setupFilePath: path.join(root, f),
            tokenName: 'mToken CryptoID USB Token',
          };
        }
        if (lower.includes('safenet') || lower.includes('etoken')) {
          return {
            found: true,
            drive: root,
            setupFileName: f,
            setupFilePath: path.join(root, f),
            tokenName: 'SafeNet eToken USB Token',
          };
        }
        if (lower.endsWith('.exe') && (lower.includes('setup') || lower.includes('pki') || lower.includes('token'))) {
          return {
            found: true,
            drive: root,
            setupFileName: f,
            setupFilePath: path.join(root, f),
            tokenName: 'USB DSC Token',
          };
        }
      }
    } catch (_) {
      // Ignore inaccessible or unready drives
    }
  }
  return { found: false };
}

/**
 * Windows Certificate Store Provider (USB DSC Tokens via Windows-MY / SunMSCAPI)
 * 
 * Interacts with Windows CryptoAPI / CNG through Java's SunMSCAPI provider.
 * When a DSC token is connected to Windows, its CSP/KSP driver enrolls the certificate
 * in CurrentUser\My. During private-key operations, the token driver pops up
 * its native hardware PIN prompt.
 */
export class WindowsStoreProvider extends BaseCertificateProvider {
  constructor() {
    super(
      'windows-store',
      'Windows Certificate Store (USB DSC Token)',
      'Access certificates enrolled in Windows Certificate Store or plugged-in USB DSC tokens (ProxKey, ePass2003, SafeNet, Watchdata, etc.)'
    );
  }

  async isAvailable() {
    return process.platform === 'win32';
  }

  async discoverCertificates() {
    try {
      const result = await runJavaBridge('list-certs', [], 15000);
      const rawCerts = result.certificates || [];
      const tokenDrive = detectConnectedTokenDrives();

      const certs = rawCerts.map(cert => {
        const isSystemCert = Boolean(
          cert.isSystemCert ||
          (cert.issuer && cert.issuer.includes('MS-Organization-Access')) ||
          (cert.issuer && cert.issuer.includes('Microsoft Windows')) ||
          (cert.subject && /CN=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(cert.subject))
        );

        const isHardware = !isSystemCert && !cert.isTestCertificate && cert.hasPrivateKey;

        return {
          id: cert.alias,
          alias: cert.alias,
          subject: cert.subject,
          subjectCommonName: isSystemCert ? 'Windows Workplace Join (Device Identity)' : parseCN(cert.subject),
          issuer: cert.issuer,
          issuerCommonName: parseCN(cert.issuer),
          serialNumber: cert.serialNumber,
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          hasPrivateKey: cert.hasPrivateKey,
          isExpired: cert.isExpired,
          notYetValid: cert.notYetValid,
          isEligibleForSigning: isSystemCert ? false : cert.isEligibleForSigning,
          isSystemCert,
          keyAlgorithm: cert.keyAlgorithm,
          keySize: cert.keySize,
          thumbprint: cert.thumbprint,
          certDerBase64: cert.certDerBase64,
          providerId: this.id,
          isHardwareToken: isHardware,
          isTestCertificate: false,
        };
      });

      certs.connectedTokenDrive = tokenDrive;
      return certs;
    } catch (err) {
      throw new Error(`Failed to query Windows Certificate Store: ${err.message}`);
    }
  }

  async signData(alias, dataBuffer) {
    if (!alias) throw new Error('Certificate alias is required for Windows Store signing');
    if (!Buffer.isBuffer(dataBuffer)) throw new Error('Data buffer is required for signing');

    const dataBase64 = dataBuffer.toString('base64');
    // Allow up to 120s for the user to type their PIN on the token's hardware dialog
    const result = await runJavaBridge('sign-data', [alias, dataBase64], 120000);

    return {
      signatureBuffer: Buffer.from(result.signatureBase64, 'base64'),
      certDerBuffer: Buffer.from(result.certBase64, 'base64'),
      algorithm: result.algorithm || 'SHA256withRSA',
    };
  }
}

/**
 * In-Memory Software Test Certificate Provider
 * 
 * Generates and provides an RSA-2048 self-signed certificate with Digital Signature
 * key usage for automated test suites, development, and offline validation.
 */
let cachedTestKeyPair = null;
let cachedTestCertDer = null;

export class SoftwareTestProvider extends BaseCertificateProvider {
  constructor() {
    super(
      'software-test',
      'Test / Software Certificate (Self-Signed)',
      'Dedicated cryptographic test certificate for automated testing and verification without requiring a physical USB token'
    );
  }

  async isAvailable() {
    return true;
  }

  async getOrCreateTestCert() {
    if (!cachedTestKeyPair || !cachedTestCertDer) {
      // Generate RSA 2048 key pair
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      // Build a minimal self-signed X.509 v3 certificate in DER format
      const certDer = buildSelfSignedCertDer({
        spkiDer: keyPair.publicKey,
        privateKeyPem: keyPair.privateKey,
        commonName: 'Document Merger Test Signer',
        organization: 'Document Merger Automated Testing',
        country: 'IN',
        validityDays: 365,
      });

      cachedTestKeyPair = keyPair;
      cachedTestCertDer = certDer;
    }

    return { keyPair: cachedTestKeyPair, certDer: cachedTestCertDer };
  }

  async discoverCertificates() {
    const { certDer } = await this.getOrCreateTestCert();
    const x509 = new crypto.X509Certificate(certDer);

    return [{
      id: 'test-signer-cert-01',
      alias: 'test-signer-cert-01',
      subject: x509.subject,
      subjectCommonName: 'Document Merger Test Signer',
      issuer: x509.issuer,
      issuerCommonName: 'Document Merger Automated Testing',
      serialNumber: x509.serialNumber,
      validFrom: x509.validFrom,
      validTo: x509.validTo,
      hasPrivateKey: true,
      isExpired: false,
      notYetValid: false,
      isEligibleForSigning: true,
      keyAlgorithm: 'RSA',
      keySize: 2048,
      thumbprint: x509.fingerprint256.replace(/:/g, ''),
      certDerBase64: certDer.toString('base64'),
      providerId: this.id,
      isHardwareToken: false,
      isTestCertificate: true,
    }];
  }

  async signData(alias, dataBuffer) {
    const { keyPair, certDer } = await this.getOrCreateTestCert();
    
    // RSA-SHA256 signature using the private key
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(dataBuffer);
    const signatureBuffer = signer.sign(keyPair.privateKey);

    return {
      signatureBuffer,
      certDerBuffer: certDer,
      algorithm: 'SHA256withRSA',
    };
  }
}

/**
 * PKCS#11 Native Provider (Skeleton for token-specific middleware DLL)
 */
export class PKCS11Provider extends BaseCertificateProvider {
  constructor() {
    super(
      'pkcs11-module',
      'Vendor PKCS#11 Module (Native Middleware)',
      'Direct PKCS#11 token integration using vendor-supplied native driver DLL (e.g. ProxKey, ePass2003, SafeNet)'
    );
    this.modulePath = null;
  }

  setModulePath(dllPath) {
    this.modulePath = dllPath;
  }

  async isAvailable() {
    return process.platform === 'win32';
  }

  async discoverCertificates() {
    if (!this.modulePath || !fs.existsSync(this.modulePath)) {
      return [];
    }
    // Reserved for specific vendor PKCS#11 drivers when path is provided
    return [];
  }

  async signData() {
    throw new Error('PKCS#11 module not configured. Please use the Windows Certificate Store provider for standard USB DSC tokens.');
  }
}

/**
 * Helper to extract Common Name (CN) from X.500 distinguished name string
 */
function parseCN(dn) {
  if (!dn) return 'Unknown Signer';
  const match = dn.match(/CN=([^,+]+)/i);
  return match ? match[1].trim() : dn;
}

/**
 * Builds a valid self-signed X.509 v3 certificate DER buffer
 */
function buildSelfSignedCertDer({ spkiDer, privateKeyPem, commonName, organization, country, validityDays = 365 }) {
  const serialBytes = crypto.randomBytes(16);
  // Ensure positive integer
  serialBytes[0] = serialBytes[0] & 0x7f;

  const now = new Date();
  const notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

  // Subject / Issuer Distinguished Name
  const dnSeq = derSequence(
    derSet(derSequence(derOID('2.5.4.6'), derPrintableString(country))),
    derSet(derSequence(derOID('2.5.4.10'), derUtf8String(organization))),
    derSet(derSequence(derOID('2.5.4.3'), derUtf8String(commonName)))
  );

  // Validity
  const validitySeq = derSequence(
    derUTCTime(now),
    derUTCTime(notAfter)
  );

  // Signature algorithm: sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sigAlgSeq = derSequence(
    derOID(OIDS.SHA256_WITH_RSA_ENCRYPTION),
    derNull()
  );

  // Key Usage Extension: digitalSignature (bit 0), nonRepudiation (bit 1) -> 0xC0
  const keyUsageExt = derSequence(
    derOID('2.5.29.15'), // keyUsage
    derTag(ASN1_TAGS.BOOLEAN, Buffer.from([0xff])), // critical = true
    derOctetString(derBitString(Buffer.from([0xc0]), 6))
  );

  // Basic Constraints: cA = false
  const basicConstraintsExt = derSequence(
    derOID('2.5.29.19'),
    derOctetString(derSequence(derTag(ASN1_TAGS.BOOLEAN, Buffer.from([0x00]))))
  );

  // Extensions [3] EXPLICIT
  const extensionsSeq = derTag(0xa3, derSequence(keyUsageExt, basicConstraintsExt));

  // TBSCertificate
  const tbsCertificate = derSequence(
    derTag(0xa0, derInteger(2)), // version v3 = 2
    derInteger(serialBytes),
    sigAlgSeq,
    dnSeq, // issuer
    validitySeq,
    dnSeq, // subject
    spkiDer, // subjectPublicKeyInfo
    extensionsSeq
  );

  // Sign TBSCertificate with RSA-SHA256
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(tbsCertificate);
  const signatureBytes = signer.sign(privateKeyPem);

  // Complete Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  const certDer = derSequence(
    tbsCertificate,
    sigAlgSeq,
    derBitString(signatureBytes)
  );

  return certDer;
}

// Provider instances
const providers = {
  'windows-store': new WindowsStoreProvider(),
  'software-test': new SoftwareTestProvider(),
  'pkcs11-module': new PKCS11Provider(),
};

/**
 * Get provider by ID
 * @param {string} providerId 
 * @returns {BaseCertificateProvider}
 */
export function getCertificateProvider(providerId = 'windows-store') {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unsupported certificate provider: ${providerId}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

/**
 * List all supported provider descriptors
 */
export async function getSupportedProviders() {
  const list = [];
  for (const [id, provider] of Object.entries(providers)) {
    const available = await provider.isAvailable();
    list.push({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      isAvailable: available,
    });
  }
  return list;
}

export default {
  BaseCertificateProvider,
  WindowsStoreProvider,
  SoftwareTestProvider,
  PKCS11Provider,
  getCertificateProvider,
  getSupportedProviders,
};
