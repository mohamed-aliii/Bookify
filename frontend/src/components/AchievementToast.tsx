import { useEffect, useRef, useState } from 'react'
import type { AchievementDef } from '../types'
import { getRecentAchievements } from '../api'

export default function AchievementToast() {
  const [toast, setToast] = useState<AchievementDef | null>(null)
  const seenRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const check = async () => {
      try {
        const recent = await getRecentAchievements()
        for (const a of recent) {
          if (!seenRef.current.has(a.key)) {
            seenRef.current.add(a.key)
            setToast(a)
            setTimeout(() => setToast(null), 4000)
            break
          }
        }
      } catch {}
    }
    check()
    const timer = setInterval(check, 15000)
    return () => clearInterval(timer)
  }, [])

  if (!toast) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] animate-slide-up pointer-events-none">
      <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 shadow-glass backdrop-blur-xl pointer-events-auto">
        <div className="text-2xl">{toast.icon}</div>
        <div>
          <p className="text-xs font-semibold text-amber-300">Achievement Unlocked!</p>
          <p className="text-sm font-medium text-slate-200">{toast.name}</p>
        </div>
      </div>
    </div>
  )
}
