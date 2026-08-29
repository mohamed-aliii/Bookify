import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamLearning } from '../api'
import type { Flashcard, ReviewRating, StudyActivity, StudySessionPlan } from '../types'
import Markdown from './Markdown'

type Phase = 'idle' | 'loading' | 'active' | 'complete'

const ACTIVITY_LABELS: Record<string, string> = {
  flashcard: 'Flashcard',
  quiz: 'Quiz',
  practice: 'Practice',
  socratic: 'Socratic',
  teachback: 'Teach Back',
}

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      {label && <p className="text-xs text-slate-500">{label}</p>}
    </div>
  )
}

export default function StudySessionView({
  bookId,
  sections,
}: {
  bookId: number
  sections: { id: number; title: string }[]
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [plan, setPlan] = useState<StudySessionPlan | null>(null)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [totalXp, setTotalXp] = useState(0)
  const [correctCount, setCorrectCount] = useState(0)
  const [sessionComplete, setSessionComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startRef = useRef(false)

  const currentActivity: StudyActivity | null = plan && currentIdx < plan.activities.length ? plan.activities[currentIdx] : null

  const startSession = useCallback(async () => {
    if (startRef.current) return
    startRef.current = true
    setPhase('loading')
    setError(null)
    try {
      const p = await api.startStudySession(bookId)
      setPlan(p)
      setCurrentIdx(p.current_index)
      setTotalXp(0)
      setCorrectCount(0)
      setSessionComplete(false)
      setPhase('active')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    } finally {
      startRef.current = false
    }
  }, [bookId])

  const advance = async (result: string, duration = 0) => {
    if (!plan || !currentActivity) return
    try {
      const res = await api.advanceStudySession(bookId, plan.session.id, {
        activity_id: currentActivity.id,
        result,
        duration_seconds: duration,
        knowledge_point_id: currentActivity.knowledge_point_id,
      })
      setTotalXp(res.total_xp)
      if (result === 'correct') setCorrectCount((c) => c + 1)
      if (res.all_done) {
        await api.completeStudySession(bookId, plan.session.id)
        setSessionComplete(true)
        setPhase('complete')
      } else {
        setCurrentIdx(res.current_index)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      {phase === 'idle' && (
        <div className="card-surface p-10 text-center">
          <p className="text-sm font-medium text-slate-300">Adaptive Study Session</p>
          <p className="mt-1 text-xs text-slate-500">
            A mixed session of flashcards, quizzes, and practice — focused on your weak areas.
          </p>
          <button
            onClick={() => void startSession()}
            className="mt-5 btn-primary"
          >
            Start Session
          </button>
        </div>
      )}

      {phase === 'loading' && <Spinner label="Preparing your session…" />}

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div>
      )}

      {phase === 'active' && currentActivity && !sessionComplete && (
        <div>
          <div className="mb-4 flex items-center justify-between text-xs text-slate-500">
            <span>
              {ACTIVITY_LABELS[currentActivity.activity_type] ?? currentActivity.activity_type} {currentIdx + 1} of{' '}
              {plan!.total_activities}
            </span>
            <span className="font-medium text-indigo-400">+{totalXp} XP</span>
          </div>
          <div className="mb-4 h-1 overflow-hidden rounded-full bg-slate-800/60">
            <div
              className="h-full rounded-full bg-indigo-500/70 transition-all"
              style={{ width: `${((currentIdx + 1) / plan!.total_activities) * 100}%` }}
            />
          </div>

          {currentActivity.activity_type === 'flashcard' && (
            <FlashcardActivity
              bookId={bookId}
              sectionId={currentActivity.knowledge_point_id ?? sections[0]?.id ?? 0}
              onComplete={(result) => void advance(result)}
            />
          )}
          {currentActivity.activity_type === 'quiz' && (
            <QuizActivity
              bookId={bookId}
              knowledgePointId={currentActivity.knowledge_point_id}
              onComplete={(result) => void advance(result)}
            />
          )}
          {currentActivity.activity_type === 'practice' && (
            <PracticeActivity
              bookId={bookId}
              sectionId={currentActivity.knowledge_point_id ?? sections[0]?.id ?? 0}
              onComplete={(result) => void advance(result)}
            />
          )}
          {(currentActivity.activity_type === 'socratic' || currentActivity.activity_type === 'teachback') && (
            <div className="rounded-2xl border border-dashed border-slate-700/60 p-8 text-center">
              <p className="text-sm text-slate-400">
                {currentActivity.activity_type === 'socratic'
                  ? 'Switch to Socratic mode in the study view for this activity.'
                  : 'Switch to Teach Back mode in the study view for this activity.'}
              </p>
              <button
                onClick={() => void advance('skipped')}
                className="mt-3 btn-secondary btn-sm"
              >
                Skip for now
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'complete' && plan && (
        <div className="card p-10 text-center">
          <p className="text-3xl font-bold text-slate-100">Session Complete</p>
          <div className="mt-4 flex items-center justify-center gap-6 text-sm text-slate-400">
            <div>
              <p className="text-2xl font-bold text-indigo-400">+{totalXp}</p>
              <p className="text-xs">XP Earned</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-emerald-400">{correctCount}</p>
              <p className="text-xs">Correct</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-300">{plan.total_activities}</p>
              <p className="text-xs">Activities</p>
            </div>
          </div>
          <div className="mt-6 flex justify-center gap-2">
            <button
              onClick={() => {
                setPhase('idle')
                setPlan(null)
              }}
              className="btn-secondary"
            >
              Done
            </button>
            <button
              onClick={() => {
                setPhase('idle')
                setPlan(null)
                void startSession()
              }}
              className="btn-primary"
            >
              New Session
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function FlashcardActivity({
  bookId,
  sectionId: _sectionId,
  onComplete,
}: {
  bookId: number
  sectionId: number
  onComplete: (result: string) => void
}) {
  const [card, setCard] = useState<Flashcard | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const due = await api.getDueCards(bookId, 1)
        if (!cancelled) {
          setCard(due.length > 0 ? due[0] : null)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId])

  const rate = async (rating: ReviewRating) => {
    if (!card) return
    await api.reviewCard(bookId, card.id, rating)
    onComplete(rating === 'again' || rating === 'hard' ? 'incorrect' : 'correct')
  }

  if (loading) return <Spinner label="Loading flashcard…" />
  if (!card) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700/60 p-8 text-center">
        <p className="text-sm text-slate-400">No due cards. Mark as done.</p>
        <button
          onClick={() => onComplete('correct')}
          className="mt-3 btn-primary btn-sm"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={() => setFlipped((f) => !f)}
        className="flex min-h-48 w-full flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center transition hover:border-indigo-500/40"
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
              onClick={() => void rate(rating)}
              className={`rounded-xl px-3 py-2 text-xs font-medium capitalize text-white transition ${cls}`}
            >
              {rating}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-center text-[11px] text-slate-600">Click to reveal</p>
      )}
    </div>
  )
}

function QuizActivity({
  bookId,
  knowledgePointId,
  onComplete,
}: {
  bookId: number
  knowledgePointId: number | null
  onComplete: (result: string) => void
}) {
  const [quiz, setQuiz] = useState<{ quiz_id: string; questions: { id: string; question: string; options: string[] }[] } | null>(null)
  const [qIdx, setQIdx] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [grade, setGrade] = useState<{ correct: boolean; answer_index: number; explanation: string } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const q = await api.generateQuiz(bookId, knowledgePointId, 1)
        if (!cancelled) {
          setQuiz(q)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, knowledgePointId])

  const pick = async (idx: number) => {
    if (!quiz || grade) return
    setSelected(idx)
    const result = await api.gradeQuiz(quiz.quiz_id, quiz.questions[qIdx].id, idx)
    setGrade(result)
  }

  const next = () => {
    if (!quiz) return
    if (qIdx + 1 >= quiz.questions.length) {
      onComplete(grade?.correct ? 'correct' : 'incorrect')
    } else {
      setQIdx((i) => i + 1)
      setSelected(null)
      setGrade(null)
    }
  }

  if (loading) return <Spinner label="Generating quiz…" />
  if (!quiz || quiz.questions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700/60 p-8 text-center">
        <p className="text-sm text-slate-400">No quiz available.</p>
        <button onClick={() => onComplete('skipped')} className="mt-3 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300">
          Skip
        </button>
      </div>
    )
  }

  const q = quiz.questions[qIdx]
  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">Question {qIdx + 1} of {quiz.questions.length}</p>
      <p className="mb-4 text-base font-medium text-slate-100"><Markdown text={q.question} /></p>
      <div className="space-y-2">
        {q.options.map((opt, idx) => {
          let style = 'border-white/[0.06] bg-white/[0.02] hover:border-indigo-500/40'
          if (grade) {
            if (idx === grade.answer_index) style = 'border-emerald-500/60 bg-emerald-500/10'
            else if (selected === idx) style = 'border-red-500/60 bg-red-500/10'
            else style = 'border-white/[0.04] bg-white/[0.01] opacity-50'
          }
          return (
            <button
              key={idx}
              onClick={() => void pick(idx)}
              disabled={!!grade}
              className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm text-slate-200 transition ${style}`}
            >
              <span className="font-semibold text-slate-500">{'ABCD'[idx]}</span>
              <span className="min-w-0 flex-1"><Markdown text={opt} /></span>
            </button>
          )
        })}
      </div>
      {grade && (
        <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${grade.correct ? 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-200' : 'border-amber-500/30 bg-amber-500/[0.07] text-amber-100'}`}>
          <p className="font-medium">{grade.correct ? 'Correct!' : 'Not quite.'}</p>
          {grade.explanation && <div className="mt-1 text-xs opacity-90"><Markdown text={grade.explanation} /></div>}
        </div>
      )}
      {grade && (
        <div className="mt-4 flex justify-end">
          <button onClick={next} className="btn-primary">
            {qIdx + 1 >= quiz.questions.length ? 'Finish' : 'Next'}
          </button>
        </div>
      )}
    </div>
  )
}

function PracticeActivity({
  bookId,
  sectionId,
  onComplete,
}: {
  bookId: number
  sectionId: number
  onComplete: (result: string) => void
}) {
  const [problem, setProblem] = useState<{ problem_id: string; question: string; hints: string[]; solution: string } | null>(null)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')
  const [correct, setCorrect] = useState<boolean | null>(null)
  const [hintsRevealed, setHintsRevealed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [grading, setGrading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const p = await api.generatePracticeProblem(bookId, sectionId, 'auto')
        if (!cancelled) {
          setProblem(p)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, sectionId])

  const submit = async () => {
    if (!problem || !answer.trim() || grading) return
    setGrading(true)
    setFeedback('')
    setCorrect(null)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let text = ''
      await streamLearning(
        `/api/books/${bookId}/practice/grade`,
        { section_id: sectionId, problem_id: problem.problem_id, answer },
        {
          onToken: (t) => {
            text += t
            setFeedback(text)
          },
        },
        controller.signal,
      )
      const lower = text.toLowerCase()
      const scoreMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*1|out of 1|%)/)
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : lower.includes('correct') || lower.includes('excellent') ? 1.0 : 0.0
      setCorrect(score >= 0.6)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setFeedback(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setGrading(false)
    }
  }

  if (loading) return <Spinner label="Generating practice problem…" />
  if (!problem) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700/60 p-8 text-center">
        <p className="text-sm text-slate-400">No practice problem available.</p>
        <button onClick={() => onComplete('skipped')} className="mt-3 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300">Skip</button>
      </div>
    )
  }

  return (
    <div>
      <div className="card mb-4 p-6">
        <p className="text-base font-medium text-slate-100"><Markdown text={problem.question} /></p>
      </div>

      {problem.hints && problem.hints.length > 0 && hintsRevealed < problem.hints.length && (
        <button
          onClick={() => setHintsRevealed((h) => h + 1)}
          className="mb-3 text-xs font-medium text-amber-400 hover:text-amber-300"
        >
          Reveal hint ({hintsRevealed}/{problem.hints.length})
        </button>
      )}
      {hintsRevealed > 0 && (
        <div className="mb-3 space-y-1">
          {problem.hints.slice(0, hintsRevealed).map((h, i) => (
            <p key={i} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-200">
              {h}
            </p>
          ))}
        </div>
      )}

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        disabled={grading || correct !== null}
        placeholder="Write your answer…"
        rows={4}
        className="w-full input disabled:opacity-50"
      />

      <div className="mt-3 flex justify-end gap-2">
        {correct !== null ? (
          <button
            onClick={() => onComplete(correct ? 'correct' : 'incorrect')}
            className="btn-primary"
          >
            Continue
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={!answer.trim() || grading}
            className="btn-primary disabled:opacity-50"
          >
            {grading ? 'Evaluating…' : 'Submit'}
          </button>
        )}
      </div>

      {feedback && (
        <div className="card mt-4 px-4 py-3">
          <Markdown text={feedback} />
        </div>
      )}
    </div>
  )
}
