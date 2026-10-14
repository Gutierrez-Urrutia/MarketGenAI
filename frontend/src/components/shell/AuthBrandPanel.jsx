import { CheckCircle2 } from "lucide-react";

import { BrandLogo } from "@/components/shell/BrandLogo";

const COPY = {
  es: {
    headline: "Del prospecto a la propuesta, en minutos.",
    sub: "Detecta oportunidades, genera propuestas de BPO con tu propio historial y haz seguimiento en un solo lugar.",
    bullets: ["Propuestas con IA basadas en tus documentos", "Pipeline de prospección y seguimiento", "Exportación a PDF y Word con tu marca"],
  },
  en: {
    headline: "From prospect to proposal, in minutes.",
    sub: "Spot opportunities, draft BPO proposals from your own history and follow up in one place.",
    bullets: ["AI proposals grounded in your documents", "Prospecting pipeline and follow-up", "PDF and Word export with your brand"],
  },
  pt: {
    headline: "Do prospect à proposta, em minutos.",
    sub: "Detecte oportunidades, gere propostas de BPO com seu próprio histórico e acompanhe tudo em um só lugar.",
    bullets: ["Propostas com IA baseadas nos seus documentos", "Pipeline de prospecção e acompanhamento", "Exportação para PDF e Word com sua marca"],
  },
};

/** Panel de marca de la pantalla de acceso (solo en pantallas anchas). */
export function AuthBrandPanel({ language = "es" }) {
  const copy = COPY[language] || COPY.es;
  return (
    <aside
      className="relative hidden overflow-hidden text-white lg:flex lg:flex-col lg:justify-between lg:p-12"
      style={{ background: "linear-gradient(155deg, rgb(var(--shell-from)) 0%, rgb(var(--shell-to)) 100%)" }}
    >
      {/* formas decorativas con el acento de la marca */}
      <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-accent-500/20 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-white/10 blur-3xl" aria-hidden="true" />

      <BrandLogo className="relative !h-14 self-start" />

      <div className="relative max-w-md">
        <h2 className="text-4xl font-bold leading-tight tracking-tight">{copy.headline}</h2>
        <p className="mt-4 text-base leading-relaxed text-white/75">{copy.sub}</p>
        <ul className="mt-8 space-y-3">
          {copy.bullets.map((text) => (
            <li key={text} className="flex items-start gap-3 text-sm text-white/90">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent-400" />
              {text}
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-white/45">© NoonDalton · AI Marketing Suite</p>
    </aside>
  );
}
