import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import ForceGraph, { ForceGraphMethods } from 'react-force-graph-3d'
import type { ConceptGraph, ConceptGraphNode, Section } from '../types'
import * as api from '../api'

interface ConceptGraphProps {
  bookId: number
}

const REL_COLORS: Record<string, string> = {
  prerequisite: '#ef4444',
  related: '#64748b',
  builds_on: '#3b82f6',
  contrasts_with: '#f59e0b',
}

const REL_LABELS: Record<string, string> = {
  prerequisite: 'Prerequisite',
  related: 'Related',
  builds_on: 'Builds On',
  contrasts_with: 'Contrasts With',
}

const CHAPTER_PALETTE = [
  '#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa',
  '#f87171', '#2dd4bf', '#fb923c', '#22d3ee', '#c084fc',
  '#4ade80', '#facc15', '#38bdf8', '#a3e635', '#e879f9',
]

function masteryColor(mastery: number | null): string {
  if (mastery === null) return '#71717a'
  if (mastery >= 0.8) return '#22c55e'
  if (mastery >= 0.5) return '#f59e0b'
  return '#ef4444'
}

function masteryLabel(m: number | null): string {
  if (m === null) return 'Unknown'
  if (m >= 0.8) return 'Mastered'
  if (m >= 0.5) return 'Learning'
  return 'Weak'
}

type GFNode = ConceptGraphNode & {
  chapterColor: string
  degree: number
  dimmed: boolean
}

type GFLink = {
  id: number
  source: number
  target: number
  relationship_type: string
  strength: number
  explanation?: string | null
}

export default function ConceptGraphView({ bookId }: ConceptGraphProps) {
  const [graph, setGraph] = useState<ConceptGraph | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [extractingSection, setExtractingSection] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ConceptGraphNode | null>(null)
  const [detail, setDetail] = useState<any>(null)
  const [hovered, setHovered] = useState<ConceptGraphNode | null>(null)
  const [hoveredLink, setHoveredLink] = useState<GFLink | null>(null)
  const [selectedLink, setSelectedLink] = useState<GFLink | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [filterRel, setFilterRel] = useState<Set<string>>(new Set(Object.keys(REL_COLORS)))
  const [colorMode, setColorMode] = useState<'chapter' | 'mastery'>('chapter')
  const [autoRotate, setAutoRotate] = useState(false)
  const [focusChapter, setFocusChapter] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 })
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)

  const chapters = useMemo(() => sections.filter(s => s.level <= 1), [sections])

  const chapterExtractedCount = useMemo(() => {
    const counts = new Map<number, number>()
    if (graph) {
      for (const n of graph.nodes) {
        const sid = n.section_id
        if (sid) counts.set(sid, (counts.get(sid) || 0) + 1)
      }
    }
    return counts
  }, [graph])

  const chapterColor = useMemo(() => {
    const map = new Map<number, string>()
    chapters.forEach((c, i) => map.set(c.id, CHAPTER_PALETTE[i % CHAPTER_PALETTE.length]))
    return map
  }, [chapters])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [data, secs] = await Promise.all([api.getConceptGraph(bookId), api.getBookSections(bookId)])
      setGraph(data)
      setSections(secs)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [bookId])

  useEffect(() => { load() }, [load])

  // Resize observer — fills available area, never wastes space
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) setDimensions({ w: Math.floor(width), h: Math.floor(height) })
      }
    })
    ro.observe(el)
    // initial
    const r = el.getBoundingClientRect()
    if (r.width > 0) setDimensions({ w: Math.floor(r.width), h: Math.floor(r.height) })
    return () => ro.disconnect()
  }, [loading])

  // also observe sidebar toggle
  useEffect(() => {
    if (!containerRef.current) return
    const r = containerRef.current.getBoundingClientRect()
    if (r.width > 0) setDimensions({ w: Math.floor(r.width), h: Math.floor(r.height) })
  }, [sidebarOpen])

  // Degree map for intelligent sizing — hubs are bigger even at large scale
  const degreeMap = useMemo(() => {
    const m = new Map<number, number>()
    if (!graph) return m
    for (const e of graph.edges) {
      if (!filterRel.has(e.relationship_type)) continue
      m.set(e.source, (m.get(e.source) || 0) + 1)
      m.set(e.target, (m.get(e.target) || 0) + 1)
    }
    return m
  }, [graph, filterRel])

  const adjacency = useMemo(() => {
    const a = new Map<number, Set<number>>()
    if (!graph) return a
    for (const e of graph.edges) {
      if (!filterRel.has(e.relationship_type)) continue
      if (!a.has(e.source)) a.set(e.source, new Set())
      if (!a.has(e.target)) a.set(e.target, new Set())
      a.get(e.source)!.add(e.target)
      a.get(e.target)!.add(e.source)
    }
    return a
  }, [graph, filterRel])

  const maxDegree = useMemo(() => Math.max(1, ...Array.from(degreeMap.values()), 1), [degreeMap])

  const searchIds = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !graph) return null
    const s = new Set<number>()
    for (const n of graph.nodes) {
      if (n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q)) s.add(n.id)
    }
    return s
  }, [query, graph])

  const searchWithNeighbors = useMemo(() => {
    if (!searchIds) return null
    const s = new Set(searchIds)
    for (const id of searchIds) {
      const neigh = adjacency.get(id)
      if (neigh) for (const nb of neigh) s.add(nb)
    }
    return s
  }, [searchIds, adjacency])

  // highlighted ids: hoverLink > hover > selectedLink > selected > search > focus
  const highlightedIds = useMemo(() => {
    if (hoveredLink) {
      const s = new Set<number>()
      const a = typeof hoveredLink.source === 'object' ? (hoveredLink.source as any).id : hoveredLink.source as number
      const b = typeof hoveredLink.target === 'object' ? (hoveredLink.target as any).id : hoveredLink.target as number
      s.add(a); s.add(b)
      return s
    }
    if (hovered) {
      const s = new Set<number>([hovered.id])
      const neigh = adjacency.get(hovered.id)
      if (neigh) for (const nb of neigh) s.add(nb)
      return s
    }
    if (selectedLink) {
      const s = new Set<number>()
      const a = typeof selectedLink.source === 'object' ? (selectedLink.source as any).id : selectedLink.source as number
      const b = typeof selectedLink.target === 'object' ? (selectedLink.target as any).id : selectedLink.target as number
      s.add(a); s.add(b)
      return s
    }
    if (selected) {
      const s = new Set<number>([selected.id])
      const neigh = adjacency.get(selected.id)
      if (neigh) for (const nb of neigh) s.add(nb)
      return s
    }
    if (searchWithNeighbors) return searchWithNeighbors
    if (focusChapter !== null && graph) {
      const s = new Set<number>()
      for (const n of graph.nodes) if (n.section_id === focusChapter) s.add(n.id)
      return s
    }
    return null
  }, [hoveredLink, hovered, selectedLink, selected, searchWithNeighbors, focusChapter, graph, adjacency])

  const filteredEdges = useMemo<GFLink[]>(() => {
    if (!graph) return []
    return graph.edges
      .filter(e => filterRel.has(e.relationship_type) && graph.nodes.some(n => n.id === e.source) && graph.nodes.some(n => n.id === e.target))
      .map(e => ({ ...e, source: e.source, target: e.target, explanation: (e as any).explanation }))
  }, [graph, filterRel])

  const fgData = useMemo(() => {
    const nodes: GFNode[] = (graph?.nodes || []).map(n => ({
      ...n,
      chapterColor: chapterColor.get(n.section_id) || '#8b5cf6',
      degree: degreeMap.get(n.id) || 0,
      dimmed: false, // computed dynamically in getters
    }))
    return { nodes, links: filteredEdges }
  }, [graph, filteredEdges, chapterColor, degreeMap])

  const nodeById = useMemo(() => {
    const m = new Map<number, ConceptGraphNode>()
    if (graph) for (const n of graph.nodes) m.set(n.id, n)
    return m
  }, [graph])

  const handleExtractChapter = async (sectionId: number) => {
    setExtractingSection(sectionId)
    setError(null)
    try {
      await api.extractSectionConceptGraph(bookId, sectionId, false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtractingSection(null)
    }
  }

  const handleNodeClick = (node: GFNode) => {
    setSelected(node)
    setSelectedLink(null)
    api.getKpDetail(bookId, node.id).then(setDetail).catch(console.error)
  }

  const handleLinkClick = (link: GFLink) => {
    setSelectedLink(link)
    setSelected(null)
    setDetail(null)
  }

  const handleMouseMove = (e: { clientX: number; clientY: number }) => {
    setMousePos({ x: e.clientX, y: e.clientY })
  }

  const toggleRel = (rel: string) => {
    setFilterRel(prev => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  useEffect(() => {
    let raf: number
    const loop = () => {
      const controls = fgRef.current?.controls() as { autoRotate?: boolean; autoRotateSpeed?: number } | undefined
      if (controls) {
        controls.autoRotate = !!autoRotate && !!graph && graph.nodes.length > 0
        controls.autoRotateSpeed = 0.35
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [autoRotate, graph])

  // Fit view when data changes or sidebar toggles
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return
    const t = setTimeout(() => {
      try { (fgRef.current as any)?.zoomToFit?.(400, 60) } catch {}
    }, 450)
    return () => clearTimeout(t)
  }, [graph, filterRel, focusChapter, sidebarOpen, dimensions.w])

  const fitView = useCallback(() => {
    try { (fgRef.current as any)?.zoomToFit?.(400, 60) } catch {}
  }, [])

  const linkVisibility = useCallback((link: any) => {
    // if search active → show only links touching search neighbourhood
    if (searchWithNeighbors) {
      const src = typeof link.source === 'object' ? link.source.id : link.source
      const tgt = typeof link.target === 'object' ? link.target.id : link.target
      return searchWithNeighbors.has(src) && searchWithNeighbors.has(tgt)
    }
    if (focusChapter === null) return true
    const src = nodeById.get(typeof link.source === 'object' ? link.source.id : link.source)
    const tgt = nodeById.get(typeof link.target === 'object' ? link.target.id : link.target)
    const isFocused = (src?.section_id === focusChapter) || (tgt?.section_id === focusChapter)
    // keep focused edges fully, cross edges touching focused chapter at 40% (handled via opacity)
    return isFocused || highlightedIds === null
  }, [focusChapter, nodeById, searchWithNeighbors, highlightedIds])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-0 p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
          <p className="text-xs text-slate-500">Loading knowledge universe…</p>
        </div>
      </div>
    )
  }

  const hasGraph = graph !== null && graph.nodes.length > 0
  const totalConcepts = graph?.nodes.length ?? 0
  const totalEdges = graph?.edges.length ?? 0
  const visibleEdges = filteredEdges.length

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-surface-0">
      {/* Top toolbar — fills width, never wastes space */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] bg-surface-1/80 px-3 py-2 backdrop-blur-xl">
        {/* Left: title + counts */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 lg:hidden"
            aria-label="Toggle chapters"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round"/></svg>
          </button>
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="hidden h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 lg:inline-flex"
            title={sidebarOpen ? 'Hide chapters' : 'Show chapters'}
            aria-label="Toggle chapters"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div className="hidden sm:flex flex-col leading-none">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-200">Knowledge Universe</span>
            {hasGraph && (
              <span className="text-[11px] text-slate-500">{totalConcepts} concepts · {visibleEdges}/{totalEdges} links{query ? ` · ${searchIds?.size ?? 0} match` : ''}</span>
            )}
          </div>
          <div className="sm:hidden text-xs font-medium text-slate-300">Universe</div>
          {hasGraph && <span className="sm:hidden text-[11px] text-slate-500">· {totalConcepts}</span>}
        </div>

        {/* Search — grows to fill middle */}
        <div className="order-last flex w-full items-center gap-2 sm:order-none sm:ml-2 sm:w-auto sm:flex-1 sm:max-w-[360px]">
          <div className="relative flex-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500">
              <circle cx="11" cy="11" r="7"/><path d="M21 21l-3.5-3.5" strokeLinecap="round"/>
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search concepts…"
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-1.5 pl-8 pr-7 text-xs text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/40 focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
              </button>
            )}
          </div>
          {query && searchIds && searchIds.size === 0 && (
            <span className="hidden text-[11px] text-amber-400 lg:inline">No match</span>
          )}
        </div>

        {/* Controls — wrap, pushes right */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-0.5">
            {Object.entries(REL_COLORS).map(([rel, color]) => (
              <button
                key={rel}
                onClick={() => toggleRel(rel)}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  filterRel.has(rel) ? 'bg-white/10 text-slate-200' : 'text-slate-500 hover:text-slate-300'
                }`}
                title={REL_LABELS[rel]}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color, opacity: filterRel.has(rel) ? 1 : 0.35 }} />
                <span className="hidden xl:inline">{REL_LABELS[rel]}</span>
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-white/10 hidden sm:block" />

          <button
            onClick={() => setColorMode(m => m === 'chapter' ? 'mastery' : 'chapter')}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white"
            title="Toggle coloring"
          >
            <span className="hidden sm:inline">{colorMode === 'chapter' ? 'By Chapter' : 'By Mastery'}</span>
            <span className="sm:hidden">{colorMode === 'chapter' ? 'Chapters' : 'Mastery'}</span>
          </button>

          <button
            onClick={() => setAutoRotate(a => !a)}
            className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${autoRotate ? 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300' : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200'}`}
            title="Auto rotate"
          >
            {autoRotate ? '⟳ On' : '⟳ Off'}
          </button>

          <button
            onClick={fitView}
            disabled={!hasGraph}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/[0.06] disabled:opacity-40"
            title="Fit to view"
          >
            ⊡ Fit
          </button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-300">{error}</div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar — collapsible, fills height */}
        <div className={`
          flex shrink-0 flex-col border-white/[0.06] bg-surface-1/60 backdrop-blur
          transition-all duration-200 ease-out
          ${sidebarOpen ? 'w-[280px] border-r translate-x-0' : 'w-[280px] -ml-[280px] border-r-0 lg:w-0 lg:-ml-0 lg:overflow-hidden lg:border-r-0'}
          max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-20 max-lg:mt-[45px] max-lg:h-[calc(100%-45px)] max-lg:w-[300px] max-lg:shadow-2xl
          ${sidebarOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full'}
        `}>
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2.5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Constellations</h3>
              <p className="text-[11px] leading-tight text-slate-500">By chapter. Dim = filtered. Search highlights across book.</p>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-300 lg:hidden">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {chapters.length === 0 && <p className="p-3 text-xs text-slate-500">No chapters found in this book.</p>}
            <div className="space-y-1">
              {chapters.map((c) => {
                const count = chapterExtractedCount.get(c.id) || 0
                const isFocused = focusChapter === c.id
                const isEmpty = count === 0
                return (
                  <div
                    key={c.id}
                    onClick={() => setFocusChapter(prev => prev === c.id ? null : c.id)}
                    className={`group flex items-center gap-2.5 rounded-xl border px-2.5 py-2.5 text-left transition-all cursor-pointer ${
                      isFocused ? 'border-indigo-500/30 bg-indigo-500/10' : isEmpty ? 'border-transparent bg-transparent hover:bg-white/[0.04]' : 'border-white/[0.04] bg-white/[0.02] hover:border-white/[0.08] hover:bg-white/[0.05]'
                    }`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white/5" style={{ backgroundColor: chapterColor.get(c.id), opacity: isFocused ? 1 : 0.95 }} />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-xs font-medium ${isFocused ? 'text-white' : 'text-slate-200'}`}>{c.title}</div>
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className={isEmpty ? 'text-slate-600' : isFocused ? 'text-indigo-300' : 'text-slate-400'}>{count > 0 ? `${count} concept${count === 1 ? '' : 's'}` : 'Not extracted'}</span>
                        {isFocused && <span className="rounded bg-white/10 px-1 py-px text-[10px] text-white">Focused</span>}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleExtractChapter(c.id) }}
                      disabled={extractingSection !== null}
                      className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                        isEmpty
                          ? 'border-indigo-500/30 bg-indigo-600 text-white hover:bg-indigo-500'
                          : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white'
                      }`}
                    >
                      {extractingSection === c.id ? '…' : (count > 0 ? 'Update' : 'Extract')}
                    </button>
                  </div>
                )
              })}
            </div>

            {hasGraph && (
              <div className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">At a glance</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-white/[0.04] py-2">
                    <div className="text-sm font-semibold text-white">{totalConcepts}</div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">Concepts</div>
                  </div>
                  <div className="rounded-lg bg-white/[0.04] py-2">
                    <div className="text-sm font-semibold text-white">{visibleEdges}</div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">Links</div>
                  </div>
                  <div className="rounded-lg bg-white/[0.04] py-2">
                    <div className="text-sm font-semibold text-white">{maxDegree}</div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">Max hub</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Larger spheres = more connections. Halo = mastery in Chapter mode.
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-white/[0.06] p-2.5">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>{chapters.filter(c => (chapterExtractedCount.get(c.id) || 0) > 0).length} / {chapters.length} chapters grown</span>
              {focusChapter !== null && (
                <button onClick={() => setFocusChapter(null)} className="rounded bg-white/10 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/15">Clear focus</button>
              )}
            </div>
          </div>
        </div>

        {/* Overlay when sidebar open on mobile */}
        {sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-10 bg-black/40 backdrop-blur-[1px] lg:hidden"
            style={{ top: 45 }}
            aria-label="Close chapters"
          />
        )}

        {/* Main 3D */}
        <div className="flex min-w-0 flex-1 flex-col bg-[#050510] relative overflow-hidden">
          <div
            ref={containerRef}
            className="relative flex-1 min-h-0 overflow-hidden"
            onMouseMove={handleMouseMove as any}
            style={{ background: 'radial-gradient(1200px 700px at 50% 35%, #14143a 0%, #0e0e28 22%, #09091a 45%, #050510 72%)' }}
          >
            {/* subtle grid to give sense of scale and fill voids intentionally */}
            <div className="pointer-events-none absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '36px 36px' }} />

            {!hasGraph ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/[0.06]">
                  <span className="text-2xl">🌌</span>
                </div>
                <h3 className="mt-4 text-sm font-semibold text-slate-200">Your knowledge universe is empty</h3>
                <p className="mt-1 max-w-md text-sm leading-relaxed text-slate-500">Extract a chapter on the left to plant its constellation. As you grow more chapters, connections weave automatically — search and filters keep even 200+ concepts readable.</p>
                {chapters.length > 0 && (() => {
                  const firstEmpty = chapters.find(c => (chapterExtractedCount.get(c.id) || 0) === 0)
                  if (!firstEmpty) return null
                  return (
                    <button
                      onClick={() => handleExtractChapter(firstEmpty.id)}
                      disabled={extractingSection !== null}
                      className="mt-5 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {extractingSection === firstEmpty.id ? 'Extracting…' : `Extract “${firstEmpty.title.slice(0, 28)}”`}
                    </button>
                  )
                })()}
              </div>
            ) : (
              <ForceGraph
                ref={fgRef as any}
                graphData={fgData as any}
                width={dimensions.w}
                height={dimensions.h}
                backgroundColor="rgba(0,0,0,0)"
                showNavInfo={false}
                nodeRelSize={3}
                // size by degree + difficulty — hubs pop at scale
                nodeVal={(n: any) => {
                  const d = (n as GFNode).degree || 0
                  const base = 5 + (d / maxDegree) * 10 + (n.difficulty || 0.3) * 6
                  return base
                }}
                nodeColor={() => '#888'}
                nodeThreeObject={(node: any) => {
                  const n = node as GFNode
                  const isMatched = searchIds ? searchIds.has(n.id) : false
                  const isHighlighted = highlightedIds ? highlightedIds.has(n.id) : false
                  const isDimmedSearch = searchIds ? (!searchWithNeighbors?.has(n.id)) : false
                  const isDimmedFocus = focusChapter !== null ? (n.section_id !== focusChapter && !isHighlighted) : false
                  const isDimmed = (searchIds ? isDimmedSearch : false) || isDimmedFocus || (highlightedIds ? !isHighlighted : false)
                  // size
                  const degNorm = n.degree / maxDegree
                  const radius = 1.9 + degNorm * 2.4 + (n.difficulty || 0.35) * 1.6
                  const geo = new THREE.SphereGeometry(radius, 12, 12)
                  // color logic — use BasicMaterial so it stays vivid even without strong lights
                  let color = n.chapterColor
                  if (colorMode === 'mastery') color = masteryColor(n.mastery)
                  else if (isMatched) color = '#ffffff'
                  const opacity = isDimmed ? 0.18 : isHighlighted || isMatched ? 1 : 0.92
                  const mat = new THREE.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity,
                  } as any)
                  // subtle emissive for matched handled via opacity + outer glow sphere below
                  const mesh = new THREE.Mesh(geo, mat)
                  // add outer ring for mastery when in chapter mode and mastery known
                  if (colorMode === 'chapter' && n.mastery !== null) {
                    const ringGeo = new THREE.RingGeometry(radius * 1.18, radius * 1.35, 24)
                    const ringMat = new THREE.MeshBasicMaterial({ color: masteryColor(n.mastery), transparent: true, opacity: isDimmed ? 0.15 : 0.9, side: THREE.DoubleSide })
                    const ring = new THREE.Mesh(ringGeo, ringMat)
                    // orient ring to camera later — just add as child
                    ring.rotation.x = Math.PI / 2
                    mesh.add(ring)
                  }
                  // make matched nodes slightly larger with glow
                  if (isHighlighted && !isDimmed) {
                    const glowGeo = new THREE.SphereGeometry(radius * 1.25, 10, 10)
                    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12 })
                    const glow = new THREE.Mesh(glowGeo, glowMat)
                    mesh.add(glow)
                  }
                  return mesh
                }}
                linkColor={(l: any) => {
                  const c = REL_COLORS[(l as any).relationship_type] || '#64748b'
                  return c
                }}
                linkWidth={(l: any) => {
                  const s = (l as any).strength || 0.5
                  const base = 0.6 + s * 1.8
                  // thinner when dimmed
                  const src = typeof (l as any).source === 'object' ? (l as any).source.id : (l as any).source
                  const tgt = typeof (l as any).target === 'object' ? (l as any).target.id : (l as any).target
                  const isHighlighted = highlightedIds ? (highlightedIds.has(src) && highlightedIds.has(tgt)) : true
                  if (highlightedIds && !isHighlighted) return 0.3
                  if (searchWithNeighbors && !(searchWithNeighbors.has(src) && searchWithNeighbors.has(tgt))) return 0.3
                  return base
                }}
                linkOpacity={0.62}
                linkVisibility={linkVisibility as any}
                linkDirectionalParticles={(l: any) => {
                  const s = (l as any).strength || 0
                  const src = typeof (l as any).source === 'object' ? (l as any).source.id : (l as any).source
                  const tgt = typeof (l as any).target === 'object' ? (l as any).target.id : (l as any).target
                  const isHighlighted = highlightedIds ? (highlightedIds.has(src) && highlightedIds.has(tgt)) : false
                  if (highlightedIds && !isHighlighted) return 0
                  if (searchWithNeighbors && !(searchWithNeighbors.has(src) && searchWithNeighbors.has(tgt))) return 0
                  return s >= 0.72 ? 2 : s >= 0.45 ? 1 : 0
                }}
                linkDirectionalParticleWidth={1.9}
                linkDirectionalParticleSpeed={0.006}
                linkDirectionalParticleColor={(l: any) => REL_COLORS[(l as any).relationship_type] || '#64748b'}
                linkCurvature={0.05}
                onNodeClick={(node: any) => handleNodeClick(node as GFNode)}
                onNodeHover={(node: any) => setHovered(node ? (node as ConceptGraphNode) : null)}
                onBackgroundClick={() => { setSelected(null); setDetail(null); setHovered(null); setSelectedLink(null); setHoveredLink(null) }}
                onLinkClick={(link: any) => handleLinkClick(link as GFLink)}
                onLinkHover={(link: any) => { setHoveredLink(link ? (link as GFLink) : null); if (link) setHovered(null) }}
                d3AlphaDecay={0.022}
                d3VelocityDecay={0.26}
                cooldownTime={2800}
                warmupTicks={60}
              />
            )}

            {/* Tooltip — fixed, never clipped */}
            {hovered && !hoveredLink && (
              <div
                className="pointer-events-none fixed z-50 max-w-[320px] rounded-xl border border-white/10 bg-surface-3/95 p-3 shadow-xl backdrop-blur-xl"
                style={{ left: mousePos.x + 14, top: mousePos.y - 10 }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold leading-tight text-slate-100">{hovered.name}</div>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ backgroundColor: chapterColor.get(hovered.section_id) || '#6b7280' }}>
                    {(chapters.find(c => c.id === hovered.section_id)?.title || hovered.section_title || 'Chapter').slice(0, 18)}
                  </span>
                </div>
                <div className="mt-1 text-xs leading-relaxed text-slate-400 line-clamp-3">{hovered.description}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-500">Degree {degreeMap.get(hovered.id) || 0}</span>
                  {hovered.mastery !== null && (
                    <span className="rounded px-1.5 py-0.5 text-white" style={{ backgroundColor: masteryColor(hovered.mastery) + 'DD' }}>
                      {masteryLabel(hovered.mastery)} {Math.round(hovered.mastery * 100)}%
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-slate-500">{hovered.section_title.slice(0, 28)}</span>
                </div>
                {adjacency.get(hovered.id) && adjacency.get(hovered.id)!.size > 0 && (
                  <div className="mt-2 border-t border-white/5 pt-2 text-[11px] text-slate-500">
                    Connected to {adjacency.get(hovered.id)!.size} concept{adjacency.get(hovered.id)!.size === 1 ? '' : 's'} — click to pin.
                  </div>
                )}
              </div>
            )}
            {hoveredLink && !hovered && (
              <div
                className="pointer-events-none fixed z-50 max-w-[360px] rounded-xl border border-white/10 bg-surface-3/95 p-3 shadow-xl backdrop-blur-xl"
                style={{ left: mousePos.x + 14, top: mousePos.y - 10 }}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: REL_COLORS[hoveredLink.relationship_type] || '#64748b' }} />
                  <span className="text-xs font-semibold text-slate-100">{REL_LABELS[hoveredLink.relationship_type] || hoveredLink.relationship_type}</span>
                  <span className="ml-auto rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-400">{Math.round(hoveredLink.strength * 100)}% · click for details</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span className="truncate text-slate-300">{nodeById.get(typeof hoveredLink.source === 'object' ? (hoveredLink.source as any).id : hoveredLink.source as any)?.name || `#${hoveredLink.source}`}</span>
                  <span>→</span>
                  <span className="truncate text-slate-300">{nodeById.get(typeof hoveredLink.target === 'object' ? (hoveredLink.target as any).id : hoveredLink.target as any)?.name || `#${hoveredLink.target}`}</span>
                </div>
                {hoveredLink.explanation && (
                  <div className="mt-2 line-clamp-3 text-xs leading-relaxed text-slate-400">{hoveredLink.explanation.slice(0, 160)}{hoveredLink.explanation.length > 160 ? '…' : ''}</div>
                )}
              </div>
            )}

            {/* Bottom-left legend — glass, compact, never wastes center */}
            {hasGraph && (
              <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[72%] flex-wrap gap-1.5">
                {chapters.filter(c => chapterExtractedCount.get(c.id)).slice(0, 6).map(c => (
                  <button
                    key={c.id}
                    onClick={() => setFocusChapter(prev => prev === c.id ? null : c.id)}
                    className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium backdrop-blur transition-colors ${
                      focusChapter === c.id
                        ? 'border-indigo-400/40 bg-indigo-500/20 text-white'
                        : 'border-white/10 bg-black/35 text-slate-300 hover:bg-black/50'
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: chapterColor.get(c.id) }} />
                    <span className="max-w-[14ch] truncate">{c.title}</span>
                  </button>
                ))}
                {hasGraph && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[11px] text-slate-400 backdrop-blur">
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-400" /> Drag to orbit · Scroll to zoom
                  </span>
                )}
              </div>
            )}

            {/* Top-right density hint */}
            {hasGraph && totalConcepts > 80 && (
              <div className="pointer-events-none absolute right-3 top-3 hidden rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-tight text-amber-200 backdrop-blur lg:flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Large book — use search and chapter focus to declutter.
              </div>
            )}
          </div>

          {/* Right detail rail — overlays, doesn't shrink canvas until opened */}
          {(selected || selectedLink) && (
            <div className="absolute bottom-0 right-0 top-0 z-10 flex w-[380px] max-w-[92vw] flex-col border-l border-white/[0.08] bg-surface-1/95 backdrop-blur-xl shadow-2xl">
              {selectedLink ? (() => {
                const srcId = typeof selectedLink.source === 'object' ? (selectedLink.source as any).id : selectedLink.source as number
                const tgtId = typeof selectedLink.target === 'object' ? (selectedLink.target as any).id : selectedLink.target as number
                const srcNode = nodeById.get(srcId)
                const tgtNode = nodeById.get(tgtId)
                return (
                  <>
                    <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: REL_COLORS[selectedLink.relationship_type] || '#64748b' }} />
                          <h3 className="text-sm font-semibold text-slate-100">{REL_LABELS[selectedLink.relationship_type] || selectedLink.relationship_type}</h3>
                          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-slate-400">{Math.round(selectedLink.strength * 100)}%</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs">
                          <button onClick={() => { if (srcNode) { setSelected(srcNode); setSelectedLink(null); api.getKpDetail(bookId, srcNode.id).then(setDetail).catch(()=>{}) } }} className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-left hover:bg-white/[0.08]">
                            <div className="text-[11px] text-slate-500">Source</div>
                            <div className="truncate text-xs font-medium text-slate-200">{srcNode?.name || `#${srcId}`}</div>
                          </button>
                          <span className="text-slate-600">→</span>
                          <button onClick={() => { if (tgtNode) { setSelected(tgtNode); setSelectedLink(null); api.getKpDetail(bookId, tgtNode.id).then(setDetail).catch(()=>{}) } }} className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-left hover:bg-white/[0.08]">
                            <div className="text-[11px] text-slate-500">Target</div>
                            <div className="truncate text-xs font-medium text-slate-200">{tgtNode?.name || `#${tgtId}`}</div>
                          </button>
                        </div>
                      </div>
                      <button onClick={() => setSelectedLink(null)} className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="Close details">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto p-4">
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Why they connect</h4>
                      <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                        <div className="max-h-[42vh] overflow-y-auto pr-1.5 text-sm leading-relaxed text-slate-300 overscroll-contain">
                          {selectedLink.explanation ? (
                            <p className="whitespace-pre-wrap">{selectedLink.explanation}</p>
                          ) : (
                            <p className="text-xs italic text-slate-500">No explanation stored for this link yet — re-extract the chapter to generate a 50-200 word explanation. The relation is <span className="text-slate-300">{REL_LABELS[selectedLink.relationship_type] || selectedLink.relationship_type}</span> at {Math.round(selectedLink.strength*100)}% strength.</p>
                          )}
                        </div>
                        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: REL_COLORS[selectedLink.relationship_type] || '#64748b' }} />
                          <span>{selectedLink.relationship_type} · strength {selectedLink.strength.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="mt-4 rounded-xl bg-indigo-500/10 p-3 text-[11px] leading-relaxed text-indigo-200/80">
                        Click source or target to pin that concept. Links are by-book only.
                      </div>
                    </div>
                    <div className="border-t border-white/[0.06] p-3">
                      <button onClick={() => setSelectedLink(null)} className="w-full rounded-lg bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10">Close</button>
                    </div>
                  </>
                )
              })() : selected ? (
                <>
              <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: chapterColor.get(selected.section_id) || '#8b5cf6' }} />
                    <h3 className="truncate text-sm font-semibold text-slate-100">{selected.name}</h3>
                  </div>
                  <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-slate-400">{detail?.description || selected.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-500">{selected.section_title}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-500">Diff {selected.difficulty?.toFixed(1) ?? '—'}</span>
                    {selected.mastery !== null && (
                      <span className="rounded px-1.5 py-0.5 font-medium text-white" style={{ backgroundColor: masteryColor(selected.mastery) }}>
                        {masteryLabel(selected.mastery)} · {Math.round(selected.mastery * 100)}%
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => { setSelected(null); setDetail(null) }}
                  className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
                  aria-label="Close details"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round"/></svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {detail?.connections?.length > 0 ? (
                  <>
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Connected — {detail.connections.length} <span className="normal-case font-normal text-slate-500">· click link for explanation</span>
                    </h4>
                    <div className="mt-3 space-y-2">
                      {detail.connections.map((c: any, i: number) => {
                        const targetNode = graph?.nodes.find(n => n.id === c.kp_id)
                        // find edge for explanation
                        const edge = graph?.edges.find(e => (e.source === selected.id && e.target === c.kp_id) || (e.target === selected.id && e.source === c.kp_id))
                        return (
                          <button
                            key={i}
                            onClick={() => {
                              if (edge) {
                                setSelectedLink(edge as GFLink)
                                setSelected(null)
                                setDetail(null)
                              } else if (targetNode) {
                                setSelected(targetNode)
                                api.getKpDetail(bookId, targetNode.id).then(setDetail).catch(console.error)
                              }
                            }}
                            className="flex w-full items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-indigo-500/20 hover:bg-white/[0.04]"
                          >
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: REL_COLORS[c.relationship_type] || '#64748b' }} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-slate-200">{c.name}</div>
                              <div className="text-[11px] text-slate-500 truncate">{REL_LABELS[c.relationship_type] || c.relationship_type} · {c.direction}{c.explanation ? ` · ${c.explanation.slice(0, 80)}…` : ''}</div>
                            </div>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5 shrink-0 text-slate-600"><path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-4 rounded-xl bg-indigo-500/10 p-3 text-[11px] leading-relaxed text-indigo-200/80">
                      Tip: Click a link row to read its 50-200 word explanation. Hover nodes to see ego-network.
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04]">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5 text-slate-600"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4" strokeLinecap="round"/></svg>
                    </div>
                    <p className="mt-3 text-xs font-medium text-slate-300">No connections yet</p>
                    <p className="mt-1 max-w-[28ch] text-xs leading-relaxed text-slate-500">Extract more chapters — the LLM links new concepts to the existing universe.</p>
                  </div>
                )}
              </div>

              <div className="border-t border-white/[0.06] p-3">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>{selected.mastery !== null ? `Mastery ${Math.round(selected.mastery*100)}%` : 'No mastery data yet'}</span>
                  <button
                    onClick={() => { setSelected(null); setDetail(null) }}
                    className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-white/10"
                  >
                    Close
                  </button>
                </div>
              </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
