// RF-VTA-01: la base de conocimiento es de la empresa; cualquier usuario carga, solo manager y admin eliminan.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { knowledgeApi, auth } = vi.hoisted(() => ({
  knowledgeApi: { list: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  auth: { user: { roles: ["user"] } },
}));

vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: "es" }) }));
vi.mock("@/api/axios", () => ({ knowledgeApi, authTokenStore: { getUser: () => auth.user } }));

import KnowledgeBaseTab from "@/pages/settings/KnowledgeBaseTab";
import { canDeleteKnowledge } from "@/utils/permissions";

const DOCS = [
  { id: "d1", title: "Perfil NoonDalton", fileType: "docx", sizeBytes: 20480, chunkCount: 3, service: "", client: "" },
  { id: "d2", title: "Caso Clínica Austral", fileType: "docx", sizeBytes: 30720, chunkCount: 4, service: "", client: "" },
];

beforeEach(() => {
  vi.clearAllMocks();
  knowledgeApi.list.mockResolvedValue({ data: { items: DOCS } });
});

describe("canDeleteKnowledge", () => {
  it("solo manager y admin pueden eliminar", () => {
    expect(canDeleteKnowledge({ roles: ["user"] })).toBe(false);
    expect(canDeleteKnowledge({ roles: ["manager"] })).toBe(true);
    expect(canDeleteKnowledge({ roles: ["admin"] })).toBe(true);
    expect(canDeleteKnowledge({})).toBe(false);
  });
});

describe("KnowledgeBaseTab", () => {
  it("un usuario común ve los documentos de la empresa y puede cargar, pero no ve el botón de eliminar", async () => {
    auth.user = { roles: ["user"] };
    const { container } = render(<KnowledgeBaseTab isDark />);
    expect(await screen.findByText("Perfil NoonDalton")).toBeTruthy();
    expect(screen.getByText("Caso Clínica Austral")).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeTruthy();
    expect(screen.queryAllByLabelText("delete")).toHaveLength(0);
    expect(screen.getByText("settings.kbSharedNote")).toBeTruthy();
  });

  it("un manager ve el botón de eliminar en cada documento", async () => {
    auth.user = { roles: ["manager"] };
    render(<KnowledgeBaseTab isDark />);
    await waitFor(() => expect(screen.getAllByLabelText("delete")).toHaveLength(2));
  });
});
