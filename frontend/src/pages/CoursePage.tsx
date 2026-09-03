import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { api } from '../api'
import type { Course, CourseProgress, CourseDueCard } from '../types'

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
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; fileName: string } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

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

  // Poll status every 2s while any book is pending indexing
  useEffect(() => {
    if (!course?.books.some(b => b.book_status === 'pending')) return
    const timer = setInterval(() => { void load() }, 2000)
    return () => clearInterval(timer)
  }, [course])

  const handleReorder = async (bookId: number, dir: 'up' | 'down') => {
    await api.reorderCourseBook(cid, bookId, dir)
    await load()
  }

  const handleRemoveBook = async (bookId: number) => {
    if (!confirm('Delete this book from the course?')) return
    await api.removeBookFromCourse(cid, bookId)
    await load()
  }

  const handleSaveEdit = async () => {
    await api.updateCourse(cid, { title: editTitle.trim() || course!.title, description: editDesc })
    setEditing(false)
    await load()
  }

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return
    setAddingFiles(true)
    setUploadProgress({ current: 1, total: files.length, fileName: files[0].name })
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        setUploadProgress({ current: i + 1, total: files.length, fileName: f.name })
        await api.uploadBook(f, { maxLevel: 1, autoConfirm: true, courseId: cid })
        // Immediately reload so the uploaded file appears right away as "Indexing"
        await load()
      }
    } catch (e) {
      console.error(e)
    } finally {
      setAddingFiles(false)
      setUploadProgress(null)
      await load()
    }
  }

  const handleAddFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const list = Array.from(files)
    e.target.value = ''
    await uploadFiles(list)
  }

  const handleDelete = async () => {
    if (!confirm('Delete this course? All books in this course will also be removed.')) return
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
              <p className="text-[10px] text-slate-500">Course PDFs</p>
              <p className="text-lg font-bold text-white">{progress.book_count}</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Cards Due</p>
              <p className="text-lg font-bold text-amber-400">{progress.cards_due}</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Mastered Cards</p>
              <p className="text-lg font-bold text-emerald-400">{progress.cards_mastered}</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-surface-1 p-3">
              <p className="text-[10px] text-slate-500">Sections Read</p>
              <p className="text-lg font-bold text-indigo-400">
                {progress.sections_read} <span className="text-xs font-normal text-slate-500">/ {progress.total_sections}</span>
              </p>
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
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={async (e) => {
              e.preventDefault()
              setIsDragging(false)
              const droppedFiles = Array.from(e.dataTransfer.files).filter(f =>
                f.name.toLowerCase().endsWith('.pdf') || f.name.toLowerCase().endsWith('.pptx')
              )
              if (droppedFiles.length) await uploadFiles(droppedFiles)
            }}
            className="space-y-3"
          >
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.pptx"
              className="hidden"
              onChange={handleAddFiles}
            />

            {/* Active Upload Progress Card */}
            {uploadProgress && (
              <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/60 to-purple-950/40 p-4 shadow-lg shadow-indigo-950/20 backdrop-blur-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="relative flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-400">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-white">
                        Uploading {uploadProgress.current} of {uploadProgress.total} file{uploadProgress.total > 1 ? 's' : ''}…
                      </p>
                      <p className="mt-0.5 max-w-sm truncate text-[11px] text-indigo-300/80">
                        {uploadProgress.fileName}
                      </p>
                    </div>
                  </div>
                  <span className="rounded-lg bg-indigo-500/20 px-2 py-1 text-xs font-medium text-indigo-300">
                    {Math.round((uploadProgress.current / uploadProgress.total) * 100)}%
                  </span>
                </div>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
                    style={{ width: `${Math.round((uploadProgress.current / uploadProgress.total) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-[10px] text-slate-400">
                  Files appear below immediately upon upload and begin indexing in the background.
                </p>
              </div>
            )}

            {/* Background Indexing Banner */}
            {course.books.filter(b => b.book_status === 'pending').length > 0 && !uploadProgress && (
              <div className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-xs text-amber-300">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500"></span>
                  </span>
                  <span>
                    <strong>{course.books.filter(b => b.book_status === 'pending').length}</strong> PDF{course.books.filter(b => b.book_status === 'pending').length === 1 ? '' : 's'} actively indexing in background (extracting L1 topics & embeddings)
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                  <div className="h-3 w-3 animate-spin rounded-full border border-amber-400 border-t-transparent" />
                  <span>Live updating</span>
                </div>
              </div>
            )}

            {/* Dropzone & Add Button */}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={addingFiles}
              className={`flex w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed py-4 transition-all ${
                isDragging
                  ? 'border-indigo-400 bg-indigo-500/10 text-white shadow-lg shadow-indigo-500/10'
                  : 'border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-white'
              } disabled:opacity-50`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {addingFiles ? 'Adding Files…' : '+ Add Course PDFs or Slides'}
              </div>
              <p className="text-[11px] text-slate-500">
                Click to browse or drag & drop .pdf or .pptx files here
              </p>
            </button>

            {/* Books List */}
            {course.books.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-sm font-medium text-slate-400">No PDFs in this course yet</p>
                <p className="mt-1 text-xs text-slate-600">Add PDFs or slides to start indexing</p>
              </div>
            ) : (
              <div className="space-y-2">
                {course.books.map((cb, i) => {
                  const isPending = cb.book_status === 'pending'
                  const isFailed = cb.book_status === 'failed' || cb.book_status === 'error'

                  return (
                    <div
                      key={cb.id}
                      onClick={() => nav(`/books/${cb.book_id}`)}
                      className={`group relative flex cursor-pointer items-center gap-3.5 rounded-2xl border p-3.5 transition-all ${
                        isPending
                          ? 'border-amber-500/30 bg-amber-500/[0.02] hover:border-amber-500/50 hover:bg-amber-500/[0.04]'
                          : isFailed
                          ? 'border-red-500/30 bg-red-500/[0.02] hover:border-red-500/40'
                          : 'border-white/[0.06] bg-surface-1 hover:border-indigo-500/30 hover:bg-white/[0.02]'
                      }`}
                    >
                      {/* Reorder buttons */}
                      <div className="flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleReorder(cb.book_id, 'up')}
                          disabled={i === 0}
                          className="text-slate-600 hover:text-white disabled:opacity-30"
                          title="Move up"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M18 15l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        <button
                          onClick={() => handleReorder(cb.book_id, 'down')}
                          disabled={i === course.books.length - 1}
                          className="text-slate-600 hover:text-white disabled:opacity-30"
                          title="Move down"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                      </div>

                      {/* Thumbnail with loading overlay */}
                      <div className="relative flex h-12 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/20 shadow-sm">
                        {cb.book_cover_path ? (
                          <img src={api.getBookCoverUrl(cb.book_id)} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-[10px] font-bold text-indigo-400/60">
                            {cb.book_content_type === 'slides' ? 'SLIDE' : 'PDF'}
                          </span>
                        )}
                        {isPending && (
                          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 backdrop-blur-[0.5px]">
                            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
                          </div>
                        )}
                      </div>

                      {/* Metadata and status flags */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-white transition group-hover:text-indigo-300">
                            {cb.book_title}
                          </p>
                          {isPending && (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-400" />
                              Indexing…
                            </span>
                          )}
                          {isFailed && (
                            <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                              Failed
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                          <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">
                            {cb.book_content_type === 'slides' ? 'Slides' : 'PDF'}
                          </span>
                          <span>·</span>
                          <span>
                            {cb.book_num_pages > 0
                              ? `${cb.book_num_pages} ${cb.book_content_type === 'slides' ? 'slides' : 'pages'}`
                              : isPending
                              ? 'Scanning pages…'
                              : '0 pages'}
                          </span>
                          {isPending ? (
                            <>
                              <span>·</span>
                              <span className="text-amber-400/80">Indexing L1 sections & vector chunks</span>
                            </>
                          ) : (
                            <>
                              <span>·</span>
                              <span className="text-emerald-400/80">Ready to read</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Delete button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemoveBook(cb.book_id) }}
                        title="Delete book from course"
                        className="rounded-lg p-1.5 text-slate-600 opacity-60 transition hover:text-red-400 hover:opacity-100"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </button>
                    </div>
                  )
                })}
              </div>
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
