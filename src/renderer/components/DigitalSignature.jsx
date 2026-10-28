import React, { useState, useEffect, useCallback } from 'react';
import { Icons } from './Icons';
import PdfSignatureCanvas from './PdfSignatureCanvas';
import SignatureAppearanceModal, { DEFAULT_APPEARANCE_CONFIG } from './SignatureAppearanceModal';

/**
 * DigitalSignature Component
 * 
 * Secure, standards-based PDF cryptographic signing using USB DSC tokens
 * (via Windows Certificate Store) or dedicated test certificates.
 */
export default function DigitalSignature({ onNotification }) {
  // Mode: 'sign' | 'verify'
  const [mode, setMode] = useState('sign');

  // Selected PDFs state (multi-file)
  const [selectedPdfs, setSelectedPdfs] = useState([]); // Array of { filePath, fileName, fileSize }
  const [previewFileIndex, setPreviewFileIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Providers & Certificates state
  const [providers, setProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('windows-store');
  const [certificates, setCertificates] = useState([]);
  const [selectedCertId, setSelectedCertId] = useState(null);
  const [isLoadingCerts, setIsLoadingCerts] = useState(false);
  const [certDiscoveryError, setCertDiscoveryError] = useState(null);
  const [connectedTokenDrive, setConnectedTokenDrive] = useState(null);

  // Signing metadata state
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [visibleSignature, setVisibleSignature] = useState(true);
  const [signaturePlacement, setSignaturePlacement] = useState(null); // { page, normX, normY, normWidth, normHeight } (shared)
  const [filePlacements, setFilePlacements] = useState({}); // { [filePath]: { page, normX, normY, normWidth, normHeight } }
  const [stampPage, setStampPage] = useState('last');

  // Adobe Acrobat-style custom signature appearance state
  const [showAppearanceModal, setShowAppearanceModal] = useState(false);
  const [customAppearance, setCustomAppearance] = useState(() => {
    try {
      const saved = localStorage.getItem('docufuse_active_sig_appearance');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.textSignature === 'Authorized Signer') {
          parsed.textSignature = '';
        }
        return parsed;
      }
    } catch (_) {}
    return DEFAULT_APPEARANCE_CONFIG;
  });

  const handleSaveAppearance = useCallback((newConfig) => {
    setCustomAppearance(newConfig);
    try {
      localStorage.setItem('docufuse_active_sig_appearance', JSON.stringify(newConfig));
    } catch (_) {}
    onNotification?.({
      type: 'success',
      title: 'Signature Appearance Updated',
      message: `Preset "${newConfig.presetName || 'Custom'}" is active.`,
      duration: 4000,
    });
  }, [onNotification]);

  // Execution state
  const [isSigning, setIsSigning] = useState(false);
  const [signingProgress, setSigningProgress] = useState(null);
  const [signResult, setSignResult] = useState(null);

  // Batch signing state
  const [batchProgress, setBatchProgress] = useState(null); // { currentFile, currentIndex, totalFiles, percent }
  const [batchResults, setBatchResults] = useState(null); // { totalFiles, successCount, failCount, results: [...] }

  // Verification-only state
  const [verifyFilePath, setVerifyFilePath] = useState(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState(null);
  const [isVerifyDragging, setIsVerifyDragging] = useState(false);

  // 1. Initial Load: Get providers and discover initial certificates
  useEffect(() => {
    if (!window.electronAPI) return;

    // Load available providers
    window.electronAPI.getSigningProviders().then(res => {
      if (res?.success && res.providers) {
        setProviders(res.providers);
      }
    }).catch(() => {});

    // Listen for signing progress
    const unsubProgress = window.electronAPI.onSigningProgress((p) => {
      setSigningProgress(p);
    });

    // Listen for batch signing progress
    const unsubBatchProgress = window.electronAPI.onSigningBatchProgress((p) => {
      setBatchProgress(p);
    });

    return () => {
      if (unsubProgress) unsubProgress();
      if (unsubBatchProgress) unsubBatchProgress();
    };
  }, []);

  // Discover certificates whenever provider changes
  const loadCertificates = useCallback(async (providerId) => {
    if (!window.electronAPI) return;
    setIsLoadingCerts(true);
    setCertDiscoveryError(null);
    setCertificates([]);
    setSelectedCertId(null);
    setConnectedTokenDrive(null);

    try {
      const res = await window.electronAPI.discoverCertificates(providerId);
      if (res.success) {
        const certs = res.certificates || [];
        setCertificates(certs);
        setConnectedTokenDrive(res.connectedTokenDrive || null);
        // Auto-select first eligible certificate (skip system certs)
        const firstEligible = certs.find(c => c.isEligibleForSigning);
        if (firstEligible) {
          setSelectedCertId(firstEligible.id || firstEligible.alias);
        } else if (certs.length > 0 && !certs[0].isSystemCert) {
          setSelectedCertId(certs[0].id || certs[0].alias);
        } else {
          setSelectedCertId(null);
        }
      } else {
        setCertDiscoveryError(res.error || 'Failed to discover certificates from provider');
      }
    } catch (err) {
      setCertDiscoveryError(err.message || 'Error communicating with certificate provider');
    } finally {
      setIsLoadingCerts(false);
    }
  }, []);

  useEffect(() => {
    loadCertificates(selectedProviderId);
  }, [selectedProviderId, loadCertificates]);

  // 2. File Selection Handlers (multi-file)
  const handleSelectPdfs = useCallback(async () => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openPdfsForSigningDialog();
    if (res.canceled) return;
    if (res.errors && res.errors.length > 0) {
      onNotification?.({
        type: 'warning',
        title: 'Some Files Skipped',
        message: `${res.errors.length} file(s) were invalid and skipped.`,
        duration: 6000,
      });
    }
    if (res.files && res.files.length > 0) {
      setSelectedPdfs(prev => {
        // Merge with existing, avoiding duplicates by filePath
        const existingPaths = new Set(prev.map(f => f.filePath));
        const newFiles = res.files.filter(f => !existingPaths.has(f.filePath));
        return [...prev, ...newFiles];
      });
      setSignResult(null);
      setBatchResults(null);
      setSignaturePlacement(null);
    }
  }, [onNotification]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (!window.electronAPI) return;

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const pdfFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfFiles.length === 0) {
      onNotification?.({
        type: 'warning',
        title: 'Invalid File',
        message: 'Please drop valid .pdf files for digital signing.',
        duration: 5000,
      });
      return;
    }

    // Validate paths
    const validationRes = await window.electronAPI.validateFiles(pdfFiles.map(f => f.path));
    if (validationRes.files && validationRes.files.length > 0) {
      const newFiles = validationRes.files.map(f => ({
        filePath: f.path,
        fileName: f.name,
        fileSize: f.size,
      }));
      setSelectedPdfs(prev => {
        const existingPaths = new Set(prev.map(p => p.filePath));
        const deduped = newFiles.filter(f => !existingPaths.has(f.filePath));
        return [...prev, ...deduped];
      });
      setSignResult(null);
      setBatchResults(null);
    }
    if (validationRes.errors && validationRes.errors.length > 0) {
      onNotification?.({
        type: 'warning',
        title: 'Some Files Skipped',
        message: `${validationRes.errors.length} file(s) could not be validated.`,
        duration: 6000,
      });
    }
  };

  const handleRemovePdf = (index) => {
    const removed = selectedPdfs[index];
    setSelectedPdfs(prev => {
      const updated = prev.filter((_, i) => i !== index);
      if (updated.length === 0) {
        setSignaturePlacement(null);
        setFilePlacements({});
      }
      return updated;
    });
    if (removed) {
      setFilePlacements(prev => {
        const next = { ...prev };
        delete next[removed.filePath];
        return next;
      });
    }
    setPreviewFileIndex(prev => {
      if (prev >= index) {
        return Math.max(0, prev - 1);
      }
      return prev;
    });
  };

  const handleClearAllPdfs = () => {
    setSelectedPdfs([]);
    setPreviewFileIndex(0);
    setSignResult(null);
    setBatchResults(null);
    setSignaturePlacement(null);
    setFilePlacements({});
  };

  // Active preview PDF calculation (defaults to first file, switches when user clicks a file)
  const activePreviewIndex = Math.min(previewFileIndex, Math.max(0, selectedPdfs.length - 1));
  const currentPreviewPdf = selectedPdfs[activePreviewIndex] || null;

  // Active placement for the file currently being previewed
  const activeFilePlacement = (currentPreviewPdf && filePlacements[currentPreviewPdf.filePath])
    ? filePlacements[currentPreviewPdf.filePath]
    : signaturePlacement;

  // Has at least one valid placement configured
  const hasValidPlacement = Boolean(
    signaturePlacement || Object.keys(filePlacements).length > 0
  );

  // Handle placement change from canvas (edits current document independently)
  const handlePlacementChange = useCallback((newPlacement) => {
    if (!currentPreviewPdf) return;

    // Update placement for the current document
    setFilePlacements(prev => ({
      ...prev,
      [currentPreviewPdf.filePath]: newPlacement,
    }));

    // If this is the initial placement (no other file has a placement yet),
    // set as baseline so all files start with this position
    if (!signaturePlacement) {
      setSignaturePlacement(newPlacement);
      setFilePlacements(prev => {
        const next = { ...prev };
        for (const pdf of selectedPdfs) {
          if (!next[pdf.filePath]) {
            next[pdf.filePath] = newPlacement;
          }
        }
        return next;
      });
    }
  }, [currentPreviewPdf, selectedPdfs, signaturePlacement]);

  // Deliberately apply current file's placement to all files
  const handleApplyCurrentToAll = useCallback(() => {
    if (!currentPreviewPdf || !activeFilePlacement) return;
    setSignaturePlacement(activeFilePlacement);
    setFilePlacements(prev => {
      const next = { ...prev };
      for (const pdf of selectedPdfs) {
        next[pdf.filePath] = activeFilePlacement;
      }
      return next;
    });
    onNotification?.({
      type: 'success',
      title: 'Position Applied to All Documents',
      message: `Signature position from "${currentPreviewPdf.fileName}" (Page ${activeFilePlacement.page}) applied to all ${selectedPdfs.length} documents.`,
      duration: 4000,
    });
  }, [currentPreviewPdf, activeFilePlacement, selectedPdfs, onNotification]);

  // 3. Digital Signing Execution (supports single and batch)
  const handleSign = useCallback(async () => {
    if (!window.electronAPI || selectedPdfs.length === 0 || !selectedCertId) return;

    const chosenCert = certificates.find(c => c.id === selectedCertId || c.alias === selectedCertId);
    if (!chosenCert) {
      onNotification?.({
        type: 'warning',
        title: 'Certificate Required',
        message: 'Please select a signing certificate.',
        duration: 5000,
      });
      return;
    }

    const isBatch = selectedPdfs.length > 1;

    // Resolve signer name considering all possibilities (DSC certificate CN, custom, none)
    const certCommonName = chosenCert.subjectCommonName || '';
    const certSubject = chosenCert.subject || '';
    const parsedCn = certSubject.match(/CN=([^,]+)/i)?.[1]?.trim() || '';
    const certSignerName = certCommonName || parsedCn || certSubject || '';

    const signerSource = customAppearance?.customFields?.signerNameSource || 'certificate';
    let effectiveSignerName = '';
    if (signerSource === 'none') {
      effectiveSignerName = '';
    } else if (signerSource === 'custom') {
      effectiveSignerName = customAppearance?.customFields?.signerName || certSignerName || '';
    } else {
      effectiveSignerName = certSignerName || customAppearance?.customFields?.signerName || '';
    }

    // Per-file appearance mapping
    const fileAppearances = {};
    for (const pdf of selectedPdfs) {
      const p = filePlacements[pdf.filePath] || signaturePlacement;
      if (visibleSignature && p) {
        fileAppearances[pdf.filePath] = {
          normX: p.normX,
          normY: p.normY,
          normWidth: p.normWidth,
          normHeight: p.normHeight,
          page: p.page,
          signerName: effectiveSignerName,
          customAppearance,
        };
      } else {
        fileAppearances[pdf.filePath] = {
          page: stampPage,
          signerName: effectiveSignerName,
          customAppearance,
        };
      }
    }

    const effectiveReason = customAppearance?.customFields?.reason !== undefined ? customAppearance.customFields.reason : reason;
    const effectiveLocation = customAppearance?.customFields?.location !== undefined ? customAppearance.customFields.location : location;

    const commonAppearance = visibleSignature && activeFilePlacement ? {
      normX: activeFilePlacement.normX,
      normY: activeFilePlacement.normY,
      normWidth: activeFilePlacement.normWidth,
      normHeight: activeFilePlacement.normHeight,
      page: activeFilePlacement.page,
      signerName: effectiveSignerName,
      customAppearance,
    } : {
      page: stampPage,
      signerName: effectiveSignerName,
      customAppearance,
    };

    const certInfoPayload = {
      id: chosenCert.id,
      alias: chosenCert.alias,
      subject: chosenCert.subject,
      subjectCommonName: chosenCert.subjectCommonName,
      issuer: chosenCert.issuer,
      issuerCommonName: chosenCert.issuerCommonName,
      serialNumber: chosenCert.serialNumber,
      validFrom: chosenCert.validFrom,
      validTo: chosenCert.validTo,
      hasPrivateKey: chosenCert.hasPrivateKey,
      isExpired: chosenCert.isExpired,
      notYetValid: chosenCert.notYetValid,
      isEligibleForSigning: chosenCert.isEligibleForSigning,
      isSystemCert: chosenCert.isSystemCert,
      keyAlgorithm: chosenCert.keyAlgorithm,
      keySize: chosenCert.keySize,
      thumbprint: chosenCert.thumbprint,
      certDerBase64: chosenCert.certDerBase64,
      isHardwareToken: chosenCert.isHardwareToken,
      isTestCertificate: chosenCert.isTestCertificate,
      providerId: chosenCert.providerId,
    };

    if (isBatch) {
      // --- Batch Signing Flow ---
      const folderRes = await window.electronAPI.selectSigningOutputFolderDialog();
      if (folderRes.canceled || !folderRes.folderPath) return;

      setIsSigning(true);
      setBatchProgress({ currentFile: null, currentIndex: 0, totalFiles: selectedPdfs.length, percent: 0, step: 'Initializing', detail: 'Preparing batch signing...' });
      setBatchResults(null);

      try {
        const result = await window.electronAPI.signPdfDocumentBatch({
          files: selectedPdfs.map(f => f.filePath),
          outputFolder: folderRes.folderPath,
          providerId: selectedProviderId,
          certificateId: selectedCertId,
          certificateInfo: certInfoPayload,
          reason: effectiveReason,
          location: effectiveLocation,
          contactInfo,
          visibleSignature,
          appearance: commonAppearance,
          fileAppearances,
        });

        setIsSigning(false);
        setBatchProgress(null);

        if (result.success !== undefined) {
          setBatchResults(result);
          if (result.successCount === result.totalFiles) {
            onNotification?.({
              type: 'success',
              title: 'All Documents Signed!',
              message: `Successfully signed ${result.successCount} of ${result.totalFiles} documents.`,
              duration: 12000,
            });
          } else if (result.successCount > 0) {
            onNotification?.({
              type: 'warning',
              title: 'Batch Signing Partially Complete',
              message: `${result.successCount} of ${result.totalFiles} documents signed. ${result.failCount} failed.`,
              duration: 12000,
            });
          } else {
            onNotification?.({
              type: 'error',
              title: 'Batch Signing Failed',
              message: 'All documents failed to sign. Check the results below for details.',
              duration: 10000,
            });
          }
        }
      } catch (err) {
        setIsSigning(false);
        setBatchProgress(null);
        onNotification?.({
          type: 'error',
          title: 'Batch Signing Error',
          message: err.message || 'An error occurred during batch signing',
          duration: 10000,
        });
      }
    } else {
      // --- Single File Signing Flow (original behavior) ---
      const singlePdf = selectedPdfs[0];
      const baseName = singlePdf.fileName.replace(/\.pdf$/i, '');
      const defaultOutputName = `${baseName}_signed.pdf`;

      const saveResult = await window.electronAPI.saveSignedPdfDialog(defaultOutputName);
      if (saveResult.canceled || !saveResult.filePath) return;

      setIsSigning(true);
      setSigningProgress({ step: 'Initializing', detail: 'Preparing cryptographic signature...', percent: 5 });

      try {
        const result = await window.electronAPI.signPdfDocument({
          inputPath: singlePdf.filePath,
          outputPath: saveResult.filePath,
          providerId: selectedProviderId,
          certificateId: selectedCertId,
          certificateInfo: certInfoPayload,
          reason: effectiveReason,
          location: effectiveLocation,
          contactInfo,
          visibleSignature,
          appearance: commonAppearance,
        });

        setIsSigning(false);
        setSigningProgress(null);

        if (result.success) {
          setSignResult(result);
          onNotification?.({
            type: 'success',
            title: 'Document Signed Successfully!',
            message: `Saved to: ${result.outputPath}`,
            outputPath: result.outputPath,
            duration: 12000,
          });
        } else {
          onNotification?.({
            type: 'error',
            title: 'Signing Failed',
            message: result.error || 'An unexpected error occurred during digital signing',
            duration: 10000,
          });
        }
      } catch (err) {
        setIsSigning(false);
        setSigningProgress(null);
        onNotification?.({
          type: 'error',
          title: 'Signing Error',
          message: err.message || 'An error occurred while communicating with the signing service',
          duration: 10000,
        });
      }
    }
  }, [selectedPdfs, selectedCertId, certificates, selectedProviderId, reason, location, contactInfo, visibleSignature, signaturePlacement, stampPage, onNotification]);

  // 4. Verify Existing PDF
  const handleVerifyPath = useCallback(async (filePath) => {
    if (!window.electronAPI || !filePath) return;
    setVerifyFilePath(filePath);
    setIsVerifying(true);
    setVerifyReport(null);

    try {
      const result = await window.electronAPI.verifyPdfDocument(filePath);
      setIsVerifying(false);
      if (result.success) {
        setVerifyReport(result.report);
      } else {
        onNotification?.({
          type: 'error',
          title: 'Verification Error',
          message: result.error || 'Failed to verify PDF',
          duration: 8000,
        });
      }
    } catch (err) {
      setIsVerifying(false);
      onNotification?.({
        type: 'error',
        title: 'Verification Error',
        message: err.message,
        duration: 8000,
      });
    }
  }, [onNotification]);

  const handleSelectPdfToVerify = useCallback(async () => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openPdfForSigningDialog();
    if (res.canceled) return;
    if (res.error) {
      onNotification?.({ type: 'error', title: 'File Error', message: res.error, duration: 6000 });
      return;
    }
    handleVerifyPath(res.filePath);
  }, [handleVerifyPath, onNotification]);

  const handleVerifyDrop = useCallback(async (e) => {
    e.preventDefault();
    setIsVerifyDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    const pdfFile = files.find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfFile) {
      onNotification?.({
        type: 'warning',
        title: 'Invalid File',
        message: 'Please drop a valid .pdf file to verify.',
        duration: 5000,
      });
      return;
    }
    handleVerifyPath(pdfFile.path);
  }, [handleVerifyPath, onNotification]);

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const eligibleCerts = certificates.filter(c => c.isEligibleForSigning && !c.isSystemCert);
  const selectedCert = eligibleCerts.find(c => c.id === selectedCertId || c.alias === selectedCertId) || eligibleCerts[0] || null;

  // Auto-sync selectedCertId if not set
  useEffect(() => {
    if (selectedCert && (!selectedCertId || !eligibleCerts.some(c => (c.id || c.alias) === selectedCertId))) {
      setSelectedCertId(selectedCert.id || selectedCert.alias);
    }
  }, [selectedCert, selectedCertId, eligibleCerts]);

  return (
    <div className="digital-signature-panel" id="digital-signature-panel">
      {/* Sub-navigation tabs: Sign Document vs Verify Signature */}
      <div className="sig-sub-tabs">
        <button
          className={`sig-sub-tab ${mode === 'sign' ? 'active' : ''}`}
          onClick={() => setMode('sign')}
          id="btn-subtab-sign"
        >
          <Icons.Signature />
          Sign PDF Document
        </button>
        <button
          className={`sig-sub-tab ${mode === 'verify' ? 'active' : ''}`}
          onClick={() => setMode('verify')}
          id="btn-subtab-verify"
        >
          <Icons.ShieldCheck />
          Verify Existing Signed PDF
        </button>
      </div>

      {mode === 'sign' ? (
        <div className="sig-workspace simplified">
          {/* TOP SECTION: Document (Step 1) & DSC Certificate (Step 2) */}
          <div className="sig-top-grid">
            {/* STEP 1: Select PDF Documents */}
            <section className="sig-card sig-step-doc">
              <div className="sig-card-header compact">
                <span className="sig-step-badge">1</span>
                <div className="sig-header-title-row">
                  <div>
                    <h3>Select PDF Documents</h3>
                    <p>
                      Choose one or more PDFs to sign
                      {selectedPdfs.length > 0 && (
                        <span className="sig-file-count-badge">
                          {selectedPdfs.length} {selectedPdfs.length !== 1 ? 'files' : 'file'}
                        </span>
                      )}
                    </p>
                  </div>
                  {selectedPdfs.length > 0 && (
                    <div className="sig-file-list-actions">
                      <button
                        type="button"
                        className="btn-sig-header-action btn-add-more"
                        onClick={handleSelectPdfs}
                        title="Add more PDFs"
                        id="btn-add-more-pdfs"
                      >
                        <Icons.FolderOpen />
                        <span>Add More</span>
                      </button>
                      <button
                        type="button"
                        className="btn-sig-header-action btn-clear-all"
                        onClick={handleClearAllPdfs}
                        title="Clear all PDFs"
                        id="btn-clear-all-pdfs"
                      >
                        <Icons.X />
                        <span>Clear All</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {selectedPdfs.length === 0 ? (
                <div
                  className={`sig-dropzone compact ${isDragging ? 'dragging' : ''}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={handleSelectPdfs}
                  id="sig-dropzone"
                >
                  <div className="sig-dropzone-icon">
                    <Icons.PDF />
                  </div>
                  <div className="sig-dropzone-text">
                    <strong>Click to select PDFs</strong> or drag & drop here
                  </div>
                  <button type="button" className="btn-browse" id="btn-browse-sig-pdf">
                    <Icons.FolderOpen />
                    Browse PDFs
                  </button>
                </div>
              ) : (
                <div
                  className={`sig-file-list ${isDragging ? 'dragging' : ''}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  id="sig-file-list"
                >
                  {selectedPdfs.map((pdf, index) => {
                    const isPreviewing = index === activePreviewIndex;
                    const pdfPlacement = filePlacements[pdf.filePath] || signaturePlacement;
                    return (
                      <div
                        className={`sig-file-list-item ${isPreviewing ? 'active-preview' : ''}`}
                        key={pdf.filePath}
                        id={`sig-file-item-${index}`}
                        onClick={() => setPreviewFileIndex(index)}
                        role="button"
                        tabIndex={0}
                        title={`Click to preview signature position on ${pdf.fileName}`}
                      >
                        <div className="sig-file-icon small">
                          <Icons.PDF />
                        </div>
                        <div className="sig-file-details">
                          <span className="sig-file-name" title={pdf.filePath}>
                            {isPreviewing && selectedPdfs.length > 1 && (
                              <span className="sig-preview-tag active">Preview</span>
                            )}
                            {pdf.fileName}
                          </span>
                          <span className="sig-file-meta">
                            {formatFileSize(pdf.fileSize)}
                            {pdfPlacement && (
                              <span className="sig-file-pos-tag" title={`Signature set on Page ${pdfPlacement.page}`}>
                                • Page {pdfPlacement.page}
                              </span>
                            )}
                            {selectedPdfs.length > 1 && !isPreviewing && (
                              <span className="sig-file-click-hint">Click to preview</span>
                            )}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn-sig-icon btn-danger btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemovePdf(index);
                          }}
                          title="Remove this PDF"
                        >
                          <Icons.X />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* STEP 2: USB DSC Certificate */}
            <section className="sig-card sig-step-cert">
              <div className="sig-card-header compact">
                <span className="sig-step-badge">2</span>
                <div className="sig-header-title-row">
                  <div>
                    <h3>USB DSC Certificate</h3>
                    <p>Hardware certificate from your USB token</p>
                  </div>
                  <div className="sig-provider-selector-wrap">
                    <select
                      id="sig-provider-select"
                      value={selectedProviderId}
                      onChange={(e) => setSelectedProviderId(e.target.value)}
                      className="sig-select compact"
                      title="Signing Provider"
                    >
                      {providers.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn-sig-refresh"
                      onClick={() => loadCertificates(selectedProviderId)}
                      disabled={isLoadingCerts}
                      title="Refresh certificates"
                      id="btn-refresh-certs"
                    >
                      <Icons.Refresh />
                      {isLoadingCerts ? '...' : 'Refresh'}
                    </button>
                  </div>
                </div>
              </div>

              {isLoadingCerts ? (
                <div className="sig-loading-certs compact">
                  <div className="sig-spinner" />
                  <p>Querying certificate store...</p>
                </div>
              ) : certDiscoveryError ? (
                <div className="sig-error-box compact">
                  <Icons.AlertCircle />
                  <div>{certDiscoveryError}</div>
                </div>
              ) : selectedCert ? (
                <div className="sig-cert-card selected active-card" id={`cert-item-${selectedCert.id || selectedCert.alias}`}>
                  <div className="sig-cert-info">
                    <div className="sig-cert-title-row">
                      <span className="sig-cert-name">
                        {selectedCert.subjectCommonName || selectedCert.subject}
                      </span>
                      <div className="sig-cert-badges">
                        {selectedCert.isHardwareToken && (
                          <span className="sig-badge hardware">
                            <Icons.Usb /> Hardware DSC
                          </span>
                        )}
                        {selectedCert.isTestCertificate && (
                          <span className="sig-badge test">Test Certificate</span>
                        )}
                        <span className="sig-badge valid">Ready to Sign</span>
                      </div>
                    </div>
                    <div className="sig-cert-meta-grid">
                      <div>
                        <span className="meta-label">Issuer:</span>
                        <span className="meta-value">{selectedCert.issuerCommonName || selectedCert.issuer}</span>
                      </div>
                      <div>
                        <span className="meta-label">Valid Until:</span>
                        <span className="meta-value">{selectedCert.validTo?.slice(0, 10)}</span>
                      </div>
                      <div>
                        <span className="meta-label">Algorithm:</span>
                        <span className="meta-value">{selectedCert.keyAlgorithm} {selectedCert.keySize ? `(${selectedCert.keySize}-bit)` : ''}</span>
                      </div>
                    </div>

                    {/* If multiple eligible certs exist, let user select */}
                    {eligibleCerts.length > 1 && (
                      <div className="sig-cert-switch-row" style={{ marginTop: '8px' }}>
                        <label style={{ fontSize: '11px', color: '#94a3b8', marginRight: '6px' }}>Select Certificate:</label>
                        <select
                          className="sig-select"
                          value={selectedCertId || ''}
                          onChange={(e) => setSelectedCertId(e.target.value)}
                        >
                          {eligibleCerts.map(c => (
                            <option key={c.id || c.alias} value={c.id || c.alias}>
                              {c.subjectCommonName || c.subject} ({c.issuerCommonName || c.issuer})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="sig-empty-certs compact">
                  <Icons.Usb />
                  {connectedTokenDrive?.found ? (
                    <div>
                      <h4 style={{ color: '#c7d2fe', marginBottom: '4px' }}>HyperPKI HYP2003 Hardware Token Plugged In</h4>
                      <p style={{ fontSize: '11px', lineHeight: 1.4, margin: '4px 0 8px 0', color: '#94a3b8' }}>
                        Token detected on Drive {connectedTokenDrive.drive}, but its driver is not installed on Windows.
                        Windows cannot access certificates on the token until the HyperPKI middleware is installed.
                      </p>
                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap', marginTop: '6px' }}>
                        <button
                          type="button"
                          className="btn-token-action primary"
                          style={{ padding: '5px 10px', fontSize: '11px' }}
                          onClick={async () => {
                            if (window.electronAPI?.openPath) {
                              const res = await window.electronAPI.openPath(connectedTokenDrive.setupFilePath);
                              if (res && res.error) {
                                window.electronAPI.showItemInFolder(connectedTokenDrive.setupFilePath);
                              }
                            } else {
                              window.electronAPI?.showItemInFolder(connectedTokenDrive.setupFilePath);
                            }
                          }}
                        >
                          <Icons.ShieldCheck /> Run D:\HyperPKI_HYP2003_Setup.exe
                        </button>
                        <button
                          type="button"
                          className="btn-token-action secondary"
                          style={{ padding: '5px 10px', fontSize: '11px' }}
                          onClick={() => window.electronAPI?.showItemInFolder(connectedTokenDrive.setupFilePath || connectedTokenDrive.drive)}
                        >
                          <Icons.FolderOpen /> Open Drive {connectedTokenDrive.drive}
                        </button>
                        <button
                          type="button"
                          className="btn-token-action secondary"
                          style={{ padding: '5px 10px', fontSize: '11px' }}
                          onClick={() => loadCertificates(selectedProviderId)}
                        >
                          <Icons.Refresh /> Refresh
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <h4>No Document-Signing Certificate Found</h4>
                      <p>
                        Please connect your USB DSC token and verify its software is running.
                      </p>
                      <button
                        type="button"
                        className="btn-sig-refresh"
                        onClick={() => loadCertificates(selectedProviderId)}
                        style={{ marginTop: '4px' }}
                      >
                        <Icons.Refresh /> Refresh Store
                      </button>
                    </div>
                  )}

                  {selectedProviderId !== 'software-test' && (
                    <div style={{ marginTop: '10px', fontSize: '11px', color: '#94a3b8' }}>
                      Testing without physical token?{' '}
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', color: '#818cf8', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
                        onClick={() => setSelectedProviderId('software-test')}
                      >
                        Switch to Software Test Certificate
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>

          {/* STEP 3: Signature Placement & Options (Adobe Acrobat style) */}
          <section className="sig-card sig-step-placement">
            <div className="sig-card-header compact">
              <span className="sig-step-badge">3</span>
              <div className="sig-header-title-row">
                <div>
                  <h3>Signature Placement</h3>
                  <p>Adobe Acrobat style: click and drag on the page to place your signature area</p>
                </div>
                <div className="sig-options-inline">
                  <label className="sig-checkbox-label">
                    <input
                      type="checkbox"
                      checked={visibleSignature}
                      onChange={(e) => setVisibleSignature(e.target.checked)}
                      id="chk-visible-sig"
                    />
                    <span>Visible signature badge on document</span>
                  </label>
                  {visibleSignature && (
                    <button
                      type="button"
                      className="btn-open-customize-appearance"
                      onClick={() => setShowAppearanceModal(true)}
                      title="Customize Adobe Acrobat-style signature appearance (Text, Draw, Image, Fields)"
                      id="btn-open-customize-appearance"
                    >
                      <Icons.Palette />
                      <span>Customize Appearance</span>
                      {customAppearance?.graphicType && customAppearance.graphicType !== 'none' && (
                        <span className="sig-graphic-type-tag">{customAppearance.graphicType}</span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {visibleSignature ? (
              <div className="sig-placement-workspace">
                {currentPreviewPdf ? (
                  <>
                    {selectedPdfs.length > 1 && (
                      <div className="sig-preview-doc-banner">
                        <div className="sig-preview-doc-info">
                          <span className="sig-preview-banner-badge">Previewing File {activePreviewIndex + 1} of {selectedPdfs.length}</span>
                          <span className="sig-preview-banner-name" title={currentPreviewPdf.fileName}>{currentPreviewPdf.fileName}</span>
                        </div>

                        {/* Intentional "Apply to All" button & Right-Click Tip */}
                        <div className="sig-scope-controls">
                          <span className="sig-scope-hint">
                            Right-click signature box or click:
                          </span>
                          <button
                            type="button"
                            className="btn-apply-all-intentional"
                            onClick={handleApplyCurrentToAll}
                            disabled={!activeFilePlacement}
                            title="Deliberately copy this signature position to all documents"
                            id="btn-apply-all-intentional"
                          >
                            <Icons.Layers />
                            <span>Apply to All Documents</span>
                          </button>
                        </div>
                      </div>
                    )}

                    <PdfSignatureCanvas
                      key={currentPreviewPdf.filePath}
                      filePath={currentPreviewPdf.filePath}
                      onPlacementChange={handlePlacementChange}
                      placement={activeFilePlacement}
                      signerName={selectedCert?.subjectCommonName || selectedCert?.subject?.match(/CN=([^,]+)/i)?.[1]?.trim() || selectedCert?.subject || ''}
                      reason={reason}
                      location={location}
                      disabled={isSigning}
                      onApplyToAll={handleApplyCurrentToAll}
                      hasMultipleDocs={selectedPdfs.length > 1}
                      customAppearance={customAppearance}
                      onOpenCustomizeAppearance={() => setShowAppearanceModal(true)}
                    />

                    <div className="sig-placement-bar">
                      <div className="sig-placement-status">
                        {activeFilePlacement ? (
                          <div className="sig-status-placed">
                            <Icons.CheckCircle />
                            <span>
                              Signature placed on <strong>Page {activeFilePlacement.page}</strong> ({Math.round(activeFilePlacement.normWidth * 100)}% × {Math.round(activeFilePlacement.normHeight * 100)}% size) for <em>{currentPreviewPdf?.fileName}</em>.
                              {selectedPdfs.length > 1 && (
                                <span>
                                  {' '}Right-click the signature box or click <strong>"Apply to All Documents"</strong> above to sync across all {selectedPdfs.length} files.
                                </span>
                              )}
                              {selectedPdfs.length <= 1 && ' You can move or resize it anytime.'}
                            </span>
                          </div>
                        ) : (
                          <div className="sig-status-unplaced">
                            <Icons.Info />
                            <span>
                              Click <strong>"Place Signature"</strong> in the toolbar above, then click and drag on the document to draw your signature box.
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="sig-canvas-placeholder">
                    <Icons.PDF />
                    <p>Select PDF document(s) above to preview pages and place your signature</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="sig-invisible-notice">
                <Icons.ShieldCheck />
                <div>
                  <strong>Invisible Certificate Signing Mode Active</strong>
                  <p>
                    The document will be cryptographically certified at document level. PDF readers (such as Adobe Acrobat) will display the verified digital signature banner and Signatures panel, without altering any visual content on the page.
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* STEP 4: Execution & Actions */}
          <div className="sig-action-bar">
            <div className="sig-action-summary">
              {selectedPdfs.length > 0 && selectedCert ? (
                <span>
                  Ready to sign <strong>{selectedPdfs.length} document{selectedPdfs.length !== 1 ? 's' : ''}</strong> with <strong>{selectedCert.subjectCommonName}</strong>
                  {visibleSignature ? (signaturePlacement ? ` on Page ${signaturePlacement.page}` : ' (placement required)') : ' (invisible)'}
                  {selectedPdfs.length > 1 && ' → output to selected folder'}
                </span>
              ) : selectedPdfs.length === 0 ? (
                <span>Please select PDF document(s) in Step 1</span>
              ) : (
                <span>Please connect and select an eligible DSC certificate in Step 2</span>
              )}
            </div>
            <button
              className="btn-merge btn-sig-execute"
              disabled={selectedPdfs.length === 0 || !selectedCertId || !selectedCert || isSigning || (visibleSignature && !hasValidPlacement)}
              onClick={handleSign}
              id="btn-sign-pdf"
            >
              <Icons.ShieldCheck />
              {isSigning
                ? 'Cryptographically Signing...'
                : selectedPdfs.length > 1
                  ? `Sign All ${selectedPdfs.length} Documents`
                  : 'Sign PDF Document'}
            </button>
          </div>

          {/* Single-File Result Card */}
          {signResult && (
            <div className="sig-result-card" id="sig-result-card">
              <div className="sig-result-header success">
                <Icons.CheckCircle />
                <div>
                  <h4>Document Signed & Cryptographically Verified!</h4>
                  <p>The PDF has been digitally signed in full accordance with ETSI EN 319 142 / PAdES Baseline (PAdES-B-B) and eIDAS standards.</p>
                </div>
              </div>

              <div className="sig-result-file">
                <span className="sig-result-label">Saved Output File:</span>
                <span className="sig-result-path">{signResult.outputPath}</span>
                <button
                  className="btn-notification-action primary"
                  onClick={() => window.electronAPI?.showItemInFolder(signResult.outputPath)}
                  id="btn-show-signed-folder"
                >
                  <Icons.ExternalLink /> Show in Folder
                </button>
              </div>

              {/* Status Breakdown Grid */}
              <div className="sig-status-grid">
                <div className="sig-status-item">
                  <div className="status-indicator pass">
                    <Icons.CheckCircle />
                  </div>
                  <div>
                    <span className="status-title">Cryptographic Integrity</span>
                    <span className="status-desc">
                      Valid SHA-256 ByteRange match. Document has not been altered since signing.
                    </span>
                  </div>
                </div>

                <div className="sig-status-item">
                  <div className="status-indicator pass">
                    <Icons.CheckCircle />
                  </div>
                  <div>
                    <span className="status-title">Mathematical Signature</span>
                    <span className="status-desc">
                      RSA signature validated against signer public key.
                    </span>
                  </div>
                </div>

                <div className="sig-status-item">
                  <div className="status-indicator pass">
                    <Icons.CheckCircle />
                  </div>
                  <div>
                    <span className="status-title">Certificate Validity Period</span>
                    <span className="status-desc">
                      Signature was created during the active validity period of the certificate.
                    </span>
                  </div>
                </div>

                <div className="sig-status-item">
                  <div className="status-indicator info">
                    <Icons.Shield />
                  </div>
                  <div>
                    <span className="status-title">Chain Trust Status</span>
                    <span className="status-desc">
                      {signResult.verification?.trustDetails || 'Cryptographically verified.'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Batch Results Card */}
          {batchResults && (
            <div className="sig-result-card sig-batch-results" id="sig-batch-result-card">
              <div className={`sig-result-header ${batchResults.failCount === 0 ? 'success' : batchResults.successCount === 0 ? 'error' : 'warning'}`}>
                {batchResults.failCount === 0 ? <Icons.CheckCircle /> : <Icons.AlertCircle />}
                <div>
                  <h4>
                    {batchResults.failCount === 0
                      ? `All ${batchResults.totalFiles} Documents Signed Successfully!`
                      : `${batchResults.successCount} of ${batchResults.totalFiles} Documents Signed`}
                  </h4>
                  <p>
                    {batchResults.failCount === 0
                      ? 'All documents have been digitally signed in full accordance with ETSI EN 319 142 / PAdES Baseline (PAdES-B-B) and eIDAS standards.'
                      : `${batchResults.failCount} document(s) failed to sign. See details below.`}
                  </p>
                </div>
              </div>

              <div className="sig-batch-results-list">
                {batchResults.results.map((r, i) => (
                  <div className={`sig-batch-result-item ${r.success ? 'success' : 'error'}`} key={i}>
                    <div className="sig-batch-result-status">
                      {r.success ? <Icons.CheckCircle /> : <Icons.AlertCircle />}
                    </div>
                    <div className="sig-batch-result-info">
                      <span className="sig-batch-result-name">{r.fileName}</span>
                      {r.success ? (
                        <span className="sig-batch-result-detail">
                          Saved to: {r.outputPath}
                        </span>
                      ) : (
                        <span className="sig-batch-result-detail error">
                          Error: {r.error}
                        </span>
                      )}
                    </div>
                    {r.success && (
                      <button
                        className="btn-sig-icon btn-sm"
                        onClick={() => window.electronAPI?.showItemInFolder(r.outputPath)}
                        title="Show in folder"
                      >
                        <Icons.ExternalLink />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* MODE: Verify Existing PDF */
        <div className="sig-workspace verify-mode">
          <section className="sig-card">
            <div className="sig-card-header">
              <div className="sig-header-icon-badge">
                <Icons.ShieldCheck />
              </div>
              <div>
                <h3>Verify Existing Signed PDF</h3>
                <p>Inspect and cryptographically validate signatures on any PDF file</p>
              </div>
            </div>

            {!verifyFilePath ? (
              <div
                className={`sig-dropzone compact ${isVerifyDragging ? 'dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setIsVerifyDragging(true); }}
                onDragLeave={() => setIsVerifyDragging(false)}
                onDrop={handleVerifyDrop}
                onClick={handleSelectPdfToVerify}
                id="sig-verify-dropzone"
              >
                <div className="sig-dropzone-icon">
                  <Icons.ShieldCheck />
                </div>
                <div className="sig-dropzone-text">
                  <strong>Click to select a PDF</strong> or drag & drop here to verify
                </div>
                <button type="button" className="btn-browse" id="btn-select-verify-pdf" disabled={isVerifying}>
                  <Icons.FolderOpen />
                  {isVerifying ? 'Verifying...' : 'Select PDF to Verify'}
                </button>
              </div>
            ) : (
              <div className="sig-selected-file-card compact" id="sig-verify-selected-file">
                <div className="sig-file-icon">
                  <Icons.PDF />
                </div>
                <div className="sig-file-details">
                  <span className="sig-file-name" title={verifyFilePath}>
                    {verifyFilePath.split(/[/\\]/).pop()}
                  </span>
                  <span className="sig-file-meta font-mono" title={verifyFilePath}>
                    {verifyFilePath}
                  </span>
                </div>
                <div className="sig-file-actions">
                  <button
                    className="btn-sig-icon"
                    onClick={() => handleVerifyPath(verifyFilePath)}
                    title="Re-verify this document"
                    id="btn-reverify-pdf"
                    disabled={isVerifying}
                  >
                    <Icons.Refresh />
                  </button>
                  <button
                    className="btn-sig-icon"
                    onClick={handleSelectPdfToVerify}
                    title="Choose a different PDF to verify"
                    id="btn-change-verify-pdf"
                    disabled={isVerifying}
                  >
                    <Icons.FolderOpen />
                  </button>
                  <button
                    className="btn-sig-icon btn-danger"
                    onClick={() => { setVerifyFilePath(null); setVerifyReport(null); }}
                    title="Clear selected PDF"
                    id="btn-clear-verify-pdf"
                    disabled={isVerifying}
                  >
                    <Icons.X />
                  </button>
                </div>
              </div>
            )}

            {isVerifying && (
              <div className="sig-loading-certs compact">
                <div className="sig-spinner" />
                <p>Reading ByteRange and validating cryptographic signature...</p>
              </div>
            )}

            {verifyReport && (
              <div className="sig-verify-report" id="sig-verify-report">
                {!verifyReport.hasSignature ? (
                  <div className="sig-empty-certs compact">
                    <Icons.AlertCircle />
                    <h4>No Digital Signatures Found</h4>
                    <p>The selected PDF document does not contain an ISO 32000-1 / PKCS#7 signature dictionary.</p>
                  </div>
                ) : (
                  <>
                    <div className={`sig-result-header ${verifyReport.isValid ? 'success' : 'error'}`}>
                      {verifyReport.isValid ? <Icons.CheckCircle /> : <Icons.AlertCircle />}
                      <div>
                        <h4>
                          {verifyReport.isValid
                            ? 'Digital Signature is VALID'
                            : 'Digital Signature FAILED Verification'}
                        </h4>
                        <p>
                          {verifyReport.isValid
                            ? 'The cryptographic signature is intact and the document has not been modified.'
                            : (verifyReport.error || 'The document has been tampered with or contains an invalid signature.')}
                        </p>
                      </div>
                    </div>

                    <div className="sig-verify-details-grid">
                      <div className="verify-detail-row">
                        <span className="detail-label">Signer Common Name:</span>
                        <span className="detail-val font-bold">{verifyReport.signer?.commonName || 'Unknown'}</span>
                      </div>
                      <div className="verify-detail-row">
                        <span className="detail-label">Signer Subject:</span>
                        <span className="detail-val font-mono text-sm">{verifyReport.signer?.subject}</span>
                      </div>
                      <div className="verify-detail-row">
                        <span className="detail-label">Issuer:</span>
                        <span className="detail-val font-mono text-sm">{verifyReport.signer?.issuer}</span>
                      </div>
                      <div className="verify-detail-row">
                        <span className="detail-label">Serial Number:</span>
                        <span className="detail-val font-mono">{verifyReport.signer?.serialNumber}</span>
                      </div>
                      <div className="verify-detail-row">
                        <span className="detail-label">Document Digest (SHA-256):</span>
                        <span className="detail-val font-mono text-sm">{verifyReport.technical?.docDigestHex}</span>
                      </div>
                      {verifyReport.metadata?.reason ? (
                        <div className="verify-detail-row">
                          <span className="detail-label">Reason:</span>
                          <span className="detail-val">{verifyReport.metadata.reason}</span>
                        </div>
                      ) : null}
                      {verifyReport.metadata?.location ? (
                        <div className="verify-detail-row">
                          <span className="detail-label">Location:</span>
                          <span className="detail-val">{verifyReport.metadata.location}</span>
                        </div>
                      ) : null}
                      <div className="verify-detail-row">
                        <span className="detail-label">Signing Time:</span>
                        <span className="detail-val">{verifyReport.metadata?.signingTime || 'Not specified'}</span>
                      </div>
                      <div className="verify-detail-row">
                        <span className="detail-label">Signature Format:</span>
                        <span className="detail-val font-semibold text-accent">{verifyReport.pades?.profile || 'PAdES-B-B (ETSI EN 319 142 / eIDAS)'}</span>
                      </div>
                      <div className="verify-detail-row">
                        <span className="detail-label">SubFilter & Protection:</span>
                        <span className="detail-val font-mono text-sm">
                          {verifyReport.pades?.subFilter || 'ETSI.CAdES.detached'} (RFC 5035 Anti-Substitution Protected)
                        </span>
                      </div>
                    </div>

                    <div className="sig-status-grid">
                      <div className="sig-status-item">
                        <div className={`status-indicator ${verifyReport.integrityValid ? 'pass' : 'fail'}`}>
                          {verifyReport.integrityValid ? <Icons.CheckCircle /> : <Icons.AlertCircle />}
                        </div>
                        <div>
                          <span className="status-title">Document Integrity</span>
                          <span className="status-desc">
                            {verifyReport.integrityValid ? 'ByteRange hash matches. Document unmodified.' : 'Document has been modified or corrupted!'}
                          </span>
                        </div>
                      </div>

                      <div className="sig-status-item">
                        <div className={`status-indicator ${verifyReport.signatureValid ? 'pass' : 'fail'}`}>
                          {verifyReport.signatureValid ? <Icons.CheckCircle /> : <Icons.AlertCircle />}
                        </div>
                        <div>
                          <span className="status-title">Cryptographic Signature</span>
                          <span className="status-desc">
                            {verifyReport.signatureValid ? 'RSA signature matches public key.' : 'Cryptographic signature is invalid.'}
                          </span>
                        </div>
                      </div>

                      <div className="sig-status-item">
                        <div className={`status-indicator ${verifyReport.pades?.isPades ? 'pass' : 'info'}`}>
                          <Icons.ShieldCheck />
                        </div>
                        <div>
                          <span className="status-title">PAdES Standard (eIDAS)</span>
                          <span className="status-desc">
                            {verifyReport.pades?.isPades
                              ? `${verifyReport.pades.profile} compliant with ESS SigningCertificateV2 binding.`
                              : 'Standard PDF digital signature.'}
                          </span>
                        </div>
                      </div>

                      <div className="sig-status-item">
                        <div className={`status-indicator ${verifyReport.certDatesValid ? 'pass' : 'fail'}`}>
                          {verifyReport.certDatesValid ? <Icons.CheckCircle /> : <Icons.AlertCircle />}
                        </div>
                        <div>
                          <span className="status-title">Certificate Validity Dates</span>
                          <span className="status-desc">
                            {verifyReport.certDatesValid ? 'Certificate was valid at signing.' : 'Certificate is expired or not yet valid.'}
                          </span>
                        </div>
                      </div>

                      <div className="sig-status-item">
                        <div className="status-indicator info">
                          <Icons.Shield />
                        </div>
                        <div>
                          <span className="status-title">Trust Chain Status</span>
                          <span className="status-desc">
                            {verifyReport.trustDetails}
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Progress Overlay for Signing (single file) */}
      {isSigning && signingProgress && !batchProgress && (
        <div className="sig-progress-overlay">
          <div className="sig-progress-card">
            <div className="sig-spinner" />
            <h4>{signingProgress.step || 'Digital Signing in Progress'}</h4>
            <p>{signingProgress.detail || 'Communicating with cryptographic provider...'}</p>
            <div className="sig-progress-bar-track">
              <div
                className="sig-progress-bar-fill"
                style={{ width: `${signingProgress.percent || 10}%` }}
              />
            </div>
            <span className="sig-progress-pct">{signingProgress.percent || 0}%</span>
          </div>
        </div>
      )}

      {/* Progress Overlay for Batch Signing */}
      {isSigning && batchProgress && (
        <div className="sig-progress-overlay">
          <div className="sig-progress-card batch">
            <div className="sig-spinner" />
            <h4>{batchProgress.step || 'Batch Signing in Progress'}</h4>
            <p>{batchProgress.detail || 'Processing documents...'}</p>
            {batchProgress.currentFile && (
              <div className="sig-batch-progress-meta">
                <span>File {(batchProgress.currentIndex || 0) + 1} of {batchProgress.totalFiles}</span>
                <span className="sig-batch-current-file">{batchProgress.currentFile}</span>
              </div>
            )}
            <div className="sig-progress-bar-track">
              <div
                className="sig-progress-bar-fill"
                style={{ width: `${batchProgress.percent || 5}%` }}
              />
            </div>
            <span className="sig-progress-pct">{batchProgress.percent || 0}%</span>
          </div>
        </div>
      )}

      {/* Adobe Acrobat Style Signature Appearance Customizer Modal */}
      <SignatureAppearanceModal
        isOpen={showAppearanceModal}
        onClose={() => setShowAppearanceModal(false)}
        onSave={handleSaveAppearance}
        currentAppearance={customAppearance}
        certificateInfo={selectedCert}
        reason={reason}
        location={location}
      />
    </div>
  );
}
