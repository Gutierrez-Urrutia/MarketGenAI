import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { BookOpen, CheckCircle2, List } from 'lucide-react'

import { booksApi } from '@/api/axios'
import { useJobPolling } from '@/hooks/useJobPolling'
import { FullPageSpinner } from '@/components/ui/Spinner'
import JobProgressCard from '@/components/ui/JobProgressCard'
import BookForm from './BookForm'
import BookChapters from './BookChapters'

const STEPS = [
  { id: 1, label: 'Concepto', icon: BookOpen },
  { id: 2, label: 'Capitulos', icon: List },
  { id: 3, label: 'Contenido', icon: CheckCircle2 },
]

function getJobId(response) {
  return response?.data?.job_id || response?.data?.jobId || response?.data?.id
}

function sortChapters(chapters) {
  return [...(chapters || [])].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
}

function StepBar({ current }) {
  return (
    <ol className="mb-8 flex items-center">
      {STEPS.map((step, index) => {
        const Icon = step.icon
        const active = step.id === current
        const done = step.id < current

        return (
          <li key={step.id} className="flex flex-1 items-center">
            <div className="flex w-full flex-col items-center">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors ${
                  active
                    ? 'border-primary-600 bg-primary-600 text-white'
                    : done
                      ? 'border-primary-400 bg-primary-50 text-primary-500'
                      : 'border-slate-200 bg-white text-slate-400'
                }`}
              >
                <Icon size={16} />
              </div>
              <span className={`mt-1 text-xs font-medium ${active ? 'text-primary-600' : done ? 'text-primary-400' : 'text-slate-400'}`}>
                {step.label}
              </span>
            </div>
            {index < STEPS.length - 1 && (
              <div className={`mx-2 h-0.5 flex-1 rounded ${done ? 'bg-primary-300' : 'bg-slate-200'}`} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default function BookWorkflow() {
  const { id: bookId } = useParams()
  const isEditing = Boolean(bookId)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [step, setStep] = useState(1)
  const [currentBook, setCurrentBook] = useState(null)
  const [chapters, setChapters] = useState([])
  const [chapterJobId, setChapterJobId] = useState(null)
  const [contentJobId, setContentJobId] = useState(null)
  const [chapterProgress, setChapterProgress] = useState(0)
  const [contentProgress, setContentProgress] = useState(0)

  const { data: existingBook, isLoading: loadingBook } = useQuery({
    queryKey: ['book', bookId],
    queryFn: () => booksApi.getBook(bookId).then((response) => response.data),
    enabled: isEditing,
  })

  const saveMutation = useMutation({
    mutationFn: (data) => (isEditing ? booksApi.updateBook(bookId, data) : booksApi.createBook(data)),
    onSuccess: async (response) => {
      const book = response.data
      setCurrentBook(book)
      setChapterProgress(0)

      const generation = await booksApi.generateChapters(book.id, {
        chapterCount: book.chapterCount ?? 5,
      })
      setChapterJobId(getJobId(generation))
    },
    onError: (error) => {
      toast.error(error?.response?.data?.detail ?? 'Error al guardar el libro')
    },
  })

  const { job: chapterJob } = useJobPolling(chapterJobId, {
    onProgress: setChapterProgress,
    onComplete: async () => {
      setChapterJobId(null)
      const response = await booksApi.getChapters(currentBook.id)
      setChapters(sortChapters(response.data))
      setStep(2)
      queryClient.invalidateQueries({ queryKey: ['book', currentBook.id] })
    },
    onError: (error) => {
      toast.error(`Generacion de capitulos fallida: ${error}`)
      setChapterJobId(null)
    },
  })

  const generateContent = useCallback(async () => {
    if (!currentBook) return

    try {
      setContentProgress(0)
      await booksApi.reorderChapters(currentBook.id, { chapterIds: chapters.map((chapter) => chapter.id) })
      const response = await booksApi.generateAllContent(currentBook.id, {
        contentType: currentBook.contentType ?? 'long',
        style: currentBook.writingStyle ?? 'professional',
        language: 'en',
      })
      setContentJobId(getJobId(response))
      setStep(3)
    } catch (error) {
      toast.error(error?.response?.data?.detail ?? 'Error al iniciar la generacion')
    }
  }, [chapters, currentBook])

  const { job: contentJob } = useJobPolling(contentJobId, {
    onProgress: setContentProgress,
    onComplete: () => {
      setContentJobId(null)
      queryClient.invalidateQueries({ queryKey: ['books'] })
      queryClient.invalidateQueries({ queryKey: ['chapters', currentBook.id] })
      toast.success('Contenido generado. Abriendo editor.')
      navigate(`/books/${currentBook.id}/editor`)
    },
    onError: (error) => {
      toast.error(`Generacion de contenido fallida: ${error}`)
      setContentJobId(null)
      setStep(2)
    },
  })

  if (isEditing && loadingBook) return <FullPageSpinner />

  const formInitialData = isEditing && existingBook
    ? {
        title: existingBook.title,
        description: existingBook.description,
        targetAudience: existingBook.targetAudience,
        keywords: existingBook.keywords ?? [],
        writingStyle: existingBook.writingStyle ?? 'professional',
        contentType: existingBook.contentType ?? 'ebook',
        chapterCount: existingBook.chapterCount ?? 5,
      }
    : null

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{isEditing ? 'Editar libro' : 'Nuevo libro'}</h1>
        <p className="mt-1 text-sm text-slate-500">
          Crea el concepto, genera capitulos, revisa el progreso y luego produce el contenido completo.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-card">
        <StepBar current={step} />

        {step === 1 && (
          <>
            <BookForm
              initialData={formInitialData}
              onSubmit={(data) => saveMutation.mutate(data)}
              isLoading={saveMutation.isPending || Boolean(chapterJobId)}
            />
            {chapterJobId && (
              <JobProgressCard
                className="mt-6"
                title="Generando capitulos"
                job={chapterJob}
                progress={chapterProgress}
              />
            )}
          </>
        )}

        {step === 2 && (
          <BookChapters
            bookId={currentBook?.id}
            chapters={chapters}
            onChaptersChange={setChapters}
            onGenerate={generateContent}
            onBack={() => setStep(1)}
            isGenerating={Boolean(contentJobId)}
            progress={contentProgress}
            job={contentJob}
          />
        )}

        {step === 3 && (
          <div className="flex flex-col items-center gap-4 py-16">
            <JobProgressCard
              className="w-full max-w-md"
              title="Generando contenido completo"
              job={contentJob}
              progress={contentProgress}
            />
            <p className="max-w-md text-center text-sm text-slate-500">
              La IA esta escribiendo cada capitulo. Al terminar abriremos el editor automaticamente.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
