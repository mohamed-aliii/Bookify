import { useCallback, useState } from 'react'
import { api, streamLearning } from '../api'
import Markdown from './Markdown'

export default function UnderstandingCheck({
  bookId,
  sectionId,
}: {
  bookId: number
  sectionId: number
}) {
  const [phase, setPhase] = useState<'idle' | 'questions' | 'answering' | 'analyzing' | 'done'>('idle')
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [analysis, setAnalysis] = useState('')
  const [loading, setLoading] = useState(false)

  const startCheck = useCallback(async () => {
    setLoading(true)
    setPhase('questions')
    try {
      const data = await api.getUnderstandingQuestions(bookId, sectionId)
      setQuestions(data.questions)
      setAnswers(data.questions.map(() => ''))
      setPhase('answering')
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [bookId, sectionId])

  const submitAnswers = useCallback(() => {
    setPhase('analyzing')
    setAnalysis('')
    streamLearning(
      `/api/books/${bookId}/understand`,
      { section_id: sectionId, answers },
      {
        onToken: (t) => setAnalysis((prev) => prev + t),
      },
    ).finally(() => setPhase('done'))
  }, [bookId, sectionId, answers])

  const reset = useCallback(() => {
    setPhase('idle')
    setQuestions([])
    setAnswers([])
    setAnalysis('')
  }, [])

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m9 11 2 2 4-4"/></svg>
        </div>
        <h3 className="text-base font-semibold text-slate-100">Understanding Check</h3>
        <p className="mt-1 max-w-sm text-xs text-slate-400">
          Before diving in, let's see what you already know. This helps focus your study on the right areas.
        </p>
      </div>

      {phase === 'idle' && (
        <button
          onClick={startCheck}
          disabled={loading}
          className="w-full btn-primary"
        >
          {loading ? 'Loading...' : 'Start Understanding Check'}
        </button>
      )}

      {(phase === 'answering' || phase === 'analyzing') && (
        <div className="space-y-4">
          {questions.map((q, i) => (
            <div key={i} className="space-y-2">
              <label className="block text-sm font-medium text-slate-200">
                {i + 1}. {q}
              </label>
              <textarea
                value={answers[i] ?? ''}
                onChange={(e) => {
                  const newAnswers = [...answers]
                  newAnswers[i] = e.target.value
                  setAnswers(newAnswers)
                }}
                rows={2}
                disabled={phase === 'analyzing'}
                placeholder="What do you already know about this?"
                className="w-full input disabled:opacity-60"
              />
            </div>
          ))}

          {phase === 'answering' && (
            <button
              onClick={submitAnswers}
              disabled={answers.some((a) => !a.trim())}
              className="w-full btn-primary"
            >
              Analyze My Understanding
            </button>
          )}
        </div>
      )}

      {(phase === 'analyzing' || phase === 'done') && analysis && (
        <div className="card p-5">
          <h4 className="mb-2 text-sm font-semibold text-indigo-300">Analysis</h4>
          <div className="text-sm leading-relaxed text-slate-300">
            <Markdown text={analysis} />
            {phase === 'analyzing' && (
              <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-indigo-400" />
            )}
          </div>
        </div>
      )}

      {phase === 'done' && (
        <button
          onClick={reset}
          className="w-full btn-secondary"
        >
          Check Again
        </button>
      )}
    </div>
  )
}
