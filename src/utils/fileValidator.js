import fs from 'fs';
import path from 'path';

export const SUPPORTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xlsx', '.xls'];

/**
 * Validate a file path for security and compatibility.
 * @param {string} filePath - Absolute path to the file
 * @param {string[]} allowedExtensions - List of allowed extensions
 * @param {number} maxSize - Maximum file size in bytes
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateFile(filePath, allowedExtensions = SUPPORTED_EXTENSIONS, maxSize = 500 * 1024 * 1024) {
  // Check type
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { valid: false, error: 'Invalid file path' };
  }

  // Normalize and check for traversal
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    return { valid: false, error: 'Path traversal detected' };
  }

  // Check extension
  const ext = path.extname(normalized).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return { valid: false, error: `Unsupported file type: ${ext}. Supported: ${allowedExtensions.join(', ')}` };
  }

  // Check file exists and is readable
  try {
    fs.accessSync(normalized, fs.constants.R_OK);
  } catch {
    return { valid: false, error: 'File not found or not readable' };
  }

  // Check it's a file (not directory)
  try {
    const stats = fs.statSync(normalized);
    if (!stats.isFile()) {
      return { valid: false, error: 'Path is not a file' };
    }

    // Check file size
    if (stats.size === 0) {
      return { valid: false, error: 'File is empty (0 bytes)' };
    }

    if (stats.size > maxSize) {
      const sizeMB = Math.round(stats.size / (1024 * 1024));
      const maxMB = Math.round(maxSize / (1024 * 1024));
      return { valid: false, error: `File is too large (${sizeMB}MB). Maximum: ${maxMB}MB` };
    }
  } catch {
    return { valid: false, error: 'Cannot read file information' };
  }

  return { valid: true };
}

/**
 * Check if a file appears to be a valid PDF
 */
export function isPdfValid(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(5);
    fs.readSync(fd, buffer, 0, 5, 0);
    fs.closeSync(fd);
    return buffer.toString('ascii').startsWith('%PDF-');
  } catch {
    return false;
  }
}

/**
 * Check if a file appears to be a valid DOCX or XLSX (ZIP-based)
 */
export function isDocxValid(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    // ZIP magic bytes: PK\x03\x04
    return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
  } catch {
    return false;
  }
}

export const isXlsxValid = isDocxValid;

/**
 * Check if a file appears to be a valid DOC or legacy XLS (OLE compound)
 */
export function isDocValid(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8);
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);
    // OLE magic bytes: D0 CF 11 E0 A1 B1 1A E1
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
  } catch {
    return false;
  }
}

export const isXlsValid = isDocValid;

export default {
  validateFile,
  isPdfValid,
  isDocxValid,
  isDocValid,
  isXlsxValid,
  isXlsValid,
  SUPPORTED_EXTENSIONS,
};
