import { useEffect, useState } from 'react'
import type { UserProfile, DailyProgress } from '../types'
import { getProfile, getTodayProgress } from '../api'

export default function GamificationBar() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [progress, setProgress] = useState<DailyProgress | null>(null)

  useEffect(() => {
    getProfile().then(setProfile).catch(() => {})
    getTodayProgress().then(setProgress).catch(() => {})
  }, [])

  if (!profile) return null

  const xpForLevel = profile.level * 100
  const levelProgress = profile.total_xp > 0 ? ((profile.total_xp % xpForLevel) / xpForLevel) * 100 : 0
  const dailyPct = progress ? Math.min((progress.xp_earned / Math.max(profile.daily_xp_goal, 1)) * 100, 100) : 0

  return (
    <div className="flex items-center gap-4 border-b border-white/[0.06] bg-surface-1/40 px-5 py-2 text-2xs">
      <div className="flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-amber-400"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        <span className="font-medium text-slate-300">Lv.{profile.level}</span>
        <div className="h-1 w-16 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${levelProgress}%` }} />
        </div>
      </div>
      {profile.current_streak > 0 && (
        <div className="flex items-center gap-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-orange-400"><path d="M12 2c1.5 3.5 4 6 4 10a4 4 0 11-8 0c0-4 2.5-6.5 4-10z"/></svg>
          <span className="font-medium text-slate-300">{profile.current_streak}d</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 ml-auto">
        <span className="text-slate-500">Daily</span>
        <div className="h-1 w-20 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${dailyPct}%` }} />
        </div>
        <span className="font-medium text-slate-400">{progress?.xp_earned ?? 0}/{profile.daily_xp_goal}</span>
      </div>
      <div className="flex items-center gap-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-yellow-400"><path d="M12 15l-2 5l9-13h-6l2-5-9 13h6z"/></svg>
        <span className="font-medium text-yellow-400">{profile.total_xp.toLocaleString()} XP</span>
      </div>
    </div>
  )
}
