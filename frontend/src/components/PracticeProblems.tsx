import { useCallback, useRef, useState } from 'react'
import { api, streamLearning } from '../api'
import Markdown from './Markdown'
import type { PracticeProblem } from '../types'

export default function PracticeProblems({
  bookId,
  sectionId,
}: {
  bookId: number
  sectionId: number
}) {
  const [problem, setProblem] = useState<PracticeProblem | null>(null)
  const [answer, setAnswer] = useState('')
  const [evaluation, setEvaluation] = useState('')
  const [hintsRevealed, setHintsRevealed] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [grading, setGrading] = useState(false)
  const [problemType, setProblemType] = useState('auto')
  const [score, setScore] = useState({ attempted: 0, correct: 0 })
  const abortRef = useRef<AbortController | null>(null)

  const generate = useCallback(async () => {
    setGenerating(true)
    setProblem(null)
    setAnswer('')
    setEvaluation('')
    setHintsRevealed(0)
    try {
      const p = await api.generatePracticeProblem(bookId, sectionId, problemType)
      setProblem(p)
    } catch (e) {
      console.error(e)
    } finally {
      setGenerating(false)
    }
  }, [bookId, sectionId, problemType])

  const submitAnswer = useCallback(() => {
    if (!answer.trim() || !problem || grading) return

    setGrading(true)
    setEvaluation('')
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    streamLearning(
      `/api/books/${bookId}/practice/grade`,
      { section_id: sectionId, problem_id: problem.problem_id, answer: answer.trim() },
      {
        onToken: (t) => setEvaluation((prev) => prev + t),
      },
      abortRef.current.signal,
    ).finally(() => {
      setGrading(false)
      setScore((s) => ({ ...s, attempted: s.attempted + 1 }))
    })
  }, [bookId, sectionId, problem, answer, grading])

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <h3 className="text-base font-semibold text-slate-100">Practice Problems</h3>
        <p className="mt-1 max-w-sm text-xs text-slate-400">
          Apply what you've learned. Real problems, not just recall.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <select
          value={problemType}
          onChange={(e) => setProblemType(e.target.value)}
          className="input"
        >
          <option value="auto">Auto (best fit)</option>
          <option value="code">Code Challenge</option>
          <option value="math">Math / Calculation</option>
          <option value="design">Design Decision</option>
          <option value="debug">Debug Exercise</option>
          <option value="conceptual">Conceptual</option>
        </select>
        <button
          onClick={generate}
          disabled={generating}
          className="btn-primary btn-sm"
        >
          {generating ? 'Generating...' : 'New Problem'}
        </button>
        {score.attempted > 0 && (
          <span className="ml-auto text-[11px] text-slate-500">
            {score.correct}/{score.attempted} correct
          </span>
        )}
      </div>

      {problem && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="mb-3 flex items-center gap-2">
              <span className="badge-warning">{problem.problem_type}</span>
              <span className={`badge rounded-full px-2 py-0.5 text-[11px] font-medium ${
                problem.difficulty === 'easy' ? 'bg-emerald-500/15 text-emerald-400' :
                problem.difficulty === 'hard' ? 'bg-red-500/15 text-red-400' :
                'bg-blue-500/15 text-blue-400'
              }`}>
                {problem.difficulty}
              </span>
            </div>
            <div className="text-sm leading-relaxed text-slate-200">
              <Markdown text={problem.question} />
            </div>
          </div>

          {hintsRevealed > 0 && (
            <div className="space-y-2">
              {problem.hints.slice(0, hintsRevealed).map((hint, i) => (
                <div key={i} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-300/90">
                  <span className="font-medium">Hint {i + 1}:</span> {hint}
                </div>
              ))}
            </div>
          )}

          {hintsRevealed < problem.hints.length && !evaluation && (
            <button
              onClick={() => setHintsRevealed((h) => h + 1)}
              className="text-xs text-amber-400/70 transition hover:text-amber-400"
            >
              {hintsRevealed === 0 ? 'Need a hint?' : 'Another hint?'} ({problem.hints.length - hintsRevealed} left)
            </button>
          )}

          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={6}
            placeholder="Write your answer here..."
            className="w-full input"
          />

          <div className="flex gap-2">
            <button
              onClick={submitAnswer}
              disabled={!answer.trim() || grading}
              className="btn-primary"
            >
              {grading ? 'Evaluating...' : 'Submit Answer'}
            </button>
            <button
              onClick={() => { setProblem(null); setAnswer(''); setEvaluation('') }}
              className="btn-secondary"
            >
              Skip
            </button>
          </div>

          {evaluation && (
            <div className="card p-5">
              <h4 className="mb-2 text-sm font-semibold text-indigo-300">Feedback</h4>
              <div className="text-sm leading-relaxed text-slate-300">
                <Markdown text={evaluation} />
              </div>
            </div>
          )}

          {evaluation && problem.solution && (
            <details className="card p-5">
              <summary className="cursor-pointer text-sm font-medium text-slate-400 hover:text-slate-300">
                View Full Solution
              </summary>
              <div className="mt-3 text-sm leading-relaxed text-slate-300">
                <Markdown text={problem.solution} />
              </div>
            </details>
          )}
        </div>
      )}

      {!problem && !generating && (
        <div className="card-surface py-12 text-center text-sm text-slate-500">
          Click "New Problem" to get started
        </div>
      )}
    </div>
  )
}
