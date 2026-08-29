import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api'
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

const SCALE_STEP = 0.25
const MIN_SCALE = 0.5
const MAX_SCALE = 3.0
const RENDER_BUFFER = 400
const PDF_TO_CSS_UNITS = 1.3333333333333333
const H_PAD = 40

export default function PdfViewer({ pdfUrl, initialPage = 1, jumpToPage, onPageChange, onSelection, onJumpComplete, className }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const eventBusRef = useRef(new EventBus())
  const holdersRef = useRef<HTMLDivElement[]>([])
  const viewsRef = useRef<(PDFPageView | null)[]>([])
  const renderedRef = useRef<Set<number>>(new Set())
  const viewportsRef = useRef<{ width: number; height: number }[]>([])
  const scaleRef = useRef(1.2)
  const manualZoomRef = useRef(false)
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
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  scaleRef.current = scale

  const destroyAll = useCallback(() => {
    for (const view of viewsRef.current) view?.destroy()
    viewsRef.current = []
    holdersRef.current.forEach((el) => el.remove())
    holdersRef.current = []
    renderedRef.current = new Set()
  }, [])

  const computeFitScale = useCallback(() => {
    const scroll = scrollRef.current
    const vp = viewportsRef.current[0]
    if (!scroll || !vp) return null
    const available = scroll.clientWidth - H_PAD
    if (available <= 0) return null
    const fit = available / (vp.width * PDF_TO_CSS_UNITS)
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit))
  }, [])

  const renderPage = useCallback(async (pageNumber: number) => {
    const doc = docRef.current
    const holder = holdersRef.current[pageNumber - 1]
    if (!doc || !holder || renderedRef.current.has(pageNumber)) return
    renderedRef.current.add(pageNumber)
    try {
      const page: PDFPageProxy = await doc.getPage(pageNumber)
      const view = new PDFPageView({
        container: holder,
        id: pageNumber,
        defaultViewport: page.getViewport({ scale: 1 }),
        scale: scaleRef.current,
        eventBus: eventBusRef.current,
      })
      viewsRef.current[pageNumber - 1] = view
      view.setPdfPage(page)
      await view.draw()
      console.log('[PdfViewer] rendered page', pageNumber)
    } catch (e) {
      renderedRef.current.delete(pageNumber)
      console.error('[PdfViewer] render error page', pageNumber, e)
    }
  }, [])

  const renderVisible = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || holdersRef.current.length === 0) return
    const viewTop = scroll.scrollTop
    const viewBottom = viewTop + scroll.clientHeight
    const containerTop = scroll.getBoundingClientRect().top
    for (let i = 0; i < holdersRef.current.length; i++) {
      const holder = holdersRef.current[i]
      const topDoc = holder.getBoundingClientRect().top - containerTop + viewTop
      const bottomDoc = topDoc + holder.getBoundingClientRect().height
      if (bottomDoc >= viewTop - RENDER_BUFFER && topDoc <= viewBottom + RENDER_BUFFER) {
        void renderPage(i + 1)
      }
    }
  }, [renderPage])

  const currentPageFromScroll = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || holdersRef.current.length === 0) return 1
    const scrollTop = scroll.scrollTop
    const containerTop = scroll.getBoundingClientRect().top
    let page = 1
    for (let i = holdersRef.current.length - 1; i >= 0; i--) {
      const topDoc = holdersRef.current[i].getBoundingClientRect().top - containerTop + scrollTop
      if (topDoc - 20 <= scrollTop) { page = i + 1; break }
    }
    return page
  }, [])

  const commitPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, totalPagesRef.current || page))
    currentPageRef.current = clamped
    setCurrentPage(clamped)
    if (totalPagesRef.current > 0) onPageChangeRef.current?.(clamped, totalPagesRef.current)
  }, [])

  const scrollToPage = useCallback((n: number) => {
    const scroll = scrollRef.current
    const holder = holdersRef.current[n - 1]
    if (!scroll || !holder) return
    const containerTop = scroll.getBoundingClientRect().top
    const target = holder.getBoundingClientRect().top - containerTop + scroll.scrollTop
    scroll.scrollTop = Math.max(0, target)
    commitPage(n)
    renderVisible()
  }, [commitPage, renderVisible])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    destroyAll()
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
        const viewports = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) =>
            doc.getPage(i + 1).then((p) => p.getViewport({ scale: 1 })),
          ),
        )
        if (cancelled) { doc.destroy(); return }
        viewportsRef.current = viewports
        console.log('[PdfViewer] loaded', doc.numPages, 'pages')
        setLoading(false)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load PDF')
      }
    }
    void load()
    return () => {
      cancelled = true
      destroyAll()
      docRef.current?.destroy()
      docRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl])

  useLayoutEffect(() => {
    const doc = docRef.current
    if (!doc || loading || totalPages === 0) return
    if (holdersRef.current.length > 0) return

    const column = columnRef.current
    if (!column) return
    const vps = viewportsRef.current
    const s = computeFitScale() ?? scale
    scaleRef.current = s
    setScale(s)
    const frag = document.createDocumentFragment()
    for (let n = 1; n <= doc.numPages; n++) {
      const holder = document.createElement('div')
      holder.className = 'pdf-page-wrap pdf-viewer-page'
      const vp = vps[n - 1]
      if (vp) {
        holder.style.width = `${Math.round(vp.width * s * PDF_TO_CSS_UNITS)}px`
        holder.style.height = `${Math.round(vp.height * s * PDF_TO_CSS_UNITS)}px`
      }
      holdersRef.current.push(holder)
      frag.appendChild(holder)
    }
    column.appendChild(frag)
    console.log('[PdfViewer] built holders:', holdersRef.current.length)

    const page = Math.max(1, Math.min(initialPage, doc.numPages))
    currentPageRef.current = page
    setCurrentPage(page)
    if (doc.numPages > 0) onPageChangeRef.current?.(page, doc.numPages)
    void renderPage(page)
    requestAnimationFrame(() => {
      scrollToPage(page)
      renderVisible()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, totalPages, pdfUrl])

  useEffect(() => {
    if (jumpToPage && jumpToPage > 0 && jumpToPage <= totalPages) {
      scrollToPage(jumpToPage)
      onJumpCompleteRef.current?.()
    }
  }, [jumpToPage, totalPages, scrollToPage])

  useEffect(() => {
    const handler = (e: Event) => {
      const el = scrollRef.current
      if (el && el.contains(e.target as Node)) e.preventDefault()
    }
    document.addEventListener('contextmenu', handler, true)
    return () => document.removeEventListener('contextmenu', handler, true)
  }, [])

  const handleScroll = useCallback(() => {
    renderVisible()
    commitPage(currentPageFromScroll())
  }, [renderVisible, commitPage, currentPageFromScroll])

  const changeScale = useCallback((s: number, manual = true) => {
    if (manual) manualZoomRef.current = true
    const clamped = Math.max(MIN_SCALE, Math.min(s, MAX_SCALE))
    setScale(clamped)
    scaleRef.current = clamped
    const doc = docRef.current
    if (!doc) return
    destroyAll()
    const column = columnRef.current
    if (!column) return
    column.innerHTML = ''
    const frag = document.createDocumentFragment()
    holdersRef.current = []
    viewsRef.current = []
    renderedRef.current = new Set()
    const vps = viewportsRef.current
    for (let n = 1; n <= doc.numPages; n++) {
      const holder = document.createElement('div')
      holder.className = 'pdf-page-wrap pdf-viewer-page'
      const vp = vps[n - 1]
      if (vp) {
        holder.style.width = `${Math.round(vp.width * clamped * PDF_TO_CSS_UNITS)}px`
        holder.style.height = `${Math.round(vp.height * clamped * PDF_TO_CSS_UNITS)}px`
      }
      holdersRef.current.push(holder)
      frag.appendChild(holder)
    }
    column.appendChild(frag)
    void renderPage(currentPageRef.current)
    requestAnimationFrame(() => {
      scrollToPage(currentPageRef.current)
      renderVisible()
    })
  }, [destroyAll, scrollToPage, renderVisible, renderPage])

  const fitWidth = useCallback(() => {
    const f = computeFitScale()
    if (f == null) return
    manualZoomRef.current = false
    changeScale(f, false)
  }, [computeFitScale, changeScale])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || loading || error) return
    const ro = new ResizeObserver(() => {
      const f = computeFitScale()
      if (f == null) return
      if (Math.abs(f - scaleRef.current) > 0.02) fitWidth()
    })
    ro.observe(scroll)
    return () => ro.disconnect()
  }, [loading, error, computeFitScale, fitWidth])

  const handleTextSelection = useCallback(() => {
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
      <div className={`flex items-center justify-center ${className ?? ''}`}>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ''}`}>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-white/[0.06] bg-surface-1/60 px-4 py-2 backdrop-blur-sm">
        <button onClick={() => scrollToPage(currentPage - 1)} disabled={currentPage <= 1} className="btn-icon !p-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="min-w-[80px] text-center text-xs text-slate-400">
          Page <input
            type="number"
            value={currentPage}
            onChange={(e) => scrollToPage(parseInt(e.target.value) || 1)}
            className="w-12 rounded border border-slate-700 bg-surface-2 px-1 py-0.5 text-center text-xs text-slate-200 outline-none focus:border-indigo-500"
          /> / {totalPages}
        </span>
        <button onClick={() => scrollToPage(currentPage + 1)} disabled={currentPage >= totalPages} className="btn-icon !p-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="mx-2 h-4 w-px bg-slate-700" />
        <button onClick={() => changeScale(scale + SCALE_STEP)} className="btn-icon !p-1.5" title="Zoom in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35M11 8v6M8 11h6" strokeLinecap="round" /></svg>
        </button>
        <span className="text-xs text-slate-500">{Math.round(scale * 100)}%</span>
        <button onClick={() => changeScale(scale - SCALE_STEP)} className="btn-icon !p-1.5" title="Zoom out">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35M8 11h6" strokeLinecap="round" /></svg>
        </button>
        <button onClick={fitWidth} className="btn-icon !p-1.5" title="Fit width">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M3 9v6M3 21V3M21 9v6M15 12h6M3 12h6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      {/* Scrollable page canvas area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onMouseUp={handleTextSelection}
        onContextMenu={(e) => e.preventDefault()}
        className="flex-1 overflow-auto overscroll-contain bg-slate-900/50"
      >
        <div ref={columnRef} className="pdfViewer flex min-h-full flex-col items-center gap-6 px-4 py-6" />
      </div>
    </div>
  )
}
