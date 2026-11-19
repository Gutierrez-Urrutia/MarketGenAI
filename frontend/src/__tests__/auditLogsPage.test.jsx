// RNF-02: página «Registro de auditoría» (solo administrador): filtros, paginación, textos y acceso.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
const idioma = { language: "es" };
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => idioma, LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));

const apiGet = vi.fn();
let usuario = { name: "Ana", email: "ana@noondalton.com", roles: ["admin"] };
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, get: (...args) => apiGet(...args) },
    authTokenStore: { ...actual.authTokenStore, getUser: () => usuario },
  };
});

const registro = (n, extra = {}) => ({
  id: `r${n}`, userId: `u${n}`, userEmail: `u${n}@example.com`, action: "proposal_created", resourceType: "proposal", resourceId: `prop-${n}`,
  ip: `10.0.0.${n}`, status: "success", timestamp: `2026-11-17T10:0${n}:00+00:00`, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  idioma.language = "es";
  usuario = { name: "Ana", email: "ana@noondalton.com", roles: ["admin"] };
  apiGet.mockResolvedValue({ data: { logs: [registro(1), registro(2, { action: "proposal_deleted", status: "failed" })], hasMore: false } });
});

const abrir = async () => {
  const { AuditLogsPage } = await import("@/views/AuditLogsPage");
  render(<AuditLogsPage />);
};

describe("permisos", () => {
  it("solo el administrador puede ver el registro", async () => {
    const { canViewAuditLogs } = await import("@/utils/permissions");
    expect(canViewAuditLogs({ roles: ["admin", "user"] })).toBe(true);
    expect(canViewAuditLogs({ roles: ["manager", "user"] })).toBe(false);
    expect(canViewAuditLogs({ roles: ["user"] })).toBe(false);
    expect(canViewAuditLogs({})).toBe(false);
  });

  it("un manager no ve la página ni consulta el registro", async () => {
    usuario = { name: "Mario", email: "m@noondalton.com", roles: ["manager"] };
    await abrir();
    expect(screen.queryByText("Registro de auditoría")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe("AuditLogsPage", () => {
  it("muestra usuario, acción con palabras, propuesta, resultado e IP", async () => {
    await abrir();
    await waitFor(() => expect(screen.getByText("u1@example.com")).toBeTruthy());
    expect(screen.getAllByText("Propuesta creada").length).toBeGreaterThan(0);
    expect(screen.getByText("10.0.0.1")).toBeTruthy();
    expect(screen.getByText("prop-1")).toBeTruthy();
    expect(screen.getByText("Correcto")).toBeTruthy();
    expect(screen.getByText("Fallido")).toBeTruthy();
    expect(screen.queryByText("proposal_created")).toBeNull();
    expect(apiGet).toHaveBeenCalledWith("/admin/audit-logs", { params: { limit: 50, offset: 0 } });
  });

  it("deja igual la acción genérica de los registros anteriores", async () => {
    apiGet.mockResolvedValue({ data: { logs: [{ id: "v1", action: "created_proposal", userId: "u1", statusCode: 201, timestamp: "2026-10-01T10:00:00+00:00" }], hasMore: false } });
    await abrir();
    await waitFor(() => expect(screen.getByText("created_proposal")).toBeTruthy());
  });

  it("filtra por acción y por propuesta y limpia los filtros", async () => {
    await abrir();
    await waitFor(() => expect(screen.getByText("u1@example.com")).toBeTruthy());
    fireEvent.change(document.querySelector("select"), { target: { value: "proposal_deleted" } });
    fireEvent.change(screen.getByPlaceholderText("ID de propuesta"), { target: { value: " prop-9 " } });
    fireEvent.click(screen.getByText("Buscar"));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("/admin/audit-logs", { params: { limit: 50, offset: 0, action: "proposal_deleted", resourceId: "prop-9" } }));
    fireEvent.click(screen.getByText("Limpiar"));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("/admin/audit-logs", { params: { limit: 50, offset: 0 } }));
    expect(screen.getByPlaceholderText("ID de propuesta").value).toBe("");
  });

  it("envía las fechas y el usuario", async () => {
    await abrir();
    await waitFor(() => expect(screen.getByText("u1@example.com")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("ID de usuario"), { target: { value: "u7" } });
    const fechas = document.querySelectorAll('input[type="date"]');
    fireEvent.change(fechas[0], { target: { value: "2026-11-01" } });
    fireEvent.change(fechas[1], { target: { value: "2026-11-17" } });
    fireEvent.click(screen.getByText("Buscar"));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("/admin/audit-logs", { params: { limit: 50, offset: 0, userId: "u7", from: "2026-11-01", to: "2026-11-17" } }));
  });

  it("pagina con Siguiente y Anterior según hasMore", async () => {
    apiGet.mockResolvedValue({ data: { logs: [registro(1)], hasMore: true } });
    await abrir();
    await waitFor(() => expect(screen.getByText("u1@example.com")).toBeTruthy());
    expect(screen.getByText("Anterior").disabled).toBe(true);
    expect(screen.getByText("Siguiente").disabled).toBe(false);
    fireEvent.click(screen.getByText("Siguiente"));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("/admin/audit-logs", { params: { limit: 50, offset: 50 } }));
    await waitFor(() => expect(screen.getByText("Anterior").disabled).toBe(false));
    fireEvent.click(screen.getByText("Anterior"));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("/admin/audit-logs", { params: { limit: 50, offset: 0 } }));
  });

  it("Siguiente se deshabilita en la última página", async () => {
    await abrir();
    await waitFor(() => expect(screen.getByText("u1@example.com")).toBeTruthy());
    expect(screen.getByText("Siguiente").disabled).toBe(true);
  });

  it("sin resultados y con error muestra un mensaje", async () => {
    apiGet.mockResolvedValue({ data: { logs: [], hasMore: false } });
    await abrir();
    await waitFor(() => expect(screen.getByText("No se encontraron registros.")).toBeTruthy());
    apiGet.mockRejectedValue(new Error("red"));
    fireEvent.click(screen.getByText("Actualizar"));
    await waitFor(() => expect(screen.getByText("No se pudo cargar el registro de auditoría.")).toBeTruthy());
  });

  it("se muestra en inglés cuando ese es el idioma", async () => {
    idioma.language = "en";
    await abrir();
    await waitFor(() => expect(screen.getByText("Audit log")).toBeTruthy());
    expect(screen.getAllByText("Proposal created").length).toBeGreaterThan(0);
  });
});
