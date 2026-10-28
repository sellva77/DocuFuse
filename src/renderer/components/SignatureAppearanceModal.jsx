import React, { useState, useEffect, useRef } from 'react';
import { Icons } from './Icons';

export const DEFAULT_APPEARANCE_CONFIG = {
  presetName: '',
  // Graphic selection: 'text' | 'draw' | 'image' | 'none'
  graphicType: 'none',
  textSignature: '',
  textStyle: 'script', // 'script' | 'serif' | 'sans'
  drawnDataUrl: null,
  imageDataUrl: null,
  imageName: '',

  // Text inclusion toggles
  includeText: {
    name: true,
    date: true,
    logo: false,
    reason: false,
    distinguishedName: false,
    adobeVersion: false,
    location: false,
    labels: true,
  },

  // Fully customizable field contents (user editable)
  customFields: {
    signPrefix: 'Digitally signed by',
    signPrefixCustom: '',  // Custom prefix when 'Custom...' is selected
    signerName: '',
    signerNameSource: 'certificate', // 'certificate' (auto from DSC) | 'custom' (user-typed) | 'none' (hidden/disabled)
    distinguishedName: '',
    reason: 'Document signature and certification',
    location: 'Office',
    versionText: 'DocuFuse 1.0.0',
    dateFormat: 'standard', // 'standard' | 'date_only' | 'iso'
    customLogoDataUrl: null,
    customLogoName: '',
    logoPosition: 'badge', // 'badge' | 'watermark'
  },

  // Styling & colors
  styling: {
    inkColor: '#000000', // Black, '#1d4ed8' (DSC Blue), '#1e1b4b' (Navy), '#991b1b' (Burgundy), '#065f46' (Green)
    borderStyle: 'solid', // 'solid' | 'blue' | 'dashed' | 'none'
    backgroundColor: '#ffffff', // '#ffffff' | 'transparent' | '#f8fafc'
  },

  textDirection: 'auto', // 'auto' | 'left' | 'right'
  digitsFormat: '0123456789',
};

const PRESETS_STORAGE_KEY = 'docufuse_sig_appearance_presets';

// Quick Reason Suggestions
const REASON_PRESETS = [
  'Document signature and certification',
  'I approve this document',
  'I am the author of this document',
  'Official endorsement and execution',
  'Agreed to the specified terms',
];

// Ink Color Options
const INK_COLORS = [
  { label: 'Black', hex: '#000000', bg: '#000000' },
  { label: 'DSC Blue', hex: '#1d4ed8', bg: '#1d4ed8' },
  { label: 'Midnight Navy', hex: '#1e1b4b', bg: '#1e1b4b' },
  { label: 'Crimson Red', hex: '#991b1b', bg: '#991b1b' },
  { label: 'Forest Green', hex: '#065f46', bg: '#065f46' },
];

export default function SignatureAppearanceModal({
  isOpen,
  onClose,
  onSave,
  currentAppearance = null,
  certificateInfo = null,
  reason = '',
  location = '',
}) {
  const [activeSettingsTab, setActiveSettingsTab] = useState('fields'); // 'fields' | 'styling'

  // Build initial config merging current appearance and certificate info
  const getInitialConfig = () => {
    // Extract signer name from DSC certificate (consider all possibilities)
    const certCommonName = certificateInfo?.subjectCommonName || '';
    const certSubject = certificateInfo?.subject || '';
    // Parse CN from subject DN string if subjectCommonName not available
    const parsedCn = certSubject.match(/CN=([^,]+)/i)?.[1]?.trim() || '';
    const defaultSigner = certCommonName || parsedCn || certSubject || '';
    const defaultDn = certSubject || (defaultSigner ? `cn=${defaultSigner}, o=Organization, c=IN` : '');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const autoPresetName = `Created ${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} +05'30'`;

    // Clean up any legacy "Authorized Signer" string from older saved states
    let initialTextSig = currentAppearance?.textSignature;
    if (initialTextSig === 'Authorized Signer') {
      initialTextSig = '';
    }
    const resolvedTextSig = initialTextSig || currentAppearance?.customFields?.signerName || defaultSigner || '';

    return {
      ...DEFAULT_APPEARANCE_CONFIG,
      presetName: currentAppearance?.presetName || autoPresetName,
      graphicType: currentAppearance?.graphicType || 'none',
      textSignature: resolvedTextSig,
      textStyle: currentAppearance?.textStyle || 'script',
      drawnDataUrl: currentAppearance?.drawnDataUrl || null,
      imageDataUrl: currentAppearance?.imageDataUrl || null,
      imageName: currentAppearance?.imageName || '',
      includeText: {
        ...DEFAULT_APPEARANCE_CONFIG.includeText,
        ...(currentAppearance?.includeText || {}),
      },
      customFields: {
        ...DEFAULT_APPEARANCE_CONFIG.customFields,
        signerName: defaultSigner,
        signerNameSource: currentAppearance?.customFields?.signerNameSource || 'certificate',
        distinguishedName: defaultDn,
        reason: reason || DEFAULT_APPEARANCE_CONFIG.customFields.reason,
        location: location || DEFAULT_APPEARANCE_CONFIG.customFields.location,
        ...(currentAppearance?.customFields || {}),
        // Always re-derive from certificate if source is 'certificate'
        ...((!currentAppearance?.customFields?.signerNameSource || currentAppearance?.customFields?.signerNameSource === 'certificate')
          ? { signerName: defaultSigner }
          : {}),
      },
      styling: {
        ...DEFAULT_APPEARANCE_CONFIG.styling,
        ...(currentAppearance?.styling || {}),
      },
      textDirection: currentAppearance?.textDirection || 'auto',
      digitsFormat: currentAppearance?.digitsFormat || '0123456789',
    };
  };

  const [config, setConfig] = useState(getInitialConfig);
  const [savedPresets, setSavedPresets] = useState([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const drawCanvasRef = useRef(null);
  const sigImageInputRef = useRef(null);
  const logoImageInputRef = useRef(null);

  // Load presets from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSavedPresets(parsed);
      }
    } catch (_) {}
  }, []);

  // Sync state whenever modal is opened
  useEffect(() => {
    if (isOpen) {
      setConfig(getInitialConfig());
    }
  }, [isOpen, currentAppearance, certificateInfo, reason, location]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Initialize and redraw drawing canvas when in 'draw' mode
  useEffect(() => {
    if (config.graphicType !== 'draw' || !drawCanvasRef.current) return;
    const canvas = drawCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = config.styling.inkColor || '#000000';
    ctx.lineWidth = 2.5;

    if (config.drawnDataUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.offsetWidth, canvas.offsetHeight);
      };
      img.src = config.drawnDataUrl;
    }
  }, [config.graphicType, config.drawnDataUrl, config.styling.inkColor]);

  // Drawing event handlers
  const handleStartDraw = (e) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
  };

  const handleDraw = (e) => {
    if (!isDrawing) return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleEndDraw = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    setConfig(prev => ({ ...prev, drawnDataUrl: dataUrl }));
  };

  const handleClearDraw = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setConfig(prev => ({ ...prev, drawnDataUrl: null }));
  };

  // Signature Image Upload
  const handleSigImageFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const dataUrl = loadEvent.target?.result;
      setConfig(prev => ({
        ...prev,
        imageDataUrl: dataUrl,
        imageName: file.name,
      }));
    };
    reader.readAsDataURL(file);
  };

  // Custom Organization Logo Upload
  const handleLogoFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const dataUrl = loadEvent.target?.result;
      setConfig(prev => ({
        ...prev,
        includeText: { ...prev.includeText, logo: true },
        customFields: {
          ...prev.customFields,
          customLogoDataUrl: dataUrl,
          customLogoName: file.name,
        },
      }));
    };
    reader.readAsDataURL(file);
  };

  // Toggle field inclusion checkbox
  const handleToggleIncludeText = (key) => {
    setConfig(prev => ({
      ...prev,
      includeText: {
        ...prev.includeText,
        [key]: !prev.includeText[key],
      },
    }));
  };

  // Update specific custom field value
  const handleCustomFieldChange = (key, value) => {
    setConfig(prev => {
      const newCustomFields = {
        ...prev.customFields,
        [key]: value,
      };

      // If user is editing custom signer name, automatically sync textSignature if it was empty,
      // legacy 'Authorized Signer', or matched the old signer name
      let newTextSig = prev.textSignature;
      if (key === 'signerName') {
        if (!newTextSig || newTextSig === 'Authorized Signer' || newTextSig === prev.customFields?.signerName) {
          newTextSig = value;
        }
      }

      return {
        ...prev,
        customFields: newCustomFields,
        textSignature: newTextSig,
      };
    });
  };

  // Update styling
  const handleStylingChange = (key, value) => {
    setConfig(prev => ({
      ...prev,
      styling: {
        ...prev.styling,
        [key]: value,
      },
    }));
  };

  // Preset management
  const handleSelectPreset = (preset) => {
    if (!preset) return;
    setConfig({
      ...preset,
      presetName: preset.presetName,
    });
  };

  const handleSave = () => {
    try {
      const existing = savedPresets.filter(p => p.presetName !== config.presetName);
      const updated = [config, ...existing].slice(0, 25);
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(updated));
      setSavedPresets(updated);
    } catch (_) {}

    onSave?.(config);
    onClose?.();
  };

  if (!isOpen) return null;

  // Format date preview according to selected format
  const padTwo = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const formatTimestamp = () => {
    switch (config.customFields.dateFormat) {
      case 'date_only':
        return `${d.getFullYear()}.${padTwo(d.getMonth() + 1)}.${padTwo(d.getDate())}`;
      case 'iso':
        return d.toISOString();
      case 'standard':
      default:
        return `${d.getFullYear()}.${padTwo(d.getMonth() + 1)}.${padTwo(d.getDate())} ${padTwo(d.getHours())}:${padTwo(d.getMinutes())}:${padTwo(d.getSeconds())} +05'30'`;
    }
  };

  const dateFormatted = formatTimestamp();
  const showLabels = config.includeText.labels;
  // Resolve signer name based on source setting
  const resolveSignerName = () => {
    if (config.customFields.signerNameSource === 'none') return '';
    if (config.customFields.signerNameSource === 'custom') {
      return config.customFields.signerName || '';
    }
    // 'certificate' mode: use certificate name (already populated from DSC)
    return config.customFields.signerName || '';
  };
  const currentSigner = resolveSignerName();
  const currentPrefix = config.customFields.signPrefix === '__custom__'
    ? (config.customFields.signPrefixCustom || '')
    : (config.customFields.signPrefix || 'Digitally signed by');

  // Count active fields for tab badge
  const activeFieldsCount = Object.values(config.includeText).filter(Boolean).length;

  return (
    <div className="adobe-sig-modal-overlay" onClick={onClose} id="adobe-sig-appearance-modal">
      <div className="adobe-sig-modal-dialog" onClick={(e) => e.stopPropagation()}>
        
        {/* Header (Fixed at top) */}
        <div className="adobe-sig-modal-header">
          <div className="adobe-sig-header-left">
            <h3 className="adobe-sig-modal-title">Customize the Signature Appearance</h3>
            <span className="adobe-sig-subtitle">Fully customize graphic, text, organization logo, colors & layout</span>
          </div>
          <button
            type="button"
            className="adobe-sig-close-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close dialog"
          >
            <Icons.X />
          </button>
        </div>

        {/* Top Graphic Selection Tabs (Fixed directly below header) */}
        <div className="adobe-sig-tabs-bar">
          <button
            type="button"
            className={`adobe-sig-tab ${config.graphicType === 'text' ? 'active' : ''}`}
            onClick={() => setConfig(prev => ({ ...prev, graphicType: 'text' }))}
            id="tab-graphic-text"
          >
            <Icons.Keyboard />
            <span>Text</span>
          </button>
          <button
            type="button"
            className={`adobe-sig-tab ${config.graphicType === 'draw' ? 'active' : ''}`}
            onClick={() => setConfig(prev => ({ ...prev, graphicType: 'draw' }))}
            id="tab-graphic-draw"
          >
            <Icons.Draw />
            <span>Draw</span>
          </button>
          <button
            type="button"
            className={`adobe-sig-tab ${config.graphicType === 'image' ? 'active' : ''}`}
            onClick={() => setConfig(prev => ({ ...prev, graphicType: 'image' }))}
            id="tab-graphic-image"
          >
            <Icons.Image />
            <span>Image</span>
          </button>
          <button
            type="button"
            className={`adobe-sig-tab ${config.graphicType === 'none' ? 'active' : ''}`}
            onClick={() => setConfig(prev => ({ ...prev, graphicType: 'none' }))}
            id="tab-graphic-none"
          >
            <Icons.None />
            <span>None</span>
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="adobe-sig-modal-body">

          {/* Graphic Mode Sub-panel */}
          {config.graphicType === 'text' && (
            <div className="adobe-sig-subpanel">
              <div className="adobe-subpanel-row" style={{ flexWrap: 'wrap', gap: '8px' }}>
                <label>Signature Text:</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1, minWidth: '240px' }}>
                  <input
                    type="text"
                    className="adobe-input flex-1"
                    placeholder={currentSigner || 'Enter signature text'}
                    value={config.textSignature}
                    onChange={(e) => setConfig(prev => ({ ...prev, textSignature: e.target.value }))}
                  />
                  {currentSigner && config.textSignature !== currentSigner && (
                    <button
                      type="button"
                      className="adobe-btn-choice"
                      style={{ whiteSpace: 'nowrap', padding: '6px 10px', fontSize: '11px' }}
                      onClick={() => setConfig(prev => ({ ...prev, textSignature: currentSigner }))}
                      title={`Use "${currentSigner}" as signature text`}
                    >
                      Use "{currentSigner}"
                    </button>
                  )}
                  <button
                    type="button"
                    className="adobe-btn-choice"
                    style={{ whiteSpace: 'nowrap', padding: '6px 10px', fontSize: '11px', color: '#ef4444', borderColor: '#fca5a5' }}
                    onClick={() => setConfig(prev => ({ ...prev, graphicType: 'none', textSignature: '' }))}
                    title="Turn off stylized graphic signature (switch to None)"
                  >
                    Turn Off Graphic
                  </button>
                </div>
                <div className="adobe-font-options">
                  <button
                    type="button"
                    className={`adobe-btn-choice ${config.textStyle === 'script' ? 'active' : ''}`}
                    onClick={() => setConfig(prev => ({ ...prev, textStyle: 'script' }))}
                  >
                    Cursive
                  </button>
                  <button
                    type="button"
                    className={`adobe-btn-choice ${config.textStyle === 'serif' ? 'active' : ''}`}
                    onClick={() => setConfig(prev => ({ ...prev, textStyle: 'serif' }))}
                  >
                    Classic Serif
                  </button>
                  <button
                    type="button"
                    className={`adobe-btn-choice ${config.textStyle === 'sans' ? 'active' : ''}`}
                    onClick={() => setConfig(prev => ({ ...prev, textStyle: 'sans' }))}
                  >
                    Modern Bold
                  </button>
                </div>
              </div>
            </div>
          )}

          {config.graphicType === 'draw' && (
            <div className="adobe-sig-subpanel">
              <div className="adobe-draw-container">
                <div className="adobe-draw-header-row">
                  <span className="adobe-draw-hint">Draw your handwritten signature below:</span>
                  <div className="adobe-draw-actions">
                    <button type="button" className="adobe-btn-small" onClick={handleClearDraw}>
                      Clear Canvas
                    </button>
                    <span className="adobe-draw-status">
                      {config.drawnDataUrl ? 'Signature captured ✓' : 'Use mouse or stylus to sign'}
                    </span>
                  </div>
                </div>
                <div className="adobe-draw-canvas-box">
                  <canvas
                    ref={drawCanvasRef}
                    className="adobe-draw-canvas"
                    onMouseDown={handleStartDraw}
                    onMouseMove={handleDraw}
                    onMouseUp={handleEndDraw}
                    onMouseLeave={handleEndDraw}
                  />
                </div>
              </div>
            </div>
          )}

          {config.graphicType === 'image' && (
            <div className="adobe-sig-subpanel">
              <div className="adobe-image-upload-row">
                <input
                  ref={sigImageInputRef}
                  type="file"
                  accept="image/png, image/jpeg, image/jpg, image/webp"
                  style={{ display: 'none' }}
                  onChange={handleSigImageFileChange}
                />
                <button
                  type="button"
                  className="adobe-btn-browse"
                  onClick={() => sigImageInputRef.current?.click()}
                >
                  <Icons.FolderOpen />
                  Choose Signature Image...
                </button>
                {config.imageDataUrl ? (
                  <div className="adobe-image-preview-meta">
                    <span className="image-filename">{config.imageName || 'Signature Image Uploaded'}</span>
                    <button
                      type="button"
                      className="adobe-btn-link-danger"
                      onClick={() => setConfig(prev => ({ ...prev, imageDataUrl: null, imageName: '' }))}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <span className="adobe-image-hint">Supports PNG, JPG (e.g. signature photo, stamp)</span>
                )}
              </div>
            </div>
          )}

          {/* Interactive Live Preview Box */}
          <div className="adobe-sig-preview-wrapper">
            <div
              className={`adobe-sig-preview-card ${config.textDirection !== 'auto' ? `align-${config.textDirection}` : ''} border-${config.styling.borderStyle}`}
              style={{
                color: config.styling.inkColor,
                backgroundColor: config.styling.backgroundColor,
              }}
              id="adobe-sig-preview-box"
            >
              {/* Optional Subtle Watermark Logo */}
              {config.includeText.logo && config.customFields.logoPosition === 'watermark' && (
                <div className="adobe-preview-watermark-overlay">
                  {config.customFields.customLogoDataUrl ? (
                    <img src={config.customFields.customLogoDataUrl} alt="Logo Watermark" className="watermark-img" />
                  ) : (
                    <Icons.ShieldCheck />
                  )}
                </div>
              )}

              {/* Graphic Side (Left if auto/left, Right if align-right) */}
              {config.graphicType !== 'none' && (
                <div className="adobe-sig-preview-graphic-side">
                  {config.graphicType === 'draw' && config.drawnDataUrl && (
                    <img src={config.drawnDataUrl} alt="Signature" className="preview-drawn-img" />
                  )}
                  {config.graphicType === 'image' && config.imageDataUrl && (
                    <img src={config.imageDataUrl} alt="Seal" className="preview-stamp-img" />
                  )}
                  {config.graphicType === 'text' && (
                    <div
                      className={`preview-stylized-text style-${config.textStyle}`}
                      style={{ color: config.styling.inkColor }}
                    >
                      {(config.textSignature && config.textSignature !== 'Authorized Signer') ? config.textSignature : (currentSigner || '')}
                    </div>
                  )}
                </div>
              )}

              {/* Typography Details Side */}
              <div className="adobe-sig-preview-text-side">
                {/* Name & Prefix */}
                {config.includeText.name && config.customFields.signerNameSource !== 'none' && currentSigner && (
                  <div className="adobe-preview-headline" style={{ color: config.styling.inkColor }}>
                    {currentPrefix}{currentPrefix ? ' ' : ''}{currentSigner}
                  </div>
                )}

                {/* Distinguished Name */}
                {config.includeText.distinguishedName && (
                  <div className="adobe-preview-detail">
                    {showLabels ? 'DN: ' : ''}{config.customFields.distinguishedName}
                  </div>
                )}

                {/* Date */}
                {config.includeText.date && (
                  <div className="adobe-preview-detail">
                    {showLabels ? 'Date: ' : ''}{dateFormatted}
                  </div>
                )}

                {/* Reason */}
                {config.includeText.reason && (
                  <div className="adobe-preview-detail">
                    {showLabels ? 'Reason: ' : ''}{config.customFields.reason}
                  </div>
                )}

                {/* Location */}
                {config.includeText.location && (
                  <div className="adobe-preview-detail">
                    {showLabels ? 'Location: ' : ''}{config.customFields.location}
                  </div>
                )}

                {/* Version */}
                {config.includeText.adobeVersion && (
                  <div className="adobe-preview-detail">
                    {showLabels ? 'Version: ' : ''}{config.customFields.versionText}
                  </div>
                )}

                {/* Badge Logo */}
                {config.includeText.logo && config.customFields.logoPosition === 'badge' && (
                  <div className="adobe-preview-logo-badge">
                    {config.customFields.customLogoDataUrl ? (
                      <img src={config.customFields.customLogoDataUrl} alt="Logo" className="badge-logo-img" />
                    ) : (
                      <Icons.ShieldCheck />
                    )}
                    <span>Certified Digital Signature</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Sub-Tabs: 1) Text Fields & Content | 2) Colors, Logo & Style */}
          <div className="adobe-settings-subnav">
            <button
              type="button"
              className={`adobe-subnav-btn ${activeSettingsTab === 'fields' ? 'active' : ''}`}
              onClick={() => setActiveSettingsTab('fields')}
              id="subtab-fields"
            >
              <Icons.FileText />
              <span>Text Content & Fields</span>
              <span className="adobe-badge-pill">{activeFieldsCount} Active</span>
            </button>
            <button
              type="button"
              className={`adobe-subnav-btn ${activeSettingsTab === 'styling' ? 'active' : ''}`}
              onClick={() => setActiveSettingsTab('styling')}
              id="subtab-styling"
            >
              <Icons.Palette />
              <span>Colors, Logo & Styling</span>
            </button>
          </div>

          {/* TAB 1: Text Content & Fields Customization */}
          {activeSettingsTab === 'fields' && (
            <div className="adobe-custom-fields-editor">
              <div className="adobe-field-custom-row">
                <div className="adobe-field-header">
                  <label className="adobe-checkbox-item">
                    <input
                      type="checkbox"
                      checked={config.includeText.name}
                      onChange={() => handleToggleIncludeText('name')}
                    />
                    <strong>Signer Name & Prefix</strong>
                  </label>
                </div>
                {config.includeText.name && (
                  <div className="adobe-field-column">
                    {/* Signer Name Source Selector */}
                    <div className="adobe-name-source-row">
                      <span className="adobe-hint-label">Name Source:</span>
                      <div className="adobe-btn-group-row">
                        <button
                          type="button"
                          className={`adobe-choice-pill ${config.customFields.signerNameSource === 'certificate' ? 'active' : ''}`}
                          onClick={() => handleCustomFieldChange('signerNameSource', 'certificate')}
                          title="Automatically use the name from DSC certificate (Digitally signed by CN)"
                        >
                          From DSC Certificate
                        </button>
                        <button
                          type="button"
                          className={`adobe-choice-pill ${config.customFields.signerNameSource === 'custom' ? 'active' : ''}`}
                          onClick={() => handleCustomFieldChange('signerNameSource', 'custom')}
                          title="Enter a custom signer name manually"
                        >
                          Custom Name
                        </button>
                        <button
                          type="button"
                          className={`adobe-choice-pill ${config.customFields.signerNameSource === 'none' ? 'active' : ''}`}
                          onClick={() => handleCustomFieldChange('signerNameSource', 'none')}
                          title="Hide the signer name completely — no 'Digitally signed by' or 'Authorized Signer' will appear"
                        >
                          No Name (Hidden)
                        </button>
                      </div>
                    </div>

                    {/* Show certificate-derived name info */}
                    {config.customFields.signerNameSource === 'certificate' && (
                      <div className="adobe-cert-name-info">
                        <span className="adobe-cert-name-label">Certificate Name (from DSC):</span>
                        <span className="adobe-cert-name-value">
                          {config.customFields.signerName || '(No certificate selected — will use DSC common name)'}
                        </span>
                        <span className="adobe-cert-name-hint">
                          This name is automatically extracted from the DSC certificate's Subject CN field.
                          It will be used in the "Digitally signed by" text.
                        </span>
                      </div>
                    )}

                    {/* Show editable name field for custom mode */}
                    {config.customFields.signerNameSource === 'custom' && (
                      <input
                        type="text"
                        className="adobe-input"
                        placeholder="Enter custom signer name"
                        value={config.customFields.signerName}
                        onChange={(e) => handleCustomFieldChange('signerName', e.target.value)}
                      />
                    )}

                    {/* Show message for 'none' mode */}
                    {config.customFields.signerNameSource === 'none' && (
                      <div className="adobe-cert-name-info">
                        <span className="adobe-cert-name-hint" style={{ color: '#f59e0b' }}>
                          The signer name line will be completely hidden. No "Authorized Signer" or certificate name will appear in the signature visual.
                        </span>
                      </div>
                    )}

                    {/* Prefix selector (only when name is visible) */}
                    {config.customFields.signerNameSource !== 'none' && (
                      <div className="adobe-field-inputs-duo">
                        <select
                          className="adobe-select"
                          style={{ width: '180px' }}
                          value={config.customFields.signPrefix}
                          onChange={(e) => handleCustomFieldChange('signPrefix', e.target.value)}
                        >
                          <option value="Digitally signed by">Digitally signed by</option>
                          <option value="Signed by">Signed by</option>
                          <option value="Approved by">Approved by</option>
                          <option value="Certified by">Certified by</option>
                          <option value="Verified by">Verified by</option>
                          <option value="Executed by">Executed by</option>
                          <option value="">No Prefix (Name Only)</option>
                          <option value="__custom__">Custom Prefix...</option>
                        </select>
                        {config.customFields.signPrefix === '__custom__' && (
                          <input
                            type="text"
                            className="adobe-input flex-1"
                            placeholder="Enter custom prefix text"
                            value={config.customFields.signPrefixCustom || ''}
                            onChange={(e) => handleCustomFieldChange('signPrefixCustom', e.target.value)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Reason */}
              <div className="adobe-field-custom-row">
                <div className="adobe-field-header">
                  <label className="adobe-checkbox-item">
                    <input
                      type="checkbox"
                      checked={config.includeText.reason}
                      onChange={() => handleToggleIncludeText('reason')}
                    />
                    <strong>Reason</strong>
                  </label>
                </div>
                {config.includeText.reason && (
                  <div className="adobe-field-column">
                    <input
                      type="text"
                      className="adobe-input"
                      placeholder="Reason for signing"
                      value={config.customFields.reason}
                      onChange={(e) => handleCustomFieldChange('reason', e.target.value)}
                    />
                    <div className="adobe-quick-chips">
                      <span className="chips-label">Quick presets:</span>
                      {REASON_PRESETS.map((r, i) => (
                        <button
                          key={i}
                          type="button"
                          className="adobe-chip-btn"
                          onClick={() => handleCustomFieldChange('reason', r)}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Location & Date in 2 columns */}
              <div className="adobe-fields-duo-grid">
                {/* Location */}
                <div className="adobe-field-custom-row">
                  <div className="adobe-field-header">
                    <label className="adobe-checkbox-item">
                      <input
                        type="checkbox"
                        checked={config.includeText.location}
                        onChange={() => handleToggleIncludeText('location')}
                      />
                      <strong>Location</strong>
                    </label>
                  </div>
                  {config.includeText.location && (
                    <input
                      type="text"
                      className="adobe-input"
                      placeholder="e.g. City, Country or Office"
                      value={config.customFields.location}
                      onChange={(e) => handleCustomFieldChange('location', e.target.value)}
                    />
                  )}
                </div>

                {/* Date Format */}
                <div className="adobe-field-custom-row">
                  <div className="adobe-field-header">
                    <label className="adobe-checkbox-item">
                      <input
                        type="checkbox"
                        checked={config.includeText.date}
                        onChange={() => handleToggleIncludeText('date')}
                      />
                      <strong>Date & Time</strong>
                    </label>
                  </div>
                  {config.includeText.date && (
                    <select
                      className="adobe-select"
                      value={config.customFields.dateFormat}
                      onChange={(e) => handleCustomFieldChange('dateFormat', e.target.value)}
                    >
                      <option value="standard">Standard: YYYY.MM.DD HH:mm:ss +05'30'</option>
                      <option value="date_only">Date Only: YYYY.MM.DD</option>
                      <option value="iso">ISO Format: YYYY-MM-DDTHH:mm:ssZ</option>
                    </select>
                  )}
                </div>
              </div>

              {/* Distinguished Name */}
              <div className="adobe-field-custom-row">
                <div className="adobe-field-header">
                  <label className="adobe-checkbox-item">
                    <input
                      type="checkbox"
                      checked={config.includeText.distinguishedName}
                      onChange={() => handleToggleIncludeText('distinguishedName')}
                    />
                    <strong>Distinguished Name (DN)</strong>
                  </label>
                </div>
                {config.includeText.distinguishedName && (
                  <input
                    type="text"
                    className="adobe-input"
                    placeholder="cn=Name, o=Organization, c=Country"
                    value={config.customFields.distinguishedName}
                    onChange={(e) => handleCustomFieldChange('distinguishedName', e.target.value)}
                  />
                )}
              </div>

              {/* Version & Labels */}
              <div className="adobe-fields-duo-grid">
                {/* Version */}
                <div className="adobe-field-custom-row">
                  <div className="adobe-field-header">
                    <label className="adobe-checkbox-item">
                      <input
                        type="checkbox"
                        checked={config.includeText.adobeVersion}
                        onChange={() => handleToggleIncludeText('adobeVersion')}
                      />
                      <strong>Software Version</strong>
                    </label>
                  </div>
                  {config.includeText.adobeVersion && (
                    <input
                      type="text"
                      className="adobe-input"
                      placeholder="e.g. DocuFuse 1.0.0"
                      value={config.customFields.versionText}
                      onChange={(e) => handleCustomFieldChange('versionText', e.target.value)}
                    />
                  )}
                </div>

                {/* Show Labels */}
                <div className="adobe-field-custom-row" style={{ justifyContent: 'center', display: 'flex', flexDirection: 'column' }}>
                  <label className="adobe-checkbox-item">
                    <input
                      type="checkbox"
                      checked={config.includeText.labels}
                      onChange={() => handleToggleIncludeText('labels')}
                    />
                    <strong>Include field labels (DN:, Date:, Reason:, Location:)</strong>
                  </label>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: Colors, Logo & Style Customization */}
          {activeSettingsTab === 'styling' && (
            <div className="adobe-styling-editor">
              {/* Ink Color Palette */}
              <div className="adobe-style-section">
                <span className="adobe-config-label">Signature Ink Color</span>
                <div className="adobe-color-swatches">
                  {INK_COLORS.map(c => (
                    <button
                      key={c.hex}
                      type="button"
                      className={`adobe-color-swatch-btn ${config.styling.inkColor === c.hex ? 'active' : ''}`}
                      onClick={() => handleStylingChange('inkColor', c.hex)}
                      title={c.label}
                    >
                      <span className="swatch-circle" style={{ backgroundColor: c.bg }} />
                      <span className="swatch-label">{c.label}</span>
                      {config.styling.inkColor === c.hex && (
                        <span className="swatch-check">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Border & Background */}
              <div className="adobe-style-duo-grid">
                <div className="adobe-style-section">
                  <span className="adobe-config-label">Border Style</span>
                  <div className="adobe-btn-group-row">
                    {[
                      { id: 'solid', label: 'Classic Gray' },
                      { id: 'blue', label: 'Official Blue' },
                      { id: 'dashed', label: 'Dashed' },
                      { id: 'none', label: 'None' },
                    ].map(b => (
                      <button
                        key={b.id}
                        type="button"
                        className={`adobe-choice-pill ${config.styling.borderStyle === b.id ? 'active' : ''}`}
                        onClick={() => handleStylingChange('borderStyle', b.id)}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="adobe-style-section">
                  <span className="adobe-config-label">Background</span>
                  <div className="adobe-btn-group-row">
                    {[
                      { id: '#ffffff', label: 'Clean White' },
                      { id: '#f8fafc', label: 'Soft Tint' },
                      { id: 'transparent', label: 'Transparent' },
                    ].map(bg => (
                      <button
                        key={bg.id}
                        type="button"
                        className={`adobe-choice-pill ${config.styling.backgroundColor === bg.id ? 'active' : ''}`}
                        onClick={() => handleStylingChange('backgroundColor', bg.id)}
                      >
                        {bg.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Custom Organization Logo / Emblem / Seal */}
              <div className="adobe-style-section">
                <div className="adobe-field-header" style={{ marginBottom: '8px' }}>
                  <label className="adobe-checkbox-item">
                    <input
                      type="checkbox"
                      checked={config.includeText.logo}
                      onChange={() => handleToggleIncludeText('logo')}
                    />
                    <strong>Custom Organization Logo / Seal / Emblem</strong>
                  </label>
                </div>

                {config.includeText.logo && (
                  <div className="adobe-logo-upload-box">
                    <input
                      ref={logoImageInputRef}
                      type="file"
                      accept="image/png, image/jpeg, image/jpg, image/webp"
                      style={{ display: 'none' }}
                      onChange={handleLogoFileChange}
                    />
                    <div className="adobe-logo-upload-controls">
                      <button
                        type="button"
                        className="adobe-btn-browse"
                        onClick={() => logoImageInputRef.current?.click()}
                      >
                        <Icons.Upload />
                        {config.customFields.customLogoDataUrl ? 'Change Logo Image' : 'Upload Organization Logo / Seal...'}
                      </button>

                      {config.customFields.customLogoDataUrl && (
                        <div className="adobe-image-preview-meta">
                          <img
                            src={config.customFields.customLogoDataUrl}
                            alt="Logo Thumb"
                            className="logo-thumb-small"
                          />
                          <span className="image-filename">{config.customFields.customLogoName || 'Custom Logo'}</span>
                          <button
                            type="button"
                            className="adobe-btn-link-danger"
                            onClick={() => handleCustomFieldChange('customLogoDataUrl', null)}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="adobe-logo-pos-row">
                      <span className="adobe-hint-label">Logo Display Mode:</span>
                      <div className="adobe-btn-group-row">
                        <button
                          type="button"
                          className={`adobe-choice-pill ${config.customFields.logoPosition === 'badge' ? 'active' : ''}`}
                          onClick={() => handleCustomFieldChange('logoPosition', 'badge')}
                        >
                          Corner Certified Badge
                        </button>
                        <button
                          type="button"
                          className={`adobe-choice-pill ${config.customFields.logoPosition === 'watermark' ? 'active' : ''}`}
                          onClick={() => handleCustomFieldChange('logoPosition', 'watermark')}
                        >
                          Subtle Background Watermark
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Text Direction & Digits Format */}
              <div className="adobe-style-duo-grid">
                <div className="adobe-style-section">
                  <span className="adobe-config-label">Text Alignment Direction</span>
                  <div className="adobe-direction-btn-group">
                    <button
                      type="button"
                      className={`adobe-dir-btn ${config.textDirection === 'left' ? 'active' : ''}`}
                      onClick={() => setConfig(prev => ({ ...prev, textDirection: 'left' }))}
                      title="Left Align"
                      id="btn-align-left"
                    >
                      <Icons.AlignLeft />
                      <span>Left</span>
                    </button>
                    <button
                      type="button"
                      className={`adobe-dir-btn ${config.textDirection === 'center' ? 'active' : ''}`}
                      onClick={() => setConfig(prev => ({ ...prev, textDirection: 'center' }))}
                      title="Center Align"
                      id="btn-align-center"
                    >
                      <Icons.AlignCenter />
                      <span>Center</span>
                    </button>
                    <button
                      type="button"
                      className={`adobe-dir-btn ${config.textDirection === 'right' ? 'active' : ''}`}
                      onClick={() => setConfig(prev => ({ ...prev, textDirection: 'right' }))}
                      title="Right Align"
                      id="btn-align-right"
                    >
                      <Icons.AlignRight />
                      <span>Right</span>
                    </button>
                    <button
                      type="button"
                      className={`adobe-dir-btn ${config.textDirection === 'auto' ? 'active' : ''}`}
                      onClick={() => setConfig(prev => ({ ...prev, textDirection: 'auto' }))}
                      title="Auto Align (Standard)"
                      id="btn-align-auto"
                    >
                      <span>Auto</span>
                    </button>
                  </div>
                </div>

                <div className="adobe-style-section">
                  <span className="adobe-config-label">Digits format</span>
                  <select
                    className="adobe-select"
                    value={config.digitsFormat}
                    onChange={(e) => setConfig(prev => ({ ...prev, digitsFormat: e.target.value }))}
                  >
                    <option value="0123456789">0123456789</option>
                    <option value="arabic">٠١٢٣٤٥٦٧٨٩</option>
                    <option value="default">Default</option>
                  </select>
                </div>
              </div>

            </div>
          )}

        </div>

        {/* Footer Actions (Fixed at bottom) */}
        <div className="adobe-sig-modal-footer">
          <div className="adobe-preset-name-box">
            <label htmlFor="input-preset-name">Preset Name</label>
            <input
              id="input-preset-name"
              type="text"
              className="adobe-preset-input"
              value={config.presetName}
              placeholder="e.g. My Official DSC Blue"
              onChange={(e) => setConfig(prev => ({ ...prev, presetName: e.target.value }))}
            />
          </div>

          {savedPresets.length > 0 && (
            <div className="adobe-footer-presets-quick">
              <select
                className="adobe-select"
                style={{ maxWidth: '180px' }}
                onChange={(e) => {
                  const match = savedPresets.find(p => p.presetName === e.target.value);
                  if (match) handleSelectPreset(match);
                }}
                defaultValue=""
              >
                <option value="" disabled>Load Preset...</option>
                {savedPresets.map((p, idx) => (
                  <option key={`${p.presetName}-${idx}`} value={p.presetName}>
                    {p.presetName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="adobe-footer-buttons">
            <button
              type="button"
              className="adobe-btn-cancel"
              onClick={onClose}
              id="btn-adobe-sig-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="adobe-btn-save"
              onClick={handleSave}
              id="btn-adobe-sig-save"
            >
              Save Appearance
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
