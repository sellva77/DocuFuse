import fs from 'fs';
import path from 'path';
import os from 'os';

const TEMP_PREFIX = 'docmerger-';
const activeTempDirs = new Set();

/**
 * Create a temporary directory for document processing
 * @returns {string} Path to the temp directory
 */
export function createTempDir() {
  const tempBase = os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, TEMP_PREFIX));
  activeTempDirs.add(tempDir);
  return tempDir;
}

/**
 * Clean up a specific temp directory, or all tracked temp directories
 * @param {string} [dirPath] - Optional specific directory to clean
 */
export function cleanupTempDir(dirPath) {
  if (dirPath) {
    safeRemoveDir(dirPath);
    activeTempDirs.delete(dirPath);
  } else {
    // Clean all tracked temp directories
    for (const dir of activeTempDirs) {
      safeRemoveDir(dir);
    }
    activeTempDirs.clear();
  }
}

/**
 * Safely remove a directory and all contents
 */
export function safeRemoveDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to clean up temp dir ${dirPath}:`, err.message);
  }
}

/**
 * Write data to a temp file
 * @param {string} tempDir - The temp directory
 * @param {string} filename - Name for the temp file
 * @param {Buffer|string} data - Data to write
 * @returns {string} Path to the temp file
 */
export function writeTempFile(tempDir, filename, data) {
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, data);
  return filePath;
}

export default {
  createTempDir,
  cleanupTempDir,
  writeTempFile,
};
