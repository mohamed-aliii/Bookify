import { useCallback, useEffect, useState } from 'react'

interface PaneWidth {
  width: number
  startResize: (e: React.PointerEvent, dir: 1 | -1) => void
}

function loadWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    // ignore storage failures
  }
  return fallback
}

export default function usePaneWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): PaneWidth {
  const [width, setWidth] = useState(() => loadWidth(key, fallback))

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width))
    } catch {
      // ignore storage failures
    }
  }, [key, width])

  const startResize = useCallback((e: React.PointerEvent, dir: 1 | -1) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX
      const next = startWidth + dir * delta
      setWidth(Math.min(max, Math.max(min, Math.round(next))))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [width, min, max])

  return { width, startResize }
}
