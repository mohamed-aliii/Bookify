import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { EventBus, PDFPageView } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

interface Props {
  pdfUrl: string
  initialPage?: number
  jumpToPage?: number | null
  onPageChange?: (page: number, totalPages: number) => void
  onSelection?: (text: string, page: number) => void
  onJumpComplete?: () => void
  className?: string
}

const PDF_TO_CSS_UNITS = 1.3333333333333333
const MIN_SCALE = 0.5
const MAX_SCALE = 3.0

export default function SlideViewer({ pdfUrl, initialPage = 1, jumpToPage, onPageChange, onSelection, onJumpComplete, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const holderRef = useRef<HTMLDivElement | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const eventBusRef = useRef(new EventBus())
  const viewRef = useRef<PDFPageView | null>(null)
  const viewportsRef = useRef<{ width: number; height: number }[]>([])
  const currentPageRef = useRef(initialPage)
  const totalPagesRef = useRef(0)

  const onPageChangeRef = useRef(onPageChange)
  onPageChangeRef.current = onPageChange
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const onJumpCompleteRef = useRef(onJumpComplete)
  onJumpCompleteRef.current = onJumpComplete

  const [currentPage, setCurrentPage] = useState(initialPage)
  const [totalPages, setTotalPages] = useState(0)
  const [, setScale] = useState(1.1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const commitPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, totalPagesRef.current || page))
    currentPageRef.current = clamped
    setCurrentPage(clamped)
    if (totalPagesRef.current > 0) onPageChangeRef.current?.(clamped, totalPagesRef.current)
  }, [])

  const computeFitScale = useCallback(() => {
    const container = containerRef.current
    const vp = viewportsRef.current[currentPageRef.current - 1]
    if (!container || !vp) return null
    const availW = container.clientWidth - 32
    const availH = container.clientHeight - 32
    if (availW <= 0 || availH <= 0) return null
    const fitW = availW / (vp.width * PDF_TO_CSS_UNITS)
    const fitH = availH / (vp.height * PDF_TO_CSS_UNITS)
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(fitW, fitH) * 0.96))
  }, [])

  const renderPage = useCallback(async (pageNumber: number) => {
    const doc = docRef.current
    const holder = holderRef.current
    if (!doc || !holder) return
    // destroy previous
    viewRef.current?.destroy()
    viewRef.current = null
    holder.innerHTML = ''
    try {
      const page = await doc.getPage(pageNumber)
      const currentScale = (() => {
        const fit = computeFitScale()
        if (fit != null) return fit
        return 1.1
      })()
      setScale(currentScale)
      const view = new PDFPageView({
        container: holder,
        id: pageNumber,
        defaultViewport: page.getViewport({ scale: 1 }),
        scale: currentScale,
        eventBus: eventBusRef.current,
      })
      viewRef.current = view
      view.setPdfPage(page)
      await view.draw()
    } catch (e) {
      console.error('[SlideViewer] render error', e)
    }
  }, [computeFitScale])

  const goTo = useCallback((n: number) => {
    const clamped = Math.max(1, Math.min(n, totalPagesRef.current || n))
    commitPage(clamped)
    void renderPage(clamped)
    onJumpCompleteRef.current?.()
  }, [commitPage, renderPage])

  // load document
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    docRef.current?.destroy()
    docRef.current = null
    totalPagesRef.current = 0
    viewportsRef.current = []
    setTotalPages(0)

    const load = async () => {
      try {
        const doc = await pdfjsLib.getDocument(pdfUrl).promise
        if (cancelled) { doc.destroy(); return }
        docRef.current = doc
        totalPagesRef.current = doc.numPages
        setTotalPages(doc.numPages)
        const vps = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1).then(p => p.getViewport({ scale: 1 }))),
        )
        if (cancelled) { doc.destroy(); return }
        viewportsRef.current = vps
        const start = Math.max(1, Math.min(initialPage, doc.numPages))
        currentPageRef.current = start
        setCurrentPage(start)
        if (doc.numPages > 0) onPageChangeRef.current?.(start, doc.numPages)
        setLoading(false)
        // initial render deferred to next effect
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e)
          // 404 for slides without PDF preview
          if (msg.includes('404') || msg.includes('Missing PDF')) {
            setError('Slide preview is generating or not available. Please wait a moment and refresh, or switch to Text view.')
          } else {
            setError(msg || 'Failed to load slides')
          }
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
      viewRef.current?.destroy()
      viewRef.current = null
      docRef.current?.destroy()
      docRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl])

  // render when ready or page changes via initial load
  useEffect(() => {
    if (loading || totalPages === 0 || error) return
    void renderPage(currentPage)
  }, [loading, totalPages, error, renderPage, currentPage])

  // jumpToPage from sidebar
  useEffect(() => {
    if (jumpToPage && jumpToPage > 0 && jumpToPage <= totalPages) {
      goTo(jumpToPage)
    }
  }, [jumpToPage, totalPages, goTo])

  // keyboard arrows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goTo(currentPageRef.current - 1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goTo(currentPageRef.current + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo])

  // resize -> fit
  useEffect(() => {
    if (loading || error) return
    const ro = new ResizeObserver(() => {
      void renderPage(currentPageRef.current)
    })
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [loading, error, renderPage])

  const handleSelection = useCallback(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text || text.length < 3) return
    onSelectionRef.current?.(text, currentPageRef.current)
  }, [])

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className ?? ''}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 p-8 text-center ${className ?? ''}`}>
        <p className="max-w-md text-sm text-amber-300">{error}</p>
        <p className="text-xs text-slate-500">Text extraction and chat still work. For visual slides, re-upload as PDF or install LibreOffice.</p>
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ''}`}>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-center gap-2 border-b border-white/[0.06] bg-surface-1/60 px-4 py-2 backdrop-blur-sm">
        <button onClick={() => goTo(currentPage - 1)} disabled={currentPage <= 1} className="btn-icon !p-1.5" title="Previous slide (←)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="min-w-[120px] text-center text-xs text-slate-400">
          Slide <input
            type="number"
            value={currentPage}
            onChange={(e) => goTo(parseInt(e.target.value) || 1)}
            className="w-12 rounded border border-slate-700 bg-surface-2 px-1 py-0.5 text-center text-xs text-slate-200 outline-none focus:border-indigo-500"
          /> / {totalPages}
        </span>
        <button onClick={() => goTo(currentPage + 1)} disabled={currentPage >= totalPages} className="btn-icon !p-1.5" title="Next slide (→)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="mx-2 h-4 w-px bg-slate-700" />
        <span className="hidden text-2xs text-slate-600 sm:inline">Use ← → arrows</span>
        <span className="ml-auto hidden items-center gap-1 text-2xs text-slate-600 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Slides — one per section
        </span>
      </div>

      {/* Slide canvas area */}
      <div
        ref={containerRef}
        onMouseUp={handleSelection}
        onContextMenu={(e) => e.preventDefault()}
        className="flex flex-1 items-center justify-center overflow-auto bg-slate-900/50 p-4"
      >
        <div ref={(el) => { holderRef.current = el }} className="pdfViewer pdf-viewer-page flex shrink-0 items-center justify-center rounded-lg bg-white shadow-xl" />
      </div>

      {/* Quick jump dots */}
      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-white/[0.06] bg-surface-1/40 px-4 py-2">
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1">
          {Array.from({ length: Math.min(totalPages, 60) }, (_, i) => (
            <button
              key={i + 1}
              onClick={() => goTo(i + 1)}
              title={`Slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${currentPage === i + 1 ? 'w-6 bg-indigo-500' : 'w-1.5 bg-slate-600 hover:bg-slate-500'}`}
            />
          ))}
          {totalPages > 60 && <span className="ml-2 text-2xs text-slate-500">+{totalPages - 60} more</span>}
        </div>
      </div>
    </div>
  )
}
