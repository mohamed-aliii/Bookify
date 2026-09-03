import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { api } from '../api'
import type { Course } from '../types'

export default function CourseListPage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [multiFiles, setMultiFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const nav = useNavigate()

  const load = () => api.listCourses().then(setCourses).catch(() => {}).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    setCreating(true)
    try {
      const course = await api.createCourse(newTitle.trim(), newDesc.trim())
      setNewTitle('')
      setNewDesc('')
      setShowCreate(false)
      await load()
      nav(`/courses/${course.id}`)
    } catch (e) {
      console.error(e)
    } finally {
      setCreating(false)
    }
  }

  const handleMultiFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setMultiFiles(Array.from(files))
    setShowCreate(true)
    if (!newTitle.trim()) {
      setNewTitle(files[0]?.name?.replace(/\.(pdf|pptx)$/i, '') || 'New Course')
    }
    e.target.value = ''
  }

  const handleCreateWithFiles = async () => {
    if (!newTitle.trim() || multiFiles.length === 0) return
    setUploading(true)
    setUploadProgress(`Uploading 0/${multiFiles.length} files...`)
    try {
      // Create course first so uploads can be linked atomically (never appear in Library)
      const course = await api.createCourse(newTitle.trim(), newDesc.trim(), [])
      for (let i = 0; i < multiFiles.length; i++) {
        setUploadProgress(`Uploading ${i + 1}/${multiFiles.length} files...`)
        await api.uploadBook(multiFiles[i], { maxLevel: 1, autoConfirm: true, courseId: course.id })
      }
      setMultiFiles([])
      setNewTitle('')
      setNewDesc('')
      setShowCreate(false)
      await load()
      nav(`/courses/${course.id}`)
    } catch (e) {
      console.error(e)
    } finally {
      setUploading(false)
      setUploadProgress('')
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    if (!confirm('Delete this course? All books in this course will also be removed.')) return
    try {
      await api.deleteCourse(id)
      await load()
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <AppShell header={<span className="text-sm font-semibold text-white">Courses</span>}>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Your Courses</h1>
            <p className="mt-1 text-xs text-slate-500">Organize books and slides into courses</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.pptx"
              className="hidden"
              onChange={handleMultiFileSelect}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-300 hover:bg-white/[0.08] disabled:opacity-50"
            >
              {uploading ? uploadProgress : 'Upload Files'}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              + New Course
            </button>
          </div>
        </div>

        {showCreate && (
          <div className="mb-6 rounded-2xl border border-white/[0.08] bg-surface-1 p-5">
            <h3 className="mb-3 text-sm font-semibold text-white">
              {multiFiles.length > 0 ? `Create Series from ${multiFiles.length} Files` : 'New Series'}
            </h3>
            {multiFiles.length > 0 && (
              <div className="mb-3 text-xs text-slate-400">
                Files: {multiFiles.map(f => f.name).join(', ')}
              </div>
            )}
            <input
              type="text"
              placeholder="Series title"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              className="mb-2 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500/50"
            />
            <textarea
              placeholder="Description (optional)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              rows={2}
              className="mb-3 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500/50"
            />
            <div className="flex gap-2">
              <button
                onClick={multiFiles.length > 0 ? handleCreateWithFiles : handleCreate}
                disabled={creating || uploading || !newTitle.trim()}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {creating || uploading ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setMultiFiles([]); setNewTitle(''); setNewDesc('') }}
                className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-medium text-slate-400 hover:bg-white/[0.08]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
          </div>
        ) : courses.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mb-4 h-16 w-16 text-slate-700">
              <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <p className="mb-2 text-sm text-slate-400">No courses yet</p>
            <p className="text-xs text-slate-600">Create a course to organize your books and slides</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {courses.map(c => {
              const totalPages = c.books?.reduce((sum, b) => sum + (b.book_num_pages || 0), 0) || 0
              const slideCount = c.books?.filter(b => b.book_content_type === 'slides').length || 0
              const bookCount = c.book_count - slideCount

              return (
                <div
                  key={c.id}
                  onClick={() => nav(`/courses/${c.id}`)}
                  className="group flex flex-col justify-between cursor-pointer rounded-2xl border border-white/[0.08] bg-surface-1 p-5 sm:p-6 transition-all duration-200 hover:border-indigo-500/40 hover:bg-surface-2/60 hover:shadow-xl hover:shadow-indigo-500/5 min-h-[220px]"
                >
                  <div>
                    <div className="flex items-start gap-4">
                      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/20 transition-all duration-200 group-hover:bg-indigo-500/20 group-hover:scale-105 group-hover:text-indigo-300">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
                          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-base font-semibold text-white transition-colors group-hover:text-indigo-200 line-clamp-2 leading-snug">
                            {c.title}
                          </h3>
                          <button
                            onClick={(e) => handleDelete(e, c.id)}
                            title="Delete course"
                            className="flex-shrink-0 rounded-lg p-1.5 text-slate-500 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-2 py-0.5 font-medium text-indigo-300 border border-indigo-500/20">
                            {c.book_count} {c.book_count === 1 ? 'item' : 'items'}
                          </span>
                          {totalPages > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-0.5 text-slate-400 border border-white/[0.06]">
                              {totalPages} pages/slides
                            </span>
                          )}
                          {slideCount > 0 && bookCount > 0 && (
                            <span className="text-[11px] text-slate-500">
                              ({slideCount} slides, {bookCount} docs)
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {c.description ? (
                      <p className="mt-3.5 text-sm leading-relaxed text-slate-300 line-clamp-4">
                        {c.description}
                      </p>
                    ) : (
                      <p className="mt-3.5 text-xs italic text-slate-600">
                        No description provided.
                      </p>
                    )}
                  </div>

                  {c.books && c.books.length > 0 && (
                    <div className="mt-5 pt-3.5 border-t border-white/[0.06]">
                      <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-slate-400">
                        <span>Included Materials</span>
                        <span className="text-indigo-400 group-hover:translate-x-0.5 transition-transform">View all &rarr;</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {c.books.slice(0, 5).map(cb => (
                          <span
                            key={cb.id}
                            className="inline-flex items-center gap-1 rounded-lg bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 border border-white/[0.04] group-hover:border-white/[0.08]"
                          >
                            <span className="truncate max-w-[140px] sm:max-w-[180px]">
                              {cb.book_title}
                            </span>
                            {cb.book_num_pages > 0 && (
                              <span className="text-[10px] text-slate-500 font-mono">
                                ({cb.book_num_pages}p)
                              </span>
                            )}
                          </span>
                        ))}
                        {c.books.length > 5 && (
                          <span className="rounded-lg bg-white/[0.03] px-2 py-1 text-xs text-slate-500 font-medium">
                            +{c.books.length - 5} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}
