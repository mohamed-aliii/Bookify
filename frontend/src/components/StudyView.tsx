import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, streamSummary } from '../api'
import type { BookProgress, Flashcard, Quiz, QuizGradeResult, ReviewRating, Section } from '../types'
import Markdown from './Markdown'
import SocraticChat from './SocraticChat'
import TeachBack from './TeachBack'
import PracticeProblems from './PracticeProblems'
import UnderstandingCheck from './UnderstandingCheck'
import WeakAreasPanel from './WeakAreasPanel'
import StudySessionView from './StudySessionView'
import ConceptGraphView from './ConceptGraph'
import Notebook from './Notebook'
import RelatedSections from './RelatedSections'
import ContentStartPicker from './ContentStartPicker'

type Mode = 'summary' | 'cards' | 'review' | 'quiz' | 'socratic' | 'practice' | 'teachback' | 'understand' | 'weakness' | 'session' | 'graph' | 'playground'

const MODE_LABELS: Record<Mode, string> = {
  summary: 'Summary',
  cards: 'Flashcards',
  review: 'Review',
  quiz: 'Quiz',
  socratic: 'Socratic',
  practice: 'Practice',
  teachback: 'Teach Back',
  understand: 'Assess',
  weakness: 'Weak Areas',
  session: 'Adaptive',
  graph: 'Graph',
  playground: 'Notebook',
}

function isDue(card: Flashcard): boolean {
  return !!card.due_at && new Date(card.due_at + 'Z').getTime() <= Date.now()
}

function dueLabel(card: Flashcard): string {
  if (!card.due_at) return 'new'
  const diffMs = new Date(card.due_at + 'Z').getTime() - Date.now()
  if (diffMs <= 0) return 'due'
  const days = Math.ceil(diffMs / 86_400_000)
  return days > 1 ? `in ${days}d` : 'later today'
}

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      {label && <p className="text-xs text-slate-500">{label}</p>}
    </div>
  )
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function ReviewCardView({
  card,
  remaining,
  sections,
  flipped,
  busy,
  onFlip,
  onRate,
}: {
  card: Flashcard
  remaining: number
  sections: Section[]
  flipped: boolean
  busy: boolean
  onFlip: () => void
  onRate: (rating: ReviewRating) => void
}) {
  const sectionTitle = sections.find((s) => s.id === card.section_id)?.title ?? ''
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span className="max-w-[65%] truncate">{sectionTitle}</span>
        <span>{remaining} due</span>
      </div>
      <button
        onClick={onFlip}
        className="flex min-h-52 w-full flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center transition hover:border-indigo-500/40"
      >
        <span className="mb-3 text-[10px] uppercase tracking-widest text-slate-600">{flipped ? 'Answer' : 'Question'}</span>
        <Markdown text={flipped ? card.back : card.front} />
      </button>
      {flipped ? (
        <div className="mt-4 grid grid-cols-4 gap-2">
          {(
            [
              ['again', 'bg-red-600/80 hover:bg-red-500'],
              ['hard', 'bg-amber-600/80 hover:bg-amber-500'],
              ['good', 'bg-emerald-600/80 hover:bg-emerald-500'],
              ['easy', 'bg-indigo-600/80 hover:bg-indigo-500'],
            ] as [ReviewRating, string][]
          ).map(([rating, cls]) => (
            <button
              key={rating}
              disabled={busy}
              onClick={() => onRate(rating)}
              className={`rounded-xl px-3 py-2 text-xs font-medium capitalize text-white transition disabled:opacity-50 ${cls}`}
            >
              {rating}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-center text-[11px] text-slate-600">Click the card to reveal the answer</p>
      )}
    </div>
  )
}

export default function StudyView({
  bookId,
  sections,
  activeSectionId,
  onSelectSection,
  notebookFocus,
  onContentStartConfirmed,
}: {
  bookId: number
  sections: Section[]
  activeSectionId: number | null
  onSelectSection: (id: number) => void
  notebookFocus?: { seq: number; cellId: number; sectionId: number | null } | null
  onContentStartConfirmed?: () => void
}) {
  const [mode, setMode] = useState<Mode>('summary')

  useEffect(() => {
    if (notebookFocus) setMode('playground')
  }, [notebookFocus])

  const [summaryText, setSummaryText] = useState('')
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [summaryStarted, setSummaryStarted] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const summaryAbortRef = useRef<AbortController | null>(null)

  const [allCards, setAllCards] = useState<Flashcard[]>([])
  const [cardCount, setCardCount] = useState(6)
  const [autoCards, setAutoCards] = useState(true)
  const [generatingCards, setGeneratingCards] = useState(false)
  const [cardsError, setCardsError] = useState<string | null>(null)
  const [deckIndex, setDeckIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [shuffled, setShuffled] = useState<number[] | null>(null)
  const [cardsLoaded, setCardsLoaded] = useState(false)

  const [wholeBook, setWholeBook] = useState(false)
  const [quizNum, setQuizNum] = useState(5)
  const [autoQuestions, setAutoQuestions] = useState(true)
  const [quizPhase, setQuizPhase] = useState<'idle' | 'loading' | 'active'>('idle')
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [quizIndex, setQuizIndex] = useState(0)
  const [quizDone, setQuizDone] = useState(false)
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [grades, setGrades] = useState<Record<string, QuizGradeResult>>({})
  const [quizError, setQuizError] = useState<string | null>(null)

  const [progress, setProgress] = useState<BookProgress | null>(null)
  const [dueQueue, setDueQueue] = useState<Flashcard[] | null>(null)
  const [reviewFlipped, setReviewFlipped] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)

  const [csOpen, setCsOpen] = useState(false)

  const toggleContentStart = () => {
    setCsOpen((o) => !o)
  }

  const section = sections.find((s) => s.id === activeSectionId) ?? null

  const loadCards = useCallback(async () => {
    try {
      setAllCards(await api.getFlashcards(bookId))
      setCardsLoaded(true)
    } catch (e) {
      setCardsError(e instanceof Error ? e.message : String(e))
    }
  }, [bookId])

  const loadProgress = useCallback(async () => {
    try {
      const p = await api.getProgress(bookId)
      setProgress(p)
      return p
    } catch {
      return null
    }
  }, [bookId])

  useEffect(() => {
    void loadCards()
    void loadProgress()
  }, [loadCards, loadProgress])

  const runSummary = useCallback(
    async (force: boolean) => {
      if (!section) return
      summaryAbortRef.current?.abort()
      const controller = new AbortController()
      summaryAbortRef.current = controller
      setSummaryStarted(true)
      setSummaryBusy(true)
      setSummaryError(null)
      setSummaryText('')
      try {
        await streamSummary(bookId, section.id, force, { onToken: (t) => setSummaryText((prev) => prev + t) }, controller.signal)
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          setSummaryError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (!controller.signal.aborted) setSummaryBusy(false)
      }
    },
    [bookId, section],
  )

  useEffect(() => {
    summaryAbortRef.current?.abort()
    setSummaryText('')
    setSummaryStarted(false)
    setSummaryBusy(false)
    setSummaryError(null)
    if (!section) return
    void (async () => {
      try {
        const { cached } = await api.summaryCached(bookId, section.id)
        if (cached) void runSummary(false)
      } catch {
        /* status check is best-effort */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, activeSectionId])

  useEffect(() => () => summaryAbortRef.current?.abort(), [])

  const sectionCards = allCards.filter((c) => c.section_id === activeSectionId)

  const deckOrder = shuffled ?? sectionCards.map((_, i) => i)

  const generateCards = async () => {
    if (!section || generatingCards) return
    setGeneratingCards(true)
    setCardsError(null)
    try {
      const fresh = await api.generateFlashcards(bookId, section.id, autoCards ? null : cardCount)
      setAllCards((prev) => [...prev.filter((c) => c.section_id !== section.id), ...fresh])
      setShuffled(null)
      setDeckIndex(0)
      setFlipped(false)
    } catch (e) {
      setCardsError(e instanceof Error ? e.message : String(e))
    } finally {
      setGeneratingCards(false)
    }
  }

  const startQuiz = async () => {
    setQuizPhase('loading')
    setQuizError(null)
    setSelected({})
    setGrades({})
    setQuizIndex(0)
    setQuizDone(false)
    try {
      const q = await api.generateQuiz(bookId, wholeBook ? null : activeSectionId, autoQuestions ? null : quizNum)
      setQuiz(q)
      setQuizPhase('active')
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : String(e))
      setQuizPhase('idle')
    }
  }

  const pickOption = async (qid: string, idx: number) => {
    if (!quiz || qid in grades) return
    setSelected((prev) => ({ ...prev, [qid]: idx }))
    try {
      const result = await api.gradeQuiz(quiz.quiz_id, qid, idx)
      setGrades((prev) => ({ ...prev, [qid]: result }))
    } catch (e) {
      setQuizError(e instanceof Error ? e.message : String(e))
    }
  }

  const refreshQueue = useCallback(async () => {
    try {
      setDueQueue(await api.getDueCards(bookId))
    } catch {
      setDueQueue([])
    }
  }, [bookId])

  useEffect(() => {
    if (mode === 'review') void refreshQueue()
  }, [mode, refreshQueue])

  const rateCard = async (rating: ReviewRating) => {
    const card = dueQueue?.[0]
    if (!card || reviewBusy) return
    setReviewBusy(true)
    try {
      const updated = await api.reviewCard(bookId, card.id, rating)
      setAllCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      setDueQueue((prev) => (prev ? prev.slice(1) : prev))
      setReviewFlipped(false)
      void loadProgress()
    } finally {
      setReviewBusy(false)
    }
  }

  const currentQuestion = quiz && quizIndex < quiz.questions.length ? quiz.questions[quizIndex] : null
  const answeredCount = Object.keys(grades).length
  const correctCount = Object.values(grades).filter((g) => g.correct).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <select
          value={activeSectionId ?? ''}
          onChange={(e) => onSelectSection(Number(e.target.value))}
          className="input max-w-[280px] min-w-0 flex-1 sm:flex-none truncate"
        >
          {sections.map((s, idx) => {
            const isLast = idx === sections.length - 1
            const pageCount = s.page_end && s.page_end > s.page_start ? (isLast ? s.page_end - s.page_start + 1 : s.page_end - s.page_start) : 1
            const displayEnd = s.page_end && s.page_end > s.page_start ? (isLast ? s.page_end : s.page_end - 1) : s.page_start
            const range = displayEnd !== s.page_start ? `p. ${s.page_start}–${displayEnd}` : `p. ${s.page_start}`
            return (
              <option key={s.id} value={s.id}>
                {'\u00A0'.repeat(((s.level ?? 1) - 1) * 4)}
                {(s.level ?? 1) > 1 ? '› ' : ''}
                {s.title} • {pageCount} p. • {range}
              </option>
            )
          })}
        </select>
        <button
          onClick={toggleContentStart}
          className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          First chapter
        </button>
        <div className="ml-auto flex overflow-x-auto no-scrollbar rounded-xl bg-white/[0.03] p-0.5 border border-white/[0.04]">
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                mode === m ? 'bg-surface-3 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {MODE_LABELS[m]}
              {m === 'cards' && sectionCards.length > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{sectionCards.length}</span>
              )}
              {m === 'review' && progress && progress.cards_due > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{progress.cards_due}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {csOpen && (
        <div className="shrink-0 border-b border-white/[0.06] bg-white/[0.015] px-5 py-3">
          <ContentStartPicker
            bookId={bookId}
            onClose={() => setCsOpen(false)}
            onConfirmed={() => {
              void loadCards()
              void loadProgress()
              onContentStartConfirmed?.()
            }}
          />
        </div>
      )}

      {progress && progress.cards_total > 0 && (
        <div className="shrink-0 border-b border-white/[0.06] px-5 py-2">
          <div className="mx-auto flex max-w-3xl items-center gap-3 text-[11px] text-slate-500">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800/60">
              <div
                className="h-full rounded-full bg-emerald-500/70 transition-all"
                style={{ width: `${Math.round((progress.cards_mastered / progress.cards_total) * 100)}%` }}
              />
            </div>
            <span>
              {progress.cards_mastered}/{progress.cards_total} mastered
            </span>
            {progress.cards_due > 0 && <span className="font-medium text-indigo-400">{progress.cards_due} due</span>}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'playground' ? (
          <Notebook bookId={bookId} sectionId={(notebookFocus?.sectionId ?? activeSectionId) ?? undefined} focus={notebookFocus ?? null} />
        ) : (
        <div className="mx-auto max-w-3xl px-5 py-6">
          {!section && (
            <div className="card-surface p-12 text-center text-sm text-slate-500">
              Pick a section to study.
            </div>
          )}

          {section && mode === 'summary' && (
            <div>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-200">{section.title}</h2>
                {!summaryBusy && (
                  <button
                    onClick={() => void runSummary(true)}
                    className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                  >
                    {summaryStarted ? 'Regenerate' : 'Generate summary'}
                  </button>
                )}
              </div>
              {!summaryStarted && !summaryBusy && (
                <div className="card-surface p-10 text-center">
                  <p className="text-sm text-slate-400">No summary yet.</p>
                  <div className="mt-4 flex justify-center">
                    <PrimaryButton onClick={() => void runSummary(false)}>Generate summary</PrimaryButton>
                  </div>
                </div>
              )}
              {summaryBusy && !summaryText && <Spinner label="Reading the section…" />}
              {summaryText && (
                <>
                  <Markdown text={summaryText} />
                  {summaryBusy && <span className="cursor-blink ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 bg-indigo-400" />}
                </>
              )}
              {summaryError && (
                <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{summaryError}</div>
              )}

              <RelatedSections bookId={bookId} sectionId={section.id} />
            </div>
          )}

          {section && mode === 'cards' && (
            <div>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold text-slate-200">{section.title}</h2>
                <span className="text-xs text-slate-600">{sectionCards.length} cards</span>
                <div className="ml-auto flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-500" title="Scale the number of cards to how much content this section has">
                    <input type="checkbox" checked={autoCards} onChange={(e) => setAutoCards(e.target.checked)} />
                    Auto
                  </label>
                  <input
                    type="number"
                    min={3}
                    max={24}
                    value={cardCount}
                    disabled={autoCards}
                    onChange={(e) => setCardCount(Number(e.target.value))}
                    className="input disabled:opacity-40"
                  />
                  <PrimaryButton onClick={() => void generateCards()} disabled={generatingCards}>
                    {generatingCards ? 'Generating…' : sectionCards.length ? 'Regenerate' : 'Generate'}
                  </PrimaryButton>
                </div>
              </div>

              {generatingCards && <Spinner label="Writing flashcards… this can take a minute" />}
              {cardsError && (
                <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{cardsError}</div>
              )}

              {!generatingCards && sectionCards.length === 0 && cardsLoaded && (
                <div className="card-surface p-10 text-center text-sm text-slate-400">
                  No flashcards for this section yet.
                </div>
              )}

              {!generatingCards && sectionCards.length > 0 && (
                <div>
                  <button
                    onClick={() => setFlipped((f) => !f)}
                    className="relative flex min-h-52 w-full flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center transition hover:border-indigo-500/40"
                  >
                    <span className="absolute right-3 top-3 rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] text-slate-400">
                      {isDue(sectionCards[deckOrder[deckIndex]]) ? 'due' : dueLabel(sectionCards[deckOrder[deckIndex]])}
                    </span>
                    <span className="mb-3 text-[10px] uppercase tracking-widest text-slate-600">{flipped ? 'Answer' : 'Question'}</span>
                    <Markdown text={flipped ? sectionCards[deckOrder[deckIndex]].back : sectionCards[deckOrder[deckIndex]].front} />
                  </button>
                  <div className="mt-4 flex items-center justify-between">
                    <button
                      onClick={() => {
                        setFlipped(false)
                        setDeckIndex((i) => (i - 1 + deckOrder.length) % deckOrder.length)
                      }}
                      className="btn-secondary btn-sm"
                    >
                      ← Prev
                    </button>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-500">
                        {deckIndex + 1} / {deckOrder.length}
                      </span>
                      <button
                        onClick={() => {
                          const order = [...sectionCards.keys()]
                          for (let i = order.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1))
                            ;[order[i], order[j]] = [order[j], order[i]]
                          }
                          setShuffled(order)
                          setDeckIndex(0)
                          setFlipped(false)
                        }}
                        className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                      >
                        Shuffle
                      </button>
                    </div>
                    <button
                      onClick={() => {
                        setFlipped(false)
                        setDeckIndex((i) => (i + 1) % deckOrder.length)
                      }}
                      className="btn-secondary btn-sm"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'review' && (
            <div>
              {!dueQueue && <Spinner label="Checking what's due…" />}
              {dueQueue && dueQueue.length === 0 && (
                <div className="card-surface p-10 text-center">
                  <p className="text-sm font-medium text-slate-300">All caught up.</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Nothing is due right now. Cards you rate come back on a spaced schedule — generate more in the
                    Flashcards tab.
                  </p>
                </div>
              )}
              {dueQueue && dueQueue.length > 0 && dueQueue[0] && (
                <ReviewCardView
                  card={dueQueue[0]}
                  remaining={dueQueue.length}
                  sections={sections}
                  flipped={reviewFlipped}
                  busy={reviewBusy}
                  onFlip={() => setReviewFlipped((f) => !f)}
                  onRate={(r) => void rateCard(r)}
                />
              )}
            </div>
          )}

          {section && mode === 'quiz' && (
            <div>
              {quizPhase === 'idle' && (
                <div className="card-surface p-8">
                  <h2 className="text-sm font-semibold text-slate-200">Test yourself</h2>
                  <div className="mt-4 space-y-3 text-sm text-slate-300">
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={!wholeBook} onChange={() => setWholeBook(false)} />
                      This section{section ? ` — ${section.title.slice(0, 40)}` : ''}
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" checked={wholeBook} onChange={() => setWholeBook(true)} />
                      The whole book (mixed sample)
                    </label>
                    <label className="flex items-center gap-2 pt-1 text-xs text-slate-500">
                      <input type="checkbox" checked={autoQuestions} onChange={(e) => setAutoQuestions(e.target.checked)} />
                      Auto — size the quiz to the content
                    </label>
                    <label className="flex items-center gap-2 pt-1 text-xs text-slate-500">
                      Questions
                      <select
                        value={quizNum}
                        disabled={autoQuestions}
                        onChange={(e) => setQuizNum(Number(e.target.value))}
                        className="input disabled:opacity-40"
                      >
                        {[3, 5, 8, 12, 15].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-5">
                    <PrimaryButton onClick={() => void startQuiz()}>Start quiz</PrimaryButton>
                  </div>
                </div>
              )}

              {quizPhase === 'loading' && <Spinner label="Writing questions…" />}
              {quizError && (
                <div className="mb-4 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">{quizError}</div>
              )}

              {quizPhase === 'active' && quiz && (
                <div>
                  {currentQuestion && !quizDone && (
                    <div>
                      <div className="mb-4 flex items-center justify-between text-xs text-slate-500">
                        <span>
                          Question {quizIndex + 1} of {quiz.questions.length}
                        </span>
                        <span>
                          Score {correctCount}/{answeredCount}
                        </span>
                      </div>
                      <div className="mb-5 text-base font-medium text-slate-100">
                        <Markdown text={currentQuestion.question} />
                      </div>
                      <div className="space-y-2">
                        {currentQuestion.options.map((opt, idx) => {
                          const grade = grades[currentQuestion.id]
                          const isSelected = selected[currentQuestion.id] === idx
                          let style =
                            'border-white/[0.06] bg-white/[0.02] hover:border-indigo-500/40'
                          if (grade) {
                            if (idx === grade.answer_index) style = 'border-emerald-500/60 bg-emerald-500/10'
                            else if (isSelected) style = 'border-red-500/60 bg-red-500/10'
                            else style = 'border-white/[0.04] bg-white/[0.01] opacity-50'
                          }
                          return (
                            <button
                              key={idx}
                              onClick={() => void pickOption(currentQuestion.id, idx)}
                              disabled={!!grade}
                              className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm text-slate-200 transition ${style}`}
                            >
                              <span className="font-semibold text-slate-500">{'ABCD'[idx]}</span>
                              <span className="min-w-0 flex-1">
                                <Markdown text={opt} />
                              </span>
                            </button>
                          )
                        })}
                      </div>

                      {grades[currentQuestion.id] && (
                        <div
                          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
                            grades[currentQuestion.id].correct
                              ? 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-200'
                              : 'border-amber-500/30 bg-amber-500/[0.07] text-amber-100'
                          }`}
                        >
                          <p className="font-medium">{grades[currentQuestion.id].correct ? 'Correct!' : 'Not quite.'}</p>
                          {grades[currentQuestion.id].explanation && (
                            <div className="mt-1 text-xs leading-relaxed opacity-90">
                              <Markdown text={grades[currentQuestion.id].explanation} />
                            </div>
                          )}
                        </div>
                      )}

                      <div className="mt-6 flex justify-end">
                        <PrimaryButton
                          onClick={() => {
                            if (quizIndex + 1 >= quiz.questions.length) {
                              setQuizDone(true)
                              void api
                                .recordQuizAttempt(bookId, wholeBook ? null : activeSectionId, correctCount, quiz.questions.length)
                                .then(() => loadProgress())
                                .catch(() => {})
                              return
                            }
                            setQuizIndex(quizIndex + 1)
                          }}
                          disabled={!grades[currentQuestion.id]}
                        >
                          {quizIndex + 1 >= quiz.questions.length ? 'See results' : 'Next question'}
                        </PrimaryButton>
                      </div>
                    </div>
                  )}

                  {quizDone && quiz && (
                    <div className="card p-10 text-center">
                      <p className="text-3xl font-bold text-slate-100">
                        {correctCount}/{quiz.questions.length}
                      </p>
                      <p className="mt-2 text-sm text-slate-400">
                        {correctCount === quiz.questions.length
                          ? 'Perfect — you know this material.'
                          : correctCount >= quiz.questions.length / 2
                            ? 'Solid. Review the misses and go again.'
                            : 'Worth rereading this section.'}
                      </p>
                      <div className="mt-6 flex justify-center gap-2">
                        <button
                          onClick={() => setQuizPhase('idle')}
                          className="btn-secondary"
                        >
                          Change settings
                        </button>
                        <PrimaryButton onClick={() => void startQuiz()}>New quiz</PrimaryButton>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {section && mode === 'socratic' && (
            <SocraticChat bookId={bookId} sectionId={section.id} />
          )}

          {section && mode === 'teachback' && (
            <TeachBack bookId={bookId} sectionId={section.id} />
          )}

          {section && mode === 'practice' && (
            <PracticeProblems bookId={bookId} sectionId={section.id} />
          )}

          {section && mode === 'understand' && (
            <UnderstandingCheck bookId={bookId} sectionId={section.id} />
          )}

          {mode === 'weakness' && (
            <WeakAreasPanel
              bookId={bookId}
              onStartSession={() => setMode('session')}
            />
          )}

          {mode === 'session' && (
            <StudySessionView
              bookId={bookId}
              sections={sections}
            />
          )}

          {mode === 'graph' && (
            <ConceptGraphView bookId={bookId} />
          )}
        </div>
        )}
      </div>
    </div>
  )
}
