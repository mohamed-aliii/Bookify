import { useEffect, useState } from 'react'
import type { AchievementDef } from '../types'
import { getAchievements } from '../api'

const CATEGORIES = ['all', 'study', 'streak', 'quiz', 'social', 'exploration'] as const

export default function AchievementGrid() {
  const [achievements, setAchievements] = useState<AchievementDef[]>([])
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => { getAchievements().then(setAchievements).catch(() => {}) }, [])

  const filtered = filter === 'all' ? achievements : achievements.filter(a => a.category === filter)
  const earned = filtered.filter(a => a.earned)
  const locked = filtered.filter(a => !a.earned)

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="section-title">Achievements</h3>
        <span className="text-2xs text-slate-500">{earned.length}/{filtered.length} earned</span>
      </div>
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {CATEGORIES.map(cat => (
          <button key={cat} onClick={() => setFilter(cat)} className={`btn-sm shrink-0 capitalize ${filter === cat ? 'btn-primary' : 'btn-ghost'}`}>
            {cat}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {earned.map(a => (
          <div key={a.key} className="card-surface p-4 text-center transition-all duration-200 hover:border-amber-500/20 hover:bg-amber-500/[0.03]">
            <div className="text-3xl mb-2">{a.icon}</div>
            <p className="text-xs font-medium text-slate-200">{a.name}</p>
            <p className="mt-0.5 text-2xs text-slate-500">{a.description}</p>
            <span className="badge-warning mt-2">Earned</span>
          </div>
        ))}
        {locked.map(a => (
          <div key={a.key} className="card-surface p-4 text-center opacity-40">
            <div className="text-3xl mb-2 grayscale">{a.icon}</div>
            <p className="text-xs font-medium text-slate-400">{a.name}</p>
            <p className="mt-0.5 text-2xs text-slate-600">{a.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
