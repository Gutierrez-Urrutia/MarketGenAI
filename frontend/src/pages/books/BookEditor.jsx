/**
 * BookEditor — Sprint 3: WYSIWYG editor per chapter.
 *
 * Layout:
 *   Left panel (260px)  — collapsible chapter TOC
 *   Center             — TipTap rich-text editor (auto-save every 30s)
 *   Right drawer       — AI refinement toolbar (slide-in)
 *
 * Features:
 *   - Load chapter content from API
 *   - Auto-save (debounced 30 s)
 *   - Manual save button
 *   - AI refinement: rewrite, shorten, expand, fix grammar, translate
 *   - Regenerate single chapter
 *   - Before/after comparison view
 *   - SEO analysis
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

// TipTap
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";

import {
  Save,
  Wand2,
  ChevronLeft,
  ChevronRight,
  BarChart2,
  RefreshCw,
  Copy,
  Check,
  BookOpen,
  AlignLeft,
  Loader2,
  Maximize2,
  Minimize2,
  FileText,
} from "lucide-react";

import { booksApi } from "@/api/axios";
import { useJobPolling } from "@/hooks/useJobPolling";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";

// ── TipTap toolbar ────────────────────────────────────────────────────────────
function EditorToolbar({ editor }) {
  if (!editor) return null;
  const btn = (active, onClick, children, title) => (
    <button
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded text-sm transition-colors ${
        active ? "bg-primary-100 text-primary-700" : "text-gray-500 hover:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-xl">
      {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), <b>B</b>, "Bold")}
      {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), <i>I</i>, "Italic")}
      {btn(editor.isActive("heading", { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), "H1", "Heading 1")}
      {btn(editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), "H2", "Heading 2")}
      {btn(editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), "H3", "Heading 3")}
      <div className="w-px h-5 bg-gray-200 mx-1" />
      {btn(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "• List", "Bullet list")}
      {btn(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), "1. List", "Numbered list")}
      {btn(editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), '" "', "Blockquote")}
      <div className="w-px h-5 bg-gray-200 mx-1" />
      {btn(false, () => editor.chain().focus().undo().run(), "↩", "Undo")}
      {btn(false, () => editor.chain().focus().redo().run(), "↪", "Redo")}
    </div>
  );
}

// ── Chapter TOC panel ─────────────────────────────────────────────────────────
function ChapterTOC({ chapters, activeId, onSelect }) {
  return (
    <nav className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Capítulos</p>
      </div>
      <ul className="flex-1 overflow-y-auto py-2">
        {chapters.map((ch, idx) => (
          <li key={ch.id}>
            <button
              onClick={() => onSelect(ch.id)}
              className={`w-full text-left px-4 py-2.5 flex items-start gap-2.5 transition-colors group ${
                ch.id === activeId
                  ? "bg-primary-50 text-primary-700 border-l-2 border-primary-500"
                  : "text-gray-600 hover:bg-gray-50 border-l-2 border-transparent"
              }`}
            >
              <span className="flex-shrink-0 mt-0.5 text-xs font-bold text-gray-400 w-5">{idx + 1}.</span>
              <span className="text-sm leading-snug line-clamp-2">{ch.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ── AI Drawer ─────────────────────────────────────────────────────────────────
const REFINE_ACTIONS = [
  { id: "rewrite",  label: "Reescribir",       icon: RefreshCw,  instruction: "Rewrite this content to be clearer and more engaging while keeping the same information." },
  { id: "shorten",  label: "Acortar",           icon: Minimize2,  instruction: "Shorten this content significantly while keeping the key points." },
  { id: "expand",   label: "Expandir",          icon: Maximize2,  instruction: "Expand this content with more detail, examples, and supporting information." },
  { id: "grammar",  label: "Corregir gramática", icon: Check,      instruction: "Fix any grammar, spelling, and punctuation errors. Improve sentence structure." },
  { id: "formal",   label: "Hacer más formal",  icon: FileText,   instruction: "Make the tone more formal and professional." },
];

function AIDrawer({ open, onClose, onApply, chapterId, bookId, isRefining, refinedContent }) {
  const [selectedAction, setSelectedAction] = useState(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [showComparison, setShowComparison] = useState(false);

  const handleRefine = () => {
    const instruction = selectedAction
      ? REFINE_ACTIONS.find((a) => a.id === selectedAction)?.instruction
      : customPrompt;
    if (!instruction) return;
    onApply(instruction);
    setShowComparison(true);
  };

  return (
    <div
      className={`fixed inset-y-0 right-0 z-40 w-80 bg-white shadow-2xl border-l border-gray-100 flex flex-col transition-transform duration-300 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Wand2 size={18} className="text-teal-500" />
          <h3 className="text-sm font-semibold text-gray-900">Asistente IA</h3>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Quick actions */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Acciones rápidas
          </p>
          <div className="space-y-1.5">
            {REFINE_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  onClick={() => { setSelectedAction(action.id); setCustomPrompt(""); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedAction === action.id
                      ? "bg-teal-50 text-teal-700 border border-teal-200"
                      : "text-gray-600 hover:bg-gray-50 border border-transparent"
                  }`}
                >
                  <Icon size={14} />
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom prompt */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Instrucción personalizada
          </p>
          <textarea
            rows={4}
            value={customPrompt}
            onChange={(e) => { setCustomPrompt(e.target.value); setSelectedAction(null); }}
            placeholder="Ej: Añade más ejemplos prácticos de empresas reales…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-teal-400"
          />
        </div>

        {/* Refined content preview */}
        {showComparison && refinedContent && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Contenido refinado
            </p>
            <div className="bg-teal-50 rounded-lg p-3 text-xs text-gray-700 max-h-48 overflow-y-auto border border-teal-100">
              <div dangerouslySetInnerHTML={{ __html: refinedContent }} />
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="px-4 py-3 border-t border-gray-100 space-y-2">
        <Button
          variant="teal"
          size="md"
          className="w-full"
          onClick={handleRefine}
          isLoading={isRefining}
          disabled={!selectedAction && !customPrompt.trim()}
          icon={<Wand2 size={14} />}
        >
          Aplicar IA
        </Button>
        {refinedContent && !isRefining && (
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            onClick={() => { onApply("__accept__"); setShowComparison(false); }}
          >
            ✓ Aceptar cambios
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main BookEditor ────────────────────────────────────────────────────────────
export default function BookEditor() {
  const { id: bookId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeChapterId, setActiveChapterId] = useState(null);
  const [tocOpen, setTocOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [refinedContent, setRefinedContent] = useState(null);
  const [isRefining, setIsRefining] = useState(false);
  const [regenJobId, setRegenJobId] = useState(null);
  const [regenProgress, setRegenProgress] = useState(0);
  const autoSaveTimerRef = useRef(null);

  // ── Fetch book + chapters ────────────────────────────────────────────────
  const { data: book } = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => booksApi.getBook(bookId).then((r) => r.data),
  });

  const { data: chapters = [] } = useQuery({
    queryKey: ["chapters", bookId],
    queryFn: () => booksApi.getChapters(bookId).then((r) => r.data ?? []),
    select: (d) => d.sort((a, b) => a.orderIndex - b.orderIndex),
    onSuccess: (d) => {
      if (!activeChapterId && d.length > 0) setActiveChapterId(d[0].id);
    },
  });

  // Auto-select first chapter
  useEffect(() => {
    if (!activeChapterId && chapters.length > 0) {
      setActiveChapterId(chapters[0].id);
    }
  }, [chapters, activeChapterId]);

  const activeChapter = chapters.find((c) => c.id === activeChapterId);

  // ── TipTap editor ─────────────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "El contenido del capítulo aparecerá aquí…" }),
      CharacterCount,
    ],
    content: "",
    onUpdate: () => {
      setIsDirty(true);
      scheduleAutoSave();
    },
  });

  // Load chapter content into editor when chapter changes
  useEffect(() => {
    if (!editor || !activeChapter) return;
    const html = activeChapter.content ?? "<p></p>";
    if (editor.getHTML() !== html) {
      editor.commands.setContent(html, false);
      setIsDirty(false);
      setRefinedContent(null);
    }
  }, [activeChapter?.id, editor]);

  // ── Auto-save ─────────────────────────────────────────────────────────────
  const saveCurrentChapter = useCallback(async (silent = false) => {
    if (!editor || !activeChapterId) return;
    const content = editor.getHTML();
    try {
      setIsSaving(true);
      await booksApi.saveContent(bookId, activeChapterId, { content });
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      setIsDirty(false);
      if (!silent) toast.success("Guardado");
    } catch {
      if (!silent) toast.error("Error al guardar");
    } finally {
      setIsSaving(false);
    }
  }, [editor, bookId, activeChapterId, queryClient]);

  const scheduleAutoSave = useCallback(() => {
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => saveCurrentChapter(true), 30_000);
  }, [saveCurrentChapter]);

  // Keyboard shortcut Ctrl/Cmd+S
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveCurrentChapter();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveCurrentChapter]);

  // ── AI Refine ────────────────────────────────────────────────────────────
  const handleRefine = useCallback(async (instruction) => {
    if (instruction === "__accept__") {
      if (refinedContent) editor.commands.setContent(refinedContent);
      setRefinedContent(null);
      setIsDirty(true);
      return;
    }
    if (!activeChapterId) return;
    try {
      setIsRefining(true);
      const res = await booksApi.refineContent(bookId, activeChapterId, {
        instruction,
        current_content: editor.getHTML(),
      });
      setRefinedContent(res.data?.refined_content ?? "");
    } catch {
      toast.error("Error al refinar contenido");
    } finally {
      setIsRefining(false);
    }
  }, [editor, bookId, activeChapterId, refinedContent]);

  // ── Regenerate single chapter ─────────────────────────────────────────────
  const regenerateChapter = useCallback(async () => {
    if (!activeChapterId) return;
    try {
      const res = await booksApi.generateChapterContent(bookId, activeChapterId, {});
      setRegenJobId(res.data.job_id);
    } catch {
      toast.error("Error al regenerar capítulo");
    }
  }, [bookId, activeChapterId]);

  useJobPolling(regenJobId, {
    onProgress: setRegenProgress,
    onComplete: () => {
      setRegenJobId(null);
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      toast.success("Capítulo regenerado");
    },
    onError: (err) => {
      toast.error(`Error: ${err}`);
      setRegenJobId(null);
    },
  });

  // ── Chapter switch (save first if dirty) ──────────────────────────────────
  const switchChapter = async (newId) => {
    if (isDirty) await saveCurrentChapter(true);
    setActiveChapterId(newId);
    setRefinedContent(null);
  };

  const wordCount = editor?.storage.characterCount?.words() ?? 0;
  const charCount = editor?.storage.characterCount?.characters() ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-gray-50">
      {/* TOC Panel */}
      <div
        className={`flex-shrink-0 bg-white border-r border-gray-100 transition-all duration-300 ${
          tocOpen ? "w-64" : "w-0 overflow-hidden"
        }`}
      >
        {chapters.length > 0 && (
          <ChapterTOC chapters={chapters} activeId={activeChapterId} onSelect={switchChapter} />
        )}
      </div>

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTocOpen((v) => !v)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              title="Toggle TOC"
            >
              <AlignLeft size={18} />
            </button>
            <button
              onClick={() => navigate(`/books`)}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              <ChevronLeft size={16} />
              {book?.title ?? "Libros"}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {isDirty && (
              <span className="text-xs text-amber-500 font-medium">Sin guardar</span>
            )}
            {isSaving && <Loader2 size={14} className="animate-spin text-gray-400" />}

            <button
              onClick={regenerateChapter}
              disabled={Boolean(regenJobId)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="Regenerar este capítulo con IA"
            >
              {regenJobId
                ? <><Loader2 size={12} className="animate-spin" /> {regenProgress}%</>
                : <><RefreshCw size={12} /> Regenerar</>}
            </button>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAiOpen((v) => !v)}
              icon={<Wand2 size={14} />}
            >
              IA
            </Button>

            <Button
              variant="primary"
              size="sm"
              onClick={() => saveCurrentChapter()}
              isLoading={isSaving}
              icon={<Save size={14} />}
            >
              Guardar
            </Button>
          </div>
        </div>

        {/* Chapter title */}
        {activeChapter && (
          <div className="px-8 pt-6 pb-2 bg-white border-b border-gray-50">
            <div className="flex items-center gap-2 max-w-3xl mx-auto">
              <span className="text-sm font-medium text-gray-400">
                Capítulo {chapters.findIndex((c) => c.id === activeChapterId) + 1}
              </span>
              <Badge status={activeChapter.status ?? "draft"} />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mt-1 max-w-3xl mx-auto">
              {activeChapter.title}
            </h2>
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-6">
            <div className="bg-white rounded-xl border border-gray-100 shadow-card overflow-hidden">
              <EditorToolbar editor={editor} />
              <EditorContent
                editor={editor}
                className="prose prose-slate max-w-none min-h-[60vh] p-6 focus:outline-none text-gray-800"
              />
            </div>

            {/* Word count */}
            <div className="flex justify-end gap-4 mt-2 text-xs text-gray-400">
              <span>{wordCount.toLocaleString()} palabras</span>
              <span>{charCount.toLocaleString()} caracteres</span>
            </div>
          </div>
        </div>
      </div>

      {/* AI Drawer */}
      <AIDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onApply={handleRefine}
        chapterId={activeChapterId}
        bookId={bookId}
        isRefining={isRefining}
        refinedContent={refinedContent}
      />

      {/* Backdrop for AI drawer on mobile */}
      {aiOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => setAiOpen(false)}
        />
      )}
    </div>
  );
}
