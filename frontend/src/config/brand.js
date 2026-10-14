/**
 * Corporate brand settings for exported documents (proposal preview, PDF and DOCX).
 *
 * This is the ONLY place to change NoonDalton's identity. When the official assets
 * arrive: replace the file at `logoPath` and the values in BRAND_BASE. Every other
 * color (soft tints, deep tones) is derived from these, so nothing else needs editing.
 *
 * Current values are the provisional palette the app already used.
 */

const BRAND_BASE = {
  name: "NoonDalton",
  logoPath: "/brand/logo-placeholder.png",
  primaryColor: "#6366F1",
  secondaryColor: "#1A2B4A",
  textColor: "#1F2937",
  font: "Inter",
};

// Neutral grays shared by all documents (not brand-specific).
const NEUTRALS = {
  muted: "#64748B",
  border: "#D8DEE8",
  surface: "#F6F8FB",
  white: "#FFFFFF",
};

function hexToRgb(hex) {
  const value = String(hex || "").replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int) || full.length !== 6) return [0, 0, 0];
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Mixes `hex` with `withHex`; `amount` is the share of `withHex` (0..1). */
export function mixColors(hex, withHex, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(withHex);
  return rgbToHex(a.map((channel, index) => channel * (1 - amount) + b[index] * amount));
}

export const BRAND = {
  ...BRAND_BASE,
  fontStack: `${BRAND_BASE.font}, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
  colors: {
    primary: BRAND_BASE.primaryColor,
    primarySoft: mixColors(BRAND_BASE.primaryColor, NEUTRALS.white, 0.9),
    primaryTint: mixColors(BRAND_BASE.primaryColor, NEUTRALS.white, 0.95),
    primaryLine: mixColors(BRAND_BASE.primaryColor, NEUTRALS.white, 0.65),
    secondary: BRAND_BASE.secondaryColor,
    secondaryDeep: mixColors(BRAND_BASE.secondaryColor, "#000000", 0.35),
    text: BRAND_BASE.textColor,
    ...NEUTRALS,
  },
};

/** Hex without "#", as the docx library expects. */
export const docxColor = (hex) => String(hex || "").replace("#", "").toUpperCase();

/** [r, g, b] tuple, as jsPDF's setTextColor expects. */
export const rgbColor = (hex) => hexToRgb(hex);

/** CSS custom properties consumed by the proposal styles in index.css. */
export function brandCssVariables(brand = BRAND) {
  const c = brand.colors;
  return {
    "--brand-font": brand.fontStack,
    "--brand-primary": c.primary,
    "--brand-primary-soft": c.primarySoft,
    "--brand-primary-tint": c.primaryTint,
    "--brand-primary-line": c.primaryLine,
    "--brand-secondary": c.secondary,
    "--brand-secondary-deep": c.secondaryDeep,
    "--brand-text": c.text,
    "--brand-muted": c.muted,
    "--brand-border": c.border,
    "--brand-surface": c.surface,
  };
}

export function applyBrandCssVariables(target = typeof document !== "undefined" ? document.documentElement : null) {
  if (!target) return;
  Object.entries(brandCssVariables()).forEach(([name, value]) => target.style.setProperty(name, value));
}

/** Reads width/height from PNG or JPEG bytes (no DOM needed). */
export function readImageSize(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  if (isPng && data.length >= 24) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { type: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  if (isJpeg) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      const length = (data[offset + 2] << 8) + data[offset + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          type: "jpg",
          height: (data[offset + 5] << 8) + data[offset + 6],
          width: (data[offset + 7] << 8) + data[offset + 8],
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function bytesToDataUrl(bytes, type) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:image/${type === "jpg" ? "jpeg" : type};base64,${btoa(binary)}`;
}

let logoPromise = null;

/**
 * Loads the brand logo once. Resolves to { bytes, dataUrl, type, width, height },
 * or null when the file is missing or not a PNG/JPEG, so exports never break on it.
 */
export function loadBrandLogo({ force = false } = {}) {
  if (logoPromise && !force) return logoPromise;
  logoPromise = (async () => {
    try {
      const response = await fetch(BRAND.logoPath);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const size = readImageSize(bytes);
      if (!size || !size.width || !size.height) return null;
      return { bytes, dataUrl: bytesToDataUrl(bytes, size.type), ...size };
    } catch {
      return null;
    }
  })();
  // Don't cache a failure: a later export retries the download.
  logoPromise.then((logo) => { if (!logo) logoPromise = null; });
  return logoPromise;
}
