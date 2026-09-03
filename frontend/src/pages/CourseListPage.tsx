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

  const coverUrl = (c: Course) => {
    if (!c.cover_path) return null
    const bid = c.books?.[0]?.book_id
    if (bid) return api.getBookCoverUrl(bid)
    return null
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {courses.map(c => (
              <div
                key={c.id}
                onClick={() => nav(`/courses/${c.id}`)}
                className="group cursor-pointer rounded-2xl border border-white/[0.06] bg-surface-1 p-4 transition-all hover:border-indigo-500/30 hover:shadow-lg hover:shadow-indigo-500/5"
              >
                <div className="mb-3 flex items-start gap-3">
                  <div className="h-16 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/20">
                    {coverUrl(c) ? (
                      <img src={coverUrl(c)!} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-lg text-indigo-400/60">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6">
                          <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-white">{c.title}</h3>
                    {c.description && (
                      <p className="mt-0.5 truncate text-xs text-slate-500">{c.description}</p>
                    )}
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, c.id)}
                    className="flex-shrink-0 rounded-lg p-1 text-slate-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span>{c.book_count} {c.book_count === 1 ? 'book' : 'books'}</span>
                </div>
                {c.books.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {c.books.slice(0, 3).map(cb => (
                      <span key={cb.id} className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-500">
                        {cb.book_title.length > 20 ? cb.book_title.slice(0, 20) + '...' : cb.book_title}
                      </span>
                    ))}
                    {c.books.length > 3 && (
                      <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-600">
                        +{c.books.length - 3} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
