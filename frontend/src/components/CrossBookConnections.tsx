import { useEffect, useState } from 'react'
import type { CrossBookLink } from '../types'
import * as api from '../api'

interface Props {
  bookId: number
}

export default function CrossBookConnections({ bookId }: Props) {
  const [links, setLinks] = useState<CrossBookLink[]>([])
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.getCrossBookLinks()
      setLinks(data.filter((l: CrossBookLink) =>
        l.source_book_title && l.target_book_title
      ))
    } catch {} finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [bookId])

  const handleExtract = async () => {
    setExtracting(true)
    try {
      await api.extractCrossBookLinks()
      await load()
    } catch (e) { console.error(e) } finally {
      setExtracting(false)
    }
  }

  const bookLinks = links.filter(l =>
    l.source_book_title && l.target_book_title
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="section-title">
          Cross-Book Connections
          <span className="ml-2 text-xs text-slate-500 font-normal">{bookLinks.length} links</span>
        </h3>
        <button
          onClick={handleExtract}
          disabled={extracting}
          className="btn-primary btn-sm"
        >
          {extracting ? 'Extracting...' : 'Extract Connections'}
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-slate-500 py-4">Loading...</div>
      ) : bookLinks.length === 0 ? (
        <div className="text-center py-8 text-slate-500">
          <div className="text-3xl mb-2">
            <svg className="mx-auto w-8 h-8 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <p className="text-sm">No cross-book connections yet.</p>
          <p className="text-xs text-slate-600 mt-1">Extract connections to find overlapping concepts across your books.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bookLinks.slice(0, 20).map(link => (
            <div
              key={link.id}
              className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3"
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-slate-200">{link.source_kp_name}</span>
                <span className="text-slate-600">↔</span>
                <span className="font-medium text-slate-200">{link.target_kp_name}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                <span className="text-indigo-400">{link.source_book_title}</span>
                <span>·</span>
                <span className="text-emerald-400">{link.target_book_title}</span>
                <span className="ml-auto px-1.5 py-0.5 rounded-md bg-white/[0.04] text-slate-400 font-medium">
                  {Math.round(link.similarity * 100)}%
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">{link.explanation}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
