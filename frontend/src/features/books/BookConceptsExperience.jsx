import { ASSET_REGENERATION_TYPES } from "@/utils/assetRegeneration";
import { AsyncJobCard } from "@/components/dashboard/AsyncJobCard";
import { CheckIcon, DownloadIcon, EyeIcon, FileIcon, PenIcon, PlusIcon, RefreshIcon, SparkIcon, TrashIcon, XIcon } from "@/components/dashboard/icons";
import api from "@/api/axios";

export function BookConceptsExperience({
  activeBookStep,
  activeChapterId,
  setActiveChapterId,
  assets,
  book,
  bookLanguage,
  bookLanguageManuallySelected,
  chapters,
  chaptersForOutline,
  contentDrafts,
  createBook,
  exportBook,
  form,
  generatedChapters,
  generateChapters,
  generateContent,
  generateInfographic,
  generateOnePager,
  generateSocialPosts,
  goToBookStep,
  isDark,
  job,
  jobTitle,
  language,
  loadAssets,
  loadBook,
  loadLibrary,
  loading,
  loadingAssets,
  previewOpen,
  previewPage,
  refineActiveChapter,
  refineText,
  regenerateAllAssets,
  regenerateStatus,
  saveChapterChanges,
  saveContentChanges,
  setActiveBookStep,
  setBookLanguage,
  setBookLanguageManuallySelected,
  setBookView,
  setChapters,
  setContentDrafts,
  setDeletedChapterIds,
  setEditableChapters,
  setPreviewOpen,
  setPreviewPage,
  setRefineText,
  showToast,
  t,
  toast,
  totalWords,
  updateForm,
}) {
  const bt = (key) => t(`books.${key}`);
  const bookInputStyle = { background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#0F172A', borderColor: isDark ? '#334155' : '#e3e6ee' };
  const bookPanelStyle = { background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' };
  const bookTextPrimary = isDark ? '#F1F5F9' : '#0F172A';
  const bookTextSecondary = isDark ? '#94A3B8' : '#64748B';
  const keywordsLabel = language === "es" ? "Palabras clave" : language === "pt" ? "Palavras-chave" : bt("keywordsLabel");
  const bookLanguageLabels = {
    en: "English",
    es: "Español",
    pt: "Português",
  };
  const keywords = form.keywords.split(",").map((item) => item.trim()).filter(Boolean);
  const previewChapters = chapters.length ? chapters : chaptersForOutline;
  const completedSteps = [
    false,
    Boolean(book?.id && activeBookStep > 1),
    Boolean(chapters.length && activeBookStep > 2),
    Boolean(generatedChapters && activeBookStep > 3),
    false,
  ];
  const previewCount = previewChapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content).length || generatedChapters;
  const previewItems = [
    { type: "cover", label: bt("cover") },
    { type: "index", label: bt("index") },
    ...previewChapters.map((chapter, index) => ({ type: "chapter", chapter, index, label: chapter.title || `${bt("chapter")} ${index + 1}` })),
  ];
  const currentPreview = previewItems[Math.min(previewPage, Math.max(previewItems.length - 1, 0))] || previewItems[0];

  const plainText = (value = "") => String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sanitizeAssetHtml = (html = "") => String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");

  const parseAssetJson = (value) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const truncatePreviewText = (value = "", maxLength = 520) => {
    const text = plainText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).replace(/\s+\S*$/, "").trim()}...`;
  };

  const buildHtmlAssetPreview = (html = "") => {
    const safeHtml = sanitizeAssetHtml(html);
    if (typeof document === "undefined") {
      return truncatePreviewText(safeHtml);
    }
    const container = document.createElement("div");
    container.innerHTML = safeHtml;
    const nodes = Array.from(container.querySelectorAll("h1, h2, h3, p, li, blockquote")).filter((node) => plainText(node.textContent));
    if (!nodes.length) {
      return truncatePreviewText(safeHtml);
    }

    const preview = document.createElement("div");
    let usedChars = 0;
    for (const node of nodes.slice(0, 7)) {
      const text = plainText(node.textContent);
      if (!text) continue;
      if (usedChars > 0 && usedChars + text.length > 620) break;
      const clone = node.cloneNode(true);
      preview.appendChild(clone);
      usedChars += text.length;
    }
    return preview.innerHTML || truncatePreviewText(safeHtml);
  };

  const buildMarketingAssetPreview = (content, type, fallback) => {
    const raw = typeof content === "string" ? content.trim() : content;
    const normalizedType = String(type || "").toLowerCase();
    if (normalizedType === "social_post" || normalizedType === "infographic") {
      return {
        body: raw || fallback,
        isHtml: false,
        isFallback: !raw,
      };
    }
    if (!raw) {
      return {
        body: fallback,
        isHtml: false,
        isFallback: true,
      };
    }
    if (typeof raw === "string" && /<\/?[a-z][\s\S]*>/i.test(raw)) {
      return {
        body: buildHtmlAssetPreview(raw),
        isHtml: true,
        isFallback: false,
      };
    }
    return {
      body: truncatePreviewText(raw),
      isHtml: false,
      isFallback: false,
    };
  };

  const marketingAssets = assets.length ? assets.map((asset) => ({
    ...(() => {
      const preview = buildMarketingAssetPreview(asset.content, asset.type, asset.description || bt("assetGenericBody"));
      return {
        id: asset.id,
        type: asset.type,
        badge: asset.type || asset.format || "Asset",
        title: asset.title || asset.name || bt("assetGenericTitle"),
        body: preview.body,
        isHtmlPreview: preview.isHtml,
        isFallbackPreview: preview.isFallback,
        downloadUrl: asset.downloadUrl || asset.url || null,
        tone: "indigo",
      };
    })(),
  })) : [
    {
      badge: "LinkedIn",
      title: bt("assetLinkedInTitle"),
      body: bt("assetLinkedInBody"),
      tone: "indigo",
    },
    {
      badge: "Email",
      title: bt("assetEmailTitle"),
      body: bt("assetEmailBody"),
      tone: "purple",
    },
    {
      badge: "Landing",
      title: bt("assetLandingTitle"),
      body: bt("assetLandingBody"),
      tone: "green",
    },
    {
      badge: "Ads",
      title: bt("assetAdTitle"),
      body: bt("assetAdBody"),
      tone: "orange",
    },
  ];

  const fallbackChapterText = (chapter) => chapter?.description || bt("noPreviewContent");
  const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const previewChapterText = (chapter, index) => {
    let text = plainText(contentDrafts[chapter.id] || chapter.content) || fallbackChapterText(chapter);
    const title = plainText(chapter.title);
    if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
      text = text.slice(title.length).replace(/^[:\s\-\u2013\u2014]+/, "").trim();
    }
    text = text.replace(/^(?:chapter|cap[ií]tulo|capitulo)\s*\d+\s*[:.\-–—]?\s*/i, "").trim();
    if (title) {
      text = text.replace(new RegExp(`^${escapeRegExp(title)}\\s*[:.\\-\\u2013\\u2014]?\\s*`, "i"), "").trim();
    }
    return text || fallbackChapterText(chapter);
  };
  const copyText = async (text) => {
    try {
      await navigator.clipboard?.writeText(text);
      showToast(bt("copied"));
    } catch {
      showToast(bt("copyFailed"));
    }
  };

  // Chapter actions: add, move, delete (client-first, persist on save)
  const addChapter = async () => {
    // optimistic UI: add a local empty chapter immediately so user can edit
    const newId = `local-${Date.now()}`;
    const newChapter = { id: newId, title: "", description: "", orderIndex: (editableChapters.length || chapters.length) };
    setEditableChapters((cur) => [...cur, { id: newId, title: newChapter.title, description: newChapter.description }]);
    setChapters((cur) => [...cur, newChapter]);
    setActiveChapterId(newId);
    showToast(bt("added") || "Capítulo añadido");
    console.debug('[BookConcepts] addChapter local id', newId);

    // If we have a server book, try to persist in background and refresh
    if (!book?.id) return;
    setLoading(true);
    try {
      const { data } = await api.post(
        `/books/${book.id}/chapters`,
        { title: newChapter.title, description: newChapter.description },
        { suppressPermissionToast: true },
      );
      if (data && data.id) {
        await loadBook(book.id);
        setActiveChapterId(data.id);
      }
    } catch (e) {
      console.error('[BookConcepts] addChapter error', e);
      showToast(bt("addFailed") || "No se pudo agregar capítulo en el servidor");
    } finally {
      setLoading(false);
    }
  };

  const moveChapter = (fromIndex, toIndex) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    setEditableChapters((current) => {
      const copy = [...current];
      const [item] = copy.splice(fromIndex, 1);
      if (!item) return current;
      copy.splice(toIndex, 0, item);
      return copy;
    });
    setChapters((current) => {
      const copy = [...current];
      const [item] = copy.splice(fromIndex, 1);
      if (!item) return current;
      copy.splice(toIndex, 0, item);
      return copy;
    });
  };

  const deleteChapter = async (chapterId) => {
    // optimistic removal from UI
    setEditableChapters((current) => current.filter((c) => c.id !== chapterId));
    setChapters((current) => current.filter((c) => c.id !== chapterId));
    setDeletedChapterIds((cur) => {
      if (cur.includes(chapterId)) return cur;
      return [...cur, chapterId];
    });
    showToast(bt("deleted") || "Capítulo eliminado");
    console.debug('[BookConcepts] deleteChapter queued id', chapterId);

    // If local/demo id, nothing to call on server
    if (!book?.id || String(chapterId).startsWith("demo-chapter-") || String(chapterId).startsWith("local-")) {
      return;
    }

    setLoading(true);
    try {
      await api.delete(`/books/${book.id}/chapters/${chapterId}`, { suppressPermissionToast: true });
      // ensure server state matches
      await loadBook(book.id);
      // remove from deleted list
      setDeletedChapterIds((cur) => cur.filter((id) => id !== chapterId));
      showToast(bt("deleted") || "Capítulo borrado");
    } catch (e) {
      console.error('[BookConcepts] deleteChapter error', e);
      showToast(bt("deleteFailed") || "No se pudo borrar capítulo en el servidor");
      // reload to restore state from server
      try { await loadBook(book.id); } catch (_) {}
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 px-2 pb-10 lg:px-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => { setBookView("library"); loadLibrary(); }}
            className="inline-flex h-11 items-center gap-2 rounded-xl border px-5 text-sm font-semibold shadow-sm"
            style={{
              background: isDark ? '#1E293B' : '#fff',
              borderColor: isDark ? '#334155' : '#e5e7eb',
              color: isDark ? '#F1F5F9' : '#374151',
            }}
          >
            <span className="text-lg leading-none">&larr;</span>
            {bt("backToBooks")}
          </button>

          <header>
            <h1 className="text-[17px] font-bold tracking-[-0.02em]" style={{ color: isDark ? '#F1F5F9' : '#0f172a' }}>{t("sidebar.books")}</h1>
            <p className="mt-1 text-[12.5px]" style={{ color: isDark ? '#94A3B8' : '#64748b' }}>{bt("workflowSubtitle")}</p>
          </header>
        </div>

        <div className="flex flex-col items-end gap-5">
          <button
            type="button"
            onClick={() => { setPreviewPage(0); setPreviewOpen(true); }}
            disabled={previewItems.length <= 2}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#0f172a] px-6 text-sm font-bold text-white shadow-sm hover:bg-[#111827] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <EyeIcon size={16} />
            {bt("bookPreviewTitle")}
          </button>
          {book && (
            <span className="rounded-full bg-emerald-50 px-5 py-2 text-sm font-semibold text-emerald-600">
              {bt("generatedContent")}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[14px] lg:grid-cols-4">
        {[bt("defineConcept"), bt("defineChapters"), bt("generateEditContent"), bt("generateMarketingAssets")].map((label, index) => {
          const step = index + 1;
          const active = activeBookStep === step;
          const done = completedSteps[step];
          return (
            <button
              key={label}
              type="button"
              onClick={() => goToBookStep(step)}
              disabled={step > 1 && !book?.id}
              className={`min-h-[88px] rounded-xl border px-5 py-4 text-left shadow-sm transition-colors ${step > 1 && !book?.id ? "cursor-not-allowed opacity-70" : ""}`}
              style={
                active
                  ? { borderColor: isDark ? 'rgb(var(--brand-800))' : 'rgb(var(--brand-200))', background: isDark ? 'rgba(55,48,163,0.18)' : 'rgb(var(--brand-50))', color: isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-700))' }
                  : { borderColor: isDark ? '#334155' : '#f3f4f6', background: isDark ? '#1E293B' : '#fff', color: isDark ? '#94A3B8' : '#94a3b8' }
              }
            >
              <div className="flex items-start gap-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-black"
                  style={
                    done
                      ? { background: isDark ? 'rgba(16,185,129,0.15)' : '#ecfdf5', color: '#10b981' }
                      : active
                        ? { background: isDark ? 'rgb(var(--brand-800))' : 'rgb(var(--brand-700))', color: '#fff' }
                        : { background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94A3B8' : '#94a3b8' }
                  }
                >
                  {done ? <CheckIcon size={16} /> : step}
                </span>
                <span>
                  <span
                    className="block text-base font-bold"
                    style={{ color: active ? (isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-700))') : done ? (isDark ? '#CBD5E1' : '#334155') : (isDark ? '#94A3B8' : '#94a3b8') }}
                  >
                    {bt("step")} {step}
                  </span>
                  <span className="mt-1 block text-sm">{label}</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="rounded-2xl border p-5 shadow-sm" style={bookPanelStyle}>
          <div className="space-y-3">
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("titleField")}</label>
              <input value={form.title} onChange={updateForm("title")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("description")}</label>
              <textarea
                rows={4}
                value={form.description}
                onChange={updateForm("description")}
                className="w-full rounded-xl border px-4 py-3 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={bookInputStyle}
              />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{keywordsLabel}</label>
              <input value={form.keywords} onChange={updateForm("keywords")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("chapterCount")}</label>
              <input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>
                {language === "es" ? "Idioma de creación" : language === "pt" ? "Idioma de criação" : "Creation language"}
              </label>
              <select
                value={bookLanguage}
                onChange={(event) => {
                  setBookLanguage(event.target.value);
                  setBookLanguageManuallySelected(true);
                }}
                className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={bookInputStyle}
              >
                {Object.entries(bookLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!bookLanguageManuallySelected && bookLanguage === value ? ` (${language === "es" ? "predeterminado" : language === "pt" ? "padrão" : "default"})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-2 pt-1">
              <button type="button" onClick={createBook} disabled={loading} title={bt("createBookHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700 disabled:opacity-60">
                <PlusIcon size={17} /> {bt("createBook")}
              </button>
              <button type="button" onClick={generateChapters} disabled={loading} title={bt("generateChaptersHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl bg-emerald-500 px-4 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-60">
                <SparkIcon size={16} /> {bt("generateChapters")}
              </button>
              <button type="button" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} title={bt("generateContentHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl border px-4 text-sm font-bold hover:bg-gray-50 disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#334155' }}>
                <PenIcon size={16} /> {bt("generateContent")}
              </button>
              <button type="button" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} title={bt("exportBookHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl border px-4 text-sm font-bold hover:bg-gray-50 disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#334155' }}>
                <DownloadIcon size={16} /> {bt("exportBook")}
              </button>
              {chapters.length > 0 && (
                <button type="button" onClick={() => setActiveBookStep(2)} className="flex h-11 items-center justify-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-50/50 px-4 text-sm font-bold text-indigo-600 hover:bg-indigo-50">
                  {bt("defineChapters")} &rarr;
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border p-6 shadow-sm" style={bookPanelStyle}>
          <div className="mb-5 flex items-start justify-between gap-4 border-b pb-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
            <div>
              <h2 className="text-[14px] font-bold" style={{ color: bookTextPrimary }}>{book?.title || form.title}</h2>
              <p className="mt-1 text-[11.5px]" style={{ color: bookTextSecondary }}>ID: {book?.id || "f32d04c4-7b29-421a-abec-c4bf93617326"}</p>
            </div>
            {book?.id && (
              <button type="button" onClick={() => loadBook(book.id)} className="inline-flex items-center gap-2 text-sm font-bold text-indigo-500 hover:text-indigo-700">
                <RefreshIcon size={16} /> {bt("reload")}
              </button>
            )}
          </div>

          {job?.id && <AsyncJobCard title={jobTitle} job={job} statusLabel={bt("status")} />}

          {activeBookStep === 1 && (
            <div className="space-y-4">
              <div className="rounded-2xl border p-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                <h3 className="text-[14px] font-bold" style={{ color: bookTextPrimary }}>{bt("defineConceptTitle")}</h3>
                <p className="mt-2 text-[13px] leading-[1.6]" style={{ color: bookTextSecondary }}>
                  {bt("defineConceptPrefix")} <strong style={{ color: bookTextPrimary }}>{bt("createBook")}</strong> {bt("defineConceptMiddle")} <strong style={{ color: bookTextPrimary }}>{bt("generateChapters")}</strong> {bt("defineConceptSuffix")}
                </p>
                {book?.id && (
                  <div className="mt-4 flex items-center gap-3 rounded-xl px-5 py-3 text-sm font-bold" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : 'rgb(var(--brand-50))', color: isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-800))' }}>
                    <CheckIcon size={18} />
                    {bt("savedMessage")}
                  </div>
                )}
              </div>
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: 'rgb(var(--brand-600))', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'rgb(var(--brand-700))' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && job?.status !== 'completed' && job?.status !== 'failed' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'rgb(var(--brand-600))', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {[
                  [bt("chapters").toUpperCase(), chapters.length || Number(form.chapterCount) || 0],
                  [bt("withContent").toUpperCase(), generatedChapters],
                  [bt("words").toUpperCase(), totalWords],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border p-4" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                    <p className="text-[11px] font-bold" style={{ color: bookTextSecondary }}>{label}</p>
                    <p className="mt-[6px] text-[18px] font-bold" style={{ color: bookTextPrimary }}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeBookStep === 2 && (
            <div className="space-y-5">
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: 'rgb(var(--brand-600))', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'rgb(var(--brand-700))' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && job?.status !== 'completed' && job?.status !== 'failed' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'rgb(var(--brand-600))', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-black" style={{ color: bookTextPrimary }}>{bt("reviewEditChapters")}</h3>
                <div className="flex gap-2">
                  <button type="button" onClick={addChapter} className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold" style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#F1F5F9' : '#334155' }}>
                    <PlusIcon size={15} /> {bt("add")}
                  </button>
                  <button type="button" onClick={async () => {
                    await saveChapterChanges(true);
                    showToast(bt("savedMessage") || "Cambios guardados");
                  }} disabled={!book || chaptersForOutline.length === 0 || loading} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                    {bt("saveChanges")}
                  </button>
                </div>
              </div>
              {chaptersForOutline.length === 0 ? (
                <div className="rounded-2xl border border-dashed py-16 text-center text-sm" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', color: bookTextSecondary }}>
                  {t("books.emptyChapters")}
                </div>
              ) : (
                <div className="space-y-4">
                  {chaptersForOutline.map((chapter, index) => (
                    <div key={chapter.id} className="grid grid-cols-[26px_1fr_34px] gap-3 rounded-2xl border p-4" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                      <div className="flex flex-col items-center gap-3 pt-1">
                        <span style={{ color: isDark ? '#475569' : '#cbd5e1' }}>::</span>
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-black" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : 'rgb(var(--brand-50))', color: isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-700))' }}>{index + 1}</span>
                      </div>
                      <div className="space-y-2">
                        <input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                          className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                        />
                        <textarea
                          ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                          rows={2}
                          value={chapter.description || ""}
                          onChange={(event) => {
                            const el = event.target;
                            el.style.height = 'auto';
                            el.style.height = `${el.scrollHeight}px`;
                            setEditableChapters((current) => current.map((item) => (
                              item.id === chapter.id ? { ...item, description: event.target.value } : item
                            )));
                          }}
                          className="w-full resize-none overflow-hidden rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                        />
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <button type="button" onClick={() => moveChapter(index, index - 1)} disabled={index === 0} className="flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#f3f4f6', color: isDark ? '#475569' : '#cbd5e1' }}>⌃</button>
                        <button type="button" onClick={() => moveChapter(index, index + 1)} disabled={index === (chaptersForOutline.length - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#f3f4f6', color: isDark ? '#475569' : '#cbd5e1' }}>⌄</button>
                        <button type="button" onClick={() => deleteChapter(chapter.id)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-100 text-red-400"><TrashIcon size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end pt-1">
                <button type="button" onClick={async () => {
                  try {
                    await saveChapterChanges(false);
                    setActiveBookStep(3);
                    const hasContent = chapters.some((c) => (contentDrafts[c.id] || c.content)?.trim());
                    if (!hasContent) {
                      await generateContent();
                    }
                  } catch(e) {
                    console.error('[BookConcepts] Error en confirm chapters:', e?.message, e?.response?.status);
                  }
                }} disabled={!book || chaptersForOutline.length === 0 || loading} className="rounded-xl bg-emerald-500 px-7 py-3 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                  {bt("confirmChapters")} &rarr;
                </button>
              </div>
            </div>
          )}

          {activeBookStep === 3 && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black" style={{ color: bookTextPrimary }}>{bt("generateEditContentTitle")}</h3>
                  <p className="text-sm" style={{ color: bookTextSecondary }}>{bt("generateEditContentHelp")}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                    <SparkIcon size={15} /> {bt("generateContent")}
                  </button>
                  <button type="button" onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50">{bt("saveChanges")}</button>
                  <button type="button" onClick={() => setActiveBookStep(4)} disabled={chapters.length === 0} className="h-10 rounded-lg border border-indigo-200 bg-indigo-50 px-5 text-sm font-bold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">{bt("marketingAssetsTitle")} &rarr;</button>
                </div>
              </div>
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: 'rgb(var(--brand-600))', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'rgb(var(--brand-700))' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'rgb(var(--brand-600))', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                  {chapters.map((chapter, index) => {
                    const selected = (activeChapterId || chapters[0]?.id) === chapter.id;
                    return (
                      <button
                        key={chapter.id}
                        type="button"
                        onClick={() => setActiveChapterId(chapter.id)}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors"
                        style={selected ? { background: isDark ? '#1E3A5F' : '#eef0fe', color: isDark ? '#F1F5F9' : 'rgb(var(--brand-800))' } : { color: bookTextSecondary }}
                      >
                        {index + 1}. {chapter.title}
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-3">
                  {(chapters.length ? chapters : [{ id: "empty", title: bt("contentLabel"), content: "" }]).map((chapter) => {
                    const isActive = chapters.length === 0 || (activeChapterId || chapters[0]?.id) === chapter.id;
                    return (
                      <div key={chapter.id} className={isActive ? "" : "hidden"}>
                        <p className="mb-2 text-sm font-bold" style={{ color: bookTextPrimary }}>{chapter.title}</p>
                        <textarea
                          rows={14}
                          value={contentDrafts[chapter.id] || chapter.content || ""}
                          onChange={(event) => setContentDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                          className="w-full rounded-xl border px-4 py-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                          placeholder={bt("emptyChapters")}
                        />
                      </div>
                    );
                  })}
                  <div className="rounded-xl border p-4" style={{ borderColor: isDark ? 'rgba(99,102,241,0.3)' : 'rgb(var(--brand-100))', background: isDark ? 'rgba(99,102,241,0.1)' : 'rgb(var(--brand-50))' }}>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-bold" style={{ color: isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-900))' }}>{bt("refineWithAi")}</p>
                      <button type="button" onClick={refineActiveChapter} disabled={!refineText.trim()} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50" style={{ background: isDark ? '#1E293B' : '#fff', color: isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-700))' }}>{bt("apply")}</button>
                    </div>
                    <textarea rows={3} value={refineText} onChange={(event) => setRefineText(event.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm" style={bookInputStyle} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeBookStep === 4 && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black" style={{ color: bookTextPrimary }}>{bt("marketingAssetsTitle")}</h3>
                  <p className="mt-1 text-sm" style={{ color: bookTextSecondary }}>{bt("marketingAssetsHelp")}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={loadAssets} disabled={!book || loadingAssets} className="inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-bold disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', color: bookTextSecondary }}>
                    <RefreshIcon size={15} /> {bt("reload")}
                  </button>
                  <button type="button" onClick={regenerateAllAssets} disabled={!book || chapters.length === 0 || loading || Object.values(regenerateStatus || {}).includes("pending")} className="inline-flex h-11 items-center gap-2 rounded-xl bg-emerald-500 px-5 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                    <SparkIcon size={15} /> {bt("regenerateAll")}
                  </button>
                </div>
              </div>
              {regenerateStatus && (
                <div className="flex flex-wrap gap-2">
                  {ASSET_REGENERATION_TYPES.map((asset) => {
                    const status = regenerateStatus[asset.key];
                    const color = status === "success" ? { background: isDark ? 'rgba(16,185,129,0.15)' : '#ecfdf5', color: '#059669' }
                      : status === "error" ? { background: isDark ? 'rgba(239,68,68,0.15)' : '#fef2f2', color: '#dc2626' }
                      : { background: isDark ? 'rgba(99,102,241,0.15)' : 'rgb(var(--brand-50))', color: 'rgb(var(--brand-700))' };
                    return (
                      <span key={asset.key} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold" style={color}>
                        {status === "pending" && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                        {bt(asset.labelKey)}
                      </span>
                    );
                  })}
                </div>
              )}
              {loadingAssets ? (
                <div className="rounded-xl border border-dashed py-12 text-center" style={{ borderColor: isDark ? '#334155' : '#e5e7eb' }}>
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  {marketingAssets.map((asset) => (
                    <div key={asset.id || `${asset.badge}-${asset.title}`} className="rounded-2xl border p-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                      <div className="mb-4 flex items-center justify-between">
                        <span className={`rounded-lg px-3 py-1 text-xs font-bold ${
                          asset.tone === "green" ? "bg-emerald-50 text-emerald-600" : asset.tone === "orange" ? "bg-orange-50 text-orange-600" : asset.tone === "purple" ? "bg-purple-50 text-purple-600" : "bg-indigo-50 text-indigo-600"
                        }`}>{asset.badge}</span>
                        {asset.downloadUrl ? (
                          <a href={asset.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                            <DownloadIcon size={15} /> {bt("download")}
                          </a>
                        ) : (
                          <button type="button" onClick={() => copyText(asset.body)} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-indigo-600">
                            <FileIcon size={15} /> {bt("copy")}
                          </button>
                        )}
                      </div>
                      <h4 className="text-lg font-black" style={{ color: bookTextPrimary }}>{asset.title}</h4>
                      {asset.isHtmlPreview ? (
                        <div
                          className="mt-3 max-h-44 overflow-hidden text-sm leading-6 [&_blockquote]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:border-indigo-300 [&_blockquote]:pl-3 [&_h1]:text-base [&_h1]:font-black [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-bold [&_li]:mt-1 [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.cta]:mt-3 [&_.cta]:inline-block [&_.cta]:rounded-lg [&_.cta]:bg-brand-700 [&_.cta]:px-3 [&_.cta]:py-2 [&_.cta]:font-bold [&_.cta]:text-white"
                          style={{ color: bookTextSecondary }}
                          dangerouslySetInnerHTML={{ __html: asset.body }}
                        />
                      ) : asset.type === "social_post" ? (
                        <div className="mt-3 space-y-2">
                          {(parseAssetJson(asset.body) || []).map((post, index) => (
                            <div key={`${post.platform}-${index}`} className="rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff' }}>
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <span className="rounded-lg px-2 py-0.5 text-[11px] font-bold uppercase" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : 'rgb(var(--brand-50))', color: isDark ? 'rgb(var(--brand-300))' : 'rgb(var(--brand-700))' }}>
                                  {post.platform}
                                </span>
                                <span className="text-[11px]" style={{ color: bookTextSecondary }}>{post.characterCount ?? (post.content || "").length} {bt("characters")}</span>
                              </div>
                              <p className="whitespace-pre-line text-sm leading-6" style={{ color: bookTextPrimary }}>{post.content}</p>
                            </div>
                          ))}
                        </div>
                      ) : asset.type === "infographic" && parseAssetJson(asset.body) ? (
                        (() => {
                          const data = parseAssetJson(asset.body);
                          return (
                            <div className="mt-3 space-y-3">
                              {(data.title || data.subtitle) && (
                                <div>
                                  {data.title && <p className="text-base font-black" style={{ color: bookTextPrimary }}>{data.title}</p>}
                                  {data.subtitle && <p className="text-sm" style={{ color: bookTextSecondary }}>{data.subtitle}</p>}
                                </div>
                              )}
                              {(data.sections || []).map((section, index) => (
                                <div key={index} className="rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#e5e7eb' }}>
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-bold" style={{ color: bookTextPrimary }}>{section.heading}</p>
                                    {section.stat && <span className="text-sm font-black" style={{ color: 'rgb(var(--brand-700))' }}>{section.stat}</span>}
                                  </div>
                                  {section.description && <p className="mt-1 text-xs leading-5" style={{ color: bookTextSecondary }}>{section.description}</p>}
                                </div>
                              ))}
                              {Array.isArray(data.keyPoints) && data.keyPoints.length > 0 && (
                                <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: bookTextSecondary }}>
                                  {data.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
                                </ul>
                              )}
                              {data.callToAction && (
                                <p className="rounded-lg px-3 py-2 text-sm font-bold text-white" style={{ background: 'rgb(var(--brand-700))' }}>
                                  {data.callToAction}
                                </p>
                              )}
                              {asset.downloadUrl && (
                                <a href={asset.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                                  <DownloadIcon size={15} /> {bt("download")}
                                </a>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <p className={`mt-3 whitespace-pre-line text-sm leading-6 ${asset.isFallbackPreview ? "line-clamp-2" : "line-clamp-6"}`} style={{ color: bookTextSecondary }}>{asset.body}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-[60] rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 backdrop-blur-sm" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="flex h-[86vh] w-full max-w-[1320px] flex-col overflow-hidden rounded-3xl shadow-2xl" style={{ background: isDark ? '#1E293B' : '#fff' }}>
            <div className="flex items-center justify-between border-b px-[18px] py-3" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
              <div className="flex items-center gap-3">
                <EyeIcon size={20} className="text-indigo-600" />
                <h3 className="text-[13.5px] font-black" style={{ color: bookTextPrimary }}>{bt("bookPreviewTitle")}</h3>
                <span className="text-sm" style={{ color: bookTextSecondary }}>· {previewCount}/{previewChapters.length || form.chapterCount} {bt("withContent").toLowerCase()}</span>
              </div>
              <button type="button" onClick={() => setPreviewOpen(false)} className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#F1F5F9' : '#64748b' }}>
                <XIcon size={26} />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]" style={{ background: isDark ? '#0F172A' : '#f1f5f9' }}>
              <aside className="overflow-y-auto px-[10px] py-[14px]" style={{ background: isDark ? 'rgba(30,41,59,0.7)' : 'rgba(255,255,255,0.7)' }}>
                {previewItems.map((item, index) => {
                  const active = previewPage === index;
                  return (
                    <button
                      key={`${item.type}-${item.label}-${index}`}
                      type="button"
                      onClick={() => setPreviewPage(index)}
                      className="mb-2 flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-[12.5px] font-bold"
                      style={active ? { background: isDark ? '#1E3A5F' : '#eef0fe', color: isDark ? '#F1F5F9' : 'rgb(var(--brand-700))' } : { color: bookTextSecondary }}
                    >
                      {item.type === "chapter" && (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-black" style={active ? { background: isDark ? 'rgb(var(--brand-800))' : 'rgb(var(--brand-700))', color: '#fff' } : { background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94A3B8' : '#94a3b8' }}>
                          {item.index + 1}
                        </span>
                      )}
                      <span className="line-clamp-2">{item.label}</span>
                    </button>
                  );
                })}
              </aside>
              <main className="overflow-auto px-10 py-12">
                {currentPreview?.type === "cover" && (
                  <section className="mx-auto flex min-h-[700px] w-[560px] flex-col justify-center rounded-md bg-[#111827] px-16 py-16 text-white shadow-2xl shadow-slate-400/50">
                    <p className="mb-36 text-center text-[13px] font-bold uppercase tracking-[0.24em] text-emerald-300">NoonDalton · AI Marketing</p>
                    <h2 className="text-[44px] font-black leading-tight">{form.title}</h2>
                    <p className="mt-6 text-[15.5px] leading-8 text-slate-300">{form.description}</p>
                    <div className="mt-8 flex flex-wrap gap-3">
                      {keywords.map((keyword) => (
                        <span key={keyword} className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-bold text-slate-200">{keyword}</span>
                      ))}
                    </div>
                    <div className="mt-12 border-t border-white/10 pt-8 text-[13.5px] text-slate-400">{previewChapters.length || form.chapterCount} {bt("chapters").toLowerCase()} · {bt("writtenWithAi")}</div>
                  </section>
                )}
                {currentPreview?.type === "index" && (
                  <section className="mx-auto min-h-[700px] w-[560px] rounded-md bg-white px-16 py-16 shadow-xl shadow-slate-300/50">
                    <h2 className="font-serif text-[30px] font-black" style={{ color: bookTextPrimary }}>{bt("index")}</h2>
                    <div className="mt-4 h-1 w-16 rounded bg-indigo-600" />
                    <div className="mt-14 space-y-0">
                      {previewChapters.map((chapter, index) => (
                        <div key={chapter.id} className="grid grid-cols-[40px_1fr_74px] items-center gap-4 border-b border-gray-100 py-3.5">
                          <span className="font-serif text-[15px] font-black text-indigo-600">{index + 1}</span>
                          <span className="font-serif text-[16px] text-gray-900">{chapter.title}</span>
                          <span className="rounded-full bg-emerald-50 px-3 py-1 text-center text-sm font-bold text-emerald-600">{bt("ready")}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {currentPreview?.type === "chapter" && (
                  <section className="mx-auto min-h-[700px] w-[560px] rounded-md bg-white px-16 py-16 shadow-xl shadow-slate-300/50">
                    <p className="text-[13px] font-black uppercase tracking-[0.22em] text-indigo-600">{bt("chapter")} {currentPreview.index + 1}</p>
                    <h2 className="mt-2.5 font-serif text-[30px] font-black leading-tight" style={{ color: bookTextPrimary }}>{currentPreview.chapter.title}</h2>
                    <div className="my-6 h-1 w-16 rounded bg-indigo-600" />
                    <div className="font-serif text-[16px] leading-[1.78] text-slate-700">
                      {previewChapterText(currentPreview.chapter, currentPreview.index)
                        .split(/\n{2,}|(?<=\.)\s+(?=[A-ZÁÉÍÓÚÑ])/)
                        .slice(0, 3)
                        .map((paragraph, index) => <p key={index} className="mb-[18px]">{paragraph}</p>)}
                    </div>
                  </section>
                )}
              </main>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
