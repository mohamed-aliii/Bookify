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
  related: '#6b7280',
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
  '#4ade80', '#facc15', '#38bdf8', '#f472b6', '#a3e635',
]

function masteryColor(mastery: number | null): string {
  if (mastery === null) return '#71717a'
  if (mastery >= 0.8) return '#22c55e'
  if (mastery >= 0.5) return '#f59e0b'
  return '#ef4444'
}

type GFNode = ConceptGraphNode & {
  chapterColor: string
  dimmed: boolean
}

type GFLink = {
  id: number
  source: number
  target: number
  relationship_type: string
  strength: number
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
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [filterRel, setFilterRel] = useState<Set<string>>(new Set(Object.keys(REL_COLORS)))
  const [colorMode, setColorMode] = useState<'chapter' | 'mastery'>('chapter')
  const [autoRotate, setAutoRotate] = useState(true)
  const [focusChapter, setFocusChapter] = useState<number | null>(null)
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined)

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

  const filteredEdges = useMemo<GFLink[]>(() => {
    if (!graph) return []
    return graph.edges
      .filter(e => filterRel.has(e.relationship_type) && graph.nodes.some(n => n.id === e.source) && graph.nodes.some(n => n.id === e.target))
      .map(e => ({ ...e, source: e.source, target: e.target }))
  }, [graph, filterRel])

  const fgData = useMemo(() => {
    const nodes: GFNode[] = (graph?.nodes || []).map(n => ({
      ...n,
      chapterColor: chapterColor.get(n.section_id) || '#8b5cf6',
      dimmed: focusChapter !== null && n.section_id !== focusChapter,
    }))
    return { nodes, links: filteredEdges }
  }, [graph, filteredEdges, chapterColor, focusChapter])

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
    api.getKpDetail(bookId, node.id).then(setDetail).catch(console.error)
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
        controls.autoRotate = autoRotate
        controls.autoRotateSpeed = 0.6
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [autoRotate])

  const linkVisibility = useCallback((link: any) => {
    if (focusChapter === null) return true
    const src = nodeById.get(typeof link.source === 'object' ? link.source.id : link.source)
    const tgt = nodeById.get(typeof link.target === 'object' ? link.target.id : link.target)
    return (src?.section_id === focusChapter) || (tgt?.section_id === focusChapter)
  }, [focusChapter, nodeById])

  if (loading) {
    return <div className="p-4 text-slate-400">Loading concept graph...</div>
  }

  const hasGraph = graph !== null && graph.nodes.length > 0

  return (
    <div className="flex h-full">
      {/* Sidebar: chapters */}
      <div className="w-72 shrink-0 border-r border-white/[0.06] bg-surface-1/50 flex flex-col">
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Constellations</h3>
          <p className="text-[11px] text-slate-500 mt-1">Extract each chapter to grow the universe. Click a chapter to focus.</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {chapters.length === 0 && <p className="text-xs text-slate-500 p-2">No chapters found.</p>}
          {chapters.map((c) => {
            const count = chapterExtractedCount.get(c.id) || 0
            return (
              <div
                key={c.id}
                onClick={() => setFocusChapter(prev => prev === c.id ? null : c.id)}
                className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer border transition-colors ${
                  focusChapter === c.id ? 'bg-white/10 border-white/15' : 'border-transparent hover:bg-white/[0.04]'
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: chapterColor.get(c.id) }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-200 truncate">{c.title}</div>
                  <div className="text-[10px] text-slate-500">
                    {count > 0 ? `${count} concept${count === 1 ? '' : 's'}` : 'Not extracted'}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleExtractChapter(c.id) }}
                  disabled={extractingSection !== null}
                  className="shrink-0 text-[11px] px-2 py-1 rounded border border-white/10 hover:bg-white/10 disabled:opacity-40 text-slate-300"
                >
                  {extractingSection === c.id ? '…' : (count > 0 ? 'Re-extract' : 'Extract')}
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* Main: 3D view */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-300">Knowledge Universe</span>
            {hasGraph && (
              <span className="text-xs text-slate-500">{graph.nodes.length} concepts · {graph.edges.length} connections</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {Object.entries(REL_COLORS).map(([rel, color]) => (
                <button
                  key={rel}
                  onClick={() => toggleRel(rel)}
                  className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors ${
                    filterRel.has(rel) ? 'bg-white/10 text-slate-200' : 'bg-transparent text-slate-600'
                  }`}
                  title={REL_LABELS[rel]}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color, opacity: filterRel.has(rel) ? 1 : 0.3 }} />
                  <span className="hidden xl:inline">{REL_LABELS[rel]}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setColorMode(m => m === 'chapter' ? 'mastery' : 'chapter')}
              className="text-[11px] px-2 py-1 rounded border border-white/10 hover:bg-white/10 text-slate-300"
              title="Toggle color mode"
            >
              {colorMode === 'chapter' ? 'By Chapter' : 'By Mastery'}
            </button>
            <button
              onClick={() => setAutoRotate(a => !a)}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${autoRotate ? 'bg-white/10 text-slate-200 border-white/15' : 'border-white/10 hover:bg-white/10 text-slate-400'}`}
            >
              {autoRotate ? 'Rotate: On' : 'Rotate: Off'}
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 border-b border-white/[0.06] text-xs text-red-400 bg-red-500/5">{error}</div>
        )}

        <div className="flex-1 relative" onMouseMove={handleMouseMove} style={{ background: 'radial-gradient(circle at 50% 40%, #10102a 0%, #050510 70%)' }}>
          {!hasGraph ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
              <div className="text-4xl">🌌</div>
              <p className="text-sm">No concepts yet. Pick a chapter on the left and extract its constellation.</p>
            </div>
          ) : (
            <ForceGraph
              ref={fgRef}
              graphData={fgData as any}
              backgroundColor="rgba(0,0,0,0)"
              showNavInfo={false}
              nodeRelSize={3}
              nodeVal={(n: any) => 6 + (n.difficulty || 0) * 10}
              nodeColor={(n: any) => {
                if (colorMode === 'mastery') return masteryColor(n.mastery)
                return n.dimmed ? 'rgba(70,70,95,0.35)' : (n.chapterColor || '#8b5cf6')
              }}
              nodeThreeObject={(n: any) => {
                const radius = 2.2 + (n.difficulty || 0.5) * 2.6
                const geo = new THREE.IcosahedronGeometry(radius, 1)
                const color = colorMode === 'mastery' ? masteryColor(n.mastery) : (n.dimmed ? '#46465f' : n.chapterColor || '#8b5cf6')
                const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: n.dimmed ? 0.35 : 1 })
                return new THREE.Mesh(geo, mat)
              }}
              linkColor={(l: any) => {
                const c = REL_COLORS[(l as any).relationship_type] || '#6b7280'
                return c
              }}
              linkWidth={(l: any) => 0.4 + (l as any).strength * 1.6}
              linkOpacity={0.55}
              linkVisibility={linkVisibility}
              linkDirectionalParticles={(l: any) => (l as any).strength >= 0.7 ? 2 : 1}
              linkDirectionalParticleWidth={1.8}
              linkDirectionalParticleSpeed={0.006}
              linkDirectionalParticleColor={(l: any) => REL_COLORS[(l as any).relationship_type] || '#6b7280'}
              onNodeClick={(node: any) => handleNodeClick(node as GFNode)}
              onNodeHover={(node: any) => setHovered(node ? (node as ConceptGraphNode) : null)}
              onBackgroundClick={() => { setSelected(null); setDetail(null); setHovered(null) }}
              d3AlphaDecay={0.02}
              d3VelocityDecay={0.3}
              cooldownTime={3000}
            />
          )}

          {/* Tooltip */}
          {hovered && (
            <div
              className="fixed z-50 bg-surface-3 border border-white/[0.12] rounded-lg p-3 shadow-xl max-w-xs pointer-events-none"
              style={{ left: mousePos.x + 12, top: mousePos.y - 8 }}
            >
              <div className="text-sm font-medium text-slate-200">{hovered.name}</div>
              <div className="text-xs text-slate-400 mt-1">{hovered.description}</div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-slate-500">Section:</span>
                <span className="text-xs text-slate-300">{hovered.section_title}</span>
              </div>
              {hovered.mastery !== null && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-slate-500">Mastery:</span>
                  <span className="text-xs font-medium" style={{ color: masteryColor(hovered.mastery) }}>
                    {Math.round(hovered.mastery * 100)}%
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Legend chips bottom-left */}
          {hasGraph && (
            <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5 max-w-[60%]">
              {chapters.filter(c => chapterExtractedCount.get(c.id)).slice(0, 8).map(c => (
                <button
                  key={c.id}
                  onClick={() => setFocusChapter(prev => prev === c.id ? null : c.id)}
                  className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full border ${
                    focusChapter === c.id ? 'bg-white/15 border-white/25 text-white' : 'bg-black/30 border-white/10 text-slate-300'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: chapterColor.get(c.id) }} />
                  {c.title.length > 22 ? c.title.slice(0, 20) + '…' : c.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="border-t border-white/[0.06] bg-surface-1/80 backdrop-blur-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-medium text-slate-200">{selected.name}</h3>
                <p className="text-xs text-slate-400 mt-1">{detail?.description || selected.description}</p>
                {detail?.connections?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {detail.connections.map((c: any, i: number) => (
                      <div key={i} className="text-xs text-slate-500">
                        <span style={{ color: REL_COLORS[c.relationship_type] || '#6b7280' }}>
                          {REL_LABELS[c.relationship_type] || c.relationship_type}
                        </span>
                        {' → '}
                        <span className="text-slate-300">{c.name}</span>
                        <span className="ml-1 text-slate-600">({c.direction})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => { setSelected(null); setDetail(null) }} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
