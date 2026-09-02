import { useEffect, useState } from 'react'
import { confirmContentStart, getContentStart, setContentStart } from '../api'
import type { ContentStartInfo } from '../types'

export default function ContentStartPicker({
  bookId,
  onConfirmed,
  onClose,
  autoClose = false,
}: {
  bookId: number
  onConfirmed?: () => void
  onClose?: () => void
  autoClose?: boolean
}) {
  const [info, setInfo] = useState<ContentStartInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [draftMaxLevel, setDraftMaxLevel] = useState<number>(2)

  const getPageCount = (s: { page_start: number; page_end: number }, idx: number, arr: { page_start: number; page_end: number }[]) => {
    if (!s.page_end || s.page_end <= 0) return 1
    const isLast = idx === arr.length - 1
    // page_end in DB is next section's page_start (exclusive) for non-last, inclusive for last
    return isLast ? s.page_end - s.page_start + 1 : s.page_end - s.page_start
  }
  const getDisplayEnd = (s: { page_start: number; page_end: number }, idx: number, arr: { page_start: number; page_end: number }[]) => {
    if (!s.page_end || s.page_end <= 0) return s.page_start
    const isLast = idx === arr.length - 1
    return isLast ? s.page_end : s.page_end - 1
  }

  const load = async () => {
    if (!Number.isFinite(bookId)) {
      setError('Invalid book id')
      return
    }
    setError(null)
    try {
      const data = await getContentStart(bookId)
      setInfo(data)
      setDraftMaxLevel(data.ingestion_max_level ?? 2)
    } catch (e) {
      const err = e as Error & { status?: number }
      const msg = err.message || String(e)
      const lower = msg.toLowerCase()
      if (err.status === 404 || lower.includes('not found') || msg.includes('404')) {
        setError('Book not found – try refreshing the library.')
      } else {
        setError(msg)
      }
    }
  }

  useEffect(() => {
    void load()
  }, [bookId])

  const applyPage = async (page: number | null) => {
    if (busy) return
    if (!Number.isFinite(bookId)) {
      setError('Invalid book id')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const maxLevelToSend = draftMaxLevel !== info?.ingestion_max_level ? draftMaxLevel : undefined
      const res = await setContentStart(bookId, page, maxLevelToSend ?? undefined)
      if (res.reindexed) {
        setSaved(true)
        await load()
        onConfirmed?.()
        if (autoClose) onClose?.()
      } else {
        setSaved(true)
        await load()
        onConfirmed?.()
        if (autoClose) onClose?.()
      }
    } catch (e) {
      const err = e as Error & { status?: number }
      const raw = err.message || String(e)
      let friendly = raw
      try {
        const parsed = JSON.parse(raw)
        if (parsed.detail) friendly = parsed.detail
      } catch {
        /* not json */
      }
      const lower = friendly.toLowerCase()
      const status = err.status
      if (lower.includes('already being indexed') || status === 409 || friendly.includes('409')) {
        friendly = 'Book is already being reindexed – please wait a few seconds and try again.'
      } else if (lower.includes('not found') || status === 404 || friendly.includes('404')) {
        friendly = 'Book not found – it may have been deleted or not yet indexed. Refresh the page.'
      }
      setError(friendly)
      // Refresh info so UI reflects pending state
      void load()
    } finally {
      setBusy(false)
    }
  }

  const applyDraftLevel = async () => {
    if (busy || !info) return
    if (draftMaxLevel === info.ingestion_max_level) return
    if (!Number.isFinite(bookId)) {
      setError('Invalid book id')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const fallbackPage = info.content_start_page ?? info.sections.find((s) => s.id === info.content_start_section_id)?.page_start ?? null
      await setContentStart(bookId, fallbackPage, draftMaxLevel)
      setSaved(true)
      await load()
      onConfirmed?.()
      if (autoClose) onClose?.()
      void load()
    } catch (e) {
      const err = e as Error & { status?: number }
      const raw = err.message || String(e)
      let friendly = raw
      try {
        const parsed = JSON.parse(raw)
        if (parsed.detail) friendly = parsed.detail
      } catch {}
      const lower = friendly.toLowerCase()
      if (lower.includes('already being indexed') || err.status === 409) {
        friendly = 'Book is already being reindexed – please wait a few seconds and try again.'
      } else if (lower.includes('not found') || err.status === 404) {
        friendly = 'Book not found – refresh the library.'
      }
      setError(friendly)
      void load()
    } finally {
      setBusy(false)
    }
  }

  const confirmCurrent = async () => {
    if (busy) return
    if (!Number.isFinite(bookId)) {
      setError('Invalid book id')
      return
    }
    // If depth toggle differs, confirm must also reindex with new level – use setContentStart path
    if (info && draftMaxLevel !== info.ingestion_max_level) {
      const fallbackPage = info.content_start_page ?? info.sections.find((s) => s.id === info.content_start_section_id)?.page_start ?? null
      setBusy(true)
      setError(null)
      setSaved(false)
      try {
        await setContentStart(bookId, fallbackPage, draftMaxLevel)
        setSaved(true)
        await load()
        onConfirmed?.()
        if (autoClose) onClose?.()
      } catch (e2) {
        const fe = e2 as Error & { status?: number }
        const fraw = fe.message || String(e2)
        let ff = fraw
        try {
          const p = JSON.parse(fraw)
          if (p.detail) ff = p.detail
        } catch {}
        const fl = ff.toLowerCase()
        if (fl.includes('already being indexed') || fe.status === 409) ff = 'Book is still indexing – please wait.'
        else if (fl.includes('not found') || fe.status === 404) ff = 'Book not found – refresh the library.'
        setError(ff)
        void load()
      } finally {
        setBusy(false)
      }
      return
    }
    setBusy(true)
    setError(null)
    try {
      await confirmContentStart(bookId)
      setSaved(true)
      await load()
      onConfirmed?.()
      if (autoClose) onClose?.()
    } catch (e) {
      const err = e as Error & { status?: number }
      const raw = err.message || String(e)
      let friendly = raw
      try {
        const parsed = JSON.parse(raw)
        if (parsed.detail) friendly = parsed.detail
      } catch {
        /* not json */
      }
      const lower = friendly.toLowerCase()
      const status = err.status
      // If confirm endpoint missing (404) – fallback to setContentStart with current page (no reindex path)
      if (status === 404 || lower.includes('not found') || friendly.includes('404')) {
        // Check if it's a missing-route 404 vs book-not-found: both contain not found, so fallback is safe – it will either confirm via setContentStart or show proper error
        const fallbackPage = info?.content_start_page ?? info?.sections.find((s) => s.id === info.content_start_section_id)?.page_start ?? null
        const maxToSend = info && draftMaxLevel !== info.ingestion_max_level ? draftMaxLevel : undefined
        try {
          await setContentStart(bookId, fallbackPage, maxToSend)
          setSaved(true)
          await load()
          onConfirmed?.()
          if (autoClose) onClose?.()
          return
        } catch (fallbackErr) {
          const fe = fallbackErr as Error & { status?: number }
          const fraw = fe.message || String(fallbackErr)
          let ffriendly = fraw
          try {
            const p = JSON.parse(fraw)
            if (p.detail) ffriendly = p.detail
          } catch {}
          const flower = ffriendly.toLowerCase()
          if (flower.includes('already being indexed') || fe.status === 409) {
            ffriendly = 'Book is still indexing – please wait.'
          } else if (flower.includes('not found') || fe.status === 404) {
            ffriendly = 'Book not found – refresh the library.'
          }
          setError(ffriendly)
          return
        }
      }
      if (lower.includes('already being indexed') || status === 409 || friendly.includes('409')) {
        friendly = 'Book is still indexing – please wait.'
      } else if (lower.includes('not found') || status === 404) {
        friendly = 'Book not found – refresh the library.'
      }
      setError(friendly)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-1 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100">Select the first chapter</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Choose where the real content starts. Front matter before this will be ignored in search and study.
          </p>
          {info?.first_section_title && (
            <p className="mt-1 text-xs text-indigo-300">
              Current: <span className="font-medium">{info.first_section_title}</span>
              {info.needs_selection && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-2xs text-amber-300">needs confirmation</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void confirmCurrent()}
            disabled={busy || info?.content_start_confirmed}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
            title={info?.content_start_confirmed ? 'Already confirmed' : 'Confirm current first chapter without reindex'}
          >
            {info?.content_start_confirmed ? 'Confirmed ✓' : 'Confirm current'}
          </button>
          <button
            onClick={() => applyPage(null)}
            disabled={busy}
            className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
          >
            Auto (detect)
          </button>
          {onClose && (
            <button onClick={onClose} className="rounded-lg px-2.5 py-1.5 text-xs text-slate-500 hover:text-slate-300">
              Close
            </button>
          )}
        </div>
      </div>

      {info && info.available_max_level >= 3 && (
        <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
          <div>
            <p className="text-xs font-medium text-slate-200">Include subsections</p>
            <p className="text-2xs text-slate-500">Level 3 sections inside each chapter (optional)</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-white/[0.03] p-0.5">
              <button
                onClick={() => setDraftMaxLevel(2)}
                disabled={busy}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${draftMaxLevel === 2 ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                L2 only
              </button>
              <button
                onClick={() => setDraftMaxLevel(3)}
                disabled={busy}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${draftMaxLevel === 3 ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                L2 + L3
              </button>
            </div>
            {draftMaxLevel !== info.ingestion_max_level && (
              <button
                onClick={() => void applyDraftLevel()}
                disabled={busy}
                className="rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-black hover:bg-amber-400 disabled:opacity-50"
              >
                Apply
              </button>
            )}
            <span className="text-2xs text-slate-500">current: L{info.ingestion_max_level}</span>
          </div>
        </div>
      )}

      {saved && (
        <div className="mx-3 mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          First chapter saved. {info?.needs_selection ? 'Reindexing...' : 'You can start studying now.'}
        </div>
      )}
      {error && (
        <div className="mx-3 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      <div className="max-h-[50vh] overflow-y-auto">
        {!info ? (
          <div className="p-6 text-center text-xs text-slate-500">Loading sections...</div>
        ) : info.sections.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            {saved ? 'Reindexing in progress – sections will refresh shortly. Keep this open or close and return in a few seconds.' : 'No sections yet — the book must be indexed first.'}
          </div>
        ) : (
          info.sections.map((s, idx) => {
            const isCurrent = s.id === info.content_start_section_id
            const pageCount = getPageCount(s, idx, info.sections)
            const displayEnd = getDisplayEnd(s, idx, info.sections)
            const range = displayEnd !== s.page_start ? `p. ${s.page_start}–${displayEnd}` : `p. ${s.page_start}`
            return (
              <div
                key={s.id}
                className={`flex items-center justify-between gap-3 border-b border-white/[0.04] px-4 py-2.5 last:border-0 ${
                  isCurrent ? 'bg-indigo-500/10' : 'hover:bg-white/[0.02]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-slate-300">
                  {'\u00A0'.repeat(((s.level ?? 1) - 1) * 3)}
                  {(s.level ?? 1) > 1 ? '› ' : ''}
                  {s.title}{' '}
                  <span className="text-xs text-slate-600" title={`${range}, ${pageCount} page${pageCount !== 1 ? 's' : ''}`}>
                    {range} • {pageCount} page{pageCount !== 1 ? 's' : ''}
                  </span>
                </span>
                <button
                  onClick={() => void applyPage(s.page_start)}
                  disabled={busy}
                  className={`shrink-0 rounded-md px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
                    isCurrent
                      ? 'border border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                      : 'border border-white/[0.08] bg-white/[0.03] text-slate-300 hover:bg-indigo-500/20 hover:text-white'
                  }`}
                >
                  {isCurrent ? 'Current first' : 'Set as first'}
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
