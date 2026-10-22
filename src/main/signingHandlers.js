import { ipcMain, dialog, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { validateFile, isPdfValid } from '../utils/fileValidator.js';
import { listProviders, discoverCertificates, signDocument, verifyDocument } from '../services/signing/signingService.js';

/**
 * Register narrowly-scoped IPC handlers for Digital Signing
 * 
 * @param {import('electron').BrowserWindow} getMainWindow - Function returning the main BrowserWindow
 */
export function registerSigningHandlers(getMainWindow) {
  // 1. Open PDF file dialog for signing
  ipcMain.handle('dialog:openPdfForSigning', async () => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select PDF Document to Sign',
      properties: ['openFile'],
      filters: [
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = path.normalize(result.filePaths[0]);
    if (filePath.includes('..')) {
      return { canceled: false, error: 'Invalid file path' };
    }

    const validation = validateFile(filePath, ['.pdf']);
    if (!validation.valid) {
      return { canceled: false, error: validation.error };
    }

    if (!isPdfValid(filePath)) {
      return { canceled: false, error: 'The selected file does not appear to be a valid PDF document' };
    }

    const stats = await fs.promises.stat(filePath);

    return {
      canceled: false,
      filePath,
      fileName: path.basename(filePath),
      fileSize: stats.size,
    };
  });

  // 1b. Open multi-file PDF dialog for batch signing
  ipcMain.handle('dialog:openPdfsForSigning', async () => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select PDF Documents to Sign',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const files = [];
    const errors = [];

    for (const fp of result.filePaths) {
      const filePath = path.normalize(fp);
      if (filePath.includes('..')) {
        errors.push({ path: fp, error: 'Invalid file path' });
        continue;
      }

      const validation = validateFile(filePath, ['.pdf']);
      if (!validation.valid) {
        errors.push({ path: fp, error: validation.error });
        continue;
      }

      if (!isPdfValid(filePath)) {
        errors.push({ path: fp, error: 'Not a valid PDF document' });
        continue;
      }

      try {
        const stats = await fs.promises.stat(filePath);
        files.push({
          filePath,
          fileName: path.basename(filePath),
          fileSize: stats.size,
        });
      } catch (err) {
        errors.push({ path: fp, error: err.message });
      }
    }

    return { canceled: false, files, errors };
  });

  // 1c. Folder picker for batch signing output
  ipcMain.handle('dialog:selectSigningOutputFolder', async () => {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Output Folder for Signed Documents',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('documents'),
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return {
      canceled: false,
      folderPath: path.normalize(result.filePaths[0]),
    };
  });

  // Read PDF bytes for interactive preview rendering in canvas
  ipcMain.handle('signing:readPdfBytes', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { success: false, error: 'File path required' };
    }
    const normalized = path.normalize(filePath);
    if (normalized.includes('..')) {
      return { success: false, error: 'Invalid file path' };
    }
    const validation = validateFile(normalized, ['.pdf']);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    try {
      const data = await fs.promises.readFile(normalized);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 2. Save dialog for signed output PDF
  ipcMain.handle('dialog:saveSignedPdf', async (_event, defaultName) => {
    const mainWindow = getMainWindow();
    const fileName = typeof defaultName === 'string' && defaultName.trim()
      ? defaultName
      : `Signed_Document_${new Date().toISOString().slice(0, 10)}.pdf`;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Digitally Signed Document',
      defaultPath: path.join(process.env.USERPROFILE || 'C:\\', 'Documents', fileName),
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
    });

    return {
      canceled: result.canceled,
      filePath: result.filePath ? path.normalize(result.filePath) : null,
    };
  });

  // 3. Get supported certificate providers
  ipcMain.handle('signing:getProviders', async () => {
    try {
      const providers = await listProviders();
      return { success: true, providers };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 4. Discover certificates for a provider
  ipcMain.handle('signing:discoverCertificates', async (_event, providerId) => {
    try {
      const certificates = await discoverCertificates(providerId || 'windows-store');
      
      const tokenDrive = certificates.connectedTokenDrive || null;

      // Ensure only necessary, sanitized information is transmitted to the renderer
      const sanitized = certificates.map(c => ({
        id: c.id,
        alias: c.alias,
        subject: c.subject,
        subjectCommonName: c.subjectCommonName,
        issuer: c.issuer,
        issuerCommonName: c.issuerCommonName,
        serialNumber: c.serialNumber,
        validFrom: c.validFrom,
        validTo: c.validTo,
        hasPrivateKey: c.hasPrivateKey,
        isExpired: c.isExpired,
        notYetValid: c.notYetValid,
        isEligibleForSigning: c.isEligibleForSigning,
        isSystemCert: Boolean(c.isSystemCert),
        keyAlgorithm: c.keyAlgorithm,
        keySize: c.keySize,
        thumbprint: c.thumbprint,
        isHardwareToken: Boolean(c.isHardwareToken),
        isTestCertificate: Boolean(c.isTestCertificate),
        providerId: c.providerId,
      }));

      return { success: true, certificates: sanitized, connectedTokenDrive: tokenDrive };
    } catch (err) {
      console.error('Certificate discovery error:', err);
      return { success: false, error: err.message || 'Failed to discover certificates' };
    }
  });

  // 5. Sign PDF document
  ipcMain.handle('signing:signDocument', async (_event, options) => {
    try {
      const mainWindow = getMainWindow();
      const sendProgress = (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('signing:progress', progress);
        }
      };

      const result = await signDocument({
        ...options,
        onProgress: sendProgress,
      });

      return result;
    } catch (err) {
      console.error('PDF signing error:', err);
      return {
        success: false,
        error: err.message || 'An unexpected error occurred during PDF digital signing',
      };
    }
  });

  // 6. Verify an existing PDF signature
  ipcMain.handle('signing:verifyDocument', async (_event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: 'File path is required' };
      }
      const normalized = path.normalize(filePath);
      if (normalized.includes('..')) {
        return { success: false, error: 'Invalid file path' };
      }

      const report = await verifyDocument(normalized);
      return { success: true, report };
    } catch (err) {
      console.error('PDF verification error:', err);
      return {
        success: false,
        error: err.message || 'Failed to verify PDF document signature',
      };
    }
  });

  // 7. Batch sign multiple PDF documents
  ipcMain.handle('signing:signDocumentBatch', async (_event, options) => {
    const {
      files,         // Array of file paths
      outputFolder,  // Destination folder
      providerId,
      certificateId,
      certificateInfo,
      reason,
      location,
      contactInfo,
      visibleSignature,
      appearance,
      fileAppearances,
    } = options;

    if (!Array.isArray(files) || files.length === 0) {
      return { success: false, error: 'No files provided for batch signing' };
    }
    if (!outputFolder || typeof outputFolder !== 'string') {
      return { success: false, error: 'Output folder is required' };
    }

    // Validate output folder is writable
    try {
      await fs.promises.access(path.normalize(outputFolder), fs.constants.W_OK);
    } catch {
      return { success: false, error: `Cannot write to output folder: ${outputFolder}` };
    }

    const mainWindow = getMainWindow();
    const sendBatchProgress = (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('signing:batchProgress', progress);
      }
    };

    const results = [];
    const totalFiles = files.length;

    for (let i = 0; i < totalFiles; i++) {
      const inputPath = files[i];
      const fileName = path.basename(inputPath);
      const baseName = fileName.replace(/\.pdf$/i, '');
      const outputPath = path.join(path.normalize(outputFolder), `${baseName}_signed.pdf`);

      sendBatchProgress({
        currentFile: fileName,
        currentIndex: i,
        totalFiles,
        percent: Math.round((i / totalFiles) * 100),
        step: 'Signing',
        detail: `Signing ${i + 1} of ${totalFiles}: ${fileName}...`,
      });

      const docAppearance = (fileAppearances && fileAppearances[inputPath])
        ? fileAppearances[inputPath]
        : appearance;

      try {
        const result = await signDocument({
          inputPath,
          outputPath,
          providerId,
          certificateId,
          certificateInfo,
          reason,
          location,
          contactInfo,
          visibleSignature,
          appearance: docAppearance,
          onProgress: (p) => {
            sendBatchProgress({
              currentFile: fileName,
              currentIndex: i,
              totalFiles,
              percent: Math.round(((i + (p.percent || 0) / 100) / totalFiles) * 100),
              step: p.step,
              detail: `(${i + 1}/${totalFiles}) ${fileName}: ${p.detail}`,
            });
          },
        });

        results.push({
          fileName,
          inputPath,
          outputPath: result.outputPath,
          success: true,
          outputSize: result.outputSize,
        });
      } catch (err) {
        console.error(`Batch signing error for ${fileName}:`, err);
        results.push({
          fileName,
          inputPath,
          outputPath,
          success: false,
          error: err.message || 'Signing failed',
        });
      }
    }

    sendBatchProgress({
      currentFile: null,
      currentIndex: totalFiles,
      totalFiles,
      percent: 100,
      step: 'Complete',
      detail: 'Batch signing complete!',
    });

    const successCount = results.filter(r => r.success).length;

    return {
      success: successCount > 0,
      totalFiles,
      successCount,
      failCount: totalFiles - successCount,
      results,
    };
  });
}

export default {
  registerSigningHandlers,
};
