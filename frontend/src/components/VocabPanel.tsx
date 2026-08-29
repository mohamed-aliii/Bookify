import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Section, VocabWord } from '../types'

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      {label && <p className="text-xs text-slate-500">{label}</p>}
    </div>
  )
}

function sectionLabel(sections: Section[], id: number | null): string {
  if (id === null) return ''
  const sec = sections.find((s) => s.id === id)
  return sec ? sec.title : 'section removed'
}

export default function VocabPanel({
  bookId,
  sections,
  activeSectionId,
  onJumpToSection,
}: {
  bookId: number
  sections: Section[]
  activeSectionId: number | null
  onJumpToSection: (sectionId: number) => void
}) {
  const [words, setWords] = useState<VocabWord[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadWords = useCallback(async () => {
    try {
      setWords(await api.listVocab(bookId))
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bookId])

  useEffect(() => {
    void loadWords()
  }, [loadWords, activeSectionId])

  const removeWord = async (word: VocabWord) => {
    try {
      await api.deleteVocab(bookId, word.id)
      setWords((prev) => prev.filter((w) => w.id !== word.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Vocabulary</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Words you saved while reading — review unknown terms and their Arabic translations.
            </p>
          </div>
          <span className="rounded-full bg-white/[0.03] border border-white/[0.05] px-3 py-1 text-xs text-slate-400">
            {words.length} {words.length === 1 ? 'word' : 'words'}
          </span>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div>
        )}

        {!loaded && <Spinner label="Loading vocabulary…" />}

        {loaded && words.length === 0 && (
          <div className="mt-6 card-surface p-10 text-center">
            <p className="text-sm font-medium text-slate-300">No vocabulary yet.</p>
            <p className="mt-1 text-xs text-slate-500">
              Select text while reading and tap the translate button — save the key terms here to revise them later.
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {words.map((word) => {
            const label = sectionLabel(sections, word.section_id)
            const attached = word.section_id !== null && sections.some((s) => s.id === word.section_id)
            return (
              <li key={word.id} className="card p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-white">{word.term}</span>
                  <button onClick={() => void removeWord(word)} className="font-medium text-red-400/90 hover:text-red-300">
                    Delete
                  </button>
                </div>
                <p className="mt-1 leading-relaxed text-indigo-200" dir="rtl">
                  {word.translation}
                </p>
                {word.note && <p className="mt-2 text-xs leading-relaxed text-slate-400">{word.note}</p>}
                {word.context && (
                  <p className="mt-2 border-l-2 border-indigo-500/40 pl-3 text-2xs italic leading-relaxed text-slate-500">
                    “{word.context}”
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  {attached ? (
                    <button
                      onClick={() => onJumpToSection(word.section_id as number)}
                      className="rounded-full bg-white/[0.03] border border-white/[0.04] px-2 py-0.5 text-slate-400 transition hover:border-indigo-500/40 hover:text-slate-300"
                    >
                      {label}
                    </button>
                  ) : (
                    label && <span className="rounded-full bg-white/[0.03] border border-white/[0.04] px-2 py-0.5 text-slate-400">{label}</span>
                  )}
                  {word.page != null && <span>p.{word.page}</span>}
                  <span className="ml-auto">{new Date(word.created_at + 'Z').toLocaleDateString()}</span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
