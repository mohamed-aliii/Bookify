import AppShell from '../components/AppShell'

export default function KnowledgeMapPage() {
  return (
    <AppShell header={<h1 className="text-sm font-semibold text-slate-200">Knowledge Map</h1>}>
      <KnowledgeMapContent />
    </AppShell>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d'
import type { ConceptGraphNode, ConceptGraphEdge, CrossBookLink } from '../types'
import { api, getUnifiedGraph, extractCrossBookLinks } from '../api'

interface UnifiedGraph {
  nodes: (ConceptGraphNode & { book_id?: number; book_title?: string })[]
  intra_edges: ConceptGraphEdge[]
  inter_edges: CrossBookLink[]
}

const BOOK_PALETTE = [
  '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171',
  '#2dd4bf', '#fb923c', '#38bdf8', '#4ade80', '#c084fc', '#facc15',
  '#22d3ee', '#e879f9', '#a3e635', '#f97316',
]

function masteryColor(m: number | null): string {
  return m === null ? '#64748b' : m >= 0.8 ? '#22c55e' : m >= 0.5 ? '#f59e0b' : '#ef4444'
}

function hashBook(title: string): number {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0
  return Math.abs(h)
}

type GraphNode = ConceptGraphNode & { book_id?: number; book_title?: string; x?: number; y?: number; _color?: string }
type GraphLink = { source: number | GraphNode; target: number | GraphNode; __type: 'intra' | 'inter'; __intra?: ConceptGraphEdge; __inter?: CrossBookLink }

function KnowledgeMapContent() {
  const [graph, setGraph] = useState<UnifiedGraph | null>(null)
  const [books, setBooks] = useState<{ id: number; title: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [hovered, setHovered] = useState<GraphNode | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [query, setQuery] = useState('')
  const [filterBooks, setFilterBooks] = useState<Set<string>>(new Set())
  const [colorMode, setColorMode] = useState<'book' | 'mastery'>('book')
  const [showIntra, setShowIntra] = useState(true)
  const [showInter, setShowInter] = useState(true)
  const [dimensions, setDimensions] = useState({ w: 1000, h: 640 })
  const containerRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [data, bks] = await Promise.all([
        getUnifiedGraph() as Promise<UnifiedGraph>,
        api.listBooks().catch(() => [] as any),
      ])
      // Enrich nodes with book info if missing — map section_id -> book via fetched books/sections would be ideal,
      // fallback to inter_edges book titles + hash by section
      setGraph(data)
      setBooks((bks as any).map((b: any) => ({ id: b.id, title: b.title })))
    } catch {} finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleExtract = async () => {
    setExtracting(true)
    try { await extractCrossBookLinks(); await load() } catch {} finally { setExtracting(false) }
  }

  // Resize observer — fills all available area
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        if (width > 10 && height > 10) setDimensions({ w: Math.floor(width), h: Math.floor(height) })
      }
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    if (r.width > 0) setDimensions({ w: Math.floor(r.width), h: Math.floor(r.height) })
    const onMove = (ev: MouseEvent) => setMousePos({ x: ev.clientX, y: ev.clientY })
    el.addEventListener('mousemove', onMove)
    return () => { ro.disconnect(); el.removeEventListener('mousemove', onMove) }
  }, [loading, selected])

  // Derive book mapping for nodes — prefer node.book_title, else try to map via inter edges or hash fallback
  const nodeBookKey = useCallback((n: GraphNode): string => {
    if ((n as any).book_title) return (n as any).book_title as string
    // try to infer from any inter edge that touches this node
    if (graph) {
      for (const e of graph.inter_edges) {
        if (e.source_kp_id === n.id && e.source_book_title) return e.source_book_title
        if (e.target_kp_id === n.id && e.target_book_title) return e.target_book_title
      }
    }
    // fallback: section_title book hint via books list hash on section
    return n.section_title || `Book ${n.section_id}`
  }, [graph])

  const bookList = useMemo(() => {
    if (!graph) return [] as string[]
    const s = new Set<string>()
    for (const n of graph.nodes) s.add(nodeBookKey(n as GraphNode))
    return Array.from(s).sort()
  }, [graph, nodeBookKey])

  const bookColorMap = useMemo(() => {
    const m = new Map<string, string>()
    // if we have real books list, assign stable colors by hash
    bookList.forEach((title) => {
      const idx = hashBook(title) % BOOK_PALETTE.length
      m.set(title, BOOK_PALETTE[idx])
    })
    // override with actual book order if available
    books.forEach((b, i) => {
      if (m.has(b.title)) m.set(b.title, BOOK_PALETTE[i % BOOK_PALETTE.length])
    })
    return m
  }, [bookList, books])

  // degree for sizing
  const degreeMap = useMemo(() => {
    const m = new Map<number, number>()
    if (!graph) return m
    for (const e of graph.intra_edges) {
      m.set(e.source, (m.get(e.source) || 0) + 1)
      m.set(e.target, (m.get(e.target) || 0) + 1)
    }
    for (const e of graph.inter_edges) {
      m.set(e.source_kp_id, (m.get(e.source_kp_id) || 0) + 1)
      m.set(e.target_kp_id, (m.get(e.target_kp_id) || 0) + 1)
    }
    return m
  }, [graph])

  const maxDegree = useMemo(() => Math.max(1, ...Array.from(degreeMap.values()), 1), [degreeMap])

  const searchIds = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !graph) return null
    const s = new Set<number>()
    for (const n of graph.nodes) {
      if (n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q) || nodeBookKey(n as any).toLowerCase().includes(q)) s.add(n.id)
    }
    return s
  }, [query, graph, nodeBookKey])

  // adjacency for highlight
  const adjacency = useMemo(() => {
    const a = new Map<number, Set<number>>()
    if (!graph) return a
    const add = (u: number, v: number) => {
      if (!a.has(u)) a.set(u, new Set())
      if (!a.has(v)) a.set(v, new Set())
      a.get(u)!.add(v); a.get(v)!.add(u)
    }
    for (const e of graph.intra_edges) if (showIntra) add(e.source, e.target)
    for (const e of graph.inter_edges) if (showInter) add(e.source_kp_id, e.target_kp_id)
    return a
  }, [graph, showIntra, showInter])

  const highlightedIds = useMemo(() => {
    const focus = hovered?.id ?? selected?.id
    if (focus != null) {
      const s = new Set<number>([focus])
      const neigh = adjacency.get(focus)
      if (neigh) for (const nb of neigh) s.add(nb)
      return s
    }
    if (searchIds && searchIds.size > 0) {
      const s = new Set(searchIds)
      for (const id of searchIds) {
        const neigh = adjacency.get(id)
        if (neigh) for (const nb of neigh) s.add(nb)
      }
      return s
    }
    return null
  }, [hovered, selected, searchIds, adjacency])

  // Filter nodes by book + search (dim instead of remove to keep physics stable — but hide fully filtered books)
  const filteredNodes = useMemo(() => {
    if (!graph) return [] as GraphNode[]
    const bookFilterActive = filterBooks.size > 0
    return (graph.nodes as GraphNode[]).filter(n => {
      const bk = nodeBookKey(n)
      if (bookFilterActive && !filterBooks.has(bk)) return false
      return true
    })
  }, [graph, filterBooks, nodeBookKey])

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map(n => n.id)), [filteredNodes])

  const filteredIntra = useMemo(() => {
    if (!graph || !showIntra) return []
    return graph.intra_edges.filter(e => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target))
  }, [graph, filteredNodeIds, showIntra])

  const filteredInter = useMemo(() => {
    if (!graph || !showInter) return []
    return graph.inter_edges.filter(e => filteredNodeIds.has(e.source_kp_id) && filteredNodeIds.has(e.target_kp_id))
  }, [graph, filteredNodeIds, showInter])

  const graphData = useMemo(() => {
    const nodes: GraphNode[] = filteredNodes.map(n => {
      const bk = nodeBookKey(n)
      const col = colorMode === 'mastery' ? masteryColor((n as any).mastery ?? null) : (bookColorMap.get(bk) || '#8b5cf6')
      return { ...n, _color: col } as GraphNode
    })
    const links: GraphLink[] = [
      ...filteredIntra.map(e => ({ source: e.source, target: e.target, __type: 'intra' as const, __intra: e })),
      ...filteredInter.map(e => ({ source: e.source_kp_id, target: e.target_kp_id, __type: 'inter' as const, __inter: e })),
    ]
    return { nodes, links }
  }, [filteredNodes, filteredIntra, filteredInter, nodeBookKey, bookColorMap, colorMode])

  // Auto fit after data change
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return
    const t = setTimeout(() => { try { (fgRef.current as any)?.zoomToFit?.(400, 60) } catch {} }, 500)
    return () => clearTimeout(t)
  }, [graph, filterBooks, showIntra, showInter, colorMode, dimensions.w])

  const fitView = useCallback(() => { try { (fgRef.current as any)?.zoomToFit?.(400, 60) } catch {} }, [])

  const toggleBook = (title: string) => {
    setFilterBooks(prev => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  if (loading) return <div className="flex h-[calc(100vh-56px)] items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" /></div>

  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0 flex-col overflow-hidden bg-surface-0">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] bg-surface-1/80 px-3 py-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <span className="hidden text-xs font-medium text-slate-300 sm:inline">Unified Map</span>
          {graph && (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-slate-400">
              {filteredNodes.length}/{graph.nodes.length} concepts · {filteredInter.length} cross · {filteredIntra.length} intra
            </span>
          )}
        </div>

        <div className="order-last flex w-full items-center gap-2 sm:order-none sm:ml-2 sm:w-auto sm:flex-1 sm:max-w-[380px]">
          <div className="relative flex-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500">
              <circle cx="11" cy="11" r="7"/><path d="M21 21l-3.5-3.5" strokeLinecap="round"/>
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search concepts, descriptions, books…"
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-1.5 pl-8 pr-7 text-xs text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/40 focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
              </button>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-0.5">
            <button onClick={() => setShowIntra(v => !v)} className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${showIntra ? 'bg-white/10 text-slate-200' : 'text-slate-500'}`}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-400" /> Intra
            </button>
            <button onClick={() => setShowInter(v => !v)} className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${showInter ? 'bg-amber-500/15 text-amber-300' : 'text-slate-500'}`}>
              <span className="mr-1 inline-block h-2 w-6 border-t-2 border-dashed border-amber-500 align-middle" /> Cross
            </button>
          </div>

          <div className="h-5 w-px bg-white/10 hidden sm:block" />

          <button
            onClick={() => setColorMode(m => m === 'book' ? 'mastery' : 'book')}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/[0.06]"
          >
            {colorMode === 'book' ? 'By Book' : 'By Mastery'}
          </button>

          <button onClick={fitView} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/[0.06]">
            ⊡ Fit
          </button>

          <button onClick={handleExtract} disabled={extracting} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {extracting ? 'Extracting…' : 'Extract Cross-Book'}
          </button>
        </div>
      </div>

      {/* Book chips */}
      {bookList.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/[0.06] bg-surface-1/40 px-3 py-2">
          <span className="mr-1 text-[11px] font-medium text-slate-500">Books:</span>
          {bookList.map(title => {
            const active = filterBooks.size === 0 || filterBooks.has(title)
            const col = bookColorMap.get(title) || '#8b5cf6'
            return (
              <button
                key={title}
                onClick={() => toggleBook(title)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  active ? 'border-white/15 bg-white/10 text-white' : 'border-white/5 bg-white/[0.02] text-slate-500 opacity-60'
                }`}
                title={title}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: col }} />
                <span className="max-w-[18ch] truncate">{title.length > 26 ? title.slice(0, 24) + '…' : title}</span>
              </button>
            )
          })}
          {filterBooks.size > 0 && (
            <button onClick={() => setFilterBooks(new Set())} className="ml-1 rounded-full bg-white/10 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/15">Clear</button>
          )}
          <span className="ml-auto hidden text-[11px] text-slate-600 sm:inline">Click to isolate — shows only that material's subgraph + its cross-links.</span>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Graph fills */}
        <div ref={containerRef} className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[#050510]">
          {/* subtle fill */}
          <div className="pointer-events-none absolute inset-0 opacity-[0.035]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '28px 28px' }} />
          <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(900px 600px at 50% 30%, rgba(99,102,241,0.08), transparent 60%)' }} />

          {!graph || graph.nodes.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/[0.06]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-slate-600">
                  <circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" strokeLinecap="round"/>
                </svg>
              </div>
              <h3 className="mt-4 text-sm font-semibold text-slate-200">No unified map yet</h3>
              <p className="mt-1 max-w-md text-sm leading-relaxed text-slate-500">Upload a few books and extract knowledge points in each book's Graph tab. Then return here and hit Extract Cross-Book to weave the connections.</p>
              <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-600">
                <span className="h-2 w-2 rounded-full bg-slate-500" /> Intra = within a book · <span className="h-0.5 w-4 border-t-2 border-dashed border-amber-500 inline-block align-middle" /> Cross = across books
              </div>
            </div>
          ) : filteredNodes.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <p className="text-sm text-slate-400">No concepts match the current filters.</p>
              <button onClick={() => { setFilterBooks(new Set()); setQuery('') }} className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/15">Clear filters</button>
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef as any}
              graphData={graphData as any}
              width={dimensions.w}
              height={dimensions.h}
              backgroundColor="rgba(0,0,0,0)"
              d3AlphaDecay={0.022}
              d3VelocityDecay={0.3}
              cooldownTicks={80}
              warmupTicks={20}
              linkDirectionalArrowLength={0}
              linkCurvature={0}
              onNodeHover={(node: any) => {
                if (node) {
                  const n = node as GraphNode
                  setHovered(n)
                  const el = containerRef.current
                  if (el) el.style.cursor = 'pointer'
                } else {
                  setHovered(null)
                  const el = containerRef.current
                  if (el) el.style.cursor = 'default'
                }
              }}
              onNodeClick={(node: any) => {
                const n = node as GraphNode
                setSelected(prev => prev?.id === n.id ? null : n)
              }}
              onBackgroundClick={() => { setSelected(null); setHovered(null) }}
              onNodeDragEnd={(node: any) => { (node as any).fx = (node as any).x; (node as any).fy = (node as any).y }}
              nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const n = node as GraphNode
                const x = (node as any).x ?? 0
                const y = (node as any).y ?? 0
                const deg = degreeMap.get(n.id) || 0
                const r = 4.5 + (deg / maxDegree) * 5 + ((n as any).mastery != null ? 0.5 : 0)
                const isHighlighted = highlightedIds ? highlightedIds.has(n.id) : false
                const isDimmed = highlightedIds ? !isHighlighted : false
                const isSearchHit = searchIds ? searchIds.has(n.id) : false

                // outer glow for highlighted
                if (isHighlighted && !isDimmed) {
                  ctx.beginPath()
                  ctx.arc(x, y, r + 3, 0, Math.PI * 2)
                  ctx.fillStyle = (n._color || '#8b5cf6') + '22'
                  ctx.fill()
                }

                // main circle
                ctx.beginPath()
                ctx.arc(x, y, r, 0, Math.PI * 2)
                ctx.fillStyle = isDimmed ? '#334155' : (n._color || '#64748b')
                if (isDimmed) (ctx.globalAlpha as any) = 0.28
                else if (searchIds && !isHighlighted) (ctx.globalAlpha as any) = 0.35
                ctx.fill()
                ctx.globalAlpha = 1

                // border
                ctx.strokeStyle = isSearchHit ? '#ffffff' : '#0f172a'
                ctx.lineWidth = isSearchHit ? 2 / globalScale : 1.6 / globalScale
                ctx.stroke()

                // mastery ring when by book
                if (colorMode === 'book' && (n as any).mastery !== null) {
                  ctx.beginPath()
                  ctx.arc(x, y, r + 1.8, 0, Math.PI * 2)
                  ctx.strokeStyle = masteryColor((n as any).mastery)
                  ctx.lineWidth = 1.2 / globalScale
                  ctx.globalAlpha = isDimmed ? 0.25 : 0.95
                  ctx.stroke()
                  ctx.globalAlpha = 1
                }

                // label — hide when zoomed far unless highlighted/search hit
                const showLabel = globalScale > 0.9 || isHighlighted || isSearchHit
                if (showLabel) {
                  const label = n.name.length > 22 ? n.name.slice(0, 20) + '…' : n.name
                  ctx.font = `${Math.max(9, 10 / globalScale)}px Inter, sans-serif`
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'top'
                  ctx.fillStyle = isDimmed ? '#64748b' : '#e2e8f0'
                  ctx.globalAlpha = isDimmed ? 0.45 : 0.95
                  ctx.fillText(label, x, y + r + 4)
                  ctx.globalAlpha = 1
                }
              }}
              nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                const x = (node as any).x ?? 0
                const y = (node as any).y ?? 0
                const deg = degreeMap.get((node as any).id) || 0
                const r = 4.5 + (deg / maxDegree) * 5 + 3
                ctx.fillStyle = color
                ctx.beginPath()
                ctx.arc(x, y, r, 0, Math.PI * 2)
                ctx.fill()
              }}
              linkCanvasObject={(link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const l = link as GraphLink
                const sx = (l.source as any).x
                const sy = (l.source as any).y
                const tx = (l.target as any).x
                const ty = (l.target as any).y
                if (sx == null || tx == null) return
                const isHighlighted = highlightedIds ? (highlightedIds.has((l.source as any).id) && highlightedIds.has((l.target as any).id)) : false
                const isDimmed = highlightedIds ? !isHighlighted : false
                if (searchIds && !isHighlighted && searchIds.size > 0) {
                  // further dim links not in search neighbourhood
                  const sIn = highlightedIds ? highlightedIds.has((l.source as any).id) : false
                  const tIn = highlightedIds ? highlightedIds.has((l.target as any).id) : false
                  if (!sIn || !tIn) {
                    ctx.globalAlpha = 0.07
                  }
                } else if (isDimmed) {
                  ctx.globalAlpha = 0.12
                }

                ctx.beginPath()
                ctx.moveTo(sx, sy)
                ctx.lineTo(tx, ty)
                if (l.__type === 'inter') {
                  ctx.strokeStyle = '#eab308'
                  ctx.lineWidth = (isHighlighted ? 2.2 : 1.4) / Math.max(0.7, globalScale * 0.6)
                  ctx.setLineDash([6 / globalScale, 4 / globalScale])
                  // inter always a bit more visible
                  ctx.globalAlpha = isDimmed ? 0.18 : Math.min(0.9, ctx.globalAlpha ? ctx.globalAlpha * 1.2 : 0.7)
                } else {
                  const rel = l.__intra?.relationship_type
                  const col = rel === 'prerequisite' ? '#ef4444' : rel === 'builds_on' ? '#3b82f6' : rel === 'contrasts_with' ? '#f59e0b' : '#475569'
                  ctx.strokeStyle = col
                  ctx.lineWidth = (0.9 + (l.__intra?.strength || 0.5) * 0.9) / Math.max(0.7, globalScale * 0.55)
                  ctx.setLineDash(rel === 'contrasts_with' ? [4 / globalScale, 3 / globalScale] : [])
                }
                ctx.stroke()
                ctx.setLineDash([])
                ctx.globalAlpha = 1
              }}
              onZoom={() => {}}
              enableNodeDrag={true}
              enableZoomInteraction={true}
              enablePanInteraction={true}
            />
          )}

          {/* Tooltip */}
          {hovered && (
            <div
              className="pointer-events-none fixed z-50 max-w-[340px] rounded-xl border border-white/10 bg-surface-3/95 p-3 shadow-xl backdrop-blur-xl"
              style={{ left: mousePos.x + 14, top: mousePos.y - 10 }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-semibold leading-tight text-slate-100">{hovered.name}</div>
                <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ backgroundColor: bookColorMap.get(nodeBookKey(hovered)) || '#64748b' }}>
                  {nodeBookKey(hovered).slice(0, 20)}
                </span>
              </div>
              <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-400">{hovered.description}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-500">↗ {degreeMap.get(hovered.id) || 0} links</span>
                {(hovered as any).mastery !== null && (hovered as any).mastery !== undefined && (
                  <span className="rounded px-1.5 py-0.5 font-medium text-white" style={{ backgroundColor: masteryColor((hovered as any).mastery) }}>
                    {Math.round((hovered as any).mastery * 100)}% mastery
                  </span>
                )}
                <span className="ml-auto truncate text-slate-500">{hovered.section_title.slice(0, 28)}</span>
              </div>
              {adjacency.get(hovered.id) && (
                <div className="mt-2 border-t border-white/5 pt-2 text-[11px] text-slate-500">
                  {adjacency.get(hovered.id)!.size} related — {Array.from(adjacency.get(hovered.id)!).slice(0, 3).map(id => graph?.nodes.find(n => n.id === id)?.name).filter(Boolean).join(' · ').slice(0, 80)}
                </div>
              )}
            </div>
          )}

          {/* Bottom legend */}
          <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[66%] flex-wrap gap-1.5">
            {bookList.slice(0, 5).map(title => (
              <span key={title} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-slate-300 backdrop-blur">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: bookColorMap.get(title) }} />
                <span className="max-w-[14ch] truncate">{title}</span>
              </span>
            ))}
            <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-slate-400 backdrop-blur sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400" /> drag · scroll to zoom · click to pin
            </span>
          </div>

          {graph && graph.nodes.length > 120 && (
            <div className="pointer-events-none absolute right-3 top-3 hidden rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200 backdrop-blur lg:flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              Large library — filter by book or search to focus
            </div>
          )}
        </div>

        {/* Detail rail — overlays, not shrinking graph until open */}
        {selected && (
          <div className="absolute bottom-0 right-0 top-0 z-10 flex w-[380px] max-w-[92%] flex-col border-l border-white/[0.08] bg-surface-1/95 backdrop-blur-xl shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: bookColorMap.get(nodeBookKey(selected)) || '#8b5cf6' }} />
                  <h3 className="truncate text-sm font-semibold text-slate-100">{selected.name}</h3>
                </div>
                <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-slate-400">{selected.description}</p>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-500">{nodeBookKey(selected)}</span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-500">{selected.section_title.slice(0, 28)}</span>
                  {(selected as any).mastery !== null && (selected as any).mastery !== undefined && (
                    <span className="rounded px-1.5 py-0.5 font-medium text-white" style={{ backgroundColor: masteryColor((selected as any).mastery) }}>
                      {Math.round((selected as any).mastery * 100)}%
                    </span>
                  )}
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {(() => {
                const nid = selected.id
                const intra = (graph?.intra_edges || []).filter(e => e.source === nid || e.target === nid)
                const inter = (graph?.inter_edges || []).filter(e => e.source_kp_id === nid || e.target_kp_id === nid)
                const all = [
                  ...intra.map(e => {
                    const otherId = e.source === nid ? e.target : e.source
                    const other = graph?.nodes.find(n => n.id === otherId)
                    return { id: otherId, name: other?.name || `#${otherId}`, book: other ? nodeBookKey(other as any) : '', type: e.relationship_type, kind: 'intra' as const, strength: e.strength, expl: (e as any).explanation, sourceTxt: selected?.description || '', targetTxt: other?.description || '', sourceSnippet: null, targetSnippet: null }
                  }),
                  ...inter.map(e => {
                    const otherId = e.source_kp_id === nid ? e.target_kp_id : e.source_kp_id
                    const other = graph?.nodes.find(n => n.id === otherId)
                    const isSource = e.source_kp_id === nid
                    return { id: otherId, name: (isSource ? e.target_kp_name : e.source_kp_name) || other?.name || `#${otherId}`, book: (isSource ? e.target_book_title : e.source_book_title) || (other ? nodeBookKey(other as any) : ''), type: e.relationship_label, kind: 'inter' as const, strength: e.similarity, expl: e.explanation || (e as any).explanation_short, sourceTxt: isSource ? selected?.description || '' : (other?.description || (e as any).source_txt || ''), targetTxt: isSource ? (other?.description || (e as any).target_txt || '') : selected?.description || '', sourceSnippet: (e as any).source_snippet || null, targetSnippet: (e as any).target_snippet || null, edge: e }
                  }),
                ]
                if (all.length === 0) {
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04]"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5 text-slate-600"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4" strokeLinecap="round"/></svg></div>
                      <p className="mt-3 text-xs font-medium text-slate-300">No connections yet</p>
                      <p className="mt-1 max-w-[28ch] text-xs leading-relaxed text-slate-500">This concept is isolated. Extract more chapters and run Extract Cross-Book to link it.</p>
                    </div>
                  )
                }
                return (
                  <>
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Related — {all.length} · <span className="normal-case text-amber-300">{inter.length} cross</span><span className="text-slate-600"> · </span>{intra.length} intra</h4>
                    <div className="mt-3 space-y-2">
                      {all.slice(0, 60).map((c, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            const target = graph?.nodes.find(n => n.id === c.id) as any
                            if (target) setSelected(target)
                          }}
                          className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${c.kind === 'inter' ? 'border-amber-500/15 bg-amber-500/[0.06] hover:border-amber-500/25 hover:bg-amber-500/[0.09]' : 'border-white/[0.06] bg-white/[0.02] hover:border-indigo-500/20 hover:bg-white/[0.04]'}`}
                        >
                          <span className={`h-2 w-2 shrink-0 rounded-full ${c.kind === 'inter' ? 'bg-amber-400' : ''}`} style={c.kind === 'intra' ? { backgroundColor: c.type === 'prerequisite' ? '#ef4444' : c.type === 'builds_on' ? '#3b82f6' : c.type === 'contrasts_with' ? '#f59e0b' : '#64748b' } : undefined} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-slate-200">{c.name}</div>
                            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                              <span className={c.kind === 'inter' ? 'text-amber-300/80' : 'text-slate-400'}>{c.type}</span>
                              <span>·</span>
                              <span className="truncate">{c.book.slice(0, 24)}</span>
                              {c.strength != null && <span className="ml-auto rounded bg-black/20 px-1 py-px font-medium">{Math.round(c.strength * 100)}%</span>}
                            </div>
                            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                              <div className="rounded-lg border border-white/[0.04] bg-black/20 px-2 py-1.5">
                                <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Source Concept</div>
                                <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{(c as any).sourceTxt?.slice(0,120) || selected?.description?.slice(0,120) || '—'}</div>
                              </div>
                              <div className="rounded-lg border border-white/[0.04] bg-black/20 px-2 py-1.5">
                                <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Target Concept</div>
                                <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{(c as any).targetTxt?.slice(0,120) || c.name}</div>
                              </div>
                            </div>
                            {(c as any).expl && <div className="mt-1.5 rounded-lg bg-white/[0.02] px-2 py-1.5 text-[11px] leading-relaxed text-slate-300 border border-white/[0.04]"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Why they connect: </span>{(c as any).expl}</div>}
                          </div>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 shrink-0 text-slate-600"><path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                      ))}
                    </div>
                  </>
                )
              })()}
            </div>

            <div className="border-t border-white/[0.06] p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-500">Click a related concept to follow the graph.</span>
                <button onClick={() => setSelected(null)} className="rounded-lg bg-white/5 px-3 py-1 text-xs font-medium text-slate-300 hover:bg-white/10">Close</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] bg-surface-1/60 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
        <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-2 w-2 rounded-full bg-emerald-500"/>Mastered</span>
        <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-2 w-2 rounded-full bg-amber-500"/>Learning</span>
        <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-2 w-2 rounded-full bg-red-500"/>Weak</span>
        <span className="hidden items-center gap-1.5 sm:inline-flex"><span className="h-2 w-2 rounded-full bg-slate-500"/>Unknown</span>
        <span className="mx-2 hidden h-3 w-px bg-white/10 sm:block" />
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-slate-500"/> Intra</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-amber-500"/> Cross</span>
        <span className="ml-auto hidden text-[11px] text-slate-600 lg:inline">Tip: filter by book chips to see how materials interweave — cross links are the bridges.</span>
      </div>
    </div>
  )
}
