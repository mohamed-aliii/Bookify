import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReadAction } from '../types'

interface Props {
  onAction: (action: ReadAction) => void
  visible: boolean
  position: { x: number; y: number } | null
  onClear: () => void
}

const ACTIONS: { action: ReadAction; label: string; icon: string }[] = [
  { action: 'simplify', label: 'Simplify', icon: '💡' },
  { action: 'explain', label: 'Explain', icon: '📖' },
  { action: 'examples', label: 'Examples', icon: '🔍' },
  { action: 'code', label: 'Code', icon: '💻' },
  { action: 'create_flashcard', label: 'Flashcard', icon: '🃏' },
  { action: 'create_note', label: 'Note', icon: '📝' },
  { action: 'ask', label: 'Ask', icon: '💬' },
  { action: 'translate', label: 'Translate', icon: '🇸🇦' },
]

export default function SelectionToolbar({ onAction, visible, position, onClear }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    if (!visible || !position || !ref.current) { setPos(null); return }
    const el = ref.current
    const rect = el.getBoundingClientRect()
    let x = position.x - rect.width / 2
    let y = position.y - rect.height - 12
    if (x < 8) x = 8
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
    if (y < 8) y = position.y + 24
    setPos({ x, y })
  }, [visible, position])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  useEffect(() => {
    if (!visible) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClear()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [visible, onClear])

  if (!visible || !position) return null

  const stylePos = pos ?? { x: position.x - 100, y: position.y - 50 }

  return (
    <div
      ref={ref}
      onMouseDown={handleMouseDown}
      className="fixed z-50 flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-800 p-1.5 shadow-xl animate-scale-in"
      style={{ left: stylePos.x, top: stylePos.y }}
    >
      {ACTIONS.map((a) => (
        <button
          key={a.action}
          onClick={() => { onAction(a.action); onClear() }}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/[0.12] hover:text-white"
        >
          <span>{a.icon}</span>
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  )
}
