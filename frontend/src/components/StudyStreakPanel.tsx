import { useEffect, useState } from 'react'
import type { UserProfile } from '../types'
import { getProfile } from '../api'
import CalendarHeatmap from './CalendarHeatmap'

export default function StudyStreakPanel() {
  const [profile, setProfile] = useState<UserProfile | null>(null)

  useEffect(() => {
    getProfile().then(setProfile).catch(() => {})
  }, [])

  if (!profile) return null

  return (
    <div className="card p-6">
      <h3 className="section-title mb-4">Study Streak</h3>
      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className="text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-orange-400"><path d="M12 2c1.5 3.5 4 6 4 10a4 4 0 11-8 0c0-4 2.5-6.5 4-10z"/></svg>
            <span className="text-2xl font-bold text-slate-100">{profile.current_streak}</span>
          </div>
          <p className="text-2xs text-slate-500">Current streak</p>
        </div>
        <div className="text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-amber-400"><path d="M12 15l-2 5l9-13h-6l2-5-9 13h6z"/></svg>
            <span className="text-2xl font-bold text-slate-100">{profile.longest_streak}</span>
          </div>
          <p className="text-2xs text-slate-500">Best streak</p>
        </div>
        <div className="text-center">
          <div className="flex items-center justify-center gap-1.5 mb-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-indigo-400"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <span className="text-2xl font-bold text-slate-100">{profile.level}</span>
          </div>
          <p className="text-2xs text-slate-500">Level</p>
        </div>
      </div>
      <CalendarHeatmap />
    </div>
  )
}
