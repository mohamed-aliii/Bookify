import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { WeakArea } from '../types'

function MasteryBar({ mastery }: { mastery: number }) {
  const pct = Math.round(mastery * 100)
  let color = 'bg-red-500'
  if (mastery >= 0.6) color = 'bg-amber-500'
  if (mastery >= 0.8) color = 'bg-emerald-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800/60">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-[11px] text-slate-500">{pct}%</span>
    </div>
  )
}

export default function WeakAreasPanel({
  bookId,
  onStartSession,
}: {
  bookId: number
  onStartSession: () => void
}) {
  const [areas, setAreas] = useState<WeakArea[]>([])
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasKPs, setHasKPs] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const kps = await api.listKnowledgePoints(bookId)
      setHasKPs(kps.length > 0)
      if (kps.length > 0) {
        const weak = await api.getWeakAreas(bookId, 20)
        setAreas(weak)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [bookId])

  useEffect(() => {
    void load()
  }, [load])

  const extract = async () => {
    setExtracting(true)
    setError(null)
    try {
      await api.extractKnowledgePoints(bookId, false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtracting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-14">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
        <p className="text-xs text-slate-500">Analyzing your knowledge…</p>
      </div>
    )
  }

  if (hasKPs === false) {
    return (
      <div className="card-surface p-10 text-center">
        <p className="text-sm font-medium text-slate-300">No knowledge points yet</p>
        <p className="mt-1 text-xs text-slate-500">
          Extract key concepts from this book to track your understanding.
        </p>
        <button
          onClick={() => void extract()}
          disabled={extracting}
          className="mt-4 btn-primary"
        >
          {extracting ? 'Extracting…' : 'Extract Knowledge Points'}
        </button>
      </div>
    )
  }

  const weak = areas.filter((a) => (a.user_kp?.mastery ?? 0) < 0.6)
  const developing = areas.filter((a) => {
    const m = a.user_kp?.mastery ?? 0
    return m >= 0.6 && m < 0.8
  })
  const strong = areas.filter((a) => (a.user_kp?.mastery ?? 0) >= 0.8)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="section-title">Knowledge Map</h2>
        <div className="flex gap-2">
          <button
            onClick={() => void extract()}
            disabled={extracting}
            className="btn-ghost btn-sm"
          >
            {extracting ? 'Extracting…' : 'Refresh'}
          </button>
          {weak.length > 0 && (
            <button
              onClick={onStartSession}
              className="btn-primary btn-sm"
            >
              Focus Weak Areas
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div>
      )}

      {weak.length > 0 && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
            Needs Work ({weak.length})
          </p>
          <div className="space-y-2">
            {weak.map((w) => (
              <div
                key={w.knowledge_point.id}
                className="card-surface px-4 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-200">{w.knowledge_point.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">{w.knowledge_point.description}</p>
                  </div>
                  <span className="badge-danger">
                    {w.section_title.slice(0, 20)}
                  </span>
                </div>
                <div className="mt-2">
                  <MasteryBar mastery={w.user_kp?.mastery ?? 0} />
                </div>
                <p className="mt-1.5 text-[11px] text-slate-600">{w.recommendation}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {developing.length > 0 && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
            Developing ({developing.length})
          </p>
          <div className="space-y-2">
            {developing.map((w) => (
              <div
                key={w.knowledge_point.id}
                className="card-surface px-4 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-slate-200">{w.knowledge_point.name}</p>
                  <span className="badge-warning">
                    {w.section_title.slice(0, 20)}
                  </span>
                </div>
                <div className="mt-2">
                  <MasteryBar mastery={w.user_kp?.mastery ?? 0} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {strong.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
            Mastered ({strong.length})
          </p>
          <div className="space-y-1.5">
            {strong.map((w) => (
              <div
                key={w.knowledge_point.id}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2"
              >
                <span className="text-xs text-slate-300">{w.knowledge_point.name}</span>
                <span className="text-[11px] text-emerald-400">{Math.round((w.user_kp?.mastery ?? 0) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
