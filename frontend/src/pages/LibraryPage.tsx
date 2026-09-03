import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Book, Course, Dashboard, SearchHit } from '../types'
import AppShell from '../components/AppShell'
import ContentStartPicker from '../components/ContentStartPicker'
import { SkeletonCard } from '../components/ui/Skeleton'
import EmptyState, { EmptyStateIcon, EmptyStateTitle, EmptyStateDescription } from '../components/ui/EmptyState'

const STATUS_STYLES: Record<string, string> = {
  ready: 'badge-success',
  pending: 'badge-warning',
  failed: 'badge-danger',
}

const COVER_GRADIENTS = [
  'from-indigo-500 to-fuchsia-600',
  'from-sky-500 to-indigo-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-orange-500',
  'from-violet-500 to-purple-700',
  'from-cyan-500 to-blue-600',
]

function coverGradient(title: string): string {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) | 0
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length]
}

export default function LibraryPage() {
  const [books, setBooks] = useState<Book[]>([])
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [reindexingId, setReindexingId] = useState<number | null>(null)
  const [failedCovers, setFailedCovers] = useState<Set<number>>(() => new Set())
  const [firstChapterBookId, setFirstChapterBookId] = useState<number | null>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [addToCourseBookId, setAddToCourseBookId] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) { setHits(null); setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(async () => {
      try { setHits(await api.searchLibrary(q)) } catch { setHits(null) } finally { setSearching(false) }
    }, 350)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) setHits(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [bks, dash, c] = await Promise.all([api.listBooks(), api.getDashboard(), api.listCourses()])
      setBooks(bks)
      setDashboard(dash)
      setCourses(c)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!books.some((b) => b.status === 'pending')) return
    const timer = setInterval(() => void refresh(), 2500)
    return () => clearInterval(timer)
  }, [books, refresh])

  // Auto-open first-chapter picker when a book finishes indexing and needs selection.
  // Slides auto-confirm, so exclude them from this flow.
  const prevBooksRef = useRef<Book[]>([])
  useEffect(() => {
    const prev = prevBooksRef.current
    // If any book just became ready and is not confirmed, pop the picker.
    const newlyReady = books.filter((b) => b.status === 'ready' && !b.content_start_confirmed && (b.content_type ?? 'book') !== 'slides')
    const prevPendingIds = new Set(prev.filter((p) => p.status === 'pending').map((p) => p.id))
    const justFinished = newlyReady.find((b) => prevPendingIds.has(b.id))
    if (justFinished && firstChapterBookId === null) {
      setFirstChapterBookId(justFinished.id)
    } else if (newlyReady.length > 0 && firstChapterBookId === null && prev.length === 0 && !loading) {
      // On initial load, if there are unconfirmed ready books, show for the most recent.
      setFirstChapterBookId(newlyReady[0].id)
    }
    prevBooksRef.current = books
  }, [books, loading, firstChapterBookId])

  const needsSelection = books.filter((b) => b.status === 'ready' && !b.content_start_confirmed && (b.content_type ?? 'book') !== 'slides')

  const onPickFile = async (file: File | undefined | null) => {
    if (!file) return
    setUploading(true); setError(null)
    try { await api.uploadBook(file); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const removeBook = async (id: number) => {
    setDeletingId(id)
    try { await api.deleteBook(id); setBooks((prev) => prev.filter((b) => b.id !== id)); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); void refresh() }
    finally { setDeletingId(null); setConfirmId(null) }
  }

  const reindexBook = async (id: number) => {
    setReindexingId(id); setError(null)
    try { await api.reindexBook(id); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setReindexingId(null) }
  }

  const addBookToCourse = async (courseId: number) => {
    if (!addToCourseBookId) return
    try {
      await api.addBooksToCourse(courseId, [addToCourseBookId])
      setAddToCourseBookId(null)
    } catch (e) { console.error(e) }
  }

  const readyCount = books.filter((b) => b.status === 'ready').length
  const statsByBook = new Map((dashboard?.books ?? []).map((d) => [d.id, d]))
  const dueBooks = (dashboard?.books ?? []).filter((d) => d.status === 'ready' && d.cards_due > 0)
  const topDue = dueBooks.length > 0 ? dueBooks.reduce((a, b) => (b.cards_due > a.cards_due ? b : a)) : null

  const searchHeader = (
    <div ref={searchBoxRef} className="relative mx-4 flex-1 max-w-lg">
      <div className="relative">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" strokeLinecap="round"/>
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => hits !== null && setHits(hits)}
          placeholder="Search across all books…"
          className="input-ghost pl-10"
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
        )}
      </div>
      {hits !== null && (
        <div className="absolute left-0 right-0 top-full mt-2 z-50 max-h-[60vh] overflow-y-auto rounded-2xl border border-white/[0.08] bg-surface-2 p-1.5 shadow-glass animate-scale-in">
          {hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-500">No matches found.</p>
          ) : (
            <ul className="space-y-0.5">
              {hits.map((hit, i) => (
                <li key={i}>
                  <button
                    onClick={() => { setHits(null); setQuery(''); navigate(hit.section_id ? `/books/${hit.book_id}?tab=study&section=${hit.section_id}` : `/books/${hit.book_id}?tab=study`) }}
                    className="block w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <div className="flex items-center gap-2 text-2xs">
                      <span className="truncate font-medium text-indigo-300">{hit.book_title}</span>
                      <span className="shrink-0 text-slate-600">p.{hit.page_start}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs font-medium text-slate-200">{hit.section_title}</p>
                    <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-slate-500">{hit.snippet}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )

  return (
    <AppShell header={searchHeader}>
      <div className="page-container">
        {error && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
        )}

        {needsSelection.length > 0 && (
          <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-amber-200">
                  {needsSelection.length} book{needsSelection.length === 1 ? '' : 's'} need first-chapter confirmation
                </p>
                <p className="mt-1 text-xs text-amber-200/70">
                  Pick where the real content starts — front matter will be ignored in search & study.
                </p>
                <ul className="mt-2 list-disc pl-4 text-xs text-amber-100/80">
                  {needsSelection.slice(0, 3).map((b) => (
                    <li key={b.id} className="truncate">
                      {b.title}
                    </li>
                  ))}
                  {needsSelection.length > 3 && <li>+{needsSelection.length - 3} more</li>}
                </ul>
              </div>
              <button
                onClick={() => setFirstChapterBookId(needsSelection[0].id)}
                className="shrink-0 rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-amber-400"
              >
                Select first chapter
              </button>
            </div>
          </div>
        )}

        {topDue && (
          <Link
            to={`/books/${topDue.id}?tab=study`}
            className="mb-8 block rounded-2xl border border-indigo-500/20 bg-gradient-to-r from-indigo-500/[0.08] to-fuchsia-500/[0.06] p-5 transition-all duration-200 hover:border-indigo-500/40 hover:shadow-glow-indigo"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white shadow-lg shadow-indigo-500/20">
                {topDue.cards_due}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-100">
                  {dashboard?.cards_due} card{dashboard?.cards_due === 1 ? '' : 's'} due for review
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  Next up: "{topDue.title}" — keep your streak going.
                </p>
              </div>
              <span className="shrink-0 btn-primary btn-sm">Review now</span>
            </div>
          </Link>
        )}

        {books.length > 0 && (
          <div className="mb-5 flex items-center justify-between">
            <p className="section-title">
              {books.length} book{books.length === 1 ? '' : 's'} · {readyCount} ready
            </p>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : books.length === 0 ? (
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void onPickFile(e.dataTransfer.files?.[0]) }}
            className={`cursor-pointer rounded-2xl border-2 border-dashed p-16 transition-all duration-200 ${
              dragging ? 'border-indigo-400 bg-indigo-500/[0.06]' : 'border-slate-700/50 hover:border-slate-600 hover:bg-white/[0.01]'
            }`}
          >
            <EmptyState>
              <EmptyStateIcon>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8">
                  <path d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </EmptyStateIcon>
              <EmptyStateTitle>Drop a PDF or PPTX to get started</EmptyStateTitle>
              <EmptyStateDescription>Your book or series slides will be parsed into sections, indexed, and ready for conversation.</EmptyStateDescription>
            </EmptyState>
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {books.map((book) => {
                const busy = deletingId === book.id || reindexingId === book.id
                const stats = statsByBook.get(book.id)
                const hasStudyData = !!stats && (stats.cards_total > 0 || stats.notes_count > 0)
                return (
                  <li key={book.id} className={`group relative ${busy ? 'animate-pulse opacity-60' : ''}`}>
                    <div className="card-hover relative flex h-full flex-col overflow-hidden">
                      <Link to={`/books/${book.id}`} className="absolute inset-0 z-0" aria-label={`Open ${book.title}`} />

                      <div className="pointer-events-none relative z-10 flex gap-4 p-5 pb-4">
                        <div className={`relative flex h-28 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br ${coverGradient(book.title)} shadow-lg ring-1 ring-white/10`}>
                          {(!failedCovers.has(book.id)) && (
                            <img
                              src={api.getBookCoverUrl(book.id)}
                              alt={`${book.title} cover`}
                              loading="lazy"
                              onError={() => setFailedCovers((prev) => new Set(prev).add(book.id))}
                              className="absolute inset-0 h-full w-full object-cover"
                            />
                          )}
                          <span className={`text-2xl font-bold ${failedCovers.has(book.id) ? '' : 'opacity-0'}`}>
                            {book.title.trim().charAt(0).toUpperCase() || '?'}
                          </span>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-center">
                          <p className="line-clamp-3 font-semibold leading-snug text-slate-100">{book.title}</p>
                          <p className="mt-1.5 truncate text-2xs text-slate-500" title={book.filename}>{book.filename}</p>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className={`${STATUS_STYLES[book.status] ?? 'badge-neutral'}`}>
                              {book.status === 'pending' ? 'Indexing…' : book.status}
                            </span>
                            {book.content_type === 'slides' && <span className="badge-indigo text-2xs">Slides</span>}
                            {book.content_type === 'slides' && book.filename.toLowerCase().endsWith('.pptx') && <span className="badge-neutral text-2xs">PPTX</span>}
                            {book.status === 'ready' && !book.content_start_confirmed && book.content_type !== 'slides' && (
                              <span className="badge-warning text-2xs" title="Pick first chapter to finish setup">
                                Needs first chapter
                              </span>
                            )}
                            {book.num_pages > 0 && <span className="text-2xs text-slate-600">{book.num_pages} {book.content_type === 'slides' ? 'slides' : 'pages'}</span>}
                          </div>
                        </div>
                      </div>

                      {book.status === 'failed' && book.error && (
                        <p className="pointer-events-none line-clamp-2 border-t border-red-500/10 bg-red-500/[0.06] px-5 py-2 text-2xs leading-relaxed text-red-300/90" title={book.error}>
                          {book.error}
                        </p>
                      )}

                      {hasStudyData && book.status === 'ready' && stats && (
                        <div className="pointer-events-none relative z-10 flex flex-wrap items-center gap-1.5 border-t border-white/[0.04] px-5 py-2.5 text-2xs text-slate-500">
                          {stats.cards_total > 0 && (
                            <>
                              <span className="badge-neutral">{stats.cards_mastered} mastered</span>
                              {stats.cards_due > 0 ? (
                                <Link to={`/books/${book.id}?tab=study`} className="pointer-events-auto badge-indigo">
                                  {stats.cards_due} due
                                </Link>
                              ) : (
                                <span className="badge-neutral">all caught up</span>
                              )}
                            </>
                          )}
                          {stats.notes_count > 0 && <span className="badge-neutral">{stats.notes_count} note{stats.notes_count === 1 ? '' : 's'}</span>}
                          {stats.last_quiz && (
                            <span className="ml-auto badge-success">
                              Quiz {stats.last_quiz.score}/{stats.last_quiz.total}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="pointer-events-none relative z-10 mt-auto flex items-center justify-between border-t border-white/[0.04] px-5 py-3">
                        <span className="text-xs font-medium text-indigo-400/60 transition group-hover:text-indigo-400">
                          Open →
                        </span>
                        <div className="flex items-center gap-1">
                          {book.status === 'ready' && !book.content_start_confirmed && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setFirstChapterBookId(book.id) }}
                              title="Select first chapter"
                              className="pointer-events-auto rounded-full bg-amber-500 px-2.5 py-1 text-2xs font-semibold text-black hover:bg-amber-400"
                            >
                              Select chapter
                            </button>
                          )}
                          {book.status !== 'pending' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); void reindexBook(book.id) }}
                              disabled={busy}
                              title="Re-index"
                              className="pointer-events-auto btn-icon !p-1.5"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                                <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmId(book.id) }}
                            disabled={busy}
                            title="Delete"
                            className="pointer-events-auto btn-icon !p-1.5 hover:!text-red-400"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                              <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                          <div className="relative">
                            <button
                              onClick={(e) => { e.stopPropagation(); setAddToCourseBookId(addToCourseBookId === book.id ? null : book.id) }}
                              disabled={busy || courses.length === 0}
                              title="Add to series"
                              className="pointer-events-auto btn-icon !p-1.5"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                                <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" strokeLinecap="round" strokeLinejoin="round"/>
                                <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                            {addToCourseBookId === book.id && courses.length > 0 && (
                              <div className="absolute right-0 bottom-full mb-1 z-30 w-48 rounded-xl border border-white/[0.08] bg-surface-2 p-1 shadow-glass" onClick={e => e.stopPropagation()}>
                                <p className="px-2 py-1 text-[10px] text-slate-500">Add to series</p>
                                {courses.map(c => (
                                  <button
                                    key={c.id}
                                    onClick={() => addBookToCourse(c.id)}
                                    className="w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-white/[0.06]"
                                  >
                                    {c.title}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {confirmId === book.id && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl bg-surface-0/90 backdrop-blur-md px-6 text-center">
                          <p className="text-sm font-medium text-slate-100">Delete "{book.title}"?</p>
                          <p className="text-xs text-slate-500">Removes the PDF, index, and all chat history.</p>
                          <div className="mt-1 flex items-center gap-2">
                            <button onClick={() => setConfirmId(null)} disabled={busy} className="btn-secondary btn-sm">Cancel</button>
                            <button onClick={() => void removeBook(book.id)} disabled={busy} className="btn-danger btn-sm">
                              {busy ? 'Deleting…' : 'Delete'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="mt-6">
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); void onPickFile(e.dataTransfer.files?.[0]) }}
                className={`cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-all duration-200 ${
                  dragging ? 'border-indigo-400 bg-indigo-500/[0.06]' : 'border-slate-700/40 hover:border-slate-600 hover:bg-white/[0.01]'
                }`}
              >
                <p className="text-xs text-slate-500">Drop another PDF or PPTX or click to browse</p>
              </div>
            </div>
          </>
        )}

        <input ref={fileRef} type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx" className="hidden" onChange={(e) => void onPickFile(e.target.files?.[0])} />

        {firstChapterBookId !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setFirstChapterBookId(null)}>
            <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  Select first chapter — {books.find((b) => b.id === firstChapterBookId)?.title ?? `Book #${firstChapterBookId}`}
                </h2>
                <button onClick={() => setFirstChapterBookId(null)} className="rounded-full bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20">
                  ✕
                </button>
              </div>
              <ContentStartPicker
                bookId={firstChapterBookId}
                onConfirmed={() => {
                  void refresh()
                }}
                onClose={() => setFirstChapterBookId(null)}
              />
              <p className="mt-3 text-center text-2xs text-slate-400">
                You can also change this later in the book’s Study → First chapter panel.
              </p>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  )
}
