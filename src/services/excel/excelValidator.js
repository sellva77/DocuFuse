import fs from 'fs';
import path from 'path';

export const SUPPORTED_EXCEL_EXTENSIONS = ['.xlsx', '.xls'];

/**
 * Check if file has ZIP magic bytes (standard for .xlsx)
 */
export function isZipHeader(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/**
 * Check if file has OLE Compound Document magic bytes (standard for legacy .xls and encrypted office files)
 */
export function isOleHeader(buffer) {
  if (!buffer || buffer.length < 8) return false;
  return (
    buffer[0] === 0xD0 &&
    buffer[1] === 0xCF &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xE0 &&
    buffer[4] === 0xA1 &&
    buffer[5] === 0xB1 &&
    buffer[6] === 0x1A &&
    buffer[7] === 0xE1
  );
}

/**
 * Check if an OLE compound document is an encrypted Office package
 */
export function isEncryptedOlePackage(buffer) {
  if (!isOleHeader(buffer)) return false;
  // Look for "EncryptedPackage" or "EncryptionInfo" in UTF-16LE / ASCII
  const str = buffer.toString('binary');
  const encPkgAscii = 'EncryptedPackage';
  const encInfoAscii = 'EncryptionInfo';
  
  // Search for UTF-16LE representation
  const encPkgUtf16 = Buffer.from('EncryptedPackage', 'utf16le').toString('binary');
  const encInfoUtf16 = Buffer.from('EncryptionInfo', 'utf16le').toString('binary');

  return (
    str.includes(encPkgAscii) ||
    str.includes(encInfoAscii) ||
    str.includes(encPkgUtf16) ||
    str.includes(encInfoUtf16)
  );
}

/**
 * Validate an Excel file before processing
 * @param {string} filePath - Absolute path to the Excel file
 * @param {number} maxSize - Maximum allowed file size in bytes
 * @returns {{ valid: boolean, error?: string, format?: 'xlsx' | 'xls' }}
 */
export function validateExcelFile(filePath, maxSize = 500 * 1024 * 1024) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { valid: false, error: 'Invalid file path' };
  }

  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    return { valid: false, error: 'Path traversal detected in file path' };
  }

  const ext = path.extname(normalized).toLowerCase();
  if (!SUPPORTED_EXCEL_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Unsupported Excel file format: "${ext}". Supported formats are: ${SUPPORTED_EXCEL_EXTENSIONS.join(', ')}`,
    };
  }

  try {
    fs.accessSync(normalized, fs.constants.R_OK);
  } catch {
    return { valid: false, error: 'File not found or not readable' };
  }

  let stats;
  try {
    stats = fs.statSync(normalized);
  } catch {
    return { valid: false, error: 'Cannot read file information' };
  }

  if (!stats.isFile()) {
    return { valid: false, error: 'Selected path is not a file' };
  }

  if (stats.size === 0) {
    return { valid: false, error: `"${path.basename(normalized)}" is empty (0 bytes).` };
  }

  if (stats.size > maxSize) {
    const sizeMB = Math.round(stats.size / (1024 * 1024));
    const maxMB = Math.round(maxSize / (1024 * 1024));
    return { valid: false, error: `File is too large (${sizeMB}MB). Maximum allowed is ${maxMB}MB.` };
  }

  // Read header bytes
  let headerBuffer;
  try {
    const fd = fs.openSync(normalized, 'r');
    const bytesToRead = Math.min(stats.size, 4096);
    headerBuffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, headerBuffer, 0, bytesToRead, 0);
    fs.closeSync(fd);
  } catch (err) {
    return { valid: false, error: `Error reading file header: ${err.message}` };
  }

  const fileName = path.basename(normalized);

  // Check magic bytes for XLSX
  if (ext === '.xlsx') {
    if (isEncryptedOlePackage(headerBuffer)) {
      return {
        valid: false,
        error: `"${fileName}" is password-protected. Please remove password protection before converting.`,
      };
    }
    if (!isZipHeader(headerBuffer)) {
      return {
        valid: false,
        error: `"${fileName}" does not appear to be a valid XLSX file. It may be corrupted or in an incompatible format.`,
      };
    }
    return { valid: true, format: 'xlsx' };
  }

  // Check magic bytes for legacy XLS
  if (ext === '.xls') {
    if (isEncryptedOlePackage(headerBuffer)) {
      return {
        valid: false,
        error: `"${fileName}" is password-protected. Please remove password protection before converting.`,
      };
    }
    if (!isOleHeader(headerBuffer)) {
      return {
        valid: false,
        error: `"${fileName}" does not appear to be a valid legacy Excel XLS file. It may be corrupted.`,
      };
    }
    return { valid: true, format: 'xls' };
  }

  return { valid: true, format: ext.slice(1) };
}

export default {
  SUPPORTED_EXCEL_EXTENSIONS,
  validateExcelFile,
  isZipHeader,
  isOleHeader,
  isEncryptedOlePackage,
};
