import { useState } from "react";

import { BRAND } from "@/config/brand";

/**
 * Logo de NoonDalton (blanco sobre transparente: se usa siempre sobre fondo de color primario).
 * Si la imagen no carga, muestra el nombre en texto. En `mark` recorta solo el isotipo "ND".
 */
export function BrandLogo({ mark = false, className = "" }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className={`font-bold tracking-tight text-white ${className}`}>{mark ? "ND" : BRAND.name}</span>;
  }

  if (mark) {
    return (
      <span className={`inline-block h-9 w-11 overflow-hidden ${className}`} aria-label={BRAND.name} role="img">
        <img src={BRAND.logoPath} alt="" onError={() => setFailed(true)} className="h-[3.2rem] max-w-none object-cover object-left-top" />
      </span>
    );
  }

  return <img src={BRAND.logoPath} alt={BRAND.name} onError={() => setFailed(true)} className={`h-10 w-auto ${className}`} />;
}
