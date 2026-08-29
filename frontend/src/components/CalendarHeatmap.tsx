import { useEffect, useState } from 'react'
import type { DailyProgress } from '../types'
import * as api from '../api'

function getIntensity(xp: number): string {
  if (xp === 0) return 'bg-slate-800'
  if (xp <= 20) return 'bg-emerald-900'
  if (xp <= 50) return 'bg-emerald-700'
  return 'bg-emerald-400'
}

function formatDays(data: DailyProgress[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const d of data) map.set(d.date, d.xp_earned)
  return map
}

export default function CalendarHeatmap() {
  const [data, setData] = useState<DailyProgress[]>([])
  const [hovered, setHovered] = useState<{ date: string; xp: number; x: number; y: number } | null>(null)

  useEffect(() => {
    api.getProgressHistory(365).then(setData).catch(() => {})
  }, [])

  const xpMap = formatDays(data)
  const today = new Date()
  const weeks: string[][] = []

  const startDate = new Date(today)
  startDate.setDate(startDate.getDate() - 364)
  const dayOfWeek = startDate.getDay()
  startDate.setDate(startDate.getDate() - dayOfWeek)

  const current = new Date(startDate)
  let week: string[] = []
  while (current <= today) {
    week.push(current.toISOString().slice(0, 10))
    if (current.getDay() === 6) {
      weeks.push(week)
      week = []
    }
    current.setDate(current.getDate() + 1)
  }
  if (week.length > 0) weeks.push(week)

  const cellSize = 13
  const gap = 3
  const width = weeks.length * (cellSize + gap)
  const height = 7 * (cellSize + gap)

  return (
    <div className="relative">
      <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
        <span>Less</span>
        {[0, 10, 30, 60].map(xp => (
          <div key={xp} className={`w-3 h-3 rounded-sm ${getIntensity(xp)}`} />
        ))}
        <span>More</span>
      </div>
      <svg width={width} height={height} className="block">
        {weeks.map((w, wi) =>
          w.map((date, di) => {
            const xp = xpMap.get(date) ?? 0
            return (
              <rect
                key={date}
                x={wi * (cellSize + gap)}
                y={di * (cellSize + gap)}
                width={cellSize}
                height={cellSize}
                rx={2}
                className={`${getIntensity(xp)} cursor-pointer transition-opacity hover:opacity-80`}
                onMouseEnter={(e) => setHovered({ date, xp, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHovered(null)}
              />
            )
          })
        )}
      </svg>
      {hovered && (
        <div
          className="fixed z-50 bg-slate-800 border border-white/10 rounded px-2 py-1 text-xs text-slate-200 pointer-events-none shadow-lg"
          style={{ left: hovered.x + 8, top: hovered.y - 30 }}
        >
          {hovered.date}: {hovered.xp} XP
        </div>
      )}
    </div>
  )
}
