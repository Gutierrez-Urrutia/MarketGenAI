// Tema oscuro: toda utilidad hover: de fondo claro usada en la app debe tener su regla oscura en index.css.
// Sin ella, el fondo claro aparece al pasar el cursor y el texto (forzado a claro) deja de leerse.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const LIGHT_HOVER = /(?<![:\w-])hover:bg-(?:(?:gray|slate|neutral|indigo|primary|teal|emerald|red)-(?:50|100|200)|white)(?![\w/-])/g;

const sourceFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return ["__tests__", "legacy", "node_modules"].includes(name) ? [] : sourceFiles(path);
  return /\.(jsx|js)$/.test(name) ? [path] : [];
});

describe("hover en tema oscuro", () => {
  const css = readFileSync(join(SRC, "index.css"), "utf8");
  const darkBlock = css.slice(css.indexOf("Hover en listados, filas y botones fantasma"), css.indexOf(".spinner {"));
  const used = new Set(sourceFiles(SRC).flatMap((file) => readFileSync(file, "utf8").match(LIGHT_HOVER) ?? []));

  it("el bloque oscuro existe", () => {
    expect(darkBlock.length).toBeGreaterThan(200);
  });

  it.each([...used].sort())("%s tiene regla en html.dark", (utility) => {
    expect(darkBlock).toContain(`.${utility.replace(":", String.raw`\:`)}`);
  });
});
