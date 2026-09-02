/**
 * Chat — AI conversational assistant for content strategy and advice.
 * Sprint 8 feature: streaming-style UX with message history.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Send, Bot, User, Trash2, Sparkles } from "lucide-react";
import { v4 as uuidv4 } from "uuid";

import { chatApi } from "@/api/axios";
import Button from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

function detectMessageLanguage(text = "") {
  const value = String(text || "").toLowerCase();
  const spanishScore = [
    /[áéíóúñ¿¡]/,
    /\b(el|la|los|las|un|una|para|con|por|que|cómo|cual|cuál|dame|ayúdame|mejorar|pregunta|respuesta)\b/,
  ].reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
  const portugueseScore = [
    /[ãõç]/,
    /\b(o|a|os|as|um|uma|para|com|por|que|como|qual|ajude|melhorar|pergunta|resposta)\b/,
  ].reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
  if (spanishScore > portugueseScore && spanishScore > 0) return "es";
  if (portugueseScore > spanishScore && portugueseScore > 0) return "pt";
  return "en";
}

const LANGUAGE_COPY = {
  en: { name: "English", fallback: "Sorry, there was an error. Please try again." },
  es: { name: "Spanish", fallback: "Lo siento, hubo un error. Por favor intenta de nuevo." },
  pt: { name: "Portuguese", fallback: "Desculpe, ocorreu um erro. Por favor, tente novamente." },
};

const SUGGESTIONS = [
  "¿Cómo puedo mejorar el SEO del capítulo de introducción?",
  "Dame ideas para el título de un eBook sobre marketing digital",
  "¿Cuál es la diferencia entre un white paper y un caso de estudio?",
  "Ayúdame a definir la audiencia objetivo para mi libro",
];

// ── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({ message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
        isUser ? "bg-primary-100 text-primary-600" : "bg-teal-100 text-teal-600"
      }`}>
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
        isUser
          ? "bg-primary-600 text-white rounded-tr-sm"
          : "bg-white border border-gray-100 text-gray-800 shadow-sm rounded-tl-sm"
      }`}>
        {message.content}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Chat() {
  const [sessionId] = useState(() => uuidv4());
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      content: "¡Hola! Soy tu asistente de contenido con IA. Puedo ayudarte con estrategia de contenido, ideas para libros, optimización de textos y mucho más. ¿En qué te puedo ayudar hoy?",
    },
  ]);
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMut = useMutation({
    mutationFn: (text) => {
      const language = detectMessageLanguage(text);
      const copy = LANGUAGE_COPY[language] || LANGUAGE_COPY.en;
      const instruction = `Respond strictly in ${copy.name}. Match the language used by the user's message. Do not switch languages unless the user asks you to.`;
      return chatApi.send({
        session_id: sessionId,
        message: `${instruction}\n\nUser message:\n${text}`,
        originalMessage: text,
        language,
        responseLanguage: copy.name,
        instruction,
        history: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      });
    },
    onSuccess: (res) => {
      setMessages((prev) => [
        ...prev,
        { id: uuidv4(), role: "assistant", content: res.data?.response ?? "…" },
      ]);
    },
    onError: (_error, text) => {
      const language = detectMessageLanguage(text);
      const copy = LANGUAGE_COPY[language] || LANGUAGE_COPY.en;
      toast.error(language === "en" ? "Error getting response" : language === "pt" ? "Erro ao obter resposta" : "Error al obtener respuesta");
      setMessages((prev) => [
        ...prev,
        { id: uuidv4(), role: "assistant", content: copy.fallback },
      ]);
    },
  });

  const sendMessage = (text) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev,
      { id: uuidv4(), role: "user", content: trimmed },
    ]);
    setInput("");
    sendMut.mutate(trimmed);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([{
      id: "welcome",
      role: "assistant",
      content: "Chat reiniciado. ¿En qué te puedo ayudar?",
    }]);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-teal-50 flex items-center justify-center">
            <Sparkles size={18} className="text-teal-500" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Asistente IA</h1>
            <p className="text-xs text-gray-400">Powered by DeepSeek</p>
          </div>
        </div>
        <button
          onClick={clearChat}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          title="Limpiar chat"
        >
          <Trash2 size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {sendMut.isPending && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center flex-shrink-0">
              <Bot size={16} className="text-teal-600" />
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
              <Spinner size="sm" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions (shown when only welcome message) */}
      {messages.length === 1 && (
        <div className="my-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => sendMessage(s)}
              className="text-left text-sm px-3 py-2.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-primary-50 hover:border-primary-200 hover:text-primary-700 transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="mt-3 flex gap-2 items-end">
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Escribe tu pregunta… (Enter para enviar, Shift+Enter para nueva línea)"
          className="flex-1 resize-none border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-400 bg-white shadow-sm"
        />
        <Button
          variant="primary"
          size="md"
          onClick={() => sendMessage()}
          isLoading={sendMut.isPending}
          disabled={!input.trim() || sendMut.isPending}
          icon={<Send size={16} />}
        />
      </div>
    </div>
  );
}
