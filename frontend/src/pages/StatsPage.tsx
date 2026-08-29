import { useEffect, useState } from 'react'
import { getGamificationStats } from '../api'
import type { GamificationStats } from '../types'
import AppShell from '../components/AppShell'
import GamificationBar from '../components/GamificationBar'
import StudyStreakPanel from '../components/StudyStreakPanel'
import AchievementGrid from '../components/AchievementGrid'
import MasteryLeaderboard from '../components/MasteryLeaderboard'
import Spinner from '../components/ui/Spinner'

export default function StatsPage() {
  const [stats, setStats] = useState<GamificationStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getGamificationStats().then(setStats).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const header = (
    <h1 className="text-sm font-semibold text-slate-200">Stats & Achievements</h1>
  )

  return (
    <AppShell header={header}>
      <div className="page-container">
        <GamificationBar />

        {loading ? (
          <div className="py-16"><Spinner label="Loading stats…" /></div>
        ) : !stats ? (
          <div className="py-16 text-center text-sm text-slate-500">Could not load stats.</div>
        ) : (
          <div className="space-y-8">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                { label: 'Total XP', value: stats.total_xp.toLocaleString(), color: 'text-amber-400', icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                )},
                { label: 'Level', value: stats.level, color: 'text-indigo-400', icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path d="M12 15l-2 5l9-13h-6l2-5-9 13h6z"/></svg>
                )},
                { label: 'Quizzes Done', value: stats.total_quizzes, color: 'text-emerald-400', icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )},
                { label: 'Current Streak', value: `${stats.current_streak}d`, color: 'text-rose-400', icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path d="M12 2c1.5 3.5 4 6 4 10a4 4 0 11-8 0c0-4 2.5-6.5 4-10z"/></svg>
                )},
              ].map((stat) => (
                <div key={stat.label} className="card p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`${stat.color} opacity-60`}>{stat.icon}</div>
                    <span className="text-2xs font-medium uppercase tracking-wider text-slate-500">{stat.label}</span>
                  </div>
                  <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                </div>
              ))}
            </div>

            <StudyStreakPanel />
            <AchievementGrid />
            <MasteryLeaderboard />
          </div>
        )}
      </div>
    </AppShell>
  )
}
