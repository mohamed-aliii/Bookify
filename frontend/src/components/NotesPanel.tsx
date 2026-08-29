import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Note, Section } from '../types'

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

export default function NotesPanel({
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
  const [notes, setNotes] = useState<Note[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [quote, setQuote] = useState('')
  const [page, setPage] = useState('')
  const [attachSection, setAttachSection] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  useEffect(() => {
    setAttachSection(activeSectionId ?? '')
  }, [activeSectionId])

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await api.listNotes(bookId))
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bookId])

  useEffect(() => {
    void loadNotes()
  }, [loadNotes])

  const saveNew = async () => {
    const content = draft.trim()
    if (!content || saving) return
    setSaving(true)
    setError(null)
    try {
      const created = await api.createNote(bookId, {
        content,
        quote: quote.trim() || null,
        page: page.trim() ? Number(page) : null,
        section_id: attachSection === '' ? null : Number(attachSection),
      })
      setNotes((prev) => [created, ...prev])
      setDraft('')
      setQuote('')
      setPage('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async (note: Note) => {
    const content = editText.trim()
    if (!content) return
    try {
      const updated = await api.updateNote(bookId, note.id, { content })
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
      setEditingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeNote = async (note: Note) => {
    try {
      await api.deleteNote(bookId, note.id)
      setNotes((prev) => prev.filter((n) => n.id !== note.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <div className="card p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Write a note… what did you learn? What confused you?"
            className="w-full resize-none input"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={attachSection}
              onChange={(e) => setAttachSection(e.target.value === '' ? '' : Number(e.target.value))}
              className="max-w-[220px] input"
            >
              <option value="">Whole book</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {'\u00A0'.repeat(((s.level ?? 1) - 1) * 3)}
                  {(s.level ?? 1) > 1 ? '› ' : ''}
                  {s.title.slice(0, 44)}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              value={page}
              onChange={(e) => setPage(e.target.value)}
              placeholder="Page"
              className="w-20 input"
            />
            <input
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              placeholder="Quoted line from the book (optional)"
              className="min-w-[200px] flex-1 input"
            />
            <button
              onClick={() => void saveNew()}
              disabled={!draft.trim() || saving}
              className="ml-auto btn-primary"
            >
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div>
        )}

        {!loaded && <Spinner label="Loading notes…" />}

        {loaded && notes.length === 0 && (
          <div className="mt-6 card-surface p-10 text-center">
            <p className="text-sm font-medium text-slate-300">No notes yet.</p>
            <p className="mt-1 text-xs text-slate-500">Capture ideas as you read — attach them to a chapter to find them later.</p>
          </div>
        )}

        <ul className="mt-6 space-y-4">
          {notes.map((note) => {
            const label = sectionLabel(sections, note.section_id)
            const attached = note.section_id !== null && sections.some((s) => s.id === note.section_id)
            return (
              <li key={note.id} className="card p-4">
                {note.quote && (
                  <blockquote className="mb-3 border-l-2 border-indigo-500/50 pl-3 text-xs italic leading-relaxed text-slate-400">
                    “{note.quote}”
                  </blockquote>
                )}

                {editingId === note.id ? (
                  <>
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={4}
                      className="w-full resize-none input"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button onClick={() => setEditingId(null)} className="btn-secondary btn-sm">
                        Cancel
                      </button>
                      <button onClick={() => void saveEdit(note)} className="btn-primary btn-sm">
                        Save
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{note.content}</p>
                )}

                {editingId !== note.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    {attached ? (
                      <button
                        onClick={() => onJumpToSection(note.section_id as number)}
                        className="rounded-full bg-white/[0.03] border border-white/[0.04] px-2 py-0.5 text-slate-400 transition hover:border-indigo-500/40 hover:text-slate-300"
                      >
                        {label}
                      </button>
                    ) : (
                      label && <span className="rounded-full bg-white/[0.03] border border-white/[0.04] px-2 py-0.5 text-slate-400">{label}</span>
                    )}
                    {note.page != null && <span>p.{note.page}</span>}
                    <span className="ml-auto">{new Date(note.updated_at + 'Z').toLocaleDateString()}</span>
                    <button
                      onClick={() => {
                        setEditingId(note.id)
                        setEditText(note.content)
                      }}
                      className="font-medium text-indigo-400 hover:text-indigo-300"
                    >
                      Edit
                    </button>
                    <button onClick={() => void removeNote(note)} className="font-medium text-red-400/90 hover:text-red-300">
                      Delete
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
