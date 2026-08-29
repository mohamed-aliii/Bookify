import { useState } from 'react'
import { api } from '../api'
import type { RecallCheckResult } from '../types'

export default function RecallPrompt({
  bookId,
  sectionId,
  sectionTitle,
  onDismiss,
}: {
  bookId: number
  sectionId: number
  sectionTitle: string
  onDismiss: () => void
}) {
  const [recall, setRecall] = useState('')
  const [result, setResult] = useState<RecallCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!recall.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const r = await api.checkRecall(bookId, sectionId, recall.trim())
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.06] p-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Quick Recall</h3>
        <button onClick={onDismiss} className="text-xs text-slate-500 hover:text-slate-300">Skip</button>
      </div>

      {!result && (
        <>
          <p className="mb-3 text-xs text-slate-400">
            Before moving on — what did you just learn from "{sectionTitle}"? Write 2-3 key points from memory.
          </p>
          <textarea
            value={recall}
            onChange={(e) => setRecall(e.target.value)}
            rows={4}
            placeholder="Type what you remember…"
            className="w-full input"
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <button
            onClick={() => void submit()}
            disabled={!recall.trim() || loading}
            className="mt-3 btn-primary btn-sm"
          >
            {loading ? 'Checking…' : 'Check my recall'}
          </button>
        </>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold ${result.score >= 70 ? 'text-emerald-400' : result.score >= 40 ? 'text-amber-400' : 'text-red-400'}`}>
              {result.score}
            </span>
            <span className="text-xs text-slate-500">/ 100</span>
          </div>

          {result.accurate_points.length > 0 && (
            <div>
              <p className="text-xs font-medium text-emerald-400">You remembered:</p>
              <ul className="mt-1 space-y-0.5">
                {result.accurate_points.map((p, i) => (
                  <li key={i} className="text-xs text-slate-400">✓ {p}</li>
                ))}
              </ul>
            </div>
          )}

          {result.missed_points.length > 0 && (
            <div>
              <p className="text-xs font-medium text-amber-400">You missed:</p>
              <ul className="mt-1 space-y-0.5">
                {result.missed_points.map((p, i) => (
                  <li key={i} className="text-xs text-slate-400">✗ {p}</li>
                ))}
              </ul>
            </div>
          )}

          {result.misconceptions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-red-400">Misconceptions:</p>
              <ul className="mt-1 space-y-0.5">
                {result.misconceptions.map((p, i) => (
                  <li key={i} className="text-xs text-slate-400">⚠ {p}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs italic text-slate-500">{result.encouragement}</p>
        </div>
      )}
    </div>
  )
}
