// RF-VTA-09: asistente único de ventas y marketing (enviar mensajes, historial, errores).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { api } = vi.hoisted(() => ({ api: { post: vi.fn() } }));

vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }) }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("react-markdown", () => ({ default: ({ children }) => <span>{children}</span> }));
vi.mock("@/api/axios", () => ({ default: api }));

import { AssistantPage } from "@/views/AssistantPage";

const input = () => screen.getByPlaceholderText("chat.placeholder");

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("AssistantPage", () => {
  it("envía lo escrito al pulsar el botón Enviar", async () => {
    api.post.mockResolvedValue({ data: { reply: "Tienes 2 propuestas" } });
    render(<AssistantPage />);
    fireEvent.change(input(), { target: { value: "¿Qué propuestas tengo?" } });
    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));

    expect(await screen.findByText("Tienes 2 propuestas")).toBeTruthy();
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/assistant/chat");
    expect(body.message).toBe("¿Qué propuestas tengo?");
    expect(body.history).toEqual([]);
    expect(input().value).toBe("");
  });

  it("envía lo escrito con Enter", async () => {
    api.post.mockResolvedValue({ data: { reply: "ok" } });
    render(<AssistantPage />);
    fireEvent.change(input(), { target: { value: "hola" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });

  it("reenvía el historial real y no los mensajes de error", async () => {
    api.post.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ data: { reply: "respuesta 2" } });
    render(<AssistantPage />);

    fireEvent.change(input(), { target: { value: "primera" } });
    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
    await screen.findByText(/Noa/i);

    fireEvent.change(input(), { target: { value: "segunda" } });
    fireEvent.click(screen.getByRole("button", { name: "chat.send" }));
    await screen.findByText("respuesta 2");

    expect(api.post.mock.calls[1][1].history).toEqual([{ role: "user", content: "primera" }]);
  });

  it("una sugerencia envía su texto", async () => {
    api.post.mockResolvedValue({ data: { reply: "ok" } });
    render(<AssistantPage />);
    fireEvent.click(screen.getByText("chat.suggestions.summarize"));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1].message).toBe("chat.suggestions.summarize");
  });

  it("no envía un mensaje vacío", () => {
    render(<AssistantPage />);
    expect(screen.getByRole("button", { name: "chat.send" }).disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });
});
