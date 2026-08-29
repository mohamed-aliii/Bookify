import AppShell from '../components/AppShell'

export default function KnowledgeMapPage() {
  return (
    <AppShell header={<h1 className="text-sm font-semibold text-slate-200">Knowledge Map</h1>}>
      <KnowledgeMapContent />
    </AppShell>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConceptGraphNode, ConceptGraphEdge, CrossBookLink } from '../types'
import * as api from '../api'

interface UnifiedGraph {
  nodes: ConceptGraphNode[]
  intra_edges: ConceptGraphEdge[]
  inter_edges: CrossBookLink[]
}

function KnowledgeMapContent() {
  const [graph, setGraph] = useState<UnifiedGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [hovered, setHovered] = useState<ConceptGraphNode | null>(null)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await api.getUnifiedGraph(); setGraph(data) } catch { } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleExtract = async () => {
    setExtracting(true)
    try { await api.extractCrossBookLinks(); await load() } catch { } finally { setExtracting(false) }
  }

  useEffect(() => {
    if (!canvasRef.current || !graph || graph.nodes.length === 0) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.parentElement?.clientWidth || 1000
    const h = canvas.parentElement?.clientHeight || 600
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.scale(dpr, dpr)

    const nodes = graph.nodes.map(n => ({
      ...n, x: w / 2 + (Math.random() - 0.5) * 300, y: h / 2 + (Math.random() - 0.5) * 300, vx: 0, vy: 0,
    }))
    const nodeIdx = new Map(nodes.map((n, i) => [n.id, i]))
    const intraEdges = graph.intra_edges.filter(e => nodeIdx.has(e.source) && nodeIdx.has(e.target)).map(e => ({ ...e, si: nodeIdx.get(e.source)!, ti: nodeIdx.get(e.target)! }))
    const interEdges = graph.inter_edges.filter(e => nodeIdx.has(e.source_kp_id) && nodeIdx.has(e.target_kp_id)).map(e => ({ ...e, si: nodeIdx.get(e.source_kp_id)!, ti: nodeIdx.get(e.target_kp_id)! }))

    let animId: number, alpha = 1
    const masteryColor = (m: number | null) => m === null ? '#6b7280' : m >= 0.8 ? '#22c55e' : m >= 0.5 ? '#f59e0b' : '#ef4444'

    const tick = () => {
      alpha *= 0.992
      if (alpha < 0.001) { draw(); return }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y, dist = Math.sqrt(dx * dx + dy * dy) || 1, force = (250 * 250) / dist * alpha
          nodes[i].vx -= (dx / dist) * force; nodes[i].vy -= (dy / dist) * force; nodes[j].vx += (dx / dist) * force; nodes[j].vy += (dy / dist) * force
        }
      }
      for (const e of [...intraEdges, ...interEdges]) {
        const s = nodes[e.si], t = nodes[e.ti]; let dx = t.x - s.x, dy = t.y - s.y, dist = Math.sqrt(dx * dx + dy * dy) || 1, force = (dist - 120) * 0.04 * alpha
        s.vx += (dx / dist) * force; s.vy += (dy / dist) * force; t.vx -= (dx / dist) * force; t.vy -= (dy / dist) * force
      }
      for (const n of nodes) { n.vx += (w / 2 - n.x) * 0.005 * alpha; n.vy += (h / 2 - n.y) * 0.005 * alpha; n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy; n.x = Math.max(40, Math.min(w - 40, n.x)); n.y = Math.max(40, Math.min(h - 40, n.y)) }
      draw(); animId = requestAnimationFrame(tick)
    }

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      for (const e of intraEdges) { const s = nodes[e.si], t = nodes[e.ti]; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.strokeStyle = '#4b5563'; ctx.globalAlpha = 0.3; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.stroke(); ctx.globalAlpha = 1 }
      for (const e of interEdges) { const s = nodes[e.si], t = nodes[e.ti]; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.strokeStyle = '#eab308'; ctx.globalAlpha = 0.5; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]) }
      for (const n of nodes) { const r = 7 + (n.description?.length || 50) / 40; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fillStyle = masteryColor(n.mastery); ctx.fill(); ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#e2e8f0'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center'; const label = n.name.length > 20 ? n.name.slice(0, 18) + '..' : n.name; ctx.fillText(label, n.x, n.y + r + 12) }
    }

    animId = requestAnimationFrame(tick)
    const onMove = (ev: MouseEvent) => { const rect = canvas.getBoundingClientRect(); const mx = ev.clientX - rect.left, my = ev.clientY - rect.top; let found: ConceptGraphNode | null = null; for (const n of nodes) { const r = 7 + (n.description?.length || 50) / 40; if (Math.hypot(mx - n.x, my - n.y) < r + 4) { found = n; break } } canvas.style.cursor = found ? 'pointer' : 'default'; setHovered(found); setMousePos({ x: ev.clientX, y: ev.clientY }) }
    canvas.addEventListener('mousemove', onMove)
    return () => { cancelAnimationFrame(animId); canvas.removeEventListener('mousemove', onMove) }
  }, [graph])

  if (loading) return <div className="flex items-center justify-center py-32"><div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" /></div>

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          {graph && <span className="text-xs text-slate-500">{graph.nodes.length} concepts · {graph.inter_edges.length} cross-book links</span>}
        </div>
        <button onClick={handleExtract} disabled={extracting} className="btn-primary btn-sm">
          {extracting ? 'Extracting…' : 'Extract Cross-Book Links'}
        </button>
      </div>

      <div className="flex-1 relative min-h-0">
        {!graph || graph.nodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.03]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-slate-600">
                <circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="text-sm">Upload multiple books and extract knowledge points to see the unified map.</p>
          </div>
        ) : (
          <canvas ref={canvasRef} className="w-full h-full" />
        )}

        {hovered && (
          <div className="fixed z-50 glass-strong rounded-xl p-3 shadow-glass max-w-xs pointer-events-none animate-scale-in" style={{ left: mousePos.x + 12, top: mousePos.y - 8 }}>
            <div className="text-sm font-medium text-slate-200">{hovered.name}</div>
            <div className="text-xs text-slate-400 mt-1">{hovered.description}</div>
            <div className="text-2xs text-slate-500 mt-1">Section: {hovered.section_title}</div>
            {hovered.mastery !== null && (
              <div className="text-2xs mt-1" style={{ color: hovered.mastery >= 0.8 ? '#22c55e' : hovered.mastery >= 0.5 ? '#f59e0b' : '#ef4444' }}>
                Mastery: {Math.round(hovered.mastery * 100)}%
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-5 px-6 py-2.5 border-t border-white/[0.06] text-2xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500"/>Mastered</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500"/>Learning</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500"/>Weak</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-500"/>Unknown</span>
        <span className="ml-4 flex items-center gap-1.5"><span className="w-4 border-t border-slate-500"/>Intra-book</span>
        <span className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-amber-500"/>Cross-book</span>
      </div>
    </div>
  )
}
