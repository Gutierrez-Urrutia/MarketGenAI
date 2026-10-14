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
