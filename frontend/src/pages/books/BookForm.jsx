/**
 * BookForm — Step 1 of the book creation / editing wizard.
 * Captures: title, description, target audience, keywords, writing style, content type.
 * On submit, calls onSubmit(data) so the parent (BookWorkflow) can proceed to Step 2.
 */
import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { BookOpen, Info } from "lucide-react";

import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import TagInput from "@/components/ui/TagInput";

const WRITING_STYLES = [
  { value: "professional", label: "Profesional" },
  { value: "conversational", label: "Conversacional" },
  { value: "academic",      label: "Académico" },
  { value: "creative",      label: "Creativo" },
  { value: "technical",     label: "Técnico" },
];

const CONTENT_TYPES = [
  { value: "whitepaper",   label: "White Paper" },
  { value: "ebook",        label: "eBook" },
  { value: "guide",        label: "Guía Práctica" },
  { value: "case_study",   label: "Caso de Estudio" },
  { value: "report",       label: "Informe" },
];

const CHAPTER_COUNTS = [3, 5, 7, 10, 12, 15];

export default function BookForm({ initialData = null, onSubmit, isLoading = false }) {
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm({
    defaultValues: {
      title: "",
      description: "",
      targetAudience: "",
      keywords: [],
      writingStyle: "professional",
      contentType: "ebook",
      chapterCount: 5,
      ...initialData,
    },
  });

  // Populate form when editing an existing book
  useEffect(() => {
    if (initialData) reset(initialData);
  }, [initialData, reset]);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Title */}
      <div>
        <Input
          label="Título del libro *"
          placeholder="e.g. Guía Definitiva de Marketing Digital para PYMEs"
          error={errors.title?.message}
          {...register("title", {
            required: "El título es obligatorio",
            minLength: { value: 5, message: "Mínimo 5 caracteres" },
            maxLength: { value: 150, message: "Máximo 150 caracteres" },
          })}
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Descripción / Propósito *
        </label>
        <textarea
          rows={4}
          placeholder="Describe el objetivo del libro, qué problema resuelve, y qué aprenderá el lector…"
          className={`block w-full rounded-lg border px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none ${
            errors.description ? "border-red-500" : "border-gray-300"
          }`}
          {...register("description", {
            required: "La descripción es obligatoria",
            minLength: { value: 20, message: "Mínimo 20 caracteres" },
            maxLength: { value: 1500, message: "Máximo 1500 caracteres" },
          })}
        />
        {errors.description && (
          <p className="mt-1 text-xs text-red-600">{errors.description.message}</p>
        )}
      </div>

      {/* Two-column row: style + type */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Writing Style */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Estilo de escritura
          </label>
          <select
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            {...register("writingStyle")}
          >
            {WRITING_STYLES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Content Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Tipo de contenido
          </label>
          <select
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            {...register("contentType")}
          >
            {CONTENT_TYPES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Target Audience */}
      <div>
        <Input
          label="Audiencia objetivo"
          placeholder="e.g. Directores de marketing de empresas B2B con 50–500 empleados"
          {...register("targetAudience")}
        />
      </div>

      {/* Keywords */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Palabras clave / Temas principales
          <span className="ml-1 text-gray-400 font-normal">(Enter o coma para añadir)</span>
        </label>
        <Controller
          name="keywords"
          control={control}
          render={({ field }) => (
            <TagInput
              value={field.value}
              onChange={field.onChange}
              placeholder="marketing, SEO, contenido…"
              maxTags={20}
            />
          )}
        />
      </div>

      {/* Chapter count */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Número de capítulos sugeridos
        </label>
        <div className="flex flex-wrap gap-2">
          {CHAPTER_COUNTS.map((n) => (
            <label key={n} className="cursor-pointer">
              <input type="radio" value={n} className="sr-only" {...register("chapterCount", { valueAsNumber: true })} />
              <span
                className={`inline-flex items-center justify-center w-10 h-10 rounded-lg border-2 text-sm font-semibold transition-colors
                  peer-checked:border-primary-600 peer-checked:bg-primary-50 peer-checked:text-primary-700`}
              >
                {n}
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 flex items-center gap-1 text-xs text-gray-400">
          <Info size={12} />
          La IA generará exactamente este número de capítulos, que podrás reordenar después.
        </p>
      </div>

      {/* Actions */}
      <div className="flex justify-end pt-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={isLoading}
          icon={<BookOpen size={18} />}
        >
          Continuar → Definir capítulos
        </Button>
      </div>
    </form>
  );
}
