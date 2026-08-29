import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { TranslateResult } from '../types'

interface Props {
  bookId: number
  sectionId: number | null
  text: string
  page: number | null
  visible: boolean
  position: { x: number; y: number } | null
  onClear: () => void
}

export default function TranslatePopup({ bookId, sectionId, text, page, visible, position, onClear }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TranslateResult | null>(null)
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useLayoutEffect(() => {
    if (!visible || !position || !ref.current) { setPos(null); return }
    const el = ref.current
    const rect = el.getBoundingClientRect()
    let x = position.x - rect.width / 2
    let y = position.y - rect.height - 12
    if (x < 8) x = 8
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
    if (y < 8) y = position.y + 24
    setPos({ x, y })
  }, [visible, position])

  useEffect(() => {
    if (!visible) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClear()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [visible, onClear])

  useEffect(() => {
    if (!visible) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSaved(new Set())
    api.translateSelection(bookId, { text, page })
      .then((res) => setResult(res))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [visible, bookId, text, page])

  const saveAll = useCallback(async () => {
    if (!result?.words.length || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.addVocabBatch(
        bookId,
        result.words.map((w) => ({ term: w.term, translation: w.translation, note: w.note, context: result.context })),
        sectionId,
      )
      setSaved(new Set(result.words.map((w) => w.term)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [result, saving, bookId, sectionId])

  if (!visible || !position) return null
  const stylePos = pos ?? { x: position.x - 120, y: position.y - 40 }

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-50 w-[340px] rounded-xl border border-slate-700/80 bg-surface-2 p-3 shadow-xl animate-scale-in"
      style={{ left: stylePos.x, top: stylePos.y }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-indigo-400">
            <path d="M3 5h6a5 5 0 015 5M3 5l9 14M3 5H1M3 15h7M19 4l3 16M16 8h7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-medium text-slate-200">Translate</span>
        </div>
        <button onClick={onClear} className="text-slate-500 hover:text-slate-200">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4 text-slate-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
          <span className="text-xs">Translating…</span>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {result && (
        <>
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {result.words.map((w) => (
              <li key={w.term} className="rounded-lg bg-white/[0.03] p-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-white">{w.term}</span>
                  {saved.has(w.term) && (
                    <span className="inline-flex items-center gap-1 text-2xs font-medium text-emerald-400">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      saved
                    </span>
                  )}
                </div>
                <p className="leading-relaxed text-indigo-200" dir="rtl">{w.translation}</p>
                {w.note && <p className="mt-1 text-2xs leading-relaxed text-slate-400">{w.note}</p>}
              </li>
            ))}
          </ul>
          <button
            onClick={() => void saveAll()}
            disabled={saving || saved.size === result.words.length}
            className="mt-3 w-full rounded-lg btn-primary btn-sm justify-center"
          >
            {saving ? 'Saving…' : saved.size === result.words.length ? 'Saved to vocab' : `Save ${result.words.length} ${result.words.length === 1 ? 'word' : 'words'} to vocab`}
          </button>
        </>
      )}
    </div>
  )
}
