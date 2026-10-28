/**
 * PDF Coordinate Utilities
 * Handles transformations between screen/canvas visual space and PDF points.
 * 
 * In PDF (ISO 32000-1):
 * - Origin (0, 0) is at the bottom-left of the page.
 * - Units are points (1/72 inch).
 * - Pages may have rotation (/Rotate 0, 90, 180, 270).
 * 
 * On Screen / Canvas:
 * - Origin (0, 0) is at top-left.
 * - Dimensions are in CSS pixels (scaled by zoom factor).
 */

/**
 * Get visual dimensions of a page accounting for rotation
 * @param {number} pageWidth - In PDF points
 * @param {number} pageHeight - In PDF points
 * @param {number} rotation - 0, 90, 180, 270
 * @returns {{ visualWidth: number, visualHeight: number }}
 */
export function getVisualPageDimensions(pageWidth, pageHeight, rotation = 0) {
  const normRot = ((rotation % 360) + 360) % 360;
  if (normRot === 90 || normRot === 270) {
    return {
      visualWidth: pageHeight,
      visualHeight: pageWidth,
    };
  }
  return {
    visualWidth: pageWidth,
    visualHeight: pageHeight,
  };
}

/**
 * Normalizes a rectangle so width and height are positive
 */
export function normalizeRect(rect) {
  let { x, y, width, height } = rect;
  if (width < 0) {
    x += width;
    width = Math.abs(width);
  }
  if (height < 0) {
    y += height;
    height = Math.abs(height);
  }
  return { x, y, width, height };
}

/**
 * Clamps a rectangle so it stays strictly within the visual container bounds
 * @param {{ x: number, y: number, width: number, height: number }} rect 
 * @param {{ width: number, height: number }} bounds 
 * @param {number} minSize - Minimum allowed width/height
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function clampRectToBounds(rect, bounds, minSize = 5) {
  let { x, y, width, height } = normalizeRect(rect);

  width = Math.max(minSize, Math.min(width, bounds.width));
  height = Math.max(minSize, Math.min(height, bounds.height));

  x = Math.max(0, Math.min(x, bounds.width - width));
  y = Math.max(0, Math.min(y, bounds.height - height));

  return { x, y, width, height };
}

/**
 * Convert screen drag coordinates to normalized fractions (0..1)
 * @param {{ x: number, y: number, width: number, height: number }} screenRect 
 * @param {number} containerWidth - CSS pixel width of rendered canvas
 * @param {number} containerHeight - CSS pixel height of rendered canvas
 * @returns {{ normX: number, normY: number, normWidth: number, normHeight: number }}
 */
export function screenToNormalized(screenRect, containerWidth, containerHeight) {
  const norm = normalizeRect(screenRect);
  return {
    normX: Math.max(0, Math.min(1, norm.x / containerWidth)),
    normY: Math.max(0, Math.min(1, norm.y / containerHeight)),
    normWidth: Math.max(0, Math.min(1, norm.width / containerWidth)),
    normHeight: Math.max(0, Math.min(1, norm.height / containerHeight)),
  };
}

/**
 * Convert normalized coordinates (0..1) back to screen pixels for a given container
 * @param {{ normX: number, normY: number, normWidth: number, normHeight: number }} normalized 
 * @param {number} containerWidth 
 * @param {number} containerHeight 
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function normalizedToScreen(normalized, containerWidth, containerHeight) {
  return {
    x: normalized.normX * containerWidth,
    y: normalized.normY * containerHeight,
    width: normalized.normWidth * containerWidth,
    height: normalized.normHeight * containerHeight,
  };
}

/**
 * Convert normalized visual coordinates to unrotated PDF coordinates (points)
 * for use in pdf-lib drawing.
 * 
 * @param {Object} options
 * @param {number} options.normX - Fraction from visual left (0..1)
 * @param {number} options.normY - Fraction from visual top (0..1)
 * @param {number} options.normWidth - Width fraction (0..1)
 * @param {number} options.normHeight - Height fraction (0..1)
 * @param {number} options.pageWidth - Unrotated page width in points
 * @param {number} options.pageHeight - Unrotated page height in points
 * @param {number} [options.rotation=0] - Page rotation angle (0, 90, 180, 270)
 * @returns {{ x: number, y: number, width: number, height: number, rotation: number, visualWidth: number, visualHeight: number }}
 */
export function normalizedToPdfPoints({
  normX,
  normY,
  normWidth,
  normHeight,
  pageWidth,
  pageHeight,
  rotation = 0,
}) {
  const normRot = ((rotation % 360) + 360) % 360;
  const { visualWidth, visualHeight } = getVisualPageDimensions(pageWidth, pageHeight, normRot);

  // Visual dimensions in points
  const vx = normX * visualWidth;
  const vy = normY * visualHeight;
  const vw = normWidth * visualWidth;
  const vh = normHeight * visualHeight;

  let x, y, width, height;

  if (normRot === 0) {
    // Standard unrotated page:
    // Origin is bottom-left, y increases upwards
    x = vx;
    y = pageHeight - (vy + vh);
    width = vw;
    height = vh;
  } else if (normRot === 90) {
    // 90 degrees clockwise rotation:
    // Visual X is unrotated Y
    // Visual Y is unrotated X
    x = vy;
    y = vx;
    width = vh;
    height = vw;
  } else if (normRot === 180) {
    // 180 degrees rotation:
    x = pageWidth - (vx + vw);
    y = vy;
    width = vw;
    height = vh;
  } else if (normRot === 270) {
    // 270 degrees rotation:
    x = pageWidth - (vy + vh);
    y = pageHeight - (vx + vw);
    width = vh;
    height = vw;
  }

  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    rotation: normRot,
    visualWidth: Math.round(visualWidth * 100) / 100,
    visualHeight: Math.round(visualHeight * 100) / 100,
  };
}

/**
 * Validate that a placement rectangle is within page bounds
 * @param {Object} rect - { x, y, width, height }
 * @param {number} pageWidth 
 * @param {number} pageHeight 
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePdfPlacement(rect, pageWidth, pageHeight) {
  if (!rect || typeof rect !== 'object') {
    return { valid: false, error: 'Placement rectangle is required' };
  }
  const { x, y, width, height } = rect;

  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return { valid: false, error: 'Placement coordinates must be valid numbers' };
  }

  // Allow compact signatures for tight spaces, small margins, initials, or small stamps
  if (width < 2 || height < 2) {
    return { valid: false, error: `Signature rectangle is too small (${Math.round(width)}x${Math.round(height)} pt). Minimum size: 2x2 pt` };
  }

  // Generous margin tolerance (2 pt) to prevent false failures from floating point rounding at page edges
  if (x < -2 || y < -2 || (x + width) > pageWidth + 2 || (y + height) > pageHeight + 2) {
    return {
      valid: false,
      error: `Signature placement (${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)}x${Math.round(height)}) exceeds page boundaries (${Math.round(pageWidth)}x${Math.round(pageHeight)})`,
    };
  }

  return { valid: true };
}

export default {
  getVisualPageDimensions,
  normalizeRect,
  clampRectToBounds,
  screenToNormalized,
  normalizedToScreen,
  normalizedToPdfPoints,
  validatePdfPlacement,
};
