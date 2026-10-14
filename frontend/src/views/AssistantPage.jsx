import { Badge, Btn } from "@/components/dashboard/ui";
import { BookIcon, BotIcon, BriefIcon, I, SaveIcon, SendIcon, Share2Icon, SparkIcon, TargetIcon } from "@/components/dashboard/icons";
import ReactMarkdown from "react-markdown";
import api from "@/api/axios";
import { completeCampaignFlowSteps } from "@/utils/campaignContent";
import { detectProposalLanguage } from "@/features/proposals/proposalDocument";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: AI ASSISTANT (contextual)                                */
/* ═══════════════════════════════════════════════════════════════ */
export function AssistantPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const { language: currentLanguage } = useLanguage();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [assistantMessages, setAssistantMessages] = useState([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);

  const assistantEndRef = useRef(null); useEffect(() => {
  assistantEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [assistantMessages, assistantLoading]);

  const suggestions = [
    { icon: BriefIcon, text: t("chat.suggestions.summarize"), color: "text-indigo-600 bg-indigo-50" },
    { icon: TargetIcon, text: t("chat.suggestions.close"), color: "text-teal-600 bg-teal-50" },
    { icon: Share2Icon, text: t("chat.suggestions.linkedin"), color: "text-purple-600 bg-purple-50" },
    { icon: BookIcon, text: t("chat.suggestions.compare"), color: "text-amber-600 bg-amber-50" },
  ];

  const assistantLanguageCopy = {
    en: {
      name: "English",
      noReply: "No response",
      fallback: "I can help with existing proposals, opportunity prioritization, and marketing ideas. The live AI endpoint is not available right now, but this assistant area is ready for DeepSeek-backed responses.",
    },
    es: {
      name: "Spanish",
      noReply: "Sin respuesta",
      fallback: "Puedo ayudarte con propuestas existentes, priorización de oportunidades e ideas de marketing. El endpoint de IA no está disponible en este momento, pero esta área está lista para respuestas respaldadas por DeepSeek.",
    },
    pt: {
      name: "Portuguese",
      noReply: "Sem resposta",
      fallback: "Posso ajudar com propostas existentes, priorização de oportunidades e ideias de marketing. O endpoint de IA não está disponível no momento, mas esta área está pronta para respostas com suporte do DeepSeek.",
    },
  };

  const sendAssistantMessage = async (overrideMessage = "") => {
    const message = (overrideMessage || assistantInput).trim();
    if (!message) return;
    const language = detectProposalLanguage(message);
    const languageCopy = assistantLanguageCopy[language] || assistantLanguageCopy.en;
    const responseInstruction = `Respond strictly in ${languageCopy.name}. Match the language used by the user's message. Do not switch languages unless the user asks you to.`;

    setAssistantInput("");
    setAssistantMessages((prev) => [
      ...prev,
      { role: "user", content: message },
    ]);

    setAssistantLoading(true);

    try {
      const { data } = await api.post("/assistant/chat", {
        message: `${responseInstruction}\n\nUser message:\n${message}`,
        originalMessage: message,
        language,
        responseLanguage: languageCopy.name,
        instruction: responseInstruction,
      });

      setAssistantMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || languageCopy.noReply },
      ]);
    } catch (error) {
      setAssistantMessages((prev) => [
        ...prev,
        { role: "assistant", content: languageCopy.fallback },
      ]);
    } finally {
      setAssistantLoading(false);
    }
  };

  const saveAssistantNote = async (content) => {
    if (!content || content.trim() === "") return;

    if (campaignFlow) {
      const existingNote = campaignFlow.savedNotes?.find(
        (note) => note.campaignId === campaignFlow.campaignId
      );
      if (existingNote) {
        const replace = window.confirm("A note already exists for this campaign. Replace it?");
        if (!replace) return;
      }

      try {
        console.log("Saving note content:", content);
        await api.post("/content/generate/template", {
          template_name: `AI Note — ${campaignFlow.campaignName}`,
          channel: "Email",
          category: "campaign_note",
          tone: "Professional",
          use_case: content,
          merge_variables: ["first_name", "company"],
          language: currentLanguage || "en",
        });
        setCampaignFlow((prev) => ({
          ...prev,
          savedNotes: [
            ...(prev?.savedNotes || []).filter((note) => note.campaignId !== campaignFlow.campaignId),
            {
              content: content,
              campaignId: campaignFlow.campaignId,
              timestamp: new Date().toISOString(),
            },
          ],
        }));
        window.dispatchEvent(new Event("marketgen:content-library-updated"));
        alert(t("chat.noteSaved"));
      } catch (e) {
        console.error("Error saving campaign note:", e);
        alert("Error saving note. Please try again.");
      }
    } else {
      alert(t("chat.noteSaved"));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {campaignFlow?.currentStep === 3 && (
        <>
          <div className="flow-step-banner">
            <span>✦ Step 3: Use the AI Assistant to shape your campaign content (optional)</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [3], 4));
                  onNavigate("content");
                }}
                style={{ background: "transparent", color: "rgb(var(--brand-600))", border: "1px solid rgb(var(--brand-600))", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.85em" }}
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => {
                  setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [3], 4));
                  onNavigate("content");
                }}
              >
                Continue to Assets →
              </button>
            </div>
          </div>
          {campaignFlow?.savedNotes?.length > 0 && (
            <div style={{ fontSize: "0.8em", color: "rgb(var(--brand-600))", marginBottom: 8 }}>
              ✓ {campaignFlow.savedNotes.length} note(s) saved for this campaign
            </div>
          )}
        </>
      )}
      <div className="p-2 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <SparkIcon size={16} className="text-indigo-600" />
          <h2 className="text-sm font-semibold text-gray-900">{t("chat.title")}</h2>
        </div>
        <Badge label={t("chat.contextAware")} color={isDark ? "bg-[#0F172A] text-slate-300 border border-white/10" : "bg-indigo-100 text-indigo-700"} />
      </div>

      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        <div className={`rounded-xl p-2 ${isDark ? "bg-[#0F172A]/40 border border-white/10" : "bg-gray-50"}`}>
          <p className="text-xs font-medium text-gray-500 mb-1">
            {t("chat.suggestedActions")}
          </p>

          <div className="grid grid-cols-2 gap-1">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  setAssistantInput(s.text);
                  sendAssistantMessage(s.text);
              }}
                className={`flex items-center gap-1 p-2.5 rounded-lg border transition-colors text-left ${isDark ? "bg-slate-800 border-white/10 hover:bg-slate-700 hover:border-white/20" : "bg-white border-gray-100 hover:border-indigo-200"}`}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isDark ? `${s.color.replace(/\bbg-\S+/g, "bg-[#0F172A]")} border border-white/10` : s.color}`}>
                  <s.icon size={12} />
                </div>
                <span className={`text-xs ${isDark ? "text-slate-200" : "text-gray-700"}`}>{s.text}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-1 max-w-[80%]">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-100"}`}>
            <BotIcon size={13} className="text-indigo-600" />
          </div>
          <div className={`border rounded-2xl rounded-tl-sm p-2 text-xs ${isDark ? "bg-slate-800 border-white/10 text-slate-200" : "bg-white border-gray-200 text-gray-700"}`}>
            {t("chat.greeting")}
          </div>
        </div>

        {assistantMessages.map((msg, index) => (
          <div
            key={index}
            className={`flex gap-1 ${
              msg.role === "user" ? "justify-end" : "max-w-[80%]"
            }`}
          >
            

            <div
              className={`rounded-2xl p-2 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white rounded-tr-sm max-w-[75%]"
                  : isDark
                    ? "bg-slate-800 border border-white/10 text-slate-200 rounded-tl-sm"
                    : "bg-white border border-gray-200 text-gray-700 rounded-tl-sm"
              }`}
            >
              <ReactMarkdown>
                {msg.content}
              </ReactMarkdown>

          {msg.role === "assistant" && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <Btn
              small
              variant="secondary"
              icon={<SaveIcon size={12} />}
              onClick={() => saveAssistantNote(msg.content)}
            >
              {t("chat.saveAsNote")}
             </Btn>
            </div>
            )}
            </div>
          </div>
        ))}

        {assistantLoading && (
          <div className="flex gap-1 max-w-[80%]">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-100"}`}>
              <BotIcon size={13} className="text-indigo-600" />
            </div>
            <div className={`border rounded-2xl rounded-tl-sm p-2 text-xs ${isDark ? "bg-slate-800 border-white/10 text-slate-400" : "bg-white border-gray-200 text-gray-400"}`}>
              {t("chat.thinking")}
            </div>
          </div>
        )}
        <div ref={assistantEndRef} />
      </div>

      <div className="p-2 border-t border-gray-100 flex gap-1">
        <input
          value={assistantInput}
          onChange={(e) => setAssistantInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && assistantInput.trim()) {
              e.preventDefault();
              sendAssistantMessage();
            }
          }}
          className="flex-1 border border-gray-300 rounded-xl px-4 py-4 text-xs"
          placeholder={t("chat.placeholder")}
        />

        <Btn
          icon={<SendIcon size={14} />}
          disabled={assistantLoading || !assistantInput.trim()}
          onClick={sendAssistantMessage}
        >
          {t("chat.send")}
        </Btn>
      </div>
    </div>
  );
}
