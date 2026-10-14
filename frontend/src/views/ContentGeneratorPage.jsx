import { ASSET_REGENERATION_TYPES, ASSET_REGENERATION_VARIATION_INSTRUCTION } from "@/utils/assetRegeneration";
import { AsyncJobCard } from "@/components/dashboard/AsyncJobCard";
import { Badge, Btn, Card, Field, Input, Select } from "@/components/dashboard/ui";
import { DownloadIcon, EyeIcon, PenIcon, PlusIcon, RefreshIcon, SparkIcon } from "@/components/dashboard/icons";
import { PREF_KEYS, getStoredPreference } from "@/utils/localStore";
import api from "@/api/axios";
import { stripHtml } from "@/utils/htmlText";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/context/ThemeContext";
import { BookConceptsExperience } from "@/features/books/BookConceptsExperience";

export function ContentGeneratorPage() {
  const { t, language } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const defaultBookForm = {
    title: t("books.defaultTitle"),
    description: t("books.defaultDescription"),
    keywords: t("books.defaultKeywords"),
    chapterCount: 5,
  };
  const previousBookDefaultsRef = useRef(defaultBookForm);
  const [bookView, setBookView] = useState("creating");
  const [savedBooks, setSavedBooks] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [book, setBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [activeBookStep, setActiveBookStep] = useState(1);
  const [job, setJob] = useState(null);
  const [jobTitle, setJobTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [editableChapters, setEditableChapters] = useState([]);
  const [contentDrafts, setContentDrafts] = useState({});
  const [refineText, setRefineText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [toast, setToast] = useState("");
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [assets, setAssets] = useState([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [loadingRefine, setLoadingRefine] = useState(false);
  const [regenerateStatus, setRegenerateStatus] = useState(null);
  const [deletedChapterIds, setDeletedChapterIds] = useState([]);
  const [form, setForm] = useState(defaultBookForm);
  const [bookLanguage, setBookLanguage] = useState(language || getStoredPreference(PREF_KEYS.language, "en"));
  const [bookLanguageManuallySelected, setBookLanguageManuallySelected] = useState(false);

  const updateForm = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  useEffect(() => {
    if (!bookLanguageManuallySelected) {
      setBookLanguage(language || getStoredPreference(PREF_KEYS.language, "en"));
    }
  }, [language, bookLanguageManuallySelected]);

  useEffect(() => {
    const previousDefaults = previousBookDefaultsRef.current;
    setForm((current) => ({
      ...current,
      title: current.title === previousDefaults.title ? defaultBookForm.title : current.title,
      description: current.description === previousDefaults.description ? defaultBookForm.description : current.description,
      keywords: current.keywords === previousDefaults.keywords ? defaultBookForm.keywords : current.keywords,
    }));
    previousBookDefaultsRef.current = defaultBookForm;
  }, [language]);

  const toastTimer = useRef(null);
  function showToast(message) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }

  async function loadLibrary() {
    setLoadingLibrary(true);
    try {
      const { data } = await api.get("/books", { suppressPermissionToast: true });
      setSavedBooks(data.books || data.data || data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingLibrary(false);
    }
  }

  useEffect(() => {
    if (bookView === "library") loadLibrary();
  }, [bookView]);

  const formatRelativeBookDate = (value) => {
    if (!value) return "Recently";
    const raw = value?._seconds ? value._seconds * 1000 : value;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "Recently";
    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays} days ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths === 1) return "1 month ago";
    if (diffMonths < 12) return `${diffMonths} months ago`;
    const diffYears = Math.floor(diffMonths / 12);
    return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
  };

  const bookStatusColor = (status = "draft") => {
    if (status === "published") return "bg-green-100 text-green-700";
    return "bg-yellow-100 text-yellow-700";
  };

  const openSavedBook = async (bookId) => {
    const loaded = await loadBook(bookId);
    if (loaded) {
      setForm({
        title: loaded.title || "",
        description: loaded.description || "",
        keywords: Array.isArray(loaded.keywords) ? loaded.keywords.join(", ") : (loaded.keywords || ""),
        chapterCount: (loaded.chapters && loaded.chapters.length) || 5,
      });
      if (loaded.chapters && loaded.chapters.length > 0) {
        const hasContent = loaded.chapters.some((c) => c.content?.trim());
        setActiveBookStep(hasContent ? 3 : 2);
      } else {
        setActiveBookStep(1);
      }
    }
    setBookView("creating");
  };

  const deleteSavedBook = async (bookId) => {
    try {
      await api.delete(`/books/${bookId}`, { suppressPermissionToast: true });
      await loadLibrary();
    } catch (e) {
      console.error(e);
    }
  };

  async function loadAssets() {
    if (!book?.id) return;
    setLoadingAssets(true);
    try {
      const { data } = await api.get("/assets", { params: { book_id: book.id }, suppressPermissionToast: true });
      setAssets(data.items || data.assets || data.data || data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingAssets(false);
    }
  }

  const demoChapters = () => Array.from({ length: Number(form.chapterCount) || 5 }, (_, index) => ({
    id: `demo-chapter-${index + 1}`,
    title: [
      "Fundamentos del Marketing con IA",
      "Automatización de Campañas",
      "Creación de Contenido con IA",
      "Segmentación y Personalización",
      "Medición, Análisis y Optimización",
    ][index] || `${t("books.chapter")} ${index + 1}`,
    description: [
      "Introducción al rol de la IA en marketing: casos de uso, beneficios y mitos. Tono divulgativo para un lector B2B.",
      "Cómo diseñar flujos automatizados de email, anuncios y nurturing. Incluir ejemplos de triggers y segmentos dinámicos.",
      "Frameworks para generar borradores, mantener la voz de marca y editar con IA. Tono práctico, orientado a producción.",
      "Modelos de segmentación dinámica y personalización 1:1 a escala. Explicar datos necesarios y privacidad.",
      "KPIs, atribución y ciclos de experimentación. Cerrar el libro con un plan de mejora continua.",
    ][index] || t("books.noPreviewContent"),
    orderIndex: index,
    status: "generated",
  }));

  const normalizeBookChapters = (items = []) => [...items].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));

  const applyBookChapters = (items = []) => {
    const sortedChapters = normalizeBookChapters(items);
    setChapters(sortedChapters);
    setEditableChapters(sortedChapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title || "",
      description: chapter.description || "",
    })));
    setContentDrafts(Object.fromEntries(sortedChapters.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
    return sortedChapters;
  };

  const runDemoJob = (title, onComplete) => {
    const jobId = `demo-${Date.now()}`;
    setJobTitle(title);
    setJob({ id: jobId, status: "processing", progress: 10 });

    [35, 65, 100].forEach((progress, index) => {
      setTimeout(() => {
        setJob({
          id: jobId,
          status: progress === 100 ? "completed" : "processing",
          progress,
        });
        if (progress === 100) onComplete?.();
      }, (index + 1) * 650);
    });
  };

  const loadBook = async (bookId) => {
    const { data } = await api.get(`/books/${bookId}`, { suppressPermissionToast: true });
    let sortedChapters = normalizeBookChapters(data.chapters || []);
    if (sortedChapters.length === 0) {
      try {
        const chaptersResponse = await api.get(`/books/${bookId}/chapters`, { suppressPermissionToast: true });
        const chapterData = chaptersResponse.data?.chapters || chaptersResponse.data?.data || chaptersResponse.data || [];
        sortedChapters = normalizeBookChapters(Array.isArray(chapterData) ? chapterData : []);
      } catch (error) {
        if (![401, 403, 404, 500].includes(error.response?.status)) throw error;
      }
    }
    setBook(data);
    applyBookChapters(sortedChapters);
    return { ...data, chapters: sortedChapters };
  };

  useEffect(() => {
    if (!job?.id || ["completed", "failed", "error"].includes(job.status)) return undefined;

    const timer = setInterval(async () => {
      try {
        const { data } = await api.get(`/jobs/${job.id}`, { suppressPermissionToast: true });
        setJob(prev => ({ ...data, _kind: prev?._kind || '' }));
        if (data.status === "completed" && book?.id) {
          const kind = job?._kind || '';
          await loadBook(book.id);
          setContentDrafts((prev) => {
            const cleaned = {};
            Object.entries(prev).forEach(([key, value]) => { cleaned[key] = stripHtml(value); });
            return cleaned;
          });
          if (kind === 'chapters') setActiveBookStep(2);
          if (kind === 'content') {
            setActiveBookStep(3);
          }
          if (kind === 'export') {
            setActiveBookStep(4);
            await loadAssets();
          }
          setJob(prev => ({ ...data, _kind: prev?._kind || '' }));
        }
      } catch (error) {
        console.error(error);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [job?.id, job?.status, book?.id]);

  useEffect(() => {
    if (!activeChapterId || !chapters.some((chapter) => chapter.id === activeChapterId)) {
      if (chapters.length > 0) setActiveChapterId(chapters[0].id);
    }
  }, [activeChapterId, chapters]);

  useEffect(() => {
    if (activeBookStep === 4 && book?.id) loadAssets();
  }, [activeBookStep, book?.id]);

  const createDraftBook = async (forceNew = false) => {
    if (book?.id && !forceNew) return book;
    const { data } = await api.post("/books", {
        title: form.title,
        description: form.description,
        keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
    }, { suppressPermissionToast: true });
    setBook(data);
    setChapters([]);
    setEditableChapters([]);
    setContentDrafts({});
    setJob(null);
    return data;
  };

  const createBook = async () => {
    setLoading(true);
    try {
      const data = await createDraftBook(true);
      await startJob(
        t("books.jobs.chapters"),
        `/books/${data.id}/chapters/generate`,
        { chapterCount: Number(form.chapterCount) || 5, language: bookLanguage, sync: true },
        "chapters",
        { bookId: data.id },
      );
      await loadBook(data.id);
      setActiveBookStep(2);
    } catch (error) {
      if (![401, 403].includes(error.response?.status)) throw error;
      const demo = demoChapters();
      setBook({
        id: `demo-book-${Date.now()}`,
        title: form.title,
        description: form.description,
        keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
        status: "generated",
      });
      setChapters(demo.map((chapter) => ({ ...chapter, status: "generated", content: `<h2>${chapter.title}</h2><p>${chapter.description}</p>` })));
      setEditableChapters(demo.map((chapter) => ({ id: chapter.id, title: chapter.title, description: chapter.description || "" })));
      setContentDrafts(Object.fromEntries(demo.map((chapter) => [chapter.id, stripHtml(`<h2>${chapter.title}</h2><p>${chapter.description}</p>`)])));
      setJob(null);
      setActiveBookStep(2);
    } finally {
      setLoading(false);
    }
  };

  const startJob = async (title, endpoint, payload = {}, jobKind = "", options = {}) => {
    const targetBookId = options.bookId || book?.id;
    if (!targetBookId) return null;
    setLoading(true);
    try {
      const { data } = await api.post(endpoint, payload, { suppressPermissionToast: true, timeout: 0 });
      const jobId = data.job_id || data.jobId || data.id;
      setJobTitle(title);
      setJob({ id: jobId, status: data.status || "pending", progress: 0, _kind: jobKind });
      if (payload.sync && jobId) {
        const jobResponse = await api.get(`/jobs/${jobId}`, { suppressPermissionToast: true });
        const jobData = { ...jobResponse.data, _kind: jobKind };
        setJob(jobData);
        if (jobData.status === 'completed') {
          const latestBook = await loadBook(targetBookId);
          if (jobKind === 'chapters') {
            if ((latestBook?.chapters || []).length === 0) applyBookChapters(demoChapters());
            setActiveBookStep(2);
          }
          if (jobKind === 'content') {
            setContentDrafts((prev) => {
              const cleaned = {};
              Object.entries(prev).forEach(([k, v]) => { cleaned[k] = stripHtml(v); });
              return cleaned;
            });
            setActiveBookStep(3);
          }
          if (jobKind === 'export') {
            setActiveBookStep(4);
            await loadAssets();
          }
        }
        // Si no completó, el useEffect de polling detectará _kind y avanzará cuando termine
      }
      return data;
    } catch (error) {
      if (![401, 403, 404, 500].includes(error.response?.status)) throw error;
      if (jobKind === "chapters") {
        runDemoJob(title, () => {
          const demo = demoChapters();
          setChapters(demo);
          setEditableChapters(demo.map((chapter) => ({ id: chapter.id, title: chapter.title, description: chapter.description || "" })));
          setContentDrafts(Object.fromEntries(demo.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
          setBook((current) => ({ ...current, status: "outlined" }));
          setActiveBookStep(2);
        });
      } else if (jobKind === "content") {
        runDemoJob(title, () => {
          setChapters((current) => {
            const next = current.map((chapter) => ({ ...chapter, status: "generated", content: chapter.content || `<h2>${chapter.title}</h2><p>${chapter.description || ""}</p>` }));
            setContentDrafts(Object.fromEntries(next.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
            return next;
          });
          setBook((current) => ({ ...current, status: "generated" }));
          setActiveBookStep(3);
        });
      } else {
        runDemoJob(title, () => setActiveBookStep(4));
      }
      return null;
    } finally {
      setLoading(false);
    }
  };

  const generateChapters = async () => {
    let targetBook = book;
    if (!targetBook?.id) {
      setLoading(true);
      try {
        targetBook = await createDraftBook();
      } catch (error) {
        if (![401, 403].includes(error.response?.status)) throw error;
        const demoBook = {
          id: `demo-book-${Date.now()}`,
          title: form.title,
          description: form.description,
          keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
          status: "draft",
        };
        setBook(demoBook);
        targetBook = demoBook;
      } finally {
        setLoading(false);
      }
    }
    const result = await startJob(
      t("books.jobs.chapters"),
      `/books/${targetBook.id}/chapters/generate`,
      { chapterCount: Number(form.chapterCount) || 5, language: bookLanguage, sync: true },
      "chapters",
      { bookId: targetBook.id },
    );
    if (targetBook?.id && !String(targetBook.id).startsWith("demo-")) {
      try { await loadBook(targetBook.id); } catch (_) {}
    }
    setActiveBookStep(2);
    return result;
  };

  const generateContent = () => startJob(
    t("books.jobs.content"),
    `/books/${book.id}/content/generate`,
    { contentType: "long", style: "professional", language: bookLanguage, sync: true },
    "content",
  );

  const exportBook = () => {
    setActiveBookStep(4);
    return startJob(
      t("books.jobs.export"),
      `/books/${book.id}/assets/whitepaper`,
      { bookId: book.id, chapterIds: chapters.map((chapter) => chapter.id), language: bookLanguage },
      "export",
    );
  };

  const generateOnePager = () => startJob(
    "Generating one-pager...",
    `/books/${book.id}/assets/one-pager`,
    {
      bookId: book.id,
      style: "professional",
      language: bookLanguage,
    },
    "export",
  );

  const generateSocialPosts = () => startJob(
    "Generating social posts...",
    `/books/${book.id}/assets/social-posts`,
    {
      bookId: book.id,
      chapterId: activeChapterId && !String(activeChapterId).startsWith("local-") && !String(activeChapterId).startsWith("demo-chapter-")
        ? activeChapterId
        : undefined,
      platforms: ["linkedin", "twitter", "facebook"],
      tone: "professional",
      language: bookLanguage,
    },
    "export",
  );

  const generateInfographic = () => startJob(
    "Generating infographic...",
    `/books/${book.id}/assets/infographic`,
    {
      bookId: book.id,
      chapterId: activeChapterId && !String(activeChapterId).startsWith("local-") && !String(activeChapterId).startsWith("demo-chapter-")
        ? activeChapterId
        : undefined,
      style: "modern",
      language: bookLanguage,
    },
    "export",
  );

  const regenerateAllAssets = async () => {
    if (!book?.id) return;
    setRegenerateStatus(Object.fromEntries(ASSET_REGENERATION_TYPES.map((asset) => [asset.key, "pending"])));

    const results = await Promise.allSettled(
      ASSET_REGENERATION_TYPES.map((asset) => api.post(
        `/books/${book.id}/${asset.path}`,
        {
          bookId: book.id,
          ...(asset.key === "whitepaper" ? { chapterIds: chapters.map((chapter) => chapter.id) } : {}),
          language: bookLanguage,
          ...(asset.forceRegenerate ? { forceRegenerate: true } : {}),
          variationInstruction: ASSET_REGENERATION_VARIATION_INSTRUCTION,
        },
        { suppressPermissionToast: true, timeout: 0 },
      )),
    );

    const nextStatus = {};
    const failed = [];
    results.forEach((result, index) => {
      const asset = ASSET_REGENERATION_TYPES[index];
      nextStatus[asset.key] = result.status === "fulfilled" ? "success" : "error";
      if (result.status === "rejected") {
        failed.push(asset);
        console.error(`regenerateAllAssets: ${asset.key} failed`, result.reason);
      }
    });
    setRegenerateStatus(nextStatus);

    await loadAssets();

    if (failed.length === 0) {
      showToast(t("books.regenerateAllSuccess"));
    } else {
      showToast(`${t("books.regenerateAllPartialError")}: ${failed.map((asset) => t(`books.${asset.labelKey}`)).join(", ")}`);
    }
  };

  const saveChapterChanges = async (stayOnStep = true) => {
    if (!book?.id) return;
    setLoading(true);
    try {
      if (editableChapters.some((chapter) => String(chapter.id).startsWith("demo-chapter-"))) {
        const nextChapters = editableChapters.map((chapter, index) => {
          const existing = chapters.find((item) => item.id === chapter.id) || {};
          return {
            ...existing,
            ...chapter,
            orderIndex: index,
            status: existing.status || "generated",
          };
        });
        applyBookChapters(nextChapters);
        if (stayOnStep) setActiveBookStep(2);
        return;
      }

      const localChapterIds = editableChapters
        .filter((chapter) => String(chapter.id).startsWith("local-"))
        .map((chapter) => chapter.id);

      const serverDeleteIds = deletedChapterIds.filter((id) => !String(id).startsWith("local-"));
      for (const chapterId of serverDeleteIds) {
        try {
          await api.delete(`/books/${book.id}/chapters/${chapterId}`, { suppressPermissionToast: true });
        } catch (e) {
          console.error('[BookConcepts] delete chapter error', e, chapterId);
        }
      }
      if (serverDeleteIds.length) setDeletedChapterIds([]);

      const idMap = {};
      for (const chapter of editableChapters) {
        if (localChapterIds.includes(chapter.id)) {
          try {
            const { data } = await api.post(
              `/books/${book.id}/chapters`,
              { title: chapter.title, description: chapter.description },
              { suppressPermissionToast: true },
            );
            if (data?.id) idMap[chapter.id] = data.id;
          } catch (e) {
            console.error('[BookConcepts] create local chapter error', e, chapter.id);
          }
        }
      }

      const updatePromises = editableChapters.map((chapter) => {
        const serverId = idMap[chapter.id] || chapter.id;
        if (String(serverId).startsWith("local-")) return Promise.resolve();
        return api.put(
          `/books/${book.id}/chapters/${serverId}`,
          { title: chapter.title, description: chapter.description },
          { suppressPermissionToast: true },
        );
      });
      await Promise.all(updatePromises);

      const orderIds = editableChapters
        .map((chapter) => idMap[chapter.id] || chapter.id)
        .filter((id) => !String(id).startsWith("local-"));
      const existingServerIds = chapters.filter((chapter) => !String(chapter.id).startsWith("local-")).map((chapter) => chapter.id);
      if (orderIds.length && orderIds.length === existingServerIds.length) {
        try {
          await api.put(
            `/books/${book.id}/chapters/reorder`,
            { chapterIds: orderIds },
            { suppressPermissionToast: true },
          );
        } catch (e) {
          console.error('[BookConcepts] reorder error', e);
        }
      }

      await loadBook(book.id);
      if (stayOnStep) setActiveBookStep(2);
    } finally {
      setLoading(false);
    }
  };

  function stripHtml(html) {
    if (!html) return "";
    return html
      .replace(/<h[1-6][^>]*>/gi, "\n\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const saveContentChanges = async () => {
    if (!book?.id) return;
    setLoading(true);
    try {
      await Promise.all(chapters.map((chapter) => api.put(
        `/books/${book.id}/chapters/${chapter.id}/content`,
        { content: contentDrafts[chapter.id] || "" },
        { suppressPermissionToast: true },
      )));
      await loadBook(book.id);
      setActiveBookStep(3);
    } finally {
      setLoading(false);
    }
  };

  async function refineActiveChapter() {
    const chapter = editableChapters?.find((item) => item.id === activeChapterId)
      || chapters.find((item) => item.id === activeChapterId);
    if (!book?.id || !chapter?.id || !refineText.trim()) return;
    setLoadingRefine(true);
    try {
      const { data } = await api.post(
        `/books/${book.id}/chapters/${chapter.id}/content/refine`,
        { instruction: refineText, language: bookLanguage },
        { suppressPermissionToast: true },
      );
      const refined = data.content || data.refinedContent || data.result || "";
      if (refined) {
        setContentDrafts((current) => ({ ...current, [chapter.id]: stripHtml(refined) }));
        showToast("Sección refinada");
      }
      setRefineText("");
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingRefine(false);
    }
  }

  const canOpenStep = (step) => {
    if (step === 1) return true;
    if (step === 2) return Boolean(book?.id);
    if (step === 3) return chapters.length > 0;
    return Boolean(book?.id && chapters.length > 0);
  };

  const goToBookStep = (step) => {
    if (canOpenStep(step)) setActiveBookStep(step);
  };

  if (bookView === "library") {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold" style={{ color: isDark ? '#F1F5F9' : '#0F172A' }}>{t("books.libraryTitle")}</h1>
            <p className="text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{t("books.subtitle")}</p>
          </div>
          <Btn onClick={() => setBookView("creating")}>{t("books.newBook")}</Btn>
        </div>

        {loadingLibrary ? (
          <div style={{ background: isDark ? '#1E293B' : '#fff', borderRadius: 14, border: `1px solid ${isDark ? '#334155' : '#eaecf3'}`, padding: '48px 24px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: isDark ? '#94A3B8' : '#64748B', fontWeight: 500, margin: 0 }}>Loading books...</p>
          </div>
        ) : savedBooks.length === 0 ? (
          <div className="rounded-2xl border p-10 text-center shadow-sm" style={{ background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' }}>
            <p className="text-sm font-medium" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{t("books.noBooksYet")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {savedBooks.map((savedBook) => (
              <div key={savedBook.id} className="rounded-2xl border p-5 shadow-sm" style={{ background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' }}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: isDark ? '#F1F5F9' : '#0F172A' }}>{savedBook.title}</p>
                    <p className="mt-1 text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{formatRelativeBookDate(savedBook.createdAt)}</p>
                  </div>
                  <Badge label={savedBook.status || "draft"} color={bookStatusColor(savedBook.status)} />
                </div>
                <p className="mb-4 line-clamp-2 text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{savedBook.description}</p>
                <div className="flex justify-end gap-2">
                  <Btn small variant="secondary" onClick={() => openSavedBook(savedBook.id)}>{t("books.open")}</Btn>
                  <Btn small variant="ghost" className="text-red-500 hover:bg-red-50 hover:text-red-700" onClick={() => deleteSavedBook(savedBook.id)}>{t("books.delete")}</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const stepLabels = [
    t("books.defineConcept"),
    t("books.defineChapters"),
    t("books.generateEditContent"),
    t("books.generateMarketingAssets"),
  ];
  const chaptersForOutline = editableChapters.length ? editableChapters : chapters;
  const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId) || chapters[0];
  const activeChapterIndex = activeChapter ? chapters.findIndex((chapter) => chapter.id === activeChapter.id) : -1;
  const activeContent = activeChapter ? (contentDrafts[activeChapter.id] || activeChapter.content || "") : "";
  const generatedChapters = chapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content).length;
  const totalWords = chapters.reduce((sum, chapter) => {
    const text = (contentDrafts[chapter.id] || chapter.content || "").replace(/<[^>]+>/g, " ");
    return sum + text.trim().split(/\s+/).filter(Boolean).length;
  }, 0);
  const previewPages = chapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content);
  const currentPreviewChapter = previewPages[previewPage] || previewPages[0];

  return (
    <BookConceptsExperience
      activeBookStep={activeBookStep}
      activeChapterId={activeChapterId}
      setActiveChapterId={setActiveChapterId}
      assets={assets}
      book={book}
      bookLanguage={bookLanguage}
      bookLanguageManuallySelected={bookLanguageManuallySelected}
      chapters={chapters}
      chaptersForOutline={chaptersForOutline}
      contentDrafts={contentDrafts}
      createBook={createBook}
      exportBook={exportBook}
      form={form}
      generatedChapters={generatedChapters}
      generateChapters={generateChapters}
      generateContent={generateContent}
      generateInfographic={generateInfographic}
      generateOnePager={generateOnePager}
      generateSocialPosts={generateSocialPosts}
      goToBookStep={goToBookStep}
      isDark={isDark}
      job={job}
      jobTitle={jobTitle}
      language={language}
      loadAssets={loadAssets}
      loadBook={loadBook}
      loadLibrary={loadLibrary}
      loading={loading}
      loadingAssets={loadingAssets}
      previewOpen={previewOpen}
      previewPage={previewPage}
      refineActiveChapter={refineActiveChapter}
      refineText={refineText}
      regenerateAllAssets={regenerateAllAssets}
      regenerateStatus={regenerateStatus}
      saveChapterChanges={saveChapterChanges}
      saveContentChanges={saveContentChanges}
      setActiveBookStep={setActiveBookStep}
      setBookLanguage={setBookLanguage}
      setBookLanguageManuallySelected={setBookLanguageManuallySelected}
      setBookView={setBookView}
      setChapters={setChapters}
      setContentDrafts={setContentDrafts}
      setDeletedChapterIds={setDeletedChapterIds}
      setEditableChapters={setEditableChapters}
      setPreviewOpen={setPreviewOpen}
      setPreviewPage={setPreviewPage}
      setRefineText={setRefineText}
      showToast={showToast}
      t={t}
      toast={toast}
      totalWords={totalWords}
      updateForm={updateForm}
    />
  );

  return (
    <div className="space-y-5">
      <Btn variant="secondary" small onClick={() => { setBookView("library"); loadLibrary(); }}>
        ← Mis libros
      </Btn>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500">Book Concepts</p>
          <h1 className="text-xl font-bold text-gray-900">{book?.title || t("sidebar.books")}</h1>
          <p className="text-xs text-gray-500">{book?.id ? `ID: ${book.id}` : t("books.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {book && <Badge label={book.status || "draft"} color="bg-indigo-100 text-indigo-700" />}
          {book?.id && (
            <Btn variant="ghost" small onClick={() => loadBook(book.id)} icon={<RefreshIcon size={12} />}>
              {t("books.reload")}
            </Btn>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stepLabels.map((label, index) => {
          const step = index + 1;
          const active = activeBookStep === step;
          return (
            <button
              key={label}
              onClick={() => goToBookStep(step)}
              disabled={!canOpenStep(step)}
              className={`rounded-xl border px-3 py-2 text-left text-xs transition-colors ${active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-white text-gray-500 hover:bg-gray-50"} ${!canOpenStep(step) ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span className="font-bold">{t("books.step")} {step}</span>
              <span className="block truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card className="p-5 space-y-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Concepto</p>
              <p className="text-xs text-gray-500">Define la base del libro y avanza por el flujo.</p>
            </div>
            <Field label={t("books.titleField")}>
              <Input value={form.title} onChange={updateForm("title")} />
            </Field>
            <Field label={t("books.description")}>
              <textarea
                rows={4}
                value={form.description}
                onChange={updateForm("description")}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </Field>
            <Field label={t("books.keywords")}>
              <Input value={form.keywords} onChange={updateForm("keywords")} />
            </Field>
            <Field label={t("books.chapterCount")}>
              <Input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} />
            </Field>
            <div className="grid grid-cols-1 gap-2 pt-2">
              <Btn onClick={createBook} disabled={loading} icon={<PlusIcon size={13} />}>
                {t("books.createBook")}
              </Btn>
              <Btn variant="teal" onClick={generateChapters} disabled={loading} icon={<SparkIcon size={13} />}>
                {t("books.generateChapters")}
              </Btn>
              <Btn variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={13} />}>
                {t("books.generateContent")}
              </Btn>
              <Btn variant="secondary" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<DownloadIcon size={13} />}>
                {t("books.exportBook")}
              </Btn>
            </div>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-semibold text-gray-900">Resumen</p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{chapters.length}</p>
                <p className="text-[11px] text-gray-500">Capítulos</p>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{generatedChapters}</p>
                <p className="text-[11px] text-gray-500">Con texto</p>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{totalWords}</p>
                <p className="text-[11px] text-gray-500">Palabras</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          {job?.id && <AsyncJobCard title={jobTitle} job={job} />}

          <Card className="p-5">
            {activeBookStep === 1 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6">
                <p className="text-sm font-semibold text-gray-900">Define the book concept</p>
                <p className="mt-1 text-xs text-gray-500">
                  Use Create Book for the fast path, or Generate Chapters to start the step-by-step review flow.
                </p>
                {book?.id && (
                  <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                    Current book is saved. Continue with Step 2 to review chapters.
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Review and edit chapters</p>
                    <p className="text-xs text-gray-500">Ajusta títulos y descripciones antes de generar contenido.</p>
                  </div>
                  <Btn small onClick={saveChapterChanges} disabled={!book || chapters.length === 0 || loading}>
                    Save changes
                  </Btn>
                </div>
                {chaptersForOutline.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
                    {t("books.emptyChapters")}
                  </div>
                ) : (
                  chaptersForOutline.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-indigo-100 text-xs font-bold text-indigo-700">
                          {index + 1}
                        </span>
                        <Input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                        />
                      </div>
                      <textarea
                        rows={3}
                        value={chapter.description || ""}
                        onChange={(event) => setEditableChapters((current) => current.map((item) => (
                          item.id === chapter.id ? { ...item, description: event.target.value } : item
                        )))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 3 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Generate and edit content</p>
                    <p className="text-xs text-gray-500">Selecciona un capítulo, edita el contenido y refínalo con instrucciones.</p>
                  </div>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={12} />}>
                      {t("books.generateContent")}
                    </Btn>
                    <Btn small onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading}>
                      Save changes
                    </Btn>
                    <Btn small variant="secondary" onClick={() => setPreviewOpen(true)} disabled={previewPages.length === 0} icon={<EyeIcon size={12} />}>
                      Preview
                    </Btn>
                  </div>
                </div>

                {chapters.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
                    Generate and validate chapters before editing content.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Índice</p>
                      <div className="space-y-1">
                        {chapters.map((chapter, index) => {
                          const selected = (activeChapter?.id || activeChapterId) === chapter.id;
                          const hasContent = Boolean(contentDrafts[chapter.id] || chapter.content);
                          return (
                            <button
                              key={chapter.id}
                              type="button"
                              onClick={() => setActiveChapterId(chapter.id)}
                              className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${selected ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-white"}`}
                            >
                              <span className="block font-semibold">{index + 1}. {chapter.title}</span>
                              <span className={selected ? "text-indigo-100" : "text-gray-400"}>
                                {hasContent ? "Contenido generado" : "Pendiente"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="rounded-xl border border-gray-100 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                              Capítulo {activeChapterIndex + 1}
                            </p>
                            <p className="text-sm font-semibold text-gray-900">{activeChapter?.title || "Selecciona un capítulo"}</p>
                          </div>
                          {activeChapter && <Badge label={activeContent ? "generated" : "draft"} color={activeContent ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"} />}
                        </div>
                        <textarea
                          rows={16}
                          value={activeChapter ? activeContent : ""}
                          onChange={(event) => {
                            if (!activeChapter) return;
                            setContentDrafts((current) => ({ ...current, [activeChapter.id]: event.target.value }));
                          }}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Generated chapter HTML will appear here."
                        />
                      </div>

                      <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-sm font-semibold text-indigo-900">✨ Refinar con IA</p>
                          <Btn small variant="secondary" onClick={refineActiveChapter} disabled={!activeChapter || !activeContent || !refineText.trim() || loadingRefine}>
                            {loadingRefine ? "Refinando..." : "Aplicar"}
                          </Btn>
                        </div>
                        <textarea
                          rows={3}
                          value={refineText}
                          onChange={(event) => setRefineText(event.target.value)}
                          className="w-full rounded-lg border border-indigo-100 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Ej: Mejora la claridad, agrega tono profesional y resume los párrafos largos."
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 4 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Generate marketing assets</p>
                    <p className="text-xs text-gray-500">Crea, previsualiza y descarga los materiales asociados al libro.</p>
                  </div>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={loadAssets} disabled={!book || loadingAssets} icon={<RefreshIcon size={12} />}>
                      Refresh
                    </Btn>
                    <Btn small onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<SparkIcon size={12} />}>
                      {t("books.generate")}
                    </Btn>
                  </div>
                </div>

                {loadingAssets ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center">
                    <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                  </div>
                ) : assets.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {assets.map((asset) => (
                      <div key={asset.id || asset.url || asset.name} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{asset.title || asset.name || asset.type || "Marketing asset"}</p>
                            <p className="mt-1 text-xs text-gray-500">{asset.format || asset.contentType || "Generated asset"}</p>
                          </div>
                          <Badge label={asset.status || "ready"} color="bg-green-100 text-green-700" />
                        </div>
                        <div className="flex gap-2">
                          <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled={!asset.url} onClick={() => asset.url && window.open(asset.url, "_blank", "noopener,noreferrer")}>
                            {t("books.preview")}
                          </Btn>
                          <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled={!asset.url} onClick={() => asset.url && window.open(asset.url, "_blank", "noopener,noreferrer")}>
                            {t("books.download")}
                          </Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {["One-Pager", "Whitepaper", "Social Summaries", "Infographic"].map((asset) => (
                      <div key={asset} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">{asset}</p>
                          <Badge label={t("books.readyToGenerate")} color="bg-indigo-100 text-indigo-700" />
                        </div>
                        <Field label={t("books.template")}>
                          <Select>
                            <option>{t("books.defaultTemplate")} {asset}</option>
                            <option>{t("books.salesStyle")}</option>
                          </Select>
                        </Field>
                        <div className="flex gap-2">
                          <Btn small icon={<SparkIcon size={12} />} onClick={asset === "One-Pager" ? generateOnePager : asset === "Social Summaries" ? generateSocialPosts : asset === "Infographic" ? generateInfographic : exportBook} disabled={!book || loading}>{t("books.generate")}</Btn>
                          <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled>{t("books.preview")}</Btn>
                          <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled>{t("books.download")}</Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{book?.title || "Preview"}</p>
                <p className="text-xs text-gray-500">
                  {currentPreviewChapter ? `${previewPage + 1} / ${previewPages.length}` : "No content"}
                </p>
              </div>
              <Btn small variant="ghost" onClick={() => setPreviewOpen(false)}>
                ✕
              </Btn>
            </div>
            <div className="max-h-[68vh] overflow-y-auto p-6">
              {currentPreviewChapter ? (
                <div>
                  <h2 className="mb-4 text-lg font-bold text-gray-900">{currentPreviewChapter.title}</h2>
                  <div
                    className="prose prose-sm max-w-none text-gray-700"
                    dangerouslySetInnerHTML={{ __html: contentDrafts[currentPreviewChapter.id] || currentPreviewChapter.content || "" }}
                  />
                </div>
              ) : (
                <p className="text-sm text-gray-400">No hay contenido para previsualizar.</p>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
              <Btn small variant="secondary" disabled={previewPage <= 0} onClick={() => setPreviewPage((current) => Math.max(current - 1, 0))}>
                Anterior
              </Btn>
              <Btn small variant="secondary" disabled={previewPage >= previewPages.length - 1} onClick={() => setPreviewPage((current) => Math.min(current + 1, previewPages.length - 1))}>
                Siguiente
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <Btn variant="secondary" small onClick={() => { setBookView("library"); loadLibrary(); }}>
        ← Mis libros
      </Btn>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("sidebar.books")}</h1>
          <p className="text-xs text-gray-500">{t("books.subtitle")}</p>
        </div>
        {book && <Badge label={book.status || "draft"} color="bg-indigo-100 text-indigo-700" />}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[t("books.defineConcept"), t("books.defineChapters"), t("books.generateEditContent"), t("books.generateMarketingAssets")].map((label, index) => (
          <button
            key={label}
            onClick={() => goToBookStep(index + 1)}
            disabled={!canOpenStep(index + 1)}
            className={`rounded-xl border px-3 py-2 text-left text-xs ${activeBookStep === index + 1 ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-white text-gray-500"} ${!canOpenStep(index + 1) ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="font-bold">{t("books.step")} {index + 1}</span>
            <span className="block">{label}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <Card className="p-5 space-y-3">
          <Field label={t("books.titleField")}>
            <Input value={form.title} onChange={updateForm("title")} />
          </Field>
          <Field label={t("books.description")}>
            <textarea
              rows={4}
              value={form.description}
              onChange={updateForm("description")}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </Field>
          <Field label={t("books.keywords")}>
            <Input value={form.keywords} onChange={updateForm("keywords")} />
          </Field>
          <Field label={t("books.chapterCount")}>
            <Input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} />
          </Field>

          <div className="grid grid-cols-1 gap-2 pt-2">
            <Btn onClick={createBook} disabled={loading} icon={<PlusIcon size={13} />}>
              {t("books.createBook")}
            </Btn>
            <Btn variant="teal" onClick={generateChapters} disabled={loading} icon={<SparkIcon size={13} />}>
              {t("books.generateChapters")}
            </Btn>
            <Btn variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={13} />}>
              {t("books.generateContent")}
            </Btn>
            <Btn variant="secondary" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<DownloadIcon size={13} />}>
              {t("books.exportBook")}
            </Btn>
          </div>
        </Card>

        <div className="space-y-4">
          {job?.id && <AsyncJobCard title={jobTitle} job={job} />}

          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{book?.title || t("books.noBook")}</p>
                <p className="text-xs text-gray-500">{book?.id ? `ID: ${book.id}` : t("books.createHint")}</p>
              </div>
              {book?.id && (
                <Btn variant="ghost" small onClick={() => loadBook(book.id)} icon={<RefreshIcon size={12} />}>
                  {t("books.reload")}
                </Btn>
              )}
            </div>

            {activeBookStep === 1 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6">
                <p className="text-sm font-semibold text-gray-900">Define the book concept</p>
                <p className="mt-1 text-xs text-gray-500">
                  Use Create Book for the fast path, or Generate Chapters to start the step-by-step review flow.
                </p>
                {book?.id && (
                  <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                    Current book is saved. Continue with Step 2 to review chapters.
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">Review and edit chapters</p>
                  <Btn small onClick={saveChapterChanges} disabled={!book || chapters.length === 0 || loading}>
                    Save changes
                  </Btn>
                </div>
                {editableChapters.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    {t("books.emptyChapters")}
                  </div>
                ) : (
                  editableChapters.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="w-6 h-6 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                          {index + 1}
                        </span>
                        <Input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                        />
                      </div>
                      <textarea
                        rows={3}
                        value={chapter.description}
                        onChange={(event) => setEditableChapters((current) => current.map((item) => (
                          item.id === chapter.id ? { ...item, description: event.target.value } : item
                        )))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 3 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">Generate and edit content</p>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={12} />}>
                      {t("books.generateContent")}
                    </Btn>
                    <Btn small onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading}>
                      Save changes
                    </Btn>
                  </div>
                </div>
                {chapters.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    Generate and validate chapters before editing content.
                  </div>
                ) : (
                  chapters.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold text-gray-700">{index + 1}. {chapter.title}</p>
                        {(contentDrafts[chapter.id] || chapter.content) && (
                          <Btn small variant="secondary" onClick={() => refineChapterWithAi(chapter)} disabled={loading}>
                            ✨ Refinar con IA
                          </Btn>
                        )}
                      </div>
                      <textarea
                        rows={8}
                        value={contentDrafts[chapter.id] || ""}
                        onChange={(event) => setContentDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Generated chapter HTML will appear here."
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 4 && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900">Generate marketing assets</p>
                <div className="grid grid-cols-3 gap-3">
                  {["One-Pager", "Whitepaper", "Social Summaries", "Infographic"].map((asset) => (
                    <div key={asset} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-semibold text-gray-900">{asset}</p>
                        <Badge label={t("books.readyToGenerate")} color="bg-indigo-100 text-indigo-700" />
                      </div>
                      <Field label={t("books.template")}><Select><option>{t("books.defaultTemplate")} {asset}</option><option>{t("books.salesStyle")}</option></Select></Field>
                      <div className="flex gap-2">
                        <Btn small icon={<SparkIcon size={12} />} onClick={asset === "One-Pager" ? generateOnePager : asset === "Social Summaries" ? generateSocialPosts : asset === "Infographic" ? generateInfographic : exportBook} disabled={!book || loading}>{t("books.generate")}</Btn>
                        <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled>{t("books.preview")}</Btn>
                        <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled>{t("books.download")}</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
