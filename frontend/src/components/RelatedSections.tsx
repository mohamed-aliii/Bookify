import { useEffect, useState } from 'react'
import type { RelatedSection } from '../types'
import * as api from '../api'

interface Props {
  bookId: number
  sectionId: number
}

export default function RelatedSections({ bookId, sectionId }: Props) {
  const [sections, setSections] = useState<RelatedSection[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!sectionId) return
    setLoading(true)
    api.getRelatedSections(bookId, sectionId)
      .then(setSections)
      .catch(() => setSections([]))
      .finally(() => setLoading(false))
  }, [bookId, sectionId])

  if (loading) return <div className="text-xs text-slate-500 py-4">Finding related sections...</div>
  if (sections.length === 0) return null

  return (
    <div className="mt-6">
      <h4 className="section-title mb-3">Related Sections in Other Books</h4>
      <div className="space-y-2">
          {sections.slice(0, 5).map((s) => (
          <div
            key={`${s.book_id}-${s.section_id}`}
            className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3"
          >
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-slate-200">{s.section_title}</div>
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.04] text-slate-400 font-medium">
                {Math.round(s.similarity_score * 100)}%
              </span>
            </div>
            <div className="text-[10px] text-indigo-400 mt-0.5">{s.book_title}</div>
            {s.explanation && (
              <p className="text-[11px] text-slate-400 mt-1.5">{s.explanation}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
