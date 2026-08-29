import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, streamChat } from '../api'
import Markdown from '../components/Markdown'
import NotesPanel from '../components/NotesPanel'
import VocabPanel from '../components/VocabPanel'
import StudyView from '../components/StudyView'
import ProgressTab from '../components/ProgressTab'
import CodeLibraryPanel from '../components/CodeLibraryPanel'
import RecallPrompt from '../components/RecallPrompt'
import GamificationBar from '../components/GamificationBar'
import ReadView from '../components/ReadView'
import usePaneWidth from '../hooks/usePaneWidth'
import type { Book, ChatSession, Citation, Message, ReadingProgress, Section } from '../types'

interface Bubble extends Message {
  pending?: boolean
  reasoning?: string
  thinkingSeconds?: number | null
  status?: string
}

function citationLabel(c: Citation): string {
  if (c.url) { try { return new URL(c.url).hostname.replace(/^www\./, '') } catch { return 'web' } }
  return c.page != null ? `p.${c.page}` : 'source'
}

const SUGGESTIONS = [
  { title: 'Explain simply', text: "Explain this book's core topic in simple terms with an everyday analogy." },
  { title: 'Real-world example', text: 'Pick one concept from the first chapter and show how it is used in a real product or company.' },
  { title: 'Quiz me', text: 'Ask me 3 questions about the beginning of this book, one at a time, and grade my answers.' },
]

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const id = Number(bookId)
  const [searchParams, setSearchParams] = useSearchParams()

  type Tab = 'chat' | 'read' | 'study' | 'progress' | 'notes' | 'vocab' | 'code'
  const paramTab = searchParams.get('tab')
  const validTabs = ['chat', 'read', 'study', 'progress', 'notes', 'vocab', 'code'] as const
  const [tab, setTabState] = useState<Tab>(validTabs.includes(paramTab as Tab) ? (paramTab as Tab) : 'chat')
  const setTab = (t: Tab) => {
    setTabState(t)
    setSearchParams(t === 'chat' ? {} : { tab: t }, { replace: true })
    if (t !== 'study') setNotebookFocus(null)
  }

  const { width: sidebarWidth, startResize: startSidebarResize } = usePaneWidth(
    `bookify:layout:${id}:sidebar`,
    240,
    180,
    400,
  )

  const [book, setBook] = useState<Book | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [messages, setMessages] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openReasoning, setOpenReasoning] = useState<Set<number>>(new Set())
  const [studySectionId, setStudySectionId] = useState<number | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [readingProgress, setReadingProgress] = useState<Map<number, ReadingProgress>>(new Map())
  const [showRecall, setShowRecall] = useState<{ sectionId: number; title: string } | null>(null)
  const [readSummary, setReadSummary] = useState<{ sections_read: number; total_sections: number } | null>(null)
  const [dueCardsCount, setDueCardsCount] = useState(0)
  const [readTargetPage, setReadTargetPage] = useState<number | null>(null)
  const [notebookFocus, setNotebookFocus] = useState<{ seq: number; cellId: number; sectionId: number | null } | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => { if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const creatingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const reasoningStartRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [b, secs, sess, rp, summary, due] = await Promise.all([
          api.getBook(id), api.getSections(id), api.listSessions(id),
          api.getReadingProgress(id), api.getReadingSummary(id), api.getDueCards(id),
        ])
        setBook(b); setSections(secs); setSessions(sess)
        const rpMap = new Map<number, ReadingProgress>()
        for (const r of rp) rpMap.set(r.section_id, r)
        setReadingProgress(rpMap)
        setReadSummary({ sections_read: summary.sections_read, total_sections: summary.total_sections })
        setDueCardsCount(due.length)
        const paramSection = Number(searchParams.get('section'))
        const valid = paramSection && secs.some((s) => s.id === paramSection)
        const firstChapter = secs.find((s) => s.level === 1 && !s.title.toLowerCase().startsWith('front matter'))
        const defaultSection = valid ? paramSection : (firstChapter?.id ?? secs[0]?.id)
        if (defaultSection) setStudySectionId(defaultSection)
        if (sess.length > 0) { setActiveSessionId(sess[0].id); setMessages(await api.listMessages(sess[0].id)) }
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    })()
  }, [id])

  useEffect(() => { if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const onScroll = () => { const el = scrollRef.current; if (!el) return; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140 }
  const autoGrow = () => { const el = textareaRef.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 192)}px` }

  const ensureSession = useCallback(async (): Promise<number> => {
    if (activeSessionId !== null) return activeSessionId
    if (creatingRef.current) throw new Error('Preparing chat, try again')
    creatingRef.current = true
    try { const created = await api.createSession(id); setSessions((prev) => [created, ...prev]); setActiveSessionId(created.id); return created.id } finally { creatingRef.current = false }
  }, [activeSessionId, id])

  const run = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || streaming) return
    setError(null); setInput(''); requestAnimationFrame(autoGrow); setStreaming(true)
    let sessionId: number
    try { sessionId = await ensureSession() } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStreaming(false); return }

    const stamp = Date.now()
    const userBubble: Bubble = { id: -stamp, role: 'user', content: text, citations: null, created_at: new Date().toISOString() }
    const botBubble: Bubble = { id: -(stamp + 1), role: 'assistant', content: '', citations: null, created_at: userBubble.created_at, pending: true, reasoning: '', thinkingSeconds: null }
    atBottomRef.current = true; setMessages((prev) => [...prev, userBubble, botBubble]); reasoningStartRef.current = null

    const controller = new AbortController(); abortRef.current = controller
    try {
      await streamChat(sessionId, text, {
        onCitations: (citations: Citation[]) => setMessages((prev) => prev.map((m) => (m.id === botBubble.id ? { ...m, citations } : m))),
        onToken: (token: string) => setMessages((prev) => prev.map((m) => { if (m.id !== botBubble.id) return m; const patch: Partial<Bubble> = { content: m.content + token }; if (m.reasoning && m.thinkingSeconds === null && reasoningStartRef.current) patch.thinkingSeconds = Math.max(1, Math.round((Date.now() - reasoningStartRef.current) / 1000)); if (m.status) patch.status = undefined; return { ...m, ...patch } })),
        onReasoning: (token: string) => { if (!reasoningStartRef.current) reasoningStartRef.current = Date.now(); setMessages((prev) => prev.map((m) => (m.id === botBubble.id ? { ...m, reasoning: (m.reasoning ?? '') + token, status: undefined } : m))) },
        onStatus: (status: string) => setMessages((prev) => prev.map((m) => (m.id === botBubble.id ? { ...m, status } : m))),
      }, controller.signal)
      setMessages(await api.listMessages(sessionId))
      const wasUntitled = sessions.find((s) => s.id === sessionId)?.title === 'New chat'
      if (wasUntitled) { const named = await api.generateSessionTitle(sessionId).catch(() => null); if (named) setSessions((prev) => prev.map((s) => (s.id === named.id ? named : s))) }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') { setMessages((prev) => prev.map((m) => (m.id === botBubble.id ? { ...m, pending: false } : m))) }
      else { const msg = e instanceof Error ? e.message : String(e); setError(msg); setMessages((prev) => prev.map((m) => (m.id === botBubble.id ? { ...m, pending: false, content: m.content || `Error: ${msg}` } : m))) }
    } finally { abortRef.current = null; reasoningStartRef.current = null; setStreaming(false) }
  }

  const stop = () => abortRef.current?.abort()
  const toggleReasoning = (msgId: number) => setOpenReasoning((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next })

  const newChat = async () => {
    if (streaming) stop()
    try { const created = await api.createSession(id); setSessions((prev) => [created, ...prev]); setActiveSessionId(created.id); setMessages([]); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const switchSession = async (sessionId: number) => { if (streaming) return; setActiveSessionId(sessionId); try { setMessages(await api.listMessages(sessionId)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }

  const handleToggleRead = async (sectionId: number, sectionTitle: string) => {
    try {
      const result = await api.toggleRead(id, sectionId)
      setReadingProgress((prev) => {
        const next = new Map(prev)
        if (result.read) {
          next.set(sectionId, { section_id: sectionId, completed_at: new Date().toISOString(), time_spent_seconds: 0 })
          setShowRecall({ sectionId, title: sectionTitle })
        } else {
          next.delete(sectionId)
        }
        return next
      })
      if (result.read) {
        setReadSummary((prev) => prev ? { ...prev, sections_read: prev.sections_read + 1 } : prev)
      } else {
        setReadSummary((prev) => prev ? { ...prev, sections_read: Math.max(0, prev.sections_read - 1) } : prev)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!book) return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 text-slate-400">
      {error ? <><p className="text-red-400">{error}</p><Link to="/" className="text-sm text-indigo-400 hover:text-indigo-300">Back to library</Link></> : <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />}
    </div>
  )

  const TAB_ITEMS = [{ key: 'chat' as const, label: 'Chat' }, { key: 'read' as const, label: 'Read' }, { key: 'study' as const, label: 'Study' }, { key: 'progress' as const, label: 'Progress' }, { key: 'notes' as const, label: 'Notes' }, { key: 'vocab' as const, label: 'Vocab' }, { key: 'code' as const, label: 'Code' }]

  return (
    <div className="flex h-screen bg-surface-0">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside style={{ width: sidebarWidth }} className={`relative fixed inset-y-0 left-0 z-50 flex flex-col border-r border-white/[0.06] bg-surface-1 transition-transform duration-300 lg:static lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-14 items-center gap-2 border-b border-white/[0.06] px-4">
          <Link to="/" className="flex items-center gap-2 text-sm text-slate-400 transition hover:text-slate-200">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Library
          </Link>
        </div>
        <div className="px-3 pt-3">
          <button onClick={() => void newChat()} disabled={streaming} className="btn-secondary w-full btn-sm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M12 5v14M5 12h14" strokeLinecap="round"/></svg>
            New chat
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {sessions.length > 0 && (
            <>
              <p className="section-title mb-2 px-1">Chats</p>
              <ul className="mb-4 space-y-0.5">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => void switchSession(s.id)} className={`w-full truncate rounded-lg px-3 py-2 text-left text-[13px] transition-colors duration-150 ${s.id === activeSessionId ? 'bg-white/[0.06] text-slate-100' : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'}`}>
                      {s.title === 'New chat' ? `Chat #${s.id}` : s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {sections.length > 0 && (
            <>
              <p className="section-title mb-2 px-1">Contents</p>
              <ul className="space-y-0.5">
                {(() => {
                  const l1Idxs: number[] = []
                  for (let i = 0; i < sections.length; i++) { if (sections[i].level === 1) l1Idxs.push(i) }
                  let startIdx = 0
                  for (let j = 0; j < l1Idxs.length - 1; j++) {
                    const between = sections.slice(l1Idxs[j] + 1, l1Idxs[j + 1])
                    if (between.some((s) => s.level === 2)) { startIdx = l1Idxs[j]; break }
                  }
                  if (startIdx === 0 && l1Idxs.length > 1) startIdx = l1Idxs[1]
                  const visible = sections.slice(startIdx)
                  return visible
                })().map((sec) => (
                  <li key={sec.id} title={sec.title} className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg py-1.5 pr-2 transition-colors duration-150 hover:bg-white/[0.03] ${(sec.level ?? 1) === 1 ? 'text-[13px] font-medium text-slate-300' : 'text-xs text-slate-500'}`} style={{ paddingLeft: `${8 + ((sec.level ?? 1) - 1) * 16}px` }}>
                    <span className="flex min-w-0 flex-1 items-baseline gap-1" onClick={() => { setReadTargetPage(sec.page_start); setTab('read'); setSidebarOpen(false) }}>
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${readingProgress.has(sec.id) ? 'bg-emerald-500' : 'border border-slate-600'}`} />
                      <span className="truncate">{(sec.level ?? 1) > 1 && <span className="mr-1 text-slate-600">›</span>}{sec.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-2xs text-slate-600">{sec.page_start}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleToggleRead(sec.id, sec.title) }}
                        title={readingProgress.has(sec.id) ? 'Mark as unread' : 'Mark as read'}
                        className={`h-3.5 w-3.5 rounded-full border transition-colors ${readingProgress.has(sec.id) ? 'border-emerald-500 bg-emerald-500' : 'border-slate-600 hover:border-slate-400'}`}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div onPointerDown={(e) => startSidebarResize(e, 1)} className="absolute right-0 top-0 hidden h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-indigo-500/40 lg:block" />
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-surface-1/80 px-4 backdrop-blur-xl lg:px-5">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="btn-icon !p-1.5 lg:hidden">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round"/></svg>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-slate-100" title={book.title}>{book.title}</h1>
            <div className="flex items-center gap-2">
              <p className="text-2xs text-slate-500">{book.num_pages > 0 && `${book.num_pages} pages`}{book.status !== 'ready' && ` · ${book.status}`}</p>
              {readSummary && readSummary.total_sections > 0 && (
                <span className="text-2xs text-emerald-400">{readSummary.sections_read}/{readSummary.total_sections} read</span>
              )}
              {dueCardsCount > 0 && (
                <span className="text-2xs text-amber-400">{dueCardsCount} due</span>
              )}
            </div>
            {readSummary && readSummary.total_sections > 0 && (
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-800/60">
                <div
                  className="h-full rounded-full bg-emerald-500/70 transition-all"
                  style={{ width: `${Math.round(readSummary.sections_read / readSummary.total_sections * 100)}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {/* Tab switcher */}
            <div className="flex gap-0.5 rounded-xl bg-white/[0.03] p-0.5 border border-white/[0.04]">
              {TAB_ITEMS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 ${tab === t.key ? 'bg-surface-3 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            {/* Export */}
            <div ref={exportRef} className="relative">
              <button onClick={() => setExportOpen((o) => !o)} className="btn-icon !p-2">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {exportOpen && (
                <div className="absolute right-0 top-full mt-2 z-30 w-60 overflow-hidden rounded-xl border border-white/[0.08] bg-surface-2 p-1.5 shadow-glass animate-scale-in">
                  <a href={`/api/books/${id}/export/flashcards.csv`} onClick={() => setExportOpen(false)} className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
                    <p className="text-xs font-medium text-slate-200">Flashcards (.csv)</p>
                    <p className="mt-0.5 text-2xs text-slate-500">Anki-ready, tagged by section</p>
                  </a>
                  <a href={`/api/books/${id}/export/notes.md`} onClick={() => setExportOpen(false)} className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
                    <p className="text-xs font-medium text-slate-200">Notes (.md)</p>
                    <p className="mt-0.5 text-2xs text-slate-500">Markdown, grouped by chapter</p>
                  </a>
                </div>
              )}
            </div>
          </div>
        </header>

        <GamificationBar />

        {showRecall && (
          <div className="shrink-0 border-b border-white/[0.06] px-5 py-3">
            <RecallPrompt
              bookId={id}
              sectionId={showRecall.sectionId}
              sectionTitle={showRecall.title}
              onDismiss={() => setShowRecall(null)}
            />
          </div>
        )}

        {/* Content */}
        {tab === 'chat' ? (
          <>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl px-5 py-8">
                {messages.length === 0 && (
                  <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
                    <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-xl font-bold text-white shadow-glow-indigo-lg">B</div>
                    <h2 className="text-xl font-semibold text-slate-100">Ask anything about "{book.title}"</h2>
                    <p className="mt-2 max-w-md text-sm text-slate-500">Every answer is grounded in the book's pages — the model shows its thinking first.</p>
                    <div className="mt-8 grid w-full max-w-2xl gap-3 sm:grid-cols-3">
                      {SUGGESTIONS.map((s) => (
                        <button key={s.title} onClick={() => void run(s.text)} disabled={streaming} className="card-surface p-4 text-left transition-all duration-200 hover:border-indigo-500/30 hover:bg-white/[0.03] disabled:opacity-50">
                          <p className="text-sm font-medium text-slate-200">{s.title}</p>
                          <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-slate-500">{s.text}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                  {messages.map((m) => m.role === 'user' ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[78%] whitespace-pre-wrap rounded-2xl bg-indigo-600/15 border border-indigo-500/10 px-4 py-2.5 text-[15px] leading-relaxed text-slate-100">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3">
                      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-[11px] font-bold text-white shadow-md shadow-indigo-500/20">B</div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        {(m.reasoning ?? '').length > 0 && (
                          <div className="mb-3">
                            <button onClick={() => toggleReasoning(m.id)} className="select-none text-xs text-slate-500 transition-colors hover:text-slate-300">
                              {m.pending && !m.content ? <span className="thinking-shimmer font-medium">Thinking…</span> : <span className="underline decoration-dotted underline-offset-4">Thought for {m.thinkingSeconds ?? '?'}s</span>}
                            </button>
                            {(m.pending && !m.content) || openReasoning.has(m.id) ? (
                              <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap border-l-2 border-slate-700/70 pl-3 text-[13px] leading-6 text-slate-500">{m.reasoning}</div>
                            ) : null}
                          </div>
                        )}
                        {m.pending && !m.content && !(m.reasoning ?? '').length && (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 py-2">{[0, 1, 2].map((i) => <span key={i} className="dot-bounce h-1.5 w-1.5 rounded-full bg-slate-400" style={{ animationDelay: `${i * 0.15}s` }} />)}</span>
                            {m.status && <span className="text-xs text-slate-500">{m.status}</span>}
                          </div>
                        )}
                        {m.content && (
                          <>
                            <Markdown text={m.content} />
                            {m.pending && <span className="cursor-blink ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 bg-indigo-400" />}
                          </>
                        )}
                        {m.citations && m.citations.length > 0 && !m.pending && (
                          <div className="mt-3 flex flex-wrap items-center gap-1.5">
                            <span className="text-2xs uppercase tracking-wide text-slate-600">Sources</span>
                            {m.citations.map((c, i) => c.url ? (
                              <a key={i} href={c.url} target="_blank" rel="noreferrer" title={c.snippet} className="badge-neutral hover:border-indigo-500/40 hover:text-slate-200 transition-colors">
                                {citationLabel(c)} · {c.section_title.slice(0, 26)}
                              </a>
                            ) : (
                              <span key={i} title={c.snippet} className="badge-neutral">
                                p.{c.page} · {c.section_title.slice(0, 26)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              </div>
            </div>

            {error && <div className="mx-auto mb-1 w-full max-w-3xl px-5"><div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div></div>}

            <div className="shrink-0 bg-gradient-to-t from-surface-0 via-surface-0 to-transparent px-5 pb-4 pt-3">
              <div className="mx-auto max-w-3xl">
                <div className="flex items-end gap-2 rounded-2xl border border-slate-700/60 bg-surface-2 py-2 pl-5 pr-2 shadow-glass transition-all duration-200 focus-within:border-indigo-500/40 focus-within:shadow-glow-indigo">
                  <textarea ref={textareaRef} value={input} onChange={(e) => { setInput(e.target.value); autoGrow() }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run() } }} rows={1} placeholder="Ask about a concept, formula, or code example…" className="max-h-48 flex-1 resize-none bg-transparent py-1.5 text-[15px] text-slate-100 outline-none placeholder:text-slate-600" disabled={streaming} />
                  {streaming ? (
                    <button onClick={stop} title="Stop" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-700 text-slate-200 transition-all duration-200 hover:bg-slate-600">
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>
                    </button>
                  ) : (
                    <button onClick={() => void run()} disabled={!input.trim()} title="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white transition-all duration-200 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4"><path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  )}
                </div>
                <p className="mt-2 text-center text-2xs text-slate-600">Answers cite the book's pages — verify important information independently.</p>
              </div>
            </div>
          </>
        ) : tab === 'read' ? (
          <ReadView
            bookId={id}
            sections={sections}
            jumpToPage={readTargetPage}
            onJumpComplete={() => setReadTargetPage(null)}
            onOpenNotebook={(cellId, sectionId) => {
              if (sectionId != null) setStudySectionId(sectionId)
              setNotebookFocus((prev) => ({ seq: (prev?.seq ?? 0) + 1, cellId, sectionId: sectionId ?? null }))
              setTab('study')
            }}
          />
        ) : tab === 'study' ? (
          <StudyView bookId={id} sections={sections} activeSectionId={studySectionId} onSelectSection={(sid) => setStudySectionId(sid)} notebookFocus={notebookFocus} />
        ) : tab === 'progress' ? (
          <ProgressTab bookId={id} />
        ) : tab === 'vocab' ? (
          <VocabPanel bookId={id} sections={sections} activeSectionId={studySectionId} onJumpToSection={(sid) => { setStudySectionId(sid); setTab('study') }} />
        ) : tab === 'code' ? (
          <CodeLibraryPanel bookId={id} sections={sections} onSendToNotebook={(sectionId) => { setStudySectionId(sectionId); setTab('study') }} />
        ) : (
          <NotesPanel bookId={id} sections={sections} activeSectionId={studySectionId} onJumpToSection={(sid) => { setStudySectionId(sid); setTab('study') }} />
        )}
      </div>
    </div>
  )
}
