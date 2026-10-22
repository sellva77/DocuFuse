/**
 * Text Sanitizer for PDF generation
 * Prevents "WinAnsi cannot encode" errors in pdf-lib StandardFonts
 * by mapping Unicode symbols (e.g. ₹ Indian Rupee, ₽, ₩, emojis, special quotes, dashes)
 * to safe WinAnsi equivalents.
 */

const SYMBOL_REPLACEMENTS = [
  // Currency symbols
  [/\u20B9/g, 'Rs. '], // Indian Rupee ₹
  [/\u20BD/g, 'RUB '], // Russian Ruble ₽
  [/\u20A9/g, 'KRW '], // Korean Won ₩
  [/\u20BA/g, 'TRY '], // Turkish Lira ₺
  [/\u20A6/g, 'NGN '], // Nigerian Naira ₦
  [/\u0E3F/g, 'THB '], // Thai Baht ฿
  [/\u20AB/g, 'VND '], // Vietnamese Dong ₫
  [/\u20B5/g, 'GHS '], // Ghanaian Cedi ₵
  [/\u20B4/g, 'UAH '], // Ukrainian Hryvnia ₴
  [/\u20AA/g, 'ILS '], // Israeli Shekel ₪
  [/\u20AC/g, 'EUR '], // Euro €

  // Quotes and apostrophes
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u00AB\u00BB]/g, '"'],

  // Dashes and hyphens
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],

  // Bullets and list markers
  [/[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25AB\u25CF\u25CB]/g, '-'],

  // Checkmarks and crosses
  [/[\u2713\u2714\u2611]/g, '[v]'],
  [/[\u2715\u2716\u2717\u2718\u274C\u2612]/g, '[x]'],

  // Math & common symbols
  [/\u2026/g, '...'],
  [/\u00A0/g, ' '], // Non-breaking space
  [/[\u200B\u200C\u200D\uFEFF]/g, ''], // Zero-width spaces
  [/\u2264/g, '<='],
  [/\u2265/g, '>='],
  [/\u2260/g, '!='],
  [/\u00B1/g, '+/-'],
  [/\u2192/g, '->'],
  [/\u2190/g, '<-'],
  [/\u2194/g, '<->'],
  [/\u2248/g, '~'],
];

/**
 * Cache font encode test results for performance across large sheets
 */
const encodableCharCache = new Map();

/**
 * Sanitize text to ensure it can be safely encoded by pdf-lib StandardFonts (WinAnsiEncoding)
 * without throwing "WinAnsi cannot encode" errors.
 *
 * @param {string} text - Input text
 * @param {Object} [font] - Optional pdf-lib font instance to validate against
 * @returns {string} Sanitized string safe for drawText and widthOfTextAtSize
 */
export function sanitizeTextForPdf(text, font = null) {
  if (text === null || text === undefined) return '';
  let str = String(text);
  if (!str) return '';

  // Apply known symbol replacements
  for (const [pattern, replacement] of SYMBOL_REPLACEMENTS) {
    str = str.replace(pattern, replacement);
  }

  // If font is provided, verify every character
  if (font && typeof font.encodeText === 'function') {
    let clean = '';
    const fontName = font.name || 'font';

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const cacheKey = `${fontName}:${char}`;

      if (encodableCharCache.has(cacheKey)) {
        clean += encodableCharCache.get(cacheKey);
        continue;
      }

      try {
        font.encodeText(char);
        encodableCharCache.set(cacheKey, char);
        clean += char;
      } catch {
        // Try decomposing diacritics
        const decomposed = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        let ok = false;
        try {
          font.encodeText(decomposed);
          encodableCharCache.set(cacheKey, decomposed);
          clean += decomposed;
          ok = true;
        } catch {
          ok = false;
        }

        if (!ok) {
          // Unencodable character (e.g. emoji, Asian, complex unicode) -> substitute with space or '?'
          const fallback = char.trim() === '' ? ' ' : '?';
          encodableCharCache.set(cacheKey, fallback);
          clean += fallback;
        }
      }
    }
    return clean;
  }

  // Fallback: replace any characters outside Latin-1 / WinAnsi with ASCII decomposition or '?'
  return str.replace(/[^\x00-\x7F\xA0-\xFF]/g, (ch) => {
    const decomp = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return /^[\x00-\x7F\xA0-\xFF]*$/.test(decomp) ? decomp : '?';
  });
}
