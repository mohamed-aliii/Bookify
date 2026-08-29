import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PdfViewer from './PdfViewer'
import SelectionToolbar from './SelectionToolbar'
import TranslatePopup from './TranslatePopup'
import SectionChatPanel, { type SectionChatHandle } from './SectionChatPanel'
import { api, authFetch } from '../api'
import type { ReadAction, Section } from '../types'

interface Props {
  bookId: number
  sections: Section[]
  jumpToPage?: number | null
  onJumpComplete?: () => void
  onOpenNotebook?: (cellId: number, sectionId: number) => void
}

interface ReadState {
  page: number | null
  viewMode: 'pdf' | 'text'
  chatVisible: boolean
}

const READ_STATE_PREFIX = 'bookify:read-state:'

function loadReadState(bookId: number): ReadState | null {
  try {
    const raw = localStorage.getItem(`${READ_STATE_PREFIX}${bookId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ReadState>
    return {
      page: typeof parsed.page === 'number' ? parsed.page : null,
      viewMode: parsed.viewMode === 'text' ? 'text' : 'pdf',
      chatVisible: typeof parsed.chatVisible === 'boolean' ? parsed.chatVisible : true,
    }
  } catch {
    return null
  }
}

function saveReadState(bookId: number, state: ReadState) {
  try {
    localStorage.setItem(`${READ_STATE_PREFIX}${bookId}`, JSON.stringify(state))
  } catch {
    // ignore storage failures
  }
}

export default function ReadView({ bookId, sections, jumpToPage, onJumpComplete, onOpenNotebook }: Props) {
  const firstChapterPage = useMemo(() => {
    const l1Idxs: number[] = []
    for (let i = 0; i < sections.length; i++) { if (sections[i].level === 1) l1Idxs.push(i) }
    let startIdx = 0
    for (let j = 0; j < l1Idxs.length - 1; j++) {
      const between = sections.slice(l1Idxs[j] + 1, l1Idxs[j + 1])
      if (between.some((s) => s.level === 2)) { startIdx = l1Idxs[j]; break }
    }
    if (startIdx === 0 && l1Idxs.length > 1) startIdx = l1Idxs[1]
    return sections[startIdx]?.page_start ?? 1
  }, [sections])

  const [selectedText, setSelectedText] = useState('')
  const [selectionPage, setSelectionPage] = useState<number | null>(null)
  const [toolbarVisible, setToolbarVisible] = useState(false)
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null)
  const [translateVisible, setTranslateVisible] = useState(false)
  const [translatePos, setTranslatePos] = useState<{ x: number; y: number } | null>(null)
  const initial = useMemo(() => loadReadState(bookId), [bookId])
  const [chatVisible, setChatVisible] = useState(initial?.chatVisible ?? true)
  const [viewMode, setViewMode] = useState<'pdf' | 'text'>(initial?.viewMode ?? 'pdf')
  const [currentPage, setCurrentPage] = useState<number>(initial?.page && initial.page >= firstChapterPage ? initial.page : firstChapterPage)
  const chatRef = useRef<SectionChatHandle>(null)

  const currentSectionId = useMemo(() => {
    for (let i = sections.length - 1; i >= 0; i--) {
      const s = sections[i]
      if (s.level === 1 && currentPage >= s.page_start) return s.id
    }
    return sections.find((s) => s.level === 1)?.id ?? null
  }, [currentPage, sections])

  const currentSectionTitle = useMemo(() => {
    const sec = sections.find((s) => s.id === currentSectionId)
    return sec?.title ?? ''
  }, [sections, currentSectionId])

  useEffect(() => {
    saveReadState(bookId, { page: currentPage, viewMode, chatVisible })
  }, [bookId, currentPage, viewMode, chatVisible])

  const pdfUrl = api.getBookPdfUrl(bookId)

  const handleSelection = useCallback((text: string, page: number) => {
    setSelectedText(text)
    setSelectionPage(page)
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      setToolbarPos({ x: rect.left + rect.width / 2, y: rect.top })
    }
    setToolbarVisible(true)
  }, [])

  const handleAction = useCallback((action: ReadAction) => {
    if (action === 'translate') {
      setToolbarVisible(false)
      setTranslatePos(toolbarPos)
      setTranslateVisible(true)
      window.getSelection()?.removeAllRanges()
      return
    }
    setChatVisible(true)
    setToolbarVisible(false)
    chatRef.current?.sendAction(selectedText, action, selectionPage)
    window.getSelection()?.removeAllRanges()
  }, [selectedText, selectionPage, toolbarPos])

  const handleClearSelection = useCallback(() => {
    setToolbarVisible(false)
    window.getSelection()?.removeAllRanges()
  }, [])

  const handleClearTranslate = useCallback(() => {
    setTranslateVisible(false)
    setTranslatePos(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  return (
    <div className="flex min-h-0 flex-1">
      {/* PDF / Text content */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* View mode toggle */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-surface-1/40 px-4 py-2">
          <button
            onClick={() => setViewMode('pdf')}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${viewMode === 'pdf' ? 'bg-white/[0.06] text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            PDF View
          </button>
          <button
            onClick={() => setViewMode('text')}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${viewMode === 'text' ? 'bg-white/[0.06] text-white' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Text View
          </button>
          <span className="ml-auto text-2xs text-slate-600">Starts at chapter 1 (page {firstChapterPage})</span>
          <button
            onClick={() => setChatVisible((v) => !v)}
            className={`ml-2 rounded-lg px-3 py-1 text-xs font-medium transition-colors ${chatVisible ? 'bg-indigo-600/20 text-indigo-300' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {chatVisible ? 'Hide Chat' : 'Show Chat'}
          </button>
        </div>

        {viewMode === 'pdf' ? (
          <PdfViewer
            pdfUrl={pdfUrl}
            initialPage={currentPage}
            jumpToPage={jumpToPage}
            onSelection={handleSelection}
            onJumpComplete={onJumpComplete}
            onPageChange={(page) => setCurrentPage(page)}
            className="flex-1"
          />
        ) : (
          <TextView bookId={bookId} sections={sections} startPage={firstChapterPage} />
        )}
      </div>

      {/* Selection toolbar */}
      <SelectionToolbar
        visible={toolbarVisible}
        position={toolbarPos}
        onAction={handleAction}
        onClear={handleClearSelection}
      />

      {/* Translate popup */}
      <TranslatePopup
        bookId={bookId}
        sectionId={currentSectionId}
        text={selectedText}
        page={selectionPage}
        visible={translateVisible}
        position={translatePos}
        onClear={handleClearTranslate}
      />

      {/* Section Chat Panel */}
      <SectionChatPanel
        ref={chatRef}
        visible={chatVisible}
        bookId={bookId}
        sectionId={currentSectionId}
        sectionTitle={currentSectionTitle}
        onOpenNotebook={onOpenNotebook}
      />
    </div>
  )
}

function TextView({ bookId, sections, startPage }: { bookId: number; sections: Section[]; startPage: number }) {
  const [chunks, setChunks] = useState<{ text: string; section_title: string; page_start: number }[] | null>(null)
  const [loading, setLoading] = useState(false)

  const loadChunks = useCallback(async () => {
    if (chunks) return
    setLoading(true)
    try {
      const secs = sections.filter((s) => s.page_start >= startPage)
      const allChunks: { text: string; section_title: string; page_start: number }[] = []
      for (const sec of secs.slice(0, 20)) {
        const res = await authFetch(`/api/books/${bookId}/sections/${sec.id}/summary`)
        if (res.ok) {
          const data = await res.json() as { cached: boolean; content?: string }
          if (data.content) {
            allChunks.push({ text: data.content, section_title: sec.title, page_start: sec.page_start })
          }
        }
      }
      setChunks(allChunks)
    } finally {
      setLoading(false)
    }
  }, [bookId, sections, startPage, chunks])

  if (!chunks && !loading) {
    void loadChunks()
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-3xl space-y-8">
        {chunks?.map((c, i) => (
          <div key={i}>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">{c.section_title} <span className="text-slate-600">p.{c.page_start}</span></h3>
            <p className="text-sm leading-relaxed text-slate-400 whitespace-pre-wrap">{c.text}</p>
          </div>
        ))}
        {chunks && chunks.length === 0 && (
          <p className="text-sm text-slate-500">No text content available. The PDF may need to be re-indexed.</p>
        )}
      </div>
    </div>
  )
}
