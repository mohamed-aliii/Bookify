import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { api } from '../api'
import type { Course, CourseBook, CourseProgress, CourseDueCard } from '../types'

export default function CoursePage() {
  const { courseId } = useParams<{ courseId: string }>()
  const nav = useNavigate()
  const [course, setCourse] = useState<Course | null>(null)
  const [progress, setProgress] = useState<CourseProgress | null>(null)
  const [dueCards, setDueCards] = useState<CourseDueCard[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'books' | 'cards'>('books')
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [studyIdx, setStudyIdx] = useState(0)
  const [showAnswer, setShowAnswer] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [addingFiles, setAddingFiles] = useState(false)

  const cid = Number(courseId)
  const load = async () => {
    try {
      const [c, p, cards] = await Promise.all([
        api.getCourse(cid),
        api.getCourseProgress(cid),
        api.getCourseDueCards(cid, 30),
      ])
      setCourse(c)
      setProgress(p)
      setDueCards(cards)
    } catch { nav('/courses') }
    finally { setLoading(false) }
  }

  useEffect(() => { if (cid) load() }, [cid])

  const handleReorder = async (bookId: number, dir: 'up' | 'down') => {
    await api.reorderCourseBook(cid, bookId, dir)
    await load()
  }

  const handleRemoveBook = async (bookId: number) => {
    if (!confirm('Remove this book from the course?')) return
    await api.removeBookFromCourse(cid, bookId)
    await load()
  }

  const handleSaveEdit = async () => {
    await api.updateCourse(cid, { title: editTitle.trim() || course!.title, description: editDesc })
    setEditing(false)
    await load()
  }

  const handleAddFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setAddingFiles(true)
    try {
      const ids: number[] = []
      for (const f of Array.from(files)) {
        const b = await api.uploadBook(f, { maxLevel: 2, autoConfirm: true })
        ids.push(b.id)
      }
      await api.addBooksToCourse(cid, ids)
      await load()
    } catch (e) { console.error(e) }
    finally { setAddingFiles(false); e.target.value = '' }
  }

  const handleDelete = async () => {
    if (!confirm('Delete this course? Books will not be deleted.')) return
    await api.deleteCourse(cid)
    nav('/courses')
  }

  const nextCard = () => {
    setShowAnswer(false)
    if (studyIdx < dueCards.length - 1) setStudyIdx(studyIdx + 1)
    else { setStudyIdx(0); setTab('books') }
  }

  const reviewCard = async (rating: 'again' | 'hard' | 'good' | 'easy') => {
    const card = dueCards[studyIdx]
    if (!card) return
    await api.reviewCard(0, card.id, rating)
    nextCard()
  }

  if (loading) return (
    <AppShell>
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      </div>
    </AppShell>
  )

  if (!course) return null

  const currentCard = dueCards[studyIdx]

  return (
    <AppShell header={
      <div className="flex items-center gap-3">
        <button onClick={() => nav('/courses')} className="text-slate-400 hover:text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="text-sm font-semibold text-white">{course.title}</span>
        {dueCards.length > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            {dueCards.length} due
          </span>
        )}
      </div>
    }>
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div className="flex-1">
            {editing ? (
              <div className="space-y-2">
                <input
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
                />
                <textarea
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  rows={2}
                  className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500/50"
                  placeholder="Description"
                />
                <div className="flex gap-2">
                  <button onClick={handleSaveEdit} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500">Save</button>
                  <button onClick={() => setEditing(false)} className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-slate-400 hover:bg-white/[0.08]">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-lg font-bold text-white">{course.title}</h1>
                {course.description && <p className="mt-1 text-xs text-slate-500">{course.description}</p>}
              </>
            )}
          </div>
          {!editing && (
            <div className="flex gap-2 ml-4">
              <button
                onClick={() => { setEditTitle(course.title); setEditDesc(course.description); setEditing(true) }}
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-slate-400 hover:bg-white/[0.08]"
              >Edit</button>
              <button
                onClick={handleDelete}
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
              >Delete</button>
            </div>
          )}
        </div>

        {/* Progress bar */}
        {progress && (
          <div className="mb-6 grid grid-cols-4 gap-3">
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Books</p>
              <p className="text-lg font-bold text-white">{progress.book_count}</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Cards Due</p>
              <p className="text-lg font-bold text-amber-400">{progress.cards_due}</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Mastered</p>
              <p className="text-lg font-bold text-emerald-400">{progress.cards_mastered}</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Read</p>
              <p className="text-lg font-bold text-indigo-400">{progress.sections_read}/{progress.total_sections}</p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl border border-white/[0.06] bg-surface-1 p-1">
          {(['books', 'cards'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition ${
                tab === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {t === 'books' ? `Books (${course.books.length})` : `Due Cards (${dueCards.length})`}
            </button>
          ))}
        </div>

        {/* Books tab */}
        {tab === 'books' && (
          <div className="space-y-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.pptx"
              className="hidden"
              onChange={handleAddFiles}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={addingFiles}
              className="w-full rounded-xl border border-dashed border-white/[0.12] bg-white/[0.02] py-3 text-xs font-medium text-slate-400 hover:bg-white/[0.04] hover:text-white disabled:opacity-50"
            >
              {addingFiles ? 'Uploading...' : '+ Add Files'}
            </button>
            {course.books.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-600">No books in this course yet</div>
            ) : (
              course.books.map((cb, i) => (
                <div key={cb.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-surface-1 p-3">
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => handleReorder(cb.book_id, 'up')}
                      disabled={i === 0}
                      className="text-slate-600 hover:text-white disabled:opacity-30"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M18 15l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    <button
                      onClick={() => handleReorder(cb.book_id, 'down')}
                      disabled={i === course.books.length - 1}
                      className="text-slate-600 hover:text-white disabled:opacity-30"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  </div>
                  <div className="flex h-10 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/20">
                    {cb.book_cover_path ? (
                      <img src={api.getBookCoverUrl(cb.book_id)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-[10px] text-indigo-400/60">{cb.book_content_type === 'slides' ? 'S' : 'B'}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{cb.book_title}</p>
                    <p className="text-[10px] text-slate-500">
                      {cb.book_content_type === 'slides' ? 'Slides' : 'Book'} · {cb.book_num_pages} pages
                    </p>
                  </div>
                  <button
                    onClick={() => nav(`/books/${cb.book_id}`)}
                    className="rounded-lg bg-white/[0.04] px-2 py-1 text-[10px] text-slate-400 hover:bg-white/[0.08] hover:text-white"
                  >Open</button>
                  <button
                    onClick={() => handleRemoveBook(cb.book_id)}
                    className="rounded-lg p-1 text-slate-600 hover:text-red-400"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Cards tab */}
        {tab === 'cards' && (
          <div>
            {dueCards.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-600">No cards due for review</div>
            ) : currentCard ? (
              <div className="mx-auto max-w-lg">
                <div className="mb-2 text-center text-[10px] text-slate-600">
                  {studyIdx + 1} / {dueCards.length}
                </div>
                <div
                  onClick={() => setShowAnswer(!showAnswer)}
                  className="cursor-pointer rounded-2xl border border-white/[0.08] bg-surface-1 p-6 min-h-[160px] flex flex-col items-center justify-center text-center"
                >
                  <p className="text-sm text-white whitespace-pre-wrap">{showAnswer ? currentCard.back : currentCard.front}</p>
                  {!showAnswer && <p className="mt-3 text-[10px] text-slate-600">tap to reveal</p>}
                </div>
                <p className="mt-2 text-[10px] text-slate-600 text-center">
                  {currentCard.book_title} · {currentCard.section_title}
                </p>
                {showAnswer && (
                  <div className="mt-4 flex gap-2 justify-center">
                    {(['again', 'hard', 'good', 'easy'] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => reviewCard(r)}
                        className={`rounded-xl px-4 py-2 text-xs font-medium capitalize ${
                          r === 'easy' ? 'bg-emerald-600 text-white hover:bg-emerald-500' :
                          r === 'good' ? 'bg-indigo-600 text-white hover:bg-indigo-500' :
                          r === 'hard' ? 'bg-amber-600 text-white hover:bg-amber-500' :
                          'bg-red-600 text-white hover:bg-red-500'
                        }`}
                      >{r}</button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </AppShell>
  )
}
