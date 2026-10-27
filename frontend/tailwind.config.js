// Las escalas de color salen de variables CSS (src/styles/tokens.css), una por tema.
// `indigo` y `teal` apuntan a la escala de marca, y `slate` y `gray` a los neutros con tinte
// verde azulado: todo el código existente que las usa cambia con el tema sin tocar cada componente.
const scale = (prefix) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
      step,
      `rgb(var(--${prefix}-${step}) / <alpha-value>)`,
    ]),
  );

const brand = scale("brand");
const neutral = scale("n");

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand,
        indigo: brand,
        teal: brand,
        accent: scale("accent"),
        slate: neutral,
        gray: neutral,
        neutral,
        page: "rgb(var(--surface-page) / <alpha-value>)",
        card: "rgb(var(--surface-card) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
      borderRadius: {
        lg: "0.625rem",
        xl: "0.875rem",
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        // sombras suaves y en capas, teñidas con el color del tema
        sm: "0 1px 2px rgb(var(--shadow-rgb) / 0.06), 0 1px 3px rgb(var(--shadow-rgb) / 0.05)",
        DEFAULT: "0 2px 4px rgb(var(--shadow-rgb) / 0.06), 0 4px 12px rgb(var(--shadow-rgb) / 0.06)",
        md: "0 4px 8px rgb(var(--shadow-rgb) / 0.07), 0 8px 20px rgb(var(--shadow-rgb) / 0.07)",
        lg: "0 8px 16px rgb(var(--shadow-rgb) / 0.08), 0 16px 36px rgb(var(--shadow-rgb) / 0.09)",
        xl: "0 12px 24px rgb(var(--shadow-rgb) / 0.10), 0 24px 56px rgb(var(--shadow-rgb) / 0.12)",
        glow: "0 0 0 4px rgb(var(--accent-600) / 0.18)",
      },
    },
  },
  plugins: [],
};
