// Formularios: FormRow alinea por abajo los controles de una misma fila, aunque un campo tenga texto de ayuda de varias líneas.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Field, FormRow } from "@/components/dashboard/ui";

describe("FormRow", () => {
  it("es una grilla de 1 columna que pasa a 2 desde sm, con los controles alineados por abajo", () => {
    const { container } = render(
      <FormRow>
        <Field label="Plantilla" hint="Texto de ayuda largo que ocupa dos líneas"><input /></Field>
        <Field label="Línea de servicio"><input /></Field>
      </FormRow>,
    );
    const row = container.firstChild;
    for (const cls of ["grid", "grid-cols-1", "sm:grid-cols-2", "items-end", "gap-x-3"]) expect(row.className).toContain(cls);
    expect(row.children).toHaveLength(2);
  });

  it("acepta clases extra para casos puntuales", () => {
    const { container } = render(<FormRow className="mb-4"><Field label="A"><input /></Field></FormRow>);
    expect(container.firstChild.className).toContain("mb-4");
  });
});
