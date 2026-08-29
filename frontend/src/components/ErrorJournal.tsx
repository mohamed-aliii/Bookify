import { useState } from 'react'
import type { QuizError } from '../types'

export default function ErrorJournal({ errors }: { errors: QuizError[] }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const displayed = showAll ? errors : errors.slice(0, 5)

  return (
    <div>
      <h3 className="section-title mb-3">Error Journal</h3>
      <p className="mb-3 text-xs text-slate-500">Questions you got wrong — review these to solidify understanding.</p>
      <div className="space-y-2">
        {displayed.map((err) => (
          <div key={err.id} className="rounded-xl border border-white/[0.04] bg-white/[0.02] px-4 py-3">
            <button
              onClick={() => setExpanded(expanded === err.id ? null : err.id)}
              className="w-full text-left"
            >
              <p className="text-sm text-slate-200">{err.question}</p>
              <div className="mt-1.5 flex items-center gap-3 text-xs">
                <span className="text-red-400">Your answer: {err.user_answer}</span>
                <span className="text-emerald-400">Correct: {err.correct_answer}</span>
              </div>
            </button>
            {expanded === err.id && err.explanation && (
              <div className="mt-3 border-t border-white/[0.04] pt-3 text-xs leading-relaxed text-slate-400">
                {err.explanation}
              </div>
            )}
          </div>
        ))}
      </div>
      {errors.length > 5 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs font-medium text-indigo-400 hover:text-indigo-300"
        >
          Show all {errors.length} errors
        </button>
      )}
    </div>
  )
}
