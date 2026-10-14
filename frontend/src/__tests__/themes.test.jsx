// Temas: tokens de color (contraste WCAG), aplicación del tema en <html> y selector de tema.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("@/api/axios", () => ({ settingsApi: { get: vi.fn(() => Promise.resolve({ data: {} })), put: vi.fn(() => Promise.resolve({})) } }));

import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { ThemeSwitcher } from "@/components/shell/ThemeSwitcher";

// ── tokens ──────────────────────────────────────────────────────────────────
const css = readFileSync(path.resolve(__dirname, "../styles/tokens.css"), "utf8");

function blockFor(selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\n\\}`));
  return match ? match[1] : "";
}

function tokensOf(theme) {
  const base = blockFor(":root,\\s*\\[data-theme=\"light\"\\]");
  const own = theme === "light" ? "" : blockFor(`\\[data-theme="${theme}"\\]`);
  const vars = {};
  for (const text of [base, own]) {
    for (const [, name, r, g, b] of text.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) vars[name] = [Number(r), Number(g), Number(b)];
  }
  return vars;
}

const luminance = ([r, g, b]) => {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const WHITE = [255, 255, 255];

describe("tokens de color por tema (WCAG AA = 4,5:1 en texto normal)", () => {
  it("el primario de la marca es #225258 y el acento #FF5500", () => {
    expect(tokensOf("light")["brand-600"]).toEqual([34, 82, 88]);
    expect(tokensOf("light")["accent-600"]).toEqual([255, 85, 0]);
  });

  it.each(["light", "dark", "noon"])("%s: texto blanco sobre el primario (botones)", (theme) => {
    expect(contrast(WHITE, tokensOf(theme)["brand-600"])).toBeGreaterThanOrEqual(4.5);
  });

  it("claro: texto principal y secundario sobre tarjeta blanca", () => {
    const t = tokensOf("light");
    expect(contrast(t["n-900"], WHITE)).toBeGreaterThanOrEqual(7);
    expect(contrast(t["n-600"], WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["brand-600"], WHITE)).toBeGreaterThanOrEqual(4.5); // enlaces
  });

  it("oscuro: texto, texto secundario y enlaces sobre la tarjeta", () => {
    const t = tokensOf("dark");
    expect(contrast(t["n-50"], t["surface-card"])).toBeGreaterThanOrEqual(7);
    expect(contrast(t["n-300"], t["surface-card"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["brand-300"], t["surface-card"])).toBeGreaterThanOrEqual(4.5);
  });

  it("noon: texto secundario sobre el fondo arena y sobre la tarjeta", () => {
    const t = tokensOf("noon");
    expect(contrast(t["n-600"], t["surface-page"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["n-900"], t["surface-card"])).toBeGreaterThanOrEqual(7);
  });

  it("texto blanco sobre las barras laterales de cada tema", () => {
    for (const theme of ["light", "dark", "noon"]) {
      const t = tokensOf(theme);
      expect(contrast(WHITE, t["shell-from"])).toBeGreaterThanOrEqual(7);
      expect(contrast(WHITE, t["shell-to"])).toBeGreaterThanOrEqual(7);
    }
  });

  it("el acento solo es válido para elementos grandes sobre blanco (3:1), como indica la guía de marca", () => {
    const ratio = contrast(tokensOf("light")["accent-600"], WHITE);
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThan(4.5);
  });

  it("cada tema define la misma escala de neutros (50 a 950)", () => {
    for (const theme of ["light", "dark", "noon"]) {
      const t = tokensOf(theme);
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) expect(t[`n-${step}`], `${theme} n-${step}`).toBeTruthy();
    }
  });
});

// ── aplicación del tema ─────────────────────────────────────────────────────
const html = document.documentElement;

function Probe() {
  const { theme } = useTheme();
  return <span data-testid="current">{theme}</span>;
}

const mount = async () => {
  await act(async () => {
    render(
      <ThemeProvider>
        <Probe />
        <ThemeSwitcher />
      </ThemeProvider>,
    );
  });
};

describe("ThemeProvider y ThemeSwitcher", () => {
  beforeEach(() => {
    localStorage.clear();
    html.className = "";
    delete html.dataset.theme;
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  it("ofrece los cuatro temas como grupo de opciones accesible", async () => {
    await mount();
    const group = screen.getByRole("radiogroup");
    expect(group).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  it("noon pone data-theme=noon y no activa la clase dark", async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getAllByRole("radio")[2]); });
    expect(screen.getByTestId("current").textContent).toBe("noon");
    expect(html.dataset.theme).toBe("noon");
    expect(html.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("marketgen_theme")).toBe("noon");
  });

  it("oscuro pone data-theme=dark y la clase dark", async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getAllByRole("radio")[1]); });
    expect(html.dataset.theme).toBe("dark");
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("sistema sigue la preferencia del sistema operativo", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await mount();
    await act(async () => { fireEvent.click(screen.getAllByRole("radio")[3]); });
    expect(html.dataset.theme).toBe("dark");
  });

  it("recuerda el tema guardado al volver a montar", async () => {
    localStorage.setItem("marketgen_theme", "noon");
    await mount();
    expect(screen.getByTestId("current").textContent).toBe("noon");
    expect(html.dataset.theme).toBe("noon");
  });

  it("ignora un tema inválido guardado", async () => {
    localStorage.setItem("marketgen_theme", "neon");
    await mount();
    expect(["light", "dark"]).toContain(html.dataset.theme);
  });
});
