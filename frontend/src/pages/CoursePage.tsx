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
  const [filterQuery, setFilterQuery] = useState('')

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
  const totalPages = course.books?.reduce((sum, b) => sum + (b.book_num_pages || 0), 0) || 0
  const slideCount = course.books?.filter(b => b.book_content_type === 'slides').length || 0
  const bookCount = course.books.length - slideCount
  const pctRead = progress && progress.total_sections > 0 ? Math.round((progress.sections_read / progress.total_sections) * 100) : 0
  const filteredBooks = course.books.filter(b =>
    !filterQuery.trim() || b.book_title.toLowerCase().includes(filterQuery.toLowerCase())
  )

  return (
    <AppShell header={
      <div className="flex items-center gap-3">
        <button onClick={() => nav('/courses')} className="text-slate-400 hover:text-white transition-colors" title="Back to Courses">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span className="text-sm font-semibold text-white truncate max-w-[200px] sm:max-w-md">{course.title}</span>
        {dueCards.length > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
            {dueCards.length} due
          </span>
        )}
      </div>
    }>
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => nav('/courses')}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            All Courses
          </button>
          {dueCards.length > 0 && tab !== 'cards' && (
            <button
              onClick={() => setTab('cards')}
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              {dueCards.length} flashcard{dueCards.length === 1 ? '' : 's'} ready for review &rarr;
            </button>
          )}
        </div>

        {/* Hero Course Header Card */}
        <div className="rounded-3xl border border-white/[0.08] bg-surface-1 p-6 sm:p-7 shadow-xl shadow-black/20">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/20 shadow-md shadow-indigo-500/5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-7 w-7">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                {editing ? (
                  <div className="space-y-3">
                    <input
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="w-full rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-2 text-base font-semibold text-white outline-none focus:border-indigo-500/50"
                      placeholder="Course title"
                    />
                    <textarea
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      rows={3}
                      className="w-full rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-2 text-sm leading-relaxed text-white placeholder-slate-500 outline-none focus:border-indigo-500/50"
                      placeholder="Course description"
                    />
                    <div className="flex gap-2">
                      <button onClick={handleSaveEdit} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors">Save Changes</button>
                      <button onClick={() => setEditing(false)} className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs text-slate-400 hover:bg-white/[0.08] transition-colors">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{course.title}</h1>
                      <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
                        Course Folder
                      </span>
                    </div>
                    {course.description ? (
                      <p className="mt-2 text-sm leading-relaxed text-slate-300 max-w-3xl">
                        {course.description}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs italic text-slate-500">
                        No description. Click Edit to add details about this course.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {!editing && (
              <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={addingFiles}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 shadow-md shadow-indigo-600/20"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Add Files
                </button>
                <button
                  onClick={() => { setEditTitle(course.title); setEditDesc(course.description); setEditing(true) }}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-300 hover:border-white/[0.15] hover:bg-white/[0.08] hover:text-white transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-slate-400">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Edit
                </button>
                <button
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Progress Metrics Overview */}
        {progress && (
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/[0.06] bg-surface-1 p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Materials</span>
                <span className="rounded-lg bg-indigo-500/10 p-1.5 text-indigo-400">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 4.5A2.5 2.5 0 016.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15z" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
              </div>
              <p className="mt-2 text-2xl font-bold text-white tracking-tight">{progress.book_count}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {slideCount > 0 && `${slideCount} slide decks`}
                {slideCount > 0 && bookCount > 0 && ' · '}
                {bookCount > 0 && `${bookCount} PDFs`}
                {slideCount === 0 && bookCount === 0 && `${totalPages} pages`}
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.06] bg-surface-1 p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Reading Progress</span>
                <span className="text-xs font-semibold text-indigo-400">{pctRead}%</span>
              </div>
              <p className="mt-2 text-2xl font-bold text-white tracking-tight">
                {progress.sections_read} <span className="text-xs font-normal text-slate-500">/ {progress.total_sections} secs</span>
              </p>
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500"
                  style={{ width: `${pctRead}%` }}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-white/[0.06] bg-surface-1 p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Cards Mastered</span>
                <span className="rounded-lg bg-emerald-500/10 p-1.5 text-emerald-400">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
              </div>
              <p className="mt-2 text-2xl font-bold text-emerald-400 tracking-tight">{progress.cards_mastered}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {progress.total_cards > 0 ? `of ${progress.total_cards} total flashcards` : 'No cards created yet'}
              </p>
            </div>

            <div
              onClick={() => dueCards.length > 0 && setTab('cards')}
              className={`rounded-2xl border p-4 shadow-sm transition-all ${
                dueCards.length > 0
                  ? 'border-amber-500/30 bg-amber-500/[0.03] cursor-pointer hover:border-amber-500/50 hover:bg-amber-500/[0.06]'
                  : 'border-white/[0.06] bg-surface-1'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Cards Due</span>
                {dueCards.length > 0 && (
                  <span className="text-[10px] font-semibold text-amber-400 hover:underline">Study Now &rarr;</span>
                )}
              </div>
              <p className="mt-2 text-2xl font-bold text-amber-400 tracking-tight">{progress.cards_due}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {dueCards.length > 0 ? 'Ready for spaced repetition' : 'All caught up!'}
              </p>
            </div>
          </div>
        )}

        {/* Tabs and Controls Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex gap-1 rounded-2xl border border-white/[0.06] bg-surface-1 p-1">
            <button
              onClick={() => setTab('books')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                tab === 'books'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <path d="M4 6h16M4 12h16M4 18h7" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Course Materials ({course.books.length})
            </button>
            <button
              onClick={() => setTab('cards')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
                tab === 'cards'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Due Flashcards ({dueCards.length})
            </button>
          </div>

          {tab === 'books' && course.books.length > 3 && (
            <div className="relative w-full sm:w-64">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <input
                type="text"
                value={filterQuery}
                onChange={e => setFilterQuery(e.target.value)}
                placeholder="Filter lectures by title…"
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500/50"
              />
            </div>
          )}
        </div>

        {/* Materials tab content */}
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
            className="space-y-3.5"
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
              <div className="flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-xs text-amber-300">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500"></span>
                  </span>
                  <span>
                    <strong>{course.books.filter(b => b.book_status === 'pending').length}</strong> lecture{course.books.filter(b => b.book_status === 'pending').length === 1 ? '' : 's'} actively indexing with AI outlines & vector embeddings
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-amber-400/80">
                  <div className="h-3 w-3 animate-spin rounded-full border border-amber-400 border-t-transparent" />
                  <span>Auto updating</span>
                </div>
              </div>
            )}

            {/* Dropzone & Add Button */}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={addingFiles}
              className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed py-5 transition-all ${
                isDragging
                  ? 'border-indigo-400 bg-indigo-500/10 text-white shadow-lg shadow-indigo-500/10'
                  : 'border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-white'
              } disabled:opacity-50`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-indigo-400">
                  <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {addingFiles ? 'Adding Files…' : '+ Add Course PDFs or PowerPoint Slides'}
              </div>
              <p className="text-[11px] text-slate-500">
                Click to browse or drag & drop .pdf or .pptx lecture slides here
              </p>
            </button>

            {/* Books / Lectures List */}
            {filteredBooks.length === 0 ? (
              <div className="py-12 text-center rounded-2xl border border-white/[0.04] bg-surface-1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 h-10 w-10 text-slate-600">
                  <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <p className="text-sm font-medium text-slate-400">
                  {filterQuery ? 'No materials match your search' : 'No materials in this course folder yet'}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {filterQuery ? 'Try a different search term' : 'Add PDFs or PowerPoint slides to begin indexing'}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredBooks.map((cb, i) => {
                  const isPending = cb.book_status === 'pending'
                  const isFailed = cb.book_status === 'failed' || cb.book_status === 'error'
                  const isSlides = cb.book_content_type === 'slides'

                  return (
                    <div
                      key={cb.id}
                      onClick={() => nav(`/books/${cb.book_id}`)}
                      className={`group relative flex cursor-pointer items-center gap-3.5 sm:gap-4 rounded-2xl border p-4 transition-all duration-200 ${
                        isPending
                          ? 'border-amber-500/30 bg-amber-500/[0.02] hover:border-amber-500/50 hover:bg-amber-500/[0.04]'
                          : isFailed
                          ? 'border-red-500/30 bg-red-500/[0.02] hover:border-red-500/40'
                          : 'border-white/[0.06] bg-surface-1 hover:border-indigo-500/40 hover:bg-white/[0.02] hover:shadow-lg hover:shadow-indigo-500/5'
                      }`}
                    >
                      {/* Index / Reorder Handle */}
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleReorder(cb.book_id, 'up')}
                            disabled={i === 0}
                            className="rounded p-0.5 text-slate-600 hover:bg-white/[0.06] hover:text-white disabled:opacity-20 transition-colors"
                            title="Move up"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M18 15l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </button>
                          <button
                            onClick={() => handleReorder(cb.book_id, 'down')}
                            disabled={i === filteredBooks.length - 1}
                            className="rounded p-0.5 text-slate-600 hover:bg-white/[0.06] hover:text-white disabled:opacity-20 transition-colors"
                            title="Move down"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </button>
                        </div>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] font-mono text-xs font-semibold text-slate-400 group-hover:bg-indigo-500/20 group-hover:text-indigo-300 transition-colors">
                          {String(cb.ord != null ? cb.ord + 1 : i + 1).padStart(2, '0')}
                        </span>
                      </div>

                      {/* Icon or Thumbnail Badge */}
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] text-slate-400 group-hover:ring-indigo-500/30 group-hover:text-indigo-300 transition-all">
                        {isSlides ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                            <rect x="2" y="3" width="20" height="14" rx="2" strokeLinecap="round" strokeLinejoin="round"/>
                            <path d="M8 21h8m-4-4v4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" strokeLinecap="round" strokeLinejoin="round"/>
                            <polyline points="14 2 14 8 20 8" strokeLinecap="round" strokeLinejoin="round"/>
                            <line x1="16" y1="13" x2="8" y2="13" strokeLinecap="round" strokeLinejoin="round"/>
                            <line x1="16" y1="17" x2="8" y2="17" strokeLinecap="round" strokeLinejoin="round"/>
                            <polyline points="10 9 9 9 8 9" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>

                      {/* Title and Details */}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm sm:text-base font-semibold text-white group-hover:text-indigo-200 transition-colors">
                            {cb.book_title}
                          </h3>
                          {isPending && (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-amber-300">
                              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-400" />
                              Indexing sections & chunks…
                            </span>
                          )}
                          {isFailed && (
                            <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
                              Failed
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          <span className="inline-flex items-center rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-slate-300 border border-white/[0.06]">
                            {isSlides ? 'Slides Presentation' : 'PDF Document'}
                          </span>
                          <span>·</span>
                          <span>
                            {cb.book_num_pages > 0
                              ? `${cb.book_num_pages} ${isSlides ? 'slides' : 'pages'}`
                              : isPending
                              ? 'Scanning pages…'
                              : '0 pages'}
                          </span>
                          <span>·</span>
                          {isPending ? (
                            <span className="text-amber-400/90 font-medium">Processing...</span>
                          ) : (
                            <span className="text-emerald-400 font-medium inline-flex items-center gap-1">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3"><polyline points="20 6 9 17 4 12"/></svg>
                              Ready
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        <span className="hidden sm:inline-flex items-center gap-1 rounded-xl bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-300 border border-indigo-500/20 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                          Open Reader &rarr;
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRemoveBook(cb.book_id) }}
                          title="Remove from course"
                          className="rounded-xl p-2 text-slate-500 opacity-60 transition hover:bg-red-500/10 hover:text-red-400 hover:opacity-100"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Flashcards Review tab */}
        {tab === 'cards' && (
          <div className="py-2">
            {dueCards.length === 0 ? (
              <div className="py-16 text-center rounded-3xl border border-white/[0.04] bg-surface-1">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-white">All caught up!</h3>
                <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
                  No flashcards are currently due for review in this course. Read more sections or come back later for your spaced repetition schedule.
                </p>
                <button
                  onClick={() => setTab('books')}
                  className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
                >
                  Back to Course Materials
                </button>
              </div>
            ) : currentCard ? (
              <div className="mx-auto max-w-lg">
                <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
                  <span>Card {studyIdx + 1} of {dueCards.length}</span>
                  <span className="font-mono text-[11px] text-amber-400">Due for review</span>
                </div>
                <div
                  onClick={() => setShowAnswer(!showAnswer)}
                  className="cursor-pointer rounded-3xl border border-white/[0.08] bg-surface-1 p-8 min-h-[200px] flex flex-col items-center justify-center text-center shadow-xl shadow-black/20 hover:border-indigo-500/30 transition-all"
                >
                  <p className="text-base font-medium text-white whitespace-pre-wrap leading-relaxed">
                    {showAnswer ? currentCard.back : currentCard.front}
                  </p>
                  {!showAnswer && (
                    <p className="mt-4 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-400">
                      Tap card to reveal answer
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs text-slate-500 text-center">
                  {currentCard.book_title} · <span className="text-slate-400">{currentCard.section_title}</span>
                </p>
                {showAnswer && (
                  <div className="mt-5 flex gap-2.5 justify-center">
                    {(['again', 'hard', 'good', 'easy'] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => reviewCard(r)}
                        className={`rounded-xl px-5 py-2.5 text-xs font-semibold capitalize transition-transform active:scale-95 shadow-md ${
                          r === 'easy' ? 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-emerald-600/20' :
                          r === 'good' ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-600/20' :
                          r === 'hard' ? 'bg-amber-600 text-white hover:bg-amber-500 shadow-amber-600/20' :
                          'bg-red-600 text-white hover:bg-red-500 shadow-red-600/20'
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
